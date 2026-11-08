# Aset templat reframe-contoh

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-08`
- Changeset: `Baseline pencatatan aset: contoh reframe 16:9 ke 9:16 tidak memuat aset pihak ketiga.`

Catatan sumber dan lisensi setiap aset pihak ketiga yang dipakai templat ini (AGENTS.md §Lisensi dan Aset).

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| - | - | - | - |

Templat ini tidak memuat aset pihak ketiga. Panggung sumber 16:9 adalah gradien dan bentuk CSS buatan sendiri (langit, tanah, bola "subjek" fiktif); teks adalah label fiktif ("Contoh Reframe", "Papan sumber 16:9"). Font diambil dari font sistem lewat `font-family: system-ui, ...` dan tidak didistribusikan.

`reframe.json` adalah sumber kebenaran data reframe (periksa dengan `bun run reframe periksa templates/reframe-contoh/reframe.json --durasi 150`). `reframe-data.js` adalah salinannya sebagai skrip global agar komposisi dapat dirender tanpa `--props-file`; `bun run uji:reframe` menolak salinan yang basi. Jangan menyertakannya pada `--komposisi`.

Render: `bun run render templates/reframe-contoh/index.html --out out/reframe.mp4` (1080x1920, 30 fps, 150 frame).

## Changelog

### 2026-11-08 - v1.0.0

- Baseline: tidak ada aset pihak ketiga.
