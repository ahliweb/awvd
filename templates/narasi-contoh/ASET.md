# Aset templat narasi-contoh

## Metadata

- Version: `v1.1.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan komposisi demo mode dan posisi caption (index.html, buat-props.mjs) dan zonaCaption/jangkarPenutur di naskah; siluet dan bentuk digambar sendiri dengan HTML/CSS/SVG; tetap tidak ada TTS, suara orang, atau aset pihak ketiga.`

Catatan sumber dan lisensi setiap aset yang dipakai templat ini (AGENTS.md §Lisensi dan Aset). Templat ini mendemonstrasikan `bun run narasi` dan mode serta posisi caption ([docs/narasi-caption.md](../../docs/narasi-caption.md)); `index.html` adalah komposisi demo caption.

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| `naskah.json` (teks narasi tentang merapikan meja kerja, penutur "Narator" dan "Pak Budi") | Ditulis proyek awvd; isi dan nama penutur fiktif, tanpa data nyata | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `index.html` (komposisi demo caption: gradien, bentuk, siluet penutur fiktif sebagai SVG inline, pita nama) dan `buat-props.mjs` | Ditulis proyek awvd; semua grafis digambar dengan HTML, CSS, dan SVG inline; teks fiktif ("Pak Budi", "Penata ruang kerja"); tanpa gambar, font, atau ikon pihak ketiga (font sistem) | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `a1.wav`, `a2-1.wav`, `a2-2.wav` | Dibuat saat dijalankan oleh `buat-audio.mjs` (nada sinus bertremolo dan senyap dari ffmpeg lavfi), ditulis ke `.cache/awvd/narasi-contoh/` dan tidak di-commit | CC0-1.0 (milik proyek awvd) | 2026-11-07 |

Tidak ada footage, suara orang, hasil TTS, atau musik pihak ketiga. WAV contoh berupa nada yang lari bicara dan jeda senyapnya disusun mengikuti tanda baca `naskah.json` (titik 0,7 s, koma 0,3 s), supaya estimasi berjangkar jeda dapat dilihat bekerja. Pada proyek nyata, narasi adalah WAV beku hasil rekaman atau TTS berlisensi jelas yang dicatat di repo proyek.

Perintah:

```bash
bun templates/narasi-contoh/buat-audio.mjs
bun run narasi templates/narasi-contoh/naskah.json --out out/narasi
bun templates/narasi-contoh/buat-props.mjs --mode sorot-kata --posisi auto   # props komposisi demo caption
bun run render templates/narasi-contoh/index.html --props-file out/narasi-contoh/props.json --out out/caption.mp4
```

## Changelog

### 2026-11-07 - v1.1.0

- Menambahkan komposisi demo caption (`index.html`, `buat-props.mjs`) dan kunci `zonaCaption`/`jangkarPenutur`/`caption.mode`/`caption.posisi` di `naskah.json`; semua grafis buatan sendiri.

### 2026-11-07 - v1.0.0

- Baseline: naskah fiktif buatan sendiri dan WAV contoh yang dibuat saat dijalankan; tidak ada aset pihak ketiga.
