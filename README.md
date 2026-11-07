# awvd — AhliWeb Video Dev

## Metadata

- Version: `v2.1.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan bun run pelajari dan kebijakan kutipan wajar (docs/pelajari-reaction.md, templat reaction, uji pelajari) ke perintah utama, indeks dokumentasi, dan struktur repo, beserta peringatan hukum tentang video pihak ketiga.`

Video MP4 dari kode web (HTML/CSS/JS) yang digambar per nomor frame, untuk dibuat dan dirawat oleh manusia maupun AI agent. awvd adalah renderer sendiri berbasis Chromium headless dan ffmpeg: sebuah komposisi adalah halaman web yang menggambar ulang dirinya untuk setiap nomor frame, sehingga hasilnya deterministik dan bisa ditinjau sebagai kode.

## Klasifikasi repo

| Atribut | Nilai |
| --- | --- |
| Status | `active` |
| Kelas repo | `internal` |
| Domain operasional | `internal-ops` |
| Tingkat risiko | `low` |
| Source of truth | `primary` untuk kode renderer awvd |
| Owner operasional | AhliWeb (akun GitHub `ahliweb`) |
| Risiko dan batasan | Tidak menyentuh production dan tidak di-deploy. Repo publik: tanpa secret, data nyata, aset tanpa lisensi jelas, atau rujukan ke repo internal yang privat. Bukan tempat proyek video: pekerjaan proyek ada di repo proyek terpisah (lihat Peran repo: upstream). |

Klasifikasi ditetapkan pemilik pada 2026-11-07.

## Peran repo: upstream

