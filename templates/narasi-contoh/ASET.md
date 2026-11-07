# Aset templat narasi-contoh

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Baseline pencatatan aset: naskah fiktif buatan sendiri dan tiga WAV nada sinus yang dibuat saat dijalankan (ffmpeg lavfi); tidak ada TTS, suara orang, atau aset pihak ketiga.`

Catatan sumber dan lisensi setiap aset yang dipakai templat ini (AGENTS.md §Lisensi dan Aset). Templat ini mendemonstrasikan `bun run narasi` ([docs/narasi-caption.md](../../docs/narasi-caption.md)); tidak ada komposisi HTML.

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| `naskah.json` (teks narasi tentang merapikan meja kerja, penutur "Narator" dan "Pak Budi") | Ditulis proyek awvd; isi dan nama penutur fiktif, tanpa data nyata | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `a1.wav`, `a2-1.wav`, `a2-2.wav` | Dibuat saat dijalankan oleh `buat-audio.mjs` (nada sinus bertremolo dan senyap dari ffmpeg lavfi), ditulis ke `.cache/awvd/narasi-contoh/` dan tidak di-commit | CC0-1.0 (milik proyek awvd) | 2026-11-07 |

Tidak ada footage, suara orang, hasil TTS, atau musik pihak ketiga. WAV contoh berupa nada yang lari bicara dan jeda senyapnya disusun mengikuti tanda baca `naskah.json` (titik 0,7 s, koma 0,3 s), supaya estimasi berjangkar jeda dapat dilihat bekerja. Pada proyek nyata, narasi adalah WAV beku hasil rekaman atau TTS berlisensi jelas yang dicatat di repo proyek.

Perintah:

```bash
bun templates/narasi-contoh/buat-audio.mjs
bun run narasi templates/narasi-contoh/naskah.json --out out/narasi
```

## Changelog

### 2026-11-07 - v1.0.0

- Baseline: naskah fiktif buatan sendiri dan WAV contoh yang dibuat saat dijalankan; tidak ada aset pihak ketiga.
