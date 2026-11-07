# Flag CLI renderer

## Metadata

- Version: `v1.3.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan bun run narasi ke tabel Perintah lain.`

Referensi CLI `scripts/render.mjs` (`bun run render`). Alur di balik perintah ini ada di [arsitektur.md](arsitektur.md).

## Flag

```text
bun scripts/render.mjs <komposisi.html|URL> --out hasil.mp4 [opsi]
```

| Flag | Bawaan | Keterangan |
| --- | --- | --- |
| `--out F` | wajib | Berkas keluaran (`.mp4`, atau `.png` bersama `--still`). Folder tujuan dibuat otomatis bila belum ada. |
| `--props JSON` / `--props-file F` | `{}` | Props komposisi; pakai salah satu, harus objek JSON. |
| `--dari N` / `--sampai M` | `0` / frame terakhir | Rentang frame (inklusif). Audio dan subtitle diselaraskan ke frame awal. |
| `--skala X` | `1` | Faktor skala keluaran (min 0,1); layout tetap, raster dibuat ulang tajam. Dimensi ganjil dipotong 1 px ke genap. |
| `--crf N` | `18` | Kualitas x264, `0..51`. |
| `--audio F` | - | Trek audio, di-encode AAC-LC 48 kHz stereo 384 kbps; yang pendek diberi senyap (setelah normalisasi), yang panjang dipotong sesuai durasi video. |
| `--kenyaringan M` | `web` | Normalisasi kenyaringan audio dengan `loudnorm` dua-pass (mode `linear`); hanya berlaku bersama `--audio`, diabaikan (dengan peringatan) tanpa `--audio`. `web`: -16 LUFS, true peak -1,5 dBTP, LRA 11. `siaran`: -23 LUFS, -1 dBTP, LRA 11 (EBU R 128; toleransi R 128 ±1 LU). `mati`: tanpa normalisasi. Nilai lain: kode keluar `2`. Pass 1 mengukur segmen audio yang sama dengan yang dipakai video (offset `--dari`, dipotong sepanjang video); audio senyap total dilewati dengan peringatan. |
| `--subtitle F` | - | `.vtt` atau `.srt`, disematkan sebagai trek lunak `mov_text`. |
| `--bahasa KODE` | `ind` | Kode bahasa trek subtitle. |
| `--still N` | - | Render satu frame N sebagai PNG, bukan video. |
| `--browser PATH` | otomatis | Jalur Chromium. Tanpa ini: `PLAYWRIGHT_BROWSERS_PATH` atau `~/.cache/ms-playwright`, lalu `google-chrome`/`chromium` sistem. |
| `--izinkan-jaringan` | mati | Mematikan pemblokiran jaringan (lihat [Jaringan dan font](#jaringan-dan-font)). Hanya untuk pratinjau; mencetak peringatan, dan hasil bisa tidak deterministik. |
| `-h`, `--help` | - | Tampilkan petunjuk. |

## Laporan kenyaringan

Setelah encode berhasil dan ada audio, renderer mengukur hasil akhir dan mencetak `kenyaringan: I=.. LUFS, TP=.. dBTP (target ..)`. Ini hanya laporan; kegagalan pengukuran tidak menggagalkan render.

## Encode video

Piksel PNG sRGB rentang penuh dari browser dikonversi eksplisit ke YUV 4:2:0 matriks BT.709 rentang TV (`scale=in_range=full:out_range=tv:out_color_matrix=bt709`) dan ditandai SDR BT.709 (primaries, transfer, matriks, rentang `tv`), sehingga warna sama di semua pemutar. Profil H.264 High, progresif, B-frame 2, GOP tertutup sepanjang setengah fps, `faststart`. Audio AAC-LC 48 kHz stereo 384 kbps. Parameter ini mengikuti YouTube Help "Recommended upload encoding settings" (support.google.com/youtube/answer/1722171). Target kenyaringan mengikuti EBU R 128 (-23 LUFS, true peak maks -1 dBTP) untuk siaran dan AES TD1004/TD1008 (streaming -14 sampai -20 LUFS, dipilih -16) untuk web.

## Kode keluar

Kode keluar `0` bila berhasil, `2` untuk argumen tidak valid, `3` bila ada permintaan jaringan yang diblokir (lihat di bawah), `1` untuk galat saat render lainnya (termasuk halaman tanpa `window.video` setelah 15 detik dan `@font-face` yang gagal dimuat).

## Jaringan dan font

Render tidak boleh bergantung pada sumber luar. Secara bawaan Chromium dijalankan dengan semua permintaan selain `file:`, `data:`, `about:`, dan `blob:` dicegat dan dibatalkan: HTTP/HTTPS (gambar, CSS, skrip, font, `fetch`, `sendBeacon`, ...) lewat `context.route`, dan WebSocket lewat `routeWebSocket` (route biasa tidak menutup WebSocket). Setiap permintaan yang diblokir dicatat.

- Render **gagal dengan kode keluar `3`** dan mencetak jumlah serta daftar URL yang diblokir (metode, URL, jenis sumber; maksimal 20 baris). Pemeriksaan berjalan setelah halaman dimuat, setelah setiap frame, dan sebelum encode selesai, jadi render berhenti segera dan keluaran setengah jadi (`.mp4`) dihapus; mode `--still` tidak menulis PNG. Bila ada galat lain yang menyertai, ia dicetak sebagai "galat yang menyertai".
- **Komposisi yang dibuka lewat `http(s)://`** (mis. server pengembangan) hanya boleh meminta asalnya sendiri (host dan port yang sama, termasuk `ws:`); asal lain diblokir.
- `--izinkan-jaringan` mematikan semua pemblokiran dengan peringatan. Pakai hanya untuk pratinjau; jangan untuk render rilis.
- Aset harus berupa berkas lokal yang tercatat: lihat [aset.md](aset.md) dan `bun run aset`.
- Batasan: yang dicegat adalah permintaan yang dikirim halaman lewat jaringan browser. Pra-koneksi (`<link rel="preconnect">`, DNS prefetch) tidak lewat mekanisme pencegat dan tidak dicatat (tidak ada data halaman yang terkirim lewatnya); perilaku pencegat pada `<iframe>`/`<object>` bersumber `file:` belum diuji.

Sebelum frame pertama renderer memuat eksplisit setiap `@font-face` (`FontFace.load()` untuk semua `document.fonts`), baru menunggu `document.fonts.ready` dan semua gambar. `document.fonts.ready` saja tidak memuat face yang belum dipakai DOM awal, sehingga elemen berfont yang dibuat di dalam `render()` bisa diukur dengan font cadangan (terukur: lebar 168,6 px lalu 189,8 px). `@font-face` yang gagal dimuat (berkas hilang atau format tak didukung) menggagalkan render (kode keluar `1`, pesan `font gagal dimuat: ...`) alih-alih diam-diam memakai font cadangan. Sebagai jaring pengaman, setelah `renderFrame(n)` face yang baru ditambahkan di dalam `render()` (mis. `new FontFace(...)` + `document.fonts.add`) juga dimuat sebelum tangkapan; ukuran teks yang diukur di dalam render yang sama tetap tanggung jawab komposisi (tunggu `face.load()` di `render` async).

## Perintah lain

| Perintah | Fungsi | Dokumen |
| --- | --- | --- |
| `bun run periksa <video.mp4>` | Pemeriksaan mutu pasca-render | [pemeriksaan-mutu.md](pemeriksaan-mutu.md) |
| `bun run sop <sop.json> --out DIR` | SOP menjadi dokumen cetak dan bahan video | [sop.md](sop.md) |
| `bun run klip <sumber.json> --fps N [--draf]` | Validasi sumber (termasuk kebijakan kutipan dan gerbang GH) dan ekstraksi frame klip | [video-tertanam-audio.md](video-tertanam-audio.md) |
| `bun run audio <rencana.json> --fps N --out F` | Perakit timeline audio | [video-tertanam-audio.md](video-tertanam-audio.md) |
| `bun run narasi <naskah.json> --out DIR` | Naskah narasi dan WAV beku menjadi cue caption VTT/SRT, stempel kata, dan rencana audio | [narasi-caption.md](narasi-caption.md) |
| `bun run pelajari <video-lokal> --sumber-sah CARA` | Statistik gaya dari video lokal yang sah dimiliki (ritme potongan, palet, kenyaringan, pola); laporan JSON/Markdown | [pelajari-reaction.md](pelajari-reaction.md) |
| `bun run kutipan -- periksa\|hash <sumber.json>` | Periksa kebijakan kutipan wajar; hitung hash gerbang hukum GH | [pelajari-reaction.md](pelajari-reaction.md#bun-run-kutipan) |
| `bun run konsep -- <subperintah>` | Konsep video: jenis, alur, brief, persetujuan | [konsep-jenis-alur.md](konsep-jenis-alur.md) |
| `bun run aset tambah\|impor\|periksa` | Aset (gambar, logo, ikon, SVG, font, audio): manifest `aset.json`, validasi, pembersih SVG, konversi sRGB, atribusi | [aset.md](aset.md) |
| `bun run uji` | Seluruh uji otomatis | [README](../README.md#perintah-utama) |

## Changelog

### 2026-11-07 - v1.3.0

- Tabel Perintah lain: `bun run narasi`; `render.mjs` tidak berubah.

### 2026-11-07 - v1.2.0

- Tabel Perintah lain: `bun run pelajari`, `bun run kutipan`, dan flag `--draf` pada `bun run klip`; `render.mjs` tidak berubah.

### 2026-11-07 - v1.1.0

- Menambahkan `--izinkan-jaringan`, kode keluar `3`, dan bagian Jaringan dan font: pemblokiran semua permintaan non-lokal (HTTP, HTTPS, WebSocket) secara bawaan, pemuatan eksplisit setiap `@font-face` sebelum frame pertama, dan galat jelas untuk font yang gagal dimuat.
- Menambahkan `bun run aset` ke tabel Perintah lain.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Flag CLI); isi dipertahankan.
- Menambahkan tabel Perintah lain sebagai penunjuk ke dokumen perintah masing-masing.
