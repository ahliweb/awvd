# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/). Versi paket di `package.json`: `0.1.0` (belum dirilis; belum ada tag).

## [Unreleased]

### Ditambahkan

- Renderer `scripts/render.mjs`: komposisi web -> MP4 H.264 lewat Chromium headless, PNG pipe, dan ffmpeg; mode `--still`, rentang `--dari`/`--sampai`, `--skala`, `--crf`, `--audio`, `--subtitle`, `--bahasa`, `--props`, `--browser`.
- Runtime `scripts/runtime.js`: `defineVideo`, `interpolasi`, `easing`, `pegas`, `urutan`, `fade`, `acak`, dan mode pratinjau `?preview`.
- Template `templates/contoh-dasar`.
- Uji otomatis `bun run uji` dan CI GitHub Actions `uji`.
- Dokumentasi: README, AGENTS.md, CLAUDE.md.
