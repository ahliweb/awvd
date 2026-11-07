# Aset templat aset-contoh

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Templat baru: contoh manifest aset.json (skema 1) dengan satu logo dan satu ikon buatan sendiri.`

Catatan sumber dan lisensi setiap aset yang dipakai templat ini (AGENTS.md §Lisensi dan Aset). Sumber kebenarannya adalah [aset.json](aset.json); tabel ini diperiksa uji (`bun run uji:aset`) agar memuat setiap `id` di manifest.

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| `logo-contoh` (`aset/logo-contoh.svg`) | Buatan Proyek awvd (logo fiktif "Contoh Karya") | MILIK-SENDIRI | 2026-11-07 |
| `ikon-centang` (`aset/ikon-centang.svg`) | Buatan Proyek awvd | CC0-1.0 | 2026-11-07 |

Tidak ada aset pihak ketiga. Logo "Contoh Karya" adalah merek fiktif dan tidak mewakili organisasi nyata. Font diambil dari font sistem lewat `font-family: system-ui, ...` dan tidak didistribusikan. Teks pada komposisi adalah data fiktif buatan sendiri.

Jalankan `bun run aset periksa templates/aset-contoh/aset.json --komposisi templates/aset-contoh/index.html` untuk memvalidasi manifest dan menghasilkan `aset-props.json`, `atribusi.txt`, dan `font-face.css`.

## Changelog

### 2026-11-07 - v1.0.0

- Templat baru: logo dan ikon SVG buatan sendiri, manifest `aset.json`, dan komposisi `index.html`.
