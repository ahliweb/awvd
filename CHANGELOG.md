# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/). Versi paket di `package.json`: `0.1.0` (belum dirilis; belum ada tag).

## [Unreleased]

### Ditambahkan

- Renderer `scripts/render.mjs`: komposisi web -> MP4 H.264 lewat Chromium headless, PNG pipe, dan ffmpeg; mode `--still`, rentang `--dari`/`--sampai`, `--skala`, `--crf`, `--audio`, `--subtitle`, `--bahasa`, `--props`, `--browser`.
- Runtime `scripts/runtime.js`: `defineVideo`, `interpolasi`, `easing`, `pegas`, `urutan`, `fade`, `acak`, dan mode pratinjau `?preview`.
- Template `templates/contoh-dasar`.
- Uji otomatis `bun run uji` dan CI GitHub Actions `uji`.
- Dokumentasi: README, AGENTS.md, CLAUDE.md.
- Aturan dokumentasi di AGENTS.md §Dokumentasi: setiap perubahan konsep/fitur wajib disertai pembaruan dokumen, dengan peta pemicu dan checklist.
- Template PR `.github/pull_request_template.md` dan `templates/contoh-dasar/ASET.md`.
- Pedoman orchestrator di AGENTS.md beserta subagent `.claude/agents/pelaksana-kompleks.md` dan `pelaksana-sederhana.md`; bagian Skill, Git dan PR, serta Rilis dan Deployment.
- README: bagian Klasifikasi repo dan Rilis.
- Renderer: flag `--kenyaringan <web|siaran|mati>` (bawaan `web` bila ada `--audio`): normalisasi `loudnorm` dua-pass linear, web -16 LUFS / -1,5 dBTP, siaran -23 LUFS / -1 dBTP (EBU R 128). Setelah encode, kenyaringan hasil dilaporkan (`kenyaringan: I=.. LUFS, TP=.. dBTP`). Uji (i) dan penegasan baru di (a) dan (e).
- Helper runtime generik di `scripts/runtime.js` (murni dan deterministik; global dan `window.VideoTerprogram`): `areaAman` (area aksi 93% dan grafis 90%, EBU R 95), `ms` dan `durasi` (preset milidetik, token Material Design 3), preset `easing` `standar`/`percepat`/`perlambat`/`ditekankanMasuk`/`ditekankanKeluar`, `luminansRelatif`/`kontras`/`pilihTeksKontras` (WCAG 2.2 SC 1.4.3), `durasiBaca`, `pecahBaris`, `captionAktif` beserta `parseVtt`/`parseSrt` (burn-in caption deterministik di DOM), dan `berjenjang` (stagger). Easing dan API lama tidak berubah. Memengaruhi repo proyek: helper baru tersedia setelah naik versi, tanpa perubahan wajib.
- Uji unit `scripts/uji-runtime.mjs` (script `bun run uji:runtime`); `bun run uji` menjalankannya lebih dulu, lalu uji renderer.

### Diubah

- Dokumentasi tidak lagi menyebut nama, path, atau tautan repo pedoman internal AhliWeb yang privat.
- Klasifikasi repo ditetapkan dan pengaturan GitHub (proteksi `main`, check wajib, merge commit saja) didokumentasikan.
- awvd ditetapkan hanya sebagai upstream (renderer, runtime, template contoh generik, uji), bukan repo proyek video. Pemakaian di repo proyek (dependensi git terkunci SHA, struktur repo proyek, naik versi, lisensi) didokumentasikan di README §Peran repo: upstream, dengan aturan 11 di AGENTS.md dan checklist baru di template PR. Tidak ada perubahan kode.

- Renderer: encode video kini mengonversi RGB ke YUV 4:2:0 BT.709 rentang TV secara eksplisit dan menandai metadata warna SDR BT.709; profil H.264 High, B-frame 2, GOP tertutup sepanjang setengah fps. Audio `--audio` kini AAC-LC 48 kHz stereo 384 kbps (sebelumnya 192k) dan dinormalisasi secara bawaan. Mengikuti YouTube Help "Recommended upload encoding settings", EBU R 128, dan AES TD1004/TD1008. Memengaruhi repo proyek: warna dan audio hasil render berubah (render ulang video yang terdampak; level audio bawaan kini -16 LUFS, gunakan `--kenyaringan mati` untuk perilaku lama).

### Diperbaiki

- Renderer: `--out` ke folder yang belum ada gagal di mode video (ffmpeg tidak membuat folder), sedangkan mode `--still` berhasil. Kini folder tujuan dibuat otomatis di kedua mode; uji (g) mencakup kasus ini. Memengaruhi repo proyek: tidak perlu lagi membuat `out/` sendiri.