awvd hanya menjadi **upstream**: mesin renderer, runtime, template contoh generik berdata fiktif, uji, dan dokumentasinya. Komposisi proyek, props dan naskah, aset klien atau merek, narasi, dan hasil render berada di repo proyek terpisah yang memasang awvd sebagai dependensi git terkunci SHA commit. Perbaikan generik dari proyek masuk lewat pull request. Penjelasan lengkap, tabel batas isi, dan cara memakai awvd di repo proyek: [docs/arsitektur.md](docs/arsitektur.md#peran-repo-upstream).

## Mulai cepat

Prasyarat: Linux, [Bun](https://bun.sh), `ffmpeg` (termasuk `ffprobe`), dan Chromium untuk Playwright. Tidak ada Node.js yang dibutuhkan.

```bash
bun install
bunx playwright-core install chromium-headless-shell   # sekali saja
bun run render templates/contoh-dasar/index.html --out out/contoh.mp4 \
  --props-file templates/contoh-dasar/props.json
```

Hasil contoh: 1280x720, 30 fps, 180 frame (6 detik). Folder `out/` diabaikan git.

Pratinjau di browser (putar real-time, slider, tombol putar/jeda), buka berkas komposisi dengan query `?preview`:

```text
file:///jalur/ke/awvd/templates/contoh-dasar/index.html?preview
```

Server statis apa pun juga bisa dipakai. Satu frame saja: `?frame=60`. Props pratinjau: `?props={"judul":"Halo"}`.

## Perintah utama

- `bun run render <komposisi> --out ...`: render video atau still ([docs/cli.md](docs/cli.md)).
- `bun run periksa <video.mp4>`: pemeriksaan mutu ([docs/pemeriksaan-mutu.md](docs/pemeriksaan-mutu.md)).
- `bun run sop <sop.json> --out DIR`: SOP menjadi dokumen dan bahan video ([docs/sop.md](docs/sop.md)).
- `bun run klip <sumber.json> --fps N` dan `bun run audio <rencana.json> --fps N --out ...`: video di dalam video dan timeline audio ([docs/video-tertanam-audio.md](docs/video-tertanam-audio.md)).
- `bun run konsep -- <subperintah>`: konsep video, pilihan jenis video dan alur produksi ([docs/konsep-jenis-alur.md](docs/konsep-jenis-alur.md)).
- `bun run pelajari <video-lokal> --sumber-sah CARA` dan `bun run kutipan -- periksa|hash <sumber.json>`: statistik gaya dari video lokal yang sah dimiliki, dan kebijakan kutipan wajar untuk video reaction ([docs/pelajari-reaction.md](docs/pelajari-reaction.md)).
- `bun run uji`: uji unit runtime, uji periksa, uji SOP, uji klip, uji konsep, uji pelajari (statistik gaya, kebijakan kutipan, templat reaction), lalu sembilan uji renderer (properti video, determinisme, still, rentang, audio, subtitle, skala, galat, kenyaringan siaran); sekitar dua setengah menit. `bun run uji -- --simpan DIR` juga menyalin PNG still hasil uji ke `DIR`; CI memakainya untuk artefak `frame-contoh`.

## Dokumentasi

Dokumentasi rinci ada di folder [`docs/`](docs/README.md); tabel di bawah menyalin indeksnya. Versi adalah versi dokumen, bukan versi software.

| Dokumen | Isi | Versi |
| --- | --- | --- |
| [docs/README.md](docs/README.md) | Indeks dokumen, peta dokumen, aturan menambah dokumen | `v1.1.0` |
| [docs/arsitektur.md](docs/arsitektur.md) | Alur render, konsep komposisi, protokol `window.video`, determinisme, peran upstream | `v1.0.0` |
| [docs/api-runtime.md](docs/api-runtime.md) | Referensi API `scripts/runtime.js` | `v1.0.0` |
| [docs/cli.md](docs/cli.md) | Flag `render.mjs`, kode keluar, encode, kenyaringan | `v1.1.0` |
| [docs/pemeriksaan-mutu.md](docs/pemeriksaan-mutu.md) | `bun run periksa`: pemeriksaan, ambang, kilatan | `v1.0.0` |
| [docs/konsep-jenis-alur.md](docs/konsep-jenis-alur.md) | `bun run konsep`: 13 jenis video, 5 alur, tingkat bukti | `v1.0.0` |
| [docs/sop.md](docs/sop.md) | SOP sebagai dokumen cetak dan bahan video | `v1.0.0` |
| [docs/video-tertanam-audio.md](docs/video-tertanam-audio.md) | Klip tertanam dan timeline audio | `v1.1.0` |
| [docs/pelajari-reaction.md](docs/pelajari-reaction.md) | `bun run pelajari`, kebijakan kutipan wajar, gerbang hukum GH, templat reaction | `v1.0.0` |
| [docs/aksesibilitas.md](docs/aksesibilitas.md) | Subtitle, kontras, kilatan, peta fitur aksesibilitas | `v1.0.0` |
| [docs/batasan.md](docs/batasan.md) | Batasan yang diketahui | `v1.1.0` |
| [docs/lisensi-kepatuhan.md](docs/lisensi-kepatuhan.md) | Lisensi, pihak ketiga, tanggung jawab aset, video pihak ketiga | `v1.1.0` |
| [docs/pedoman-produksi.md](docs/pedoman-produksi.md) | Pedoman produksi berbasis riset dan checklist | `v1.0.0` |
| [docs/log-keputusan.md](docs/log-keputusan.md) | Log keputusan awvd (KP-001 dst.) | `v1.1.0` |
| [AGENTS.md](AGENTS.md) | Aturan kerja AI agent, git, rilis, dokumentasi | `v1.6.0` |
| [CHANGELOG.md](CHANGELOG.md) | Riwayat perubahan software | - |

## Struktur repo

```text
scripts/render.mjs      CLI renderer (Chromium + ffmpeg)
scripts/runtime.js      runtime komposisi (defineVideo, interpolasi, helper)
scripts/periksa.mjs     alat QC pasca-render
scripts/sop.mjs         generator SOP (dokumen cetak + bahan video); sop-alir.js: perutean garis alir
scripts/klip.mjs        validasi manifest sumber dan ekstraksi frame klip
scripts/audio.mjs       perakit timeline audio
scripts/konsep.mjs      konsep video: jenis, alur, brief, persetujuan
scripts/pelajari.mjs    statistik gaya dari video lokal (ritme potongan, palet, kenyaringan)
scripts/kutipan.mjs     kebijakan kutipan wajar dan gerbang hukum GH (dipanggil klip.mjs dan audio.mjs)
scripts/preset-jenis.js salinan preset untuk browser (DIHASILKAN dari data/jenis-video.json)
scripts/uji*.mjs        uji otomatis (runtime, periksa, sop, klip, konsep, pelajari, renderer)
data/                   jenis-video.json (13 jenis) dan alur-produksi.json (5 alur)
templates/<nama>/       komposisi contoh generik + ASET.md (catatan aset pihak ketiga):
                        contoh-dasar, sop, klip-tertanam, konsep-contoh, reaction
docs/                   dokumentasi rinci (indeks: docs/README.md)
.github/                workflow CI uji dan template pull request
.claude/agents/         subagent pelaksana (kompleks, sederhana) untuk orchestrator
AGENTS.md  CLAUDE.md    aturan kerja AI agent (CLAUDE.md hanya merujuk AGENTS.md)
CHANGELOG.md  LICENSE   riwayat software dan lisensi MIT
.cache/ out/            cache klip dan hasil render; diabaikan git
```

## Kontribusi

Setiap perubahan lewat branch dan pull request (`<jenis>/<ringkas>`), dan merge hanya setelah semua check (`uji`, GitGuardian) berstatus SUCCESS. Perubahan konsep atau fitur wajib membawa pembaruan dokumen di PR yang sama. Aturan lengkapnya ada di [AGENTS.md](AGENTS.md): §Git dan PR untuk alur git, dan §Dokumentasi untuk peta "perubahan apa memperbarui dokumen mana".

Ada dua jenis versi yang berbeda. Versi dokumen (`Version` di blok Metadata README, AGENTS.md, dan dokumen di `docs/`) menandai revisi dokumen. Versi software ada di `package.json` dan `CHANGELOG.md`. README `v2.0.0` tidak berarti awvd `2.0.0`.

## Rilis

Belum ada rilis bertag. Versi paket `0.1.0`, dan semua perubahan dicatat di [CHANGELOG.md](CHANGELOG.md) bagian `[Unreleased]`. awvd tidak di-deploy ke server mana pun; ia dipakai lokal dan di CI. Prosedur rilis bila kelak diputuskan pemilik ada di AGENTS.md §Rilis dan Deployment.

## Lisensi

awvd berlisensi [MIT](LICENSE). Kode ditulis sendiri tanpa menyalin Remotion maupun repositori skill-nya; pihak ketiga dan tanggung jawab pengguna atas aset (font, musik, gambar, footage, klip, suara TTS) ada di [docs/lisensi-kepatuhan.md](docs/lisensi-kepatuhan.md).

**Peringatan hukum: video pihak ketiga.** awvd tidak menyediakan dan tidak akan menyediakan pengunduh atau perekam video platform (YouTube, TikTok, Facebook, Instagram, X, dan sejenisnya); fitur sumber hanya menerima berkas yang sah Anda miliki, dengan manifest dan atribusi. Kutipan untuk video reaction dan ulasan diperiksa terhadap kebijakan internal yang terukur dan gerbang tinjauan hukum, bukan jaminan kutipan sah. Dokumentasi ini bukan nasihat hukum; rincian di [docs/pelajari-reaction.md](docs/pelajari-reaction.md).

## Changelog

### 2026-11-07 - v2.1.0

- Perintah utama, indeks dokumentasi (versi dokumen yang berubah dan baris `docs/pelajari-reaction.md`), dan struktur repo memuat `bun run pelajari`, kebijakan kutipan wajar (`scripts/kutipan.mjs`), templat `reaction`, dan uji pelajari. Peringatan hukum tentang video pihak ketiga ada di [docs/lisensi-kepatuhan.md](docs/lisensi-kepatuhan.md#video-pihak-ketiga-dan-kutipan-wajar).

### 2026-11-07 - v2.0.0

- Struktur dokumentasi berubah (major): isi rinci README dipindah ke folder `docs/` tanpa mengurangi informasi, dan README menjadi ringkasan dengan indeks dokumentasi. Pemetaan: §Alur render, §Konsep komposisi, §Aturan determinisme, §Peran repo: upstream (rinci), dan §Pemakaian di AhliWeb ke `docs/arsitektur.md`; §Referensi API runtime ke `docs/api-runtime.md`; §Flag CLI ke `docs/cli.md`; §Pemeriksaan mutu ke `docs/pemeriksaan-mutu.md`; §Konsep ke `docs/konsep-jenis-alur.md`; §SOP sebagai bahan video ke `docs/sop.md`; §Video di dalam video dan §Timeline audio ke `docs/video-tertanam-audio.md`; §Aksesibilitas ke `docs/aksesibilitas.md`; §Batasan yang diketahui ke `docs/batasan.md`; §Lisensi dan Kepatuhan ke `docs/lisensi-kepatuhan.md`.
- Dokumen baru: `docs/pedoman-produksi.md`, `docs/log-keputusan.md`, dan `docs/README.md` (indeks dan peta dokumen).
- §Struktur repo dirapikan (daftar ganda dihapus) dan §Perintah utama dipisah; rujukan "§..." di entri lama di bawah merujuk ke struktur README sebelum v2.0.0.

### 2026-11-07 - v1.10.0

- Menambahkan §Konsep: jenis video dan alur produksi: subperintah `bun run konsep` (`baru`, `daftar`, `periksa`, `brief`, `setuju`, `preset`, `sinkron-preset`), skema `konsep.json`, tabel 13 jenis dan 5 alur, diagram alur konsep sampai final, penjelasan tingkat bukti (banyak nilai adalah keputusan desain), konflik pedoman TikTok dan lint caption, preset di komposisi, dan batasan.
- §Referensi API runtime: menambahkan `presetJenis(nama)` (data dimuat lewat `scripts/preset-jenis.js`, dihasilkan dari `data/jenis-video.json`).
- §Pemeriksaan mutu: menambahkan flag `--konsep` (ambang durasi maks, cps, kenyaringan dari preset; pemeriksaan rasio; info burn-in).
- §Struktur repo: mencantumkan `scripts/konsep.mjs`, `scripts/preset-jenis.js`, `scripts/uji-konsep.mjs`, `data/`, dan `templates/konsep-contoh/`; `bun run uji` kini juga menjalankan uji konsep.

### 2026-11-07 - v1.9.0

- Menambahkan bagian Video di dalam video (aturan sumber dan lisensi, manifest `sumber.json`, `scripts/klip.mjs`, cache, warna, memakai klip di komposisi, templat `klip-tertanam`, batasan) dan Timeline audio (rencana audio, mode klip dan validasi pemegang suara, gain dan perakitan, narasi dan TTS).
- §Referensi API runtime: `gambarKosong`, `indeksFrameKlip`, `jalurFrameKlip`, `klipGambar`, `kreditKlip`, `angka`/`persen`/`rupiah`, dan `kenBurns`.
- §Aturan determinisme, §Batasan yang diketahui (butir `<video>` diganti rujukan ke fitur klip tertanam), §Struktur repo, dan §Tanggung jawab pengguna atas aset disesuaikan.

### 2026-11-07 - v1.8.0

- Menambahkan bagian SOP sebagai bahan video: alur Mermaid, perintah dan flag `scripts/sop.mjs`, skema `sop.json`, aturan validasi (termasuk pemindai data pribadi), isi dokumen cetak (lima simbol, segilima penghubung antar halaman, PDF bertag tanpa klaim PDF/UA), video dan caption (jadwal, segmen, narasi otomatis, cabang Ya/Tidak sebagai inferensi), dan daftar keputusan desain.
- §Struktur repo: `scripts/sop.mjs`, `scripts/sop-alir.js`, `scripts/uji-sop.mjs`, `templates/sop/`; `bun run uji` kini menjalankan `uji-sop.mjs` sebelum uji renderer.

### 2026-11-07 - v1.7.0

- Menambahkan §Pemeriksaan mutu (bun run periksa): flag, kode keluar, tabel pemeriksaan (encoding, kenyaringan, kilatan fotosensitif, subtitle, durasi) dengan ambang dan sumbernya, aproksimasi area uji kilatan, serta batasannya (penyaringan konservatif, bukan sertifikasi).
- §Struktur repo: mencantumkan `scripts/periksa.mjs`, `scripts/uji-periksa.mjs`, dan perintah `bun run periksa`; `bun run uji` kini juga menjalankan uji alat QC.

### 2026-11-07 - v1.6.0

- §Referensi API runtime: menambahkan `areaAman`, `ms` dan `durasi`, preset `easing` (standar, percepat, perlambat, ditekankanMasuk, ditekankanKeluar), `luminansRelatif`/`kontras`/`pilihTeksKontras`, `durasiBaca`, `pecahBaris`, `captionAktif`/`parseVtt`/`parseSrt`, dan `berjenjang`, masing-masing dengan sumbernya (EBU R 95, Material Design 3, NN/g, WCAG 2.2 SC 1.4.3, Netflix Timed Text Style Guide).
- §Struktur repo: mencantumkan `scripts/uji-runtime.mjs` dan `bun run uji:runtime`; `bun run uji` kini menjalankan uji unit runtime sebelum uji renderer.

### 2026-11-07 - v1.5.0

- §Flag CLI: menambahkan `--kenyaringan web|siaran|mati` dan laporan kenyaringan; `--audio` kini AAC-LC 48 kHz 384k; catatan encode BT.709, H.264 High, GOP tertutup beserta rujukan YouTube Help, EBU R 128, dan AES.
- §Alur render, §Batasan yang diketahui, dan §Struktur repo (sembilan uji) disesuaikan.

### 2026-11-07 - v1.4.1

- §Flag CLI: `--out` membuat folder tujuan bila belum ada.

### 2026-11-07 - v1.4.0

- Menambahkan bagian Peran repo: upstream: awvd hanya upstream, tabel batas isi awvd dan repo proyek, diagram hubungan dengan repo proyek, dan subbagian Memakai awvd di repo proyek (dependensi git terkunci SHA, struktur repo proyek, naik versi, lisensi).
- Risiko dan batasan di Klasifikasi repo dan bagian Pemakaian di AhliWeb disesuaikan.

### 2026-11-07 - v1.3.1

- Klasifikasi repo ditetapkan pemilik; menambahkan tingkat risiko.

### 2026-11-07 - v1.3.0

- Menambahkan bagian Klasifikasi repo (kelas dan domain masih usulan) dan Rilis.
- Struktur repo mencantumkan `.claude/agents/`.
- Mengganti "Hubungan dengan repo lain" menjadi "Pemakaian di AhliWeb" dan menghapus nama, path, serta tautan repo pedoman internal yang privat.

### 2026-11-07 - v1.2.0

- Menambahkan bagian Kontribusi dan dokumentasi (rujukan ke AGENTS.md §Dokumentasi, pemisahan versi dokumen dan software).
- Mendokumentasikan opsi `--simpan DIR` pada `bun run uji`.
- Struktur repo mencantumkan `templates/<nama>/ASET.md` dan template PR.

### 2026-11-07 - v1.1.0

- Menambahkan bagian Lisensi dan Kepatuhan menggantikan bagian Lisensi singkat.

### 2026-11-07 - v1.0.0

- README lengkap pertama: alur render, mulai cepat, konsep komposisi, API runtime, flag CLI, determinisme, aksesibilitas, batasan, struktur repo, dan hubungan dengan repo lain.
