# Arsitektur awvd

## Metadata

- Version: `v1.3.0`
- Last updated: `2026-11-08`
- Changeset: `Alur render: cache segmen opt-in (--cache-segmen) dengan kunci global, manifest berkas per pekerja, dan syarat determinisme sisi cache. Sebelumnya: segmen tetap dengan pekerja paralel dan penggabungan tanpa encode ulang, pemanasan 2 frame.`

Dokumen ini menjelaskan cara awvd bekerja: dari komposisi web sampai MP4, kontrak antara komposisi dan renderer, aturan yang menjaga hasil tetap deterministik, serta peran awvd sebagai upstream bagi repo proyek video. Referensi rinci ada di [api-runtime.md](api-runtime.md) dan [cli.md](cli.md).

## Alur render

```mermaid
flowchart LR
    K[Komposisi HTML<br/>defineVideo + render] --> O[render.mjs<br/>probe, bagi segmen tetap]
    O --> P1[Pekerja 1..N<br/>Chromium + renderFrame n<br/>screenshot PNG]
    P1 --> F[ffmpeg per segmen<br/>x264 video-saja -> MPEG-TS]
    F --> G[Gabung -c copy<br/>+faststart, verifikasi PTS]
    A[Audio / subtitle<br/>opsional] --> Z[Tahap akhir tunggal<br/>-c:v copy]
    G --> Z
    Z --> M[MP4 H.264 High<br/>yuv420p, BT.709]
    CS[(Cache segmen<br/>opsional)] -.hit: lewati pekerja.-> G
    F -.simpan.-> CS
```

