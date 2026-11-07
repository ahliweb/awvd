# Aset templat timeline-contoh

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Baseline pencatatan aset: dua klip contoh dan dua audio contoh buatan proyek sendiri (ffmpeg lavfi), logo contoh disalin dari templat aset-contoh; tidak ada aset pihak ketiga.`

Catatan sumber dan lisensi setiap aset yang dipakai templat ini (AGENTS.md §Lisensi dan Aset). Templat ini hanya berisi `timeline.json` contoh beserta manifest kecil yang dirujuknya; tidak ada komposisi `index.html` (templat render timeline menyusul di issue #32). Cara memakainya ada di [docs/timeline.md](../../docs/timeline.md).

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| `aset/klip-a.mkv` (3 s, 480x270, 25 fps, H.264 + AAC mono) | Dibuat proyek awvd dengan ffmpeg lavfi (`testsrc2` dan `sine` 1000 Hz bertremolo) | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `aset/klip-b.mkv` (4 s, 480x270, 25 fps, H.264 + AAC mono) | Dibuat proyek awvd dengan ffmpeg lavfi (`gradients` dan `sine` 700 Hz bertremolo) | CC-BY-4.0 (milik proyek awvd; dipilih agar contoh memperlihatkan aturan atribusi) | 2026-11-07 |
| `aset/narasi-1.m4a` (3 s, AAC mono 24 kbps) | Dibuat proyek awvd dengan ffmpeg lavfi (`sine` 330 Hz bertremolo); nada, bukan suara manusia atau TTS | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `aset/musik-1.m4a` (15 s, AAC mono 24 kbps) | Dibuat proyek awvd dengan ffmpeg lavfi (`aevalsrc`, akor sinus A-C#-E) | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `aset/logo-contoh.svg` | Disalin dari `templates/aset-contoh/aset/logo-contoh.svg` (logo fiktif buatan proyek awvd) | MILIK-SENDIRI (proyek awvd) | 2026-11-07 |

Tidak ada footage, suara, atau musik pihak ketiga, dan tidak ada data nyata orang. Isi `sumber.json` dan `aset.json` fiktif.

**Mengapa berkas media di-commit.** Hash `sha256` di `sumber.json` dan `aset.json` harus stabil di semua mesin, dan biner H.264/AAC dari ffmpeg tidak identik antar-versi. Berkas masukan contoh ini kecil (sekitar 150 KB seluruhnya) dan memakai kontainer `.mkv`/`.m4a` karena `*.mp4` diabaikan git (AGENTS.md aturan 3). Klip yang dibuat ulang dengan perintah di bawah setara tetapi berhash lain, sehingga manifest perlu disesuaikan.

Perintah pembuatan (hasilnya setara, tidak identik byte demi byte):

```bash
ENC="-vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p -c:v libx264 -preset veryslow -crf 36 \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 24k -ac 1 -ar 48000 -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact"
ffmpeg -f lavfi -i "testsrc2=size=480x270:rate=25:duration=3" \
  -f lavfi -i "sine=f=1000:d=3:sample_rate=48000,tremolo=f=4:d=0.8" $ENC klip-a.mkv
ffmpeg -f lavfi -i "gradients=size=480x270:rate=25:duration=4:speed=0.15:seed=7:nb_colors=4" \
  -f lavfi -i "sine=f=700:d=4:sample_rate=48000,tremolo=f=3:d=0.8" $ENC klip-b.mkv
AENC="-c:a aac -b:a 24k -ac 1 -map_metadata -1 -fflags +bitexact -flags:a +bitexact"
ffmpeg -f lavfi -i "sine=f=330:d=3:sample_rate=24000,tremolo=f=5:d=0.6" $AENC narasi-1.m4a
ffmpeg -f lavfi -i "aevalsrc=0.1*sin(2*PI*220*t)+0.1*sin(2*PI*277.18*t)+0.1*sin(2*PI*329.63*t):d=15:s=48000" $AENC musik-1.m4a
```

## Changelog

### 2026-11-07 - v1.0.0

- Baseline: dua klip contoh, dua audio contoh, dan logo contoh; tanpa aset pihak ketiga.
