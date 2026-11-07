# awvd — AhliWeb Video Dev

## Metadata

- Version: `v2.13.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan bun run timeline periksa (validator timeline.json), docs/timeline.md, templat timeline-contoh, dan uji timeline di bun run uji; indeks dokumentasi dan struktur repo diperbarui. Sebelumnya: adaptor TTS lokal opsional di bun run narasi.`

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

Prasyarat: Linux, [Bun](https://bun.sh), `ffmpeg` (termasuk `ffprobe`; `libvidstab` opsional untuk stabilisasi klip, cadangannya `deshake`), dan Chromium untuk Playwright. Tidak ada Node.js yang dibutuhkan.

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
- `bun run klip <sumber.json> --fps N` dan `bun run audio <rencana.json> --fps N --out ...`: video di dalam video dan timeline audio ([docs/video-tertanam-audio.md](docs/video-tertanam-audio.md)). Klip dapat diberi LUT `.cube` dan koreksi warna saat ekstraksi lewat `klip[].efek` ([docs/olah-klip.md](docs/olah-klip.md)).
- `bun run konsep -- <subperintah>`: konsep video, pilihan jenis video dan alur produksi, termasuk preset transisi di brief dan profil gerak `kurangiGerak` dari `konsep.json` lewat props ([docs/konsep-jenis-alur.md](docs/konsep-jenis-alur.md)).
- `bun run klip <sumber.json> --fps N` dan `bun run audio <rencana.json> --fps N --out ...`: video di dalam video dan timeline audio ([docs/video-tertanam-audio.md](docs/video-tertanam-audio.md)). Klip dapat diberi LUT `.cube` dan koreksi warna saat ekstraksi lewat `klip[].efek` ([docs/olah-klip.md](docs/olah-klip.md)). Narasi dan klip bersuara dapat diberi peredam bising (`bersih`: `afftdn`, atau `arnndn` dengan model milik pengguna) dan pengubah nada/tempo (`suara`) di rencana audio ([docs/video-tertanam-audio.md](docs/video-tertanam-audio.md#olah-suara-per-trek)).
- `bun run klip <sumber.json> --fps N` dan `bun run audio <rencana.json> --fps N --out ...`: video di dalam video dan timeline audio ([docs/video-tertanam-audio.md](docs/video-tertanam-audio.md)). Klip dapat distabilkan, di-chroma-key (PNG beralfa), diberi LUT `.cube` dan koreksi warna saat ekstraksi lewat `klip[].efek` ([docs/olah-klip.md](docs/olah-klip.md)).
- `bun run konsep -- <subperintah>`: konsep video, pilihan jenis video dan alur produksi ([docs/konsep-jenis-alur.md](docs/konsep-jenis-alur.md)).
- `bun run aset tambah|impor|periksa`: aset (gambar, logo, ikon, SVG, font, audio) dengan manifest `aset.json`, validasi lisensi, pembersih SVG, dan atribusi ([docs/aset.md](docs/aset.md)); komposisi memakai aset lewat helper runtime `logo`, `ikon`, `asetGambar`, `kreditAset`, dan `pasangFont` ([docs/api-runtime.md](docs/api-runtime.md)). Render memblokir semua permintaan jaringan non-lokal (kode keluar 3; [docs/cli.md](docs/cli.md#jaringan-dan-font)).
- Transisi dan animasi elemen: muat `scripts/transisi.js` setelah `runtime.js` (`window.Transisi`); galeri semua jenis di `templates/transisi-galeri/` ([docs/transisi-animasi.md](docs/transisi-animasi.md)).
- `bun run pelajari <video-lokal> --sumber-sah CARA` dan `bun run kutipan -- periksa|hash <sumber.json>`: statistik gaya dari video lokal yang sah dimiliki, dan kebijakan kutipan wajar untuk video reaction ([docs/pelajari-reaction.md](docs/pelajari-reaction.md)).
- `bun run narasi <naskah.json> --out DIR`: naskah narasi dan WAV beku menjadi cue caption VTT/SRT yang sinkron (estimasi berjangkar jeda, lint cps profil audiens), stempel kata, dan `rencana-audio.json` untuk `bun run audio` ([docs/narasi-caption.md](docs/narasi-caption.md)).
- `bun run uji`: uji unit runtime, uji periksa, uji SOP, uji klip, uji konsep, uji visual (helper warna dan ukuran teks, data audiens), uji transisi, uji aset (`bun run uji:aset`), uji pelajari (statistik gaya, kebijakan kutipan, templat reaction), uji audio (`bun run uji:audio`: SNR peredam bising, nada dan tempo, kenyaringan -16 LUFS, determinisme), uji narasi (`bun run uji:narasi`: skema naskah, estimasi berjangkar jeda, cue, templat narasi-contoh), lalu sembilan uji renderer (properti video, determinisme, still, rentang, audio, subtitle, skala, galat, kenyaringan siaran); sekitar tiga menit. `bun run uji -- --simpan DIR` juga menyalin PNG still hasil uji ke `DIR`; CI memakainya untuk artefak `frame-contoh`.
- Mode dan posisi caption di komposisi: helper runtime `rencanaCaption`, `keadaanCaption`, dan `captionHtml` menampilkan cue VTT/SRT dan `kata.json` dengan mode `pop-on`, `roll-up`, `paint-on`, `sorot-kata`, `satu-kata` dan posisi `bawah`, `atas`, `auto` (menghindari zona penting), `dekat-penutur`, di dalam area aman 16:9 dan 9:16 dengan kontras terjaga; demo di `templates/narasi-contoh/` ([docs/narasi-caption.md](docs/narasi-caption.md#mode-dan-posisi-caption), [docs/api-runtime.md](docs/api-runtime.md)).
- `bun run uji`: uji unit runtime, uji periksa, uji SOP, uji klip, uji konsep, uji visual (helper warna dan ukuran teks, data audiens), uji transisi, uji aset (`bun run uji:aset`), uji pelajari (statistik gaya, kebijakan kutipan, templat reaction), uji narasi (`bun run uji:narasi`: skema naskah, estimasi berjangkar jeda, cue, templat narasi-contoh), uji caption (`bun run uji:caption`: lima mode, posisi dan zona, area aman 16:9 dan 9:16, kontras, DOM di Chromium), uji timeline (`bun run uji:timeline`: skema, aturan R01-R17, manifest nyata, kode keluar, waktu klip), lalu sepuluh uji renderer (properti video, determinisme, still, rentang, audio, subtitle, skala, galat, kenyaringan siaran, determinisme `--skala` 0.5 dan 0.75); sekitar tiga menit. `bun run uji -- --simpan DIR` juga menyalin PNG still hasil uji ke `DIR`; CI memakainya untuk artefak `frame-contoh`.
- `bun run uji`: uji unit runtime, uji periksa, uji SOP, uji klip, uji konsep, uji visual (helper warna dan ukuran teks, data audiens), uji transisi, uji aset (`bun run uji:aset`), uji pelajari (statistik gaya, kebijakan kutipan, templat reaction), lalu sepuluh uji renderer (properti video, determinisme, still, rentang, audio, subtitle, skala, galat, kenyaringan siaran, determinisme `--skala` 0.5 dan 0.75); sekitar tiga menit. `bun run uji -- --simpan DIR` juga menyalin PNG still hasil uji ke `DIR`; CI memakainya untuk artefak `frame-contoh`.
- `bun run narasi <naskah.json> --out DIR`: naskah narasi dan WAV beku menjadi cue caption VTT/SRT yang sinkron (estimasi berjangkar jeda, lint cps profil audiens), stempel kata, dan `rencana-audio.json` untuk `bun run audio`; mesin suara opsional `sherpa-onnx` (TTS lokal: Supertonic untuk Indonesia, Kokoro untuk Inggris; tidak dibundel, WAV dibekukan di cache berhash, label suara sintetis wajib, konten medis diperingatkan atau ditolak) ([docs/narasi-caption.md](docs/narasi-caption.md#tts-lokal-sherpa-onnx)).
- `bun run timeline periksa [timeline.json]`: validator `timeline.json` (skema 1) fail-closed sebelum Chromium: skema, rujukan ke `aset.json` dan `sumber.json` nyata, tumpang tindih dan transisi, waktu klip, audio, atribusi, dan kebijakan kutipan; kode keluar 2 untuk timeline tidak valid. Render dari timeline menyusul ([docs/timeline.md](docs/timeline.md)).
- `bun run uji`: uji unit runtime, uji periksa, uji SOP, uji klip, uji konsep, uji visual (helper warna dan ukuran teks, data audiens), uji transisi, uji aset (`bun run uji:aset`), uji pelajari (statistik gaya, kebijakan kutipan, templat reaction), uji narasi (`bun run uji:narasi`: skema naskah, estimasi berjangkar jeda, cue, templat narasi-contoh), lalu sembilan uji renderer (properti video, determinisme, still, rentang, audio, subtitle, skala, galat, kenyaringan siaran); sekitar tiga menit. `bun run uji -- --simpan DIR` juga menyalin PNG still hasil uji ke `DIR`; CI memakainya untuk artefak `frame-contoh`.

## Dokumentasi

Dokumentasi rinci ada di folder [`docs/`](docs/README.md); tabel di bawah menyalin indeksnya. Versi adalah versi dokumen, bukan versi software.

| Dokumen | Isi | Versi |
| --- | --- | --- |
| [docs/README.md](docs/README.md) | Indeks dokumen, peta dokumen, aturan menambah dokumen | `v1.12.0` |
| [docs/arsitektur.md](docs/arsitektur.md) | Alur render, konsep komposisi, protokol `window.video`, pemblokiran jaringan, determinisme, peran upstream | `v1.1.1` |
| [docs/api-runtime.md](docs/api-runtime.md) | Referensi API `scripts/runtime.js` | `v1.4.0` |
| [docs/cli.md](docs/cli.md) | Flag `render.mjs`, kode keluar, jaringan dan font, encode, kenyaringan | `v1.4.0` |
| [docs/aset.md](docs/aset.md) | `bun run aset`: manifest `aset.json`, matriks lisensi, SVG, resolusi, sRGB, atribusi, helper runtime | `v1.1.0` |
| [docs/pemeriksaan-mutu.md](docs/pemeriksaan-mutu.md) | `bun run periksa`: pemeriksaan, ambang, kilatan | `v1.0.1` |
| [docs/konsep-jenis-alur.md](docs/konsep-jenis-alur.md) | `bun run konsep`: 13 jenis video, 5 alur, tingkat bukti, profil audiens | `v1.2.0` |
| [docs/sop.md](docs/sop.md) | SOP sebagai dokumen cetak dan bahan video | `v1.0.1` |
| [docs/video-tertanam-audio.md](docs/video-tertanam-audio.md) | Klip tertanam dan timeline audio | `v1.6.0` |
| [docs/olah-klip.md](docs/olah-klip.md) | Efek klip saat ekstraksi: LUT `.cube`, warna, keseimbangan, kunci cache | `v1.2.0` |
| [docs/pelajari-reaction.md](docs/pelajari-reaction.md) | `bun run pelajari`, kebijakan kutipan wajar, gerbang hukum GH, templat reaction | `v1.0.0` |
| [docs/visual-audiens.md](docs/visual-audiens.md) | Profil audiens, ukuran teks, buta warna, ketajaman, efek dekoratif | `v1.0.0` |
| [docs/transisi-animasi.md](docs/transisi-animasi.md) | Modul `scripts/transisi.js`: 21 transisi, 13 animasi elemen, `kurangiGerak`, biaya kompresi | `v1.1.0` |
| [docs/aksesibilitas.md](docs/aksesibilitas.md) | Subtitle, kontras, kilatan, gerak, teks alternatif aset, peta fitur aksesibilitas | `v1.6.0` |
| [docs/batasan.md](docs/batasan.md) | Batasan yang diketahui | `v1.6.0` |
| [docs/lisensi-kepatuhan.md](docs/lisensi-kepatuhan.md) | Lisensi, pihak ketiga, model TTS dan OpenRAIL-M, tanggung jawab aset, matriks lisensi aset, video pihak ketiga | `v1.4.0` |
| [docs/pedoman-produksi.md](docs/pedoman-produksi.md) | Pedoman produksi berbasis riset dan checklist | `v1.1.0` |
| [docs/roadmap.md](docs/roadmap.md) | Roadmap fase F1–F6, paritas fitur, label dan milestone | `v1.7.0` |
| [docs/log-keputusan.md](docs/log-keputusan.md) | Log keputusan awvd (KP-001 dst.) | `v1.13.0` |
| [docs/narasi-caption.md](docs/narasi-caption.md) | `bun run narasi`: `naskah.json`, estimasi berjangkar jeda, cue VTT/SRT dengan lint cps, rencana audio, mode dan posisi caption | `v1.2.0` |
| [docs/timeline.md](docs/timeline.md) | `timeline.json` (skema 1) dan validator `bun run timeline periksa`: aturan, waktu klip, kutipan turunan; render menyusul | `v1.0.0` |
| [AGENTS.md](AGENTS.md) | Aturan kerja AI agent, git, rilis, dokumentasi | `v1.9.0` |
| [CHANGELOG.md](CHANGELOG.md) | Riwayat perubahan software | - |

## Struktur repo

```text
scripts/render.mjs      CLI renderer (Chromium + ffmpeg)
scripts/runtime.js      runtime komposisi (defineVideo, interpolasi, helper)
scripts/periksa.mjs     alat QC pasca-render
scripts/sop.mjs         generator SOP (dokumen cetak + bahan video); sop-alir.js: perutean garis alir
scripts/klip.mjs        validasi manifest sumber dan ekstraksi frame klip (dengan efek: stabil, kunciWarna, LUT .cube, warna, keseimbangan)
scripts/audio.mjs       perakit timeline audio
scripts/konsep.mjs      konsep video: jenis, alur, brief, persetujuan
scripts/aset.mjs        aset: tambah, impor, periksa (manifest aset.json); aset-lib.js: logika bersama,
                        aset-svg.js: pemeriksa dan pembersih SVG berdaftar-izin, browser.js: cari Chromium
scripts/pelajari.mjs    statistik gaya dari video lokal (ritme potongan, palet, kenyaringan)
scripts/kutipan.mjs     kebijakan kutipan wajar dan gerbang hukum GH (dipanggil klip.mjs dan audio.mjs)
scripts/narasi.mjs      naskah.json -> cue caption VTT/SRT, stempel kata, rencana audio; narasi-selaras.mjs:
                        estimasi timing berjangkar jeda, narasi-cue.mjs: pengelompokan cue, lint, VTT/SRT,
                        narasi-caption.mjs: skema mode, posisi, zona, dan jangkar penutur
                        narasi-tts.mjs: adaptor TTS lokal opsional (sherpa-onnx, cache berhash, label sintetis),
                        normalisasi-id.mjs: normalisasi teks Indonesia untuk TTS
scripts/timeline.mjs    validator timeline.json (skema 1, fail-closed): bun run timeline periksa
scripts/preset-jenis.js salinan preset untuk browser (DIHASILKAN dari data/jenis-video.json)
data/                   jenis-video.json (13 jenis), alur-produksi.json (5 alur), audiens.json (5 profil audiens),
                        suara.json (katalog mesin dan 15 karakter suara TTS), skema-timeline.json (JSON Schema timeline.json)
scripts/transisi.js     modul transisi dan animasi elemen (window.Transisi), dimuat setelah runtime.js
scripts/uji*.mjs        uji otomatis (runtime, periksa, sop, klip, audio, konsep, visual, transisi, aset, pelajari, narasi, renderer)
scripts/uji*.mjs        uji otomatis (runtime, periksa, sop, klip, konsep, visual, transisi, aset, pelajari, narasi, caption, timeline, renderer)
templates/<nama>/       komposisi contoh generik + ASET.md (catatan aset pihak ketiga):
                        contoh-dasar, sop, klip-tertanam (dengan LUT contoh di lut/), konsep-contoh, transisi-galeri, aset-contoh, reaction,
                        narasi-contoh (demo mode dan posisi caption: index.html, buat-props.mjs),
                        timeline-contoh (timeline.json contoh, aset.json dan sumber.json kecil, media buatan sendiri)
docs/                   dokumentasi rinci (indeks: docs/README.md)
.github/                workflow CI uji dan template pull request
.claude/agents/         subagent pelaksana (kompleks, sederhana) untuk orchestrator
AGENTS.md  CLAUDE.md    aturan kerja AI agent (CLAUDE.md hanya merujuk AGENTS.md)
CHANGELOG.md  LICENSE   riwayat software dan lisensi MIT
.cache/ out/            cache klip dan hasil render; diabaikan git
```

## Kontribusi

Setiap perubahan lewat branch dan pull request (`<jenis>/<ringkas>`), dan merge hanya setelah semua check (`uji`, GitGuardian) berstatus SUCCESS. Perubahan konsep atau fitur wajib membawa pembaruan dokumen di PR yang sama. Aturan lengkapnya ada di [AGENTS.md](AGENTS.md): §Git dan PR untuk alur git, dan §Dokumentasi untuk peta "perubahan apa memperbarui dokumen mana". Rencana kerja ada di [docs/roadmap.md](docs/roadmap.md); setiap pekerjaan dimulai dari issue (formulir tugas, bug, riset, atau epik) dan PR menutupnya dengan `Closes #n`.

Ada dua jenis versi yang berbeda. Versi dokumen (`Version` di blok Metadata README, AGENTS.md, dan dokumen di `docs/`) menandai revisi dokumen. Versi software ada di `package.json` dan `CHANGELOG.md`. README `v2.0.0` tidak berarti awvd `2.0.0`.

## Rilis

Belum ada rilis bertag. Versi paket `0.1.0`, dan semua perubahan dicatat di [CHANGELOG.md](CHANGELOG.md) bagian `[Unreleased]`. awvd tidak di-deploy ke server mana pun; ia dipakai lokal dan di CI. Prosedur rilis bila kelak diputuskan pemilik ada di AGENTS.md §Rilis dan Deployment.

## Lisensi

awvd berlisensi [MIT](LICENSE). Kode ditulis sendiri tanpa menyalin Remotion maupun repositori skill-nya; pihak ketiga dan tanggung jawab pengguna atas aset (font, musik, gambar, footage, klip, suara TTS) ada di [docs/lisensi-kepatuhan.md](docs/lisensi-kepatuhan.md).

**Peringatan hukum: video pihak ketiga.** awvd tidak menyediakan dan tidak akan menyediakan pengunduh atau perekam video platform (YouTube, TikTok, Facebook, Instagram, X, dan sejenisnya); fitur sumber hanya menerima berkas yang sah Anda miliki, dengan manifest dan atribusi. Kutipan untuk video reaction dan ulasan diperiksa terhadap kebijakan internal yang terukur dan gerbang tinjauan hukum, bukan jaminan kutipan sah. Dokumentasi ini bukan nasihat hukum; rincian di [docs/pelajari-reaction.md](docs/pelajari-reaction.md).

## Changelog

### 2026-11-07 - v2.13.0

- §Perintah utama: `bun run timeline periksa` dan uji timeline di `bun run uji`. Indeks dokumentasi memuat `docs/timeline.md` dan versi dokumen yang berubah. §Struktur repo: `scripts/timeline.mjs`, `data/skema-timeline.json`, `scripts/uji-timeline.mjs`, dan templat `timeline-contoh`.

### 2026-11-07 - v2.12.0

- §Perintah utama: `bun run narasi` memuat mesin suara opsional `sherpa-onnx` (TTS lokal, tidak dibundel). §Struktur repo: `narasi-tts.mjs`, `normalisasi-id.mjs`, dan `data/suara.json`. Indeks dokumentasi memperbarui versi `docs/README.md`, `cli.md`, `video-tertanam-audio.md`, `aksesibilitas.md`, `batasan.md`, `lisensi-kepatuhan.md`, `roadmap.md`, `log-keputusan.md`, dan `narasi-caption.md`.

### 2026-11-07 - v2.11.0

- §Perintah utama: mode dan posisi caption (helper runtime, templat demo) dan `bun run uji:caption` di `bun run uji`. Baris `bun run uji` yang ganda dan basi dihapus, dan jumlah uji renderer dikoreksi menjadi sepuluh. §Struktur repo: `scripts/narasi-caption.mjs`, `scripts/uji-caption.mjs`, templat `narasi-contoh` sebagai demo caption (baris templat yang ganda digabung). Versi dokumen yang berubah di indeks.

### 2026-11-07 - v2.10.0

- Efek klip: §Perintah utama menyebut stabilisasi dan chroma key (PNG beralfa) di `klip[].efek`; indeks dokumentasi memuat `docs/olah-klip.md` v1.2.0 (dan versi dokumen yang berubah); §Struktur repo menyebut efek baru di `klip.mjs`. `bun run uji` tidak berubah (uji klip diperluas, perlu ffmpeg; uji vidstab dilewati bila build tidak memilikinya).

### 2026-11-07 - v2.9.0

- §Perintah utama: `bun run audio` memuat olah suara per trek (peredam bising `afftdn`/`arnndn`, pengubah nada dan tempo) dan `bun run uji` memuat uji audio (`bun run uji:audio`). Struktur repo menambahkan uji audio; versi indeks dokumentasi diperbarui (`video-tertanam-audio` v1.4.0, `roadmap` v1.3.0, `log-keputusan` v1.8.0, `docs/README` v1.7.1).

### 2026-11-07 - v2.8.0

- §Dokumentasi: kolom Versi indeks diperbarui (`konsep-jenis-alur.md`, `transisi-animasi.md`, `aksesibilitas.md`, `log-keputusan.md`, `docs/README.md`). Ringkasan `bun run konsep` dan transisi menyebut preset transisi di brief dan `kurangiGerak` dari konsep.

### 2026-11-07 - v2.8.0

- §Dokumentasi: kolom Versi indeks diperbarui (`konsep-jenis-alur.md`, `transisi-animasi.md`, `aksesibilitas.md`, `log-keputusan.md`, `docs/README.md`). Ringkasan `bun run konsep` dan transisi menyebut preset transisi di brief dan `kurangiGerak` dari konsep.

### 2026-11-07 - v2.7.0

- §Perintah utama: `bun run narasi` dan uji narasi di `bun run uji`. Indeks dokumentasi memuat `docs/narasi-caption.md` dan versi dokumen yang berubah. §Struktur repo: `scripts/narasi*.mjs`, `scripts/uji-narasi.mjs`, dan `templates/narasi-contoh`.

### 2026-11-07 - v2.6.0

- Efek warna klip: indeks dokumentasi memuat `docs/olah-klip.md` (dan versi dokumen yang berubah), §Perintah utama menyebut `klip[].efek`, §Struktur repo menyebut efek di `klip.mjs` dan LUT contoh di `templates/klip-tertanam/lut/`. `bun run uji` tidak berubah (uji klip diperluas).

### 2026-11-07 - v2.5.2

- §Struktur repo: `bun run uji` memuat sepuluh uji renderer (menambah determinisme `--skala`); indeks dokumentasi memperbarui versi `arsitektur.md`, `cli.md`, `transisi-animasi.md`, dan `batasan.md`.

### 2026-11-07 - v2.5.1

- Perintah utama menyebut helper runtime aset; kolom Versi indeks dokumentasi diperbarui (`api-runtime` v1.3.0, `aset` v1.1.0, `aksesibilitas` v1.3.1, `roadmap` v1.0.1, `log-keputusan` v1.5.0, `docs/README` v1.5.1).

### 2026-11-07 - v2.5.0

- Mendaftarkan `docs/roadmap.md` di indeks dokumentasi; Kontribusi menyebut roadmap dan formulir issue.

### 2026-11-07 - v2.4.0

- Perintah utama, indeks dokumentasi (versi dokumen yang berubah dan baris `docs/pelajari-reaction.md`), dan struktur repo memuat `bun run pelajari`, kebijakan kutipan wajar (`scripts/kutipan.mjs`), templat `reaction`, dan uji pelajari. `bun run uji` kini juga menjalankan uji pelajari. Peringatan hukum tentang video pihak ketiga ada di [docs/lisensi-kepatuhan.md](docs/lisensi-kepatuhan.md#video-pihak-ketiga-dan-kutipan-wajar).

### 2026-11-07 - v2.3.0

- Fitur aset: perintah `bun run aset` di Perintah utama, `scripts/aset*.{mjs,js}` dan `templates/aset-contoh` di Struktur repo, serta indeks dokumentasi memuat `docs/aset.md` dan versi dokumen yang berubah. `bun run uji` kini juga menjalankan uji aset. Render memblokir permintaan jaringan non-lokal.

### 2026-11-07 - v2.2.0

- Menambahkan modul transisi dan animasi: `scripts/transisi.js`, `templates/transisi-galeri/`, dan `scripts/uji-transisi.mjs`. Indeks dokumentasi memuat `docs/transisi-animasi.md` (dan versi dokumen yang berubah), §Struktur repo mencantumkan modul, uji, dan templat baru, dan `bun run uji` kini juga menjalankan uji transisi.

### 2026-11-07 - v2.1.0

- Mendaftarkan `docs/visual-audiens.md` di indeks dokumentasi dan memperbarui kolom Versi dokumen yang berubah (`api-runtime`, `pemeriksaan-mutu`, `konsep-jenis-alur`, `aksesibilitas`, `batasan`, `pedoman-produksi`, `log-keputusan`, `docs/README`).
- §Perintah utama: `bun run uji` kini juga menjalankan uji visual. §Struktur repo: `data/audiens.json` dan uji visual.

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