Rentang frame dibagi menjadi segmen berukuran tetap (`4 x round(fps/2)` frame, kelipatan GOP) yang tidak bergantung jumlah pekerja. Setiap segmen dirender pekerja `scripts/render-segmen.mjs` di proses Chromium sendiri: PNG dialirkan langsung ke stdin ffmpeg (tidak ada berkas sementara per frame) dan menghasilkan satu aliran H.264 video-saja yang diremux ke MPEG-TS. `render.mjs` menggabung segmen dengan concat demuxer `-c copy` (tanpa encode ulang), memverifikasi jumlah frame dan PTS, lalu, bila ada audio atau subtitle, memasangnya di satu tahap akhir dengan `-c:v copy` (kenyaringan dua-pass tetap tahap tunggal). Serial adalah satu pekerja di jalur yang sama, sehingga MP4 byte-identik untuk jumlah pekerja berapa pun. Alasan, parameter, dan batasannya ada di [cli.md](cli.md#render-paralel-dan-segmen).

Dengan `--cache-segmen` (opt-in), `render.mjs` mencari tiap segmen di cache sebelum meluncurkan pekerja: segmen yang kunci globalnya (lingkungan, props, konfigurasi, flag, ukuran segmen) dan rentangnya sama, serta manifest berkas yang dimuat halaman (direkam pekerja saat render, sha256) masih cocok, diambil dari cache tanpa Chromium dan ffmpeg; sisanya dirender pekerja lalu disimpan atomik segera setelah selesai. Hasil akhirnya byte-identik dengan render tanpa cache karena segmen yang sama dikunci oleh semua masukan yang memengaruhi byte-nya dan gabungan tetap diverifikasi. Kunci, fail-safe, dan integritasnya ada di [cli.md](cli.md#cache-segmen).

## Konsep komposisi

Video adalah fungsi murni dari nomor frame. Komposisi memuat `scripts/runtime.js`, memanggil `defineVideo`, dan menggambar ulang DOM di `render(frame, ctx)`.

```html
<script src="../../scripts/runtime.js"></script>
<script>
  defineVideo({
    width: 1280, height: 720, fps: 30, durationInFrames: 180,
    render(frame, ctx) {
      const { judul } = ctx.props;
      document.getElementById("judul").textContent = judul ?? "";
      document.getElementById("judul").style.opacity =
        fade(frame, ctx.durationInFrames);
    },
  });
</script>
```

- `render` boleh `async`; renderer menunggu hasilnya dan `document.fonts.ready` sebelum mengambil screenshot.
- `props` datang dari `--props`/`--props-file` (menjadi `window.videoProps`) atau `?props=` saat pratinjau.
- Contoh lengkap: [`templates/contoh-dasar/`](../templates/contoh-dasar/).

## Protokol window.video dan renderFrame

Kontrak antara komposisi dan renderer hanya tiga hal: `window.videoProps` (masuk), `window.video` (keluar), dan `renderFrame(n)` (dipanggil per frame). `defineVideo` ([api-runtime.md](api-runtime.md)) membuat `window.video`. Urutan berikut dijalankan dalam satu sesi browser (`scripts/render-sesi.mjs`): oleh `render.mjs` untuk probe konfigurasi dan mode `--still`, dan oleh setiap pekerja segmen (`scripts/render-segmen.mjs`) untuk segmennya sendiri; `R` di bawah adalah proses yang memegang sesi itu.

```mermaid
sequenceDiagram
    participant R as render.mjs
    participant H as Halaman komposisi
    participant F as ffmpeg
    R->>H: pasang pemblokiran jaringan (hanya file:, data:, about:, blob:)
    R->>H: suntik window.videoProps sebelum skrip halaman berjalan
    R->>H: buka halaman (file:// atau URL)
    H-->>R: window.video siap (batas 15 detik)
    R->>H: muat setiap @font-face, lalu tunggu document.fonts.ready dan semua gambar
    Note over R,H: pekerja segmen: 2 frame pemanasan (dirender, ditangkap, dibuang)
    loop setiap frame n pada segmen
        R->>H: await renderFrame(n)
        H-->>R: DOM digambar ulang untuk n
        R->>F: screenshot PNG ke stdin
        Note over R: ada permintaan diblokir? render gagal, kode keluar 3
    end
    R->>F: tutup stdin, tunggu encode selesai
```

| Elemen | Arah | Isi |
| --- | --- | --- |
| `window.videoProps` | renderer ke komposisi | Objek props dari `--props`/`--props-file`, disuntik sebelum skrip halaman berjalan; tersedia sebagai `ctx.props` di `render`. Saat pratinjau datang dari `?props=`. |
| `window.video` | komposisi ke renderer | `{ width, height, fps, durationInFrames, renderFrame(n) }`. Renderer menunggu paling lama 15 detik; tanpa itu render gagal dengan kode keluar `1`. Keempat angka harus positif. |
| `renderFrame(n)` | renderer memanggil | Membulatkan `n`, menolak di luar `0..durationInFrames-1`, dan berjalan berurutan (satu pada satu waktu). Boleh `async`; renderer menunggu hasilnya. |

Langkah renderer sesudah `window.video` siap: viewport diatur ke `width` x `height` komposisi; renderer memuat eksplisit setiap `@font-face` (`FontFace.load()` untuk semua `document.fonts`; render gagal bila ada yang gagal dimuat), menunggu `document.fonts.ready` dan semua `<img>` (render gagal bila ada gambar rusak); tiap frame ditangkap sebagai PNG lewat CDP dengan `clip.scale` = `max(--skala, 1)` (layout tetap, raster dibuat ulang tajam untuk skala di atas 1); untuk `--skala` di bawah 1 `ffmpeg` memperkecil tangkapan skala 1 ke ukuran akhir (lanczos), karena `clip.scale` di bawah 1 menghasilkan raster yang berbeda acak pada batas tile; PNG dialirkan ke stdin ffmpeg tanpa berkas sementara. Sebelum frame pertama setiap segmen, dua frame pemanasan dirender dan ditangkap lalu dibuang (dua tangkapan pertama sebuah proses Chromium bisa berbeda beberapa piksel dari frame yang sama di tengah proses). `--tangkap jpeg` mengganti PNG dengan JPEG hanya untuk pratinjau draf. Mode `--still N` menjalankan pemanasan yang sama lalu `renderFrame(N)` satu kali dan menyimpan PNG.

Mode URL untuk pratinjau dan debug (tanpa query, halaman diam menunggu renderer): `?preview`, `?frame=N`, `?props={...}`. Rinciannya ada di [api-runtime.md](api-runtime.md#mode-url).

## Aturan determinisme

Dua render dari komposisi dan props yang sama harus menghasilkan frame identik (diverifikasi oleh `bun run uji` lewat `framemd5`), untuk jumlah pekerja `--paralel` berapa pun: MP4 byte-identik dan tangkapan PNG per frame sama dengan tangkapan berurutan satu proses (diverifikasi oleh `scripts/uji-render-paralel.mjs`). Syaratnya ada di renderer: segmen berukuran tetap, `-threads` x264 dipatok, dan pemanasan 2 frame ([cli.md](cli.md#render-paralel-dan-segmen)); komposisi hanya perlu mematuhi aturan di bawah.

- Seluruh gerak hanya berasal dari `frame` atau `ctx.detik`.
- Jangan pakai `Date.now()`, `performance.now()`, `setTimeout`/`setInterval`, atau `requestAnimationFrame` untuk menggerakkan animasi.
- Jangan pakai `Math.random()`; pakai `acak(seed)`.
- Jangan pakai CSS animation atau transition; runtime menyuntikkan aturan yang mematikannya.
- Font dan gambar harus termuat sebelum frame pertama; renderer memuat eksplisit setiap `@font-face`, menunggu `document.fonts.ready` dan semua `<img>`, dan gagal bila ada gambar atau font rusak.
- Tidak ada sumber luar: semua permintaan selain `file:`, `data:`, `about:`, dan `blob:` (HTTP, HTTPS, WebSocket, `fetch`, `sendBeacon`) diblokir dan menggagalkan render dengan kode keluar `3` beserta daftar URL-nya. Aset berupa berkas lokal yang tercatat ([aset.md](aset.md)); rinciannya di [cli.md](cli.md#jaringan-dan-font).
- Cache segmen (`--cache-segmen`) bersandar pada aturan di atas: komposisi yang membaca isi berkas yang sama harus menghasilkan piksel yang sama. Masukan yang tak lewat berkas lokal atau kunci cache (mis. sumber acak, waktu, atau keadaan luar yang lolos dari aturan determinisme) membuat segmen basi dipakai; cache hanya menjamin hasil yang sama untuk masukan yang sama, bukan menutup komposisi yang tidak deterministik ([cli.md](cli.md#cache-segmen)).
- Frame klip digambar ke `<canvas>` lewat `klipGambar` (bukan `<img>`, yang kadang tertangkap dengan frame sebelumnya). Teramati di Chromium mesin pengembangan: kotak berlatar dengan `border-radius` pada posisi pecahan (mis. caption `inline-block` di tengah) menghasilkan 1-2 piksel tepi yang berubah antar-run pada render berurutan; latar bersudut siku atau posisi bulat tidak. Templat `klip-tertanam` memakai latar caption bersudut siku dan lolos uji frame identik.

## Peran repo: upstream

awvd hanya menjadi **upstream**: mesin renderer, runtime, template contoh generik, dan uji. awvd **bukan** repo proyek pengembangan atau pembuatan video. Pekerjaan proyek video berada di repo proyek terpisah, privat atau publik, dengan lisensi pilihan pemilik proyek itu. Penetapan ini adalah keputusan pemilik pada 2026-11-07.

| Masuk awvd | Tidak masuk awvd (masuk repo proyek) |
| --- | --- |
| Renderer `scripts/render.mjs` dan runtime `scripts/runtime.js` | Komposisi proyek (halaman HTML video milik proyek) |
| Uji otomatis dan CI | Props dan naskah proyek |
| Template contoh generik berdata fiktif di `templates/` untuk dokumentasi dan uji | Aset klien atau merek (logo, font, gambar, musik, footage) |
| Dokumentasi API runtime, flag CLI, dan aturan determinisme | Narasi, TTS, dan subtitle proyek |
| Perbaikan dan fitur generik yang berguna bagi semua proyek | Hasil render (MP4, PNG) dan kode khusus proyek |

```mermaid
flowchart LR
    U[awvd<br/>upstream: renderer, runtime,<br/>template generik, uji] -->|bun add, dikunci ke SHA commit| RP[Repo proyek video<br/>privat atau publik]
    RP -->|render.mjs + runtime.js| H[Hasil render<br/>out/*.mp4, tidak di-commit]
    RP -.->|perbaikan atau fitur generik<br/>lewat PR| U
```

Kode khusus proyek tidak masuk awvd. Perbaikan atau fitur yang bersifat generik, yang ditemukan saat mengerjakan proyek, dikirim balik sebagai pull request ke awvd (ikuti [AGENTS.md](../AGENTS.md) §Git dan PR).

### Memakai awvd di repo proyek

Repo proyek memasang awvd sebagai dependensi git Bun yang dikunci ke satu commit:

```bash
bun add "github:ahliweb/awvd#<sha-commit>"
```

Contoh struktur repo proyek:

```text
package.json                 dependensi awvd (dikunci ke SHA commit)
video/<nama>/index.html      komposisi proyek
video/<nama>/props.json      props dan naskah proyek (data fiktif untuk contoh)
video/<nama>/aset/           font, gambar, audio milik proyek, dicatat lisensinya
out/                         hasil render; diabaikan git (tambahkan ke .gitignore)
```

Komposisi memuat runtime dari paket yang terpasang, dengan jalur relatif dari `video/<nama>/index.html`:

```html
<script src="../../node_modules/awvd/scripts/runtime.js"></script>
```

Render dijalankan dengan renderer dari paket yang sama:

```bash
bun node_modules/awvd/scripts/render.mjs video/<nama>/index.html \
  --out out/<nama>.mp4 --props-file video/<nama>/props.json
```

Prasyarat (Bun, `ffmpeg`, Chromium untuk Playwright) sama dengan [Mulai cepat di README](../README.md#mulai-cepat); flag CLI sama dengan [cli.md](cli.md).

**Menaikkan versi.** Baca [CHANGELOG.md](../CHANGELOG.md) awvd, terutama butir yang ditandai memengaruhi repo proyek, lalu ulangi `bun add "github:ahliweb/awvd#<sha-baru>"` dan render ulang video yang terdampak. Cara lain sengaja tidak dipakai: git submodule (alurnya lebih rumit) serta menyalin atau mem-fork awvd (menyimpang dari upstream).

**Lisensi.** awvd berlisensi MIT. Pemberitahuan MIT ikut terpasang di `node_modules/awvd/LICENSE` dan wajib dipertahankan. Repo proyek boleh memakai lisensi lain, termasuk non-komersial atau source-available, hanya untuk materi orisinal proyeknya sendiri, bukan untuk kode awvd.

## Pemakaian di AhliWeb

- Proyek video AhliWeb dikerjakan di repo proyek terpisah yang memakai awvd sebagai dependensi (lihat [Peran repo: upstream](#peran-repo-upstream)), bukan di repo ini.
- AI agent AhliWeb memakai awvd lewat skill internal `video-terprogram`, yang berisi prosedur membuat dan merevisi video.
- Panduan video formal untuk pemerintah dan swasta mengikuti standar dokumen formal internal AhliWeb; awvd menjadi alat render videonya.

## Changelog

### 2026-11-08 - v1.3.0

- Alur render: cache segmen opt-in (diagram dan paragraf), dan butir aturan determinisme tentang ketergantungan cache pada determinisme komposisi (isu #46).

### 2026-11-08 - v1.2.0

- Alur render: segmen tetap dengan pekerja paralel (proses Chromium per segmen), gabung `-c copy`, tahap akhir tunggal untuk audio dan subtitle; serial = satu pekerja di jalur yang sama.
- Protokol: sesi browser bersama (`render-sesi.mjs`), pemanasan 2 frame sebelum tiap segmen dan `--still`, `--tangkap jpeg` sebagai draf.
- Aturan determinisme: keluaran identik untuk jumlah pekerja berapa pun dan syarat sisi renderer-nya.

### 2026-11-07 - v1.1.1

- Langkah penangkapan frame memuat jalur skala di bawah 1 (isu #26).

### 2026-11-07 - v1.1.0

- Protokol renderer: pemblokiran semua permintaan non-lokal (kode keluar `3`) dan pemuatan eksplisit setiap `@font-face` sebelum frame pertama ditambahkan ke diagram urutan, langkah renderer, dan aturan determinisme.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Alur render, §Konsep komposisi, §Aturan determinisme, §Peran repo: upstream, §Pemakaian di AhliWeb); isi dipertahankan.
- Menambahkan bagian Protokol window.video dan renderFrame (diagram urutan dan tabel kontrak) berdasarkan perilaku `scripts/render.mjs` dan `scripts/runtime.js`.
