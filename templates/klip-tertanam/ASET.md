# Aset templat klip-tertanam

## Metadata

- Version: `v1.1.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan dua LUT 3D contoh (identitas.cube, hangat.cube) yang dibangkitkan skrip buat-lut.mjs, dan sumber-warna.json yang memakai klip yang sama. Sebelumnya: baseline pencatatan aset: dua klip contoh buatan proyek sendiri (ffmpeg lavfi), audio contoh dibuat saat dijalankan, tidak ada aset pihak ketiga.`

Catatan sumber dan lisensi setiap aset yang dipakai templat ini (AGENTS.md §Lisensi dan Aset).

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| `aset/pola-uji.mkv` (3 s, 480x270, 25 fps, H.264 + AAC mono) | Dibuat proyek awvd dengan ffmpeg lavfi (`testsrc2` dan `sine` bernada 1000 Hz bertremolo) | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `aset/pola-warna.mkv` (4 s, 480x270, 25 fps, H.264 + AAC mono) | Dibuat proyek awvd dengan ffmpeg lavfi (`gradients` dan `sine` bernada 700 Hz bertremolo) | CC-BY-4.0 (milik proyek awvd; dipilih agar contoh memperlihatkan atribusi TASL) | 2026-11-07 |
| `narasi-1.wav`, `narasi-2.wav`, `musik.wav` | Dibuat saat dijalankan oleh `buat-audio.mjs` (nada sinus dari ffmpeg lavfi), ditulis ke `.cache/` dan tidak di-commit | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `lut/identitas.cube`, `lut/hangat.cube` (LUT 3D `.cube`, ukuran 17) | Dibangkitkan proyek awvd oleh `buat-lut.mjs` (rumus murni: identitas, dan hangat = merah x1,1 dengan batas putih, biru x0,85); keluaran deterministik, jadi berkas yang di-commit sama dengan keluaran skrip (diuji) | CC0-1.0 (milik proyek awvd) | 2026-11-07 |

Tidak ada footage, suara, atau musik pihak ketiga, dan tidak ada data nyata orang. Narasi contoh berupa nada, bukan suara manusia atau TTS. Font diambil dari font sistem.

**Mengapa `.mkv`, bukan `.mp4`.** Dua klip kecil (sekitar 150 KB) di-commit agar hash `sha256` di `sumber.json` stabil di semua mesin. Biner H.264 dari ffmpeg tidak identik antar-versi, jadi klip yang dibuat ulang dengan perintah di bawah akan berhash lain dan perlu `sumber.json` yang disesuaikan. Ini berkas masukan contoh, bukan video keluaran (AGENTS.md aturan 3), dan sengaja memakai kontainer lain karena `*.mp4` diabaikan git.

Perintah pembuatan (hasilnya setara, tidak identik byte demi byte):

```bash
ENC="-vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p -c:v libx264 -preset veryslow -crf 30 \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 48k -ac 1 -ar 48000 -map_metadata -1"
ffmpeg -f lavfi -i "testsrc2=size=480x270:rate=25:duration=3" \
  -f lavfi -i "sine=f=1000:d=3:sample_rate=48000,tremolo=f=4:d=0.8" $ENC pola-uji.mkv
ffmpeg -f lavfi -i "gradients=size=480x270:rate=25:duration=4:speed=0.15:seed=7:nb_colors=4" \
  -f lavfi -i "sine=f=700:d=4:sample_rate=48000,tremolo=f=3:d=0.8" $ENC pola-warna.mkv
```

## Changelog

### 2026-11-07 - v1.1.0

- Menambahkan `lut/identitas.cube` dan `lut/hangat.cube` (dibangkitkan `buat-lut.mjs`) serta contoh `sumber-warna.json` yang memakai `aset/pola-uji.mkv`.

### 2026-11-07 - v1.0.0

- Baseline: dua klip contoh buatan sendiri dan audio contoh buatan saat dijalankan; tidak ada aset pihak ketiga.
