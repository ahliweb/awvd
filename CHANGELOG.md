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

### Diubah

- Dokumentasi tidak lagi menyebut nama, path, atau tautan repo pedoman internal AhliWeb yang privat.
- Klasifikasi repo ditetapkan dan pengaturan GitHub (proteksi `main`, check wajib, merge commit saja) didokumentasikan.
- awvd ditetapkan hanya sebagai upstream (renderer, runtime, template contoh generik, uji), bukan repo proyek video. Pemakaian di repo proyek (dependensi git terkunci SHA, struktur repo proyek, naik versi, lisensi) didokumentasikan di README §Peran repo: upstream, dengan aturan 11 di AGENTS.md dan checklist baru di template PR. Tidak ada perubahan kode.

### Diperbaiki

- Renderer: `--out` ke folder yang belum ada gagal di mode video (ffmpeg tidak membuat folder), sedangkan mode `--still` berhasil. Kini folder tujuan dibuat otomatis di kedua mode; uji (g) mencakup kasus ini. Memengaruhi repo proyek: tidak perlu lagi membuat `out/` sendiri.
