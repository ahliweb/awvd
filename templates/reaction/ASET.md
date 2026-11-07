# Aset templat reaction

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Baseline pencatatan aset: dua klip contoh buatan proyek sendiri (ffmpeg lavfi) yang menjadi "karya yang dikutip" fiktif, audio contoh dibuat saat dijalankan, tidak ada aset pihak ketiga.`

Catatan sumber dan lisensi setiap aset yang dipakai templat ini (AGENTS.md §Lisensi dan Aset).

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| `aset/karya-fiktif-1.mkv` (64 s, 480x270, 10 fps, H.264 + AAC mono 16 kHz) | Dibuat proyek awvd dengan ffmpeg lavfi (`color` dengan kotak oranye bergerak dan latar yang berganti gelap-terang di detik 8, 20, 32, 48; `sine` bernada 440 Hz bertremolo, dianggap "ucapan" untuk contoh) | CC0-1.0 (milik proyek awvd) | 2026-11-07 |
| `aset/karya-fiktif-2.mkv` (64 s, 480x270, 10 fps, H.264 + AAC mono 16 kHz) | Dibuat proyek awvd dengan ffmpeg lavfi (`color` dengan kotak merah bergerak turun dan latar yang berganti di detik 16 dan 40; `aevalsrc` berupa akor tiga nada, dianggap "musik" untuk contoh) | CC-BY-4.0 (milik proyek awvd; dipilih agar contoh memperlihatkan atribusi TASL) | 2026-11-07 |
| `narasi-1.wav` sampai `narasi-6.wav`, `musik.wav` | Dibuat saat dijalankan oleh `buat-audio.mjs` (nada sinus dari ffmpeg lavfi), ditulis ke `.cache/` dan tidak di-commit | CC0-1.0 (milik proyek awvd) | 2026-11-07 |

Tidak ada footage, suara, atau musik pihak ketiga, dan tidak ada data nyata orang. Narasi contoh berupa nada, bukan suara manusia atau TTS. Font diambil dari font sistem.

**Mengapa karya yang dikutip berlisensi CC0 dan CC BY.** Templat ini tidak boleh memuat karya pihak ketiga (AGENTS.md aturan 11), jadi "karya yang dikutip" dibuat sendiri. Karena milik proyek, lisensinya CC0/CC BY dan `sumber.json` menerapkan kebijakan kutipan wajar secara sukarela (blok `kutipan` pada tiap sumber) supaya seluruh angka kebijakan dan aturan audio terlihat bekerja. Untuk karya pihak ketiga, lisensinya diganti `KUTIPAN-WAJAR` sehingga gerbang hukum GH berlaku (lihat [docs/pelajari-reaction.md](../../docs/pelajari-reaction.md)). Berkas catatan analisisnya: [KUTIPAN-WAJAR.md](KUTIPAN-WAJAR.md).

**Mengapa `.mkv`, bukan `.mp4`.** Dua klip kecil (sekitar 90 dan 120 KB) di-commit agar hash `sha256` di `sumber.json` stabil di semua mesin. Biner H.264 dari ffmpeg tidak identik antar-versi, jadi klip yang dibuat ulang dengan perintah di bawah akan berhash lain dan perlu `sumber.json` yang disesuaikan. Ini berkas masukan contoh, bukan video keluaran (AGENTS.md aturan 3), dan sengaja memakai kontainer lain karena `*.mp4` diabaikan git. Durasi 64 detik dipilih agar batas 15% durasi sumber (9,6 detik) cukup untuk kutipan contoh.

Perintah pembuatan (hasilnya setara, tidak identik byte demi byte):

```bash
ENC="-vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p -c:v libx264 -preset veryslow -crf 30 -g 120 \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 8k -ac 1 -ar 16000 -map_metadata -1"
ffmpeg -f lavfi -i "color=c=0x14203c:s=480x270:r=10:d=64,drawbox=x=0:y=0:w=iw:h=ih:color=0xe8dcc0:t=fill:enable='between(t,8,20)+between(t,32,48)',drawbox=x='mod(t*40,420)':y=100:w=60:h=60:color=0xf59f00:t=fill" \
  -f lavfi -i "sine=f=440:d=64:sample_rate=16000,tremolo=f=2:d=0.7" $ENC karya-fiktif-1.mkv
ffmpeg -f lavfi -i "color=c=0x103828:s=480x270:r=10:d=64,drawbox=x=0:y=0:w=iw:h=ih:color=0xd0e8f0:t=fill:enable='between(t,16,40)',drawbox=x=200:y='mod(t*25,200)':w=80:h=50:color=0x802020:t=fill" \
  -f lavfi -i "aevalsrc=0.15*sin(2*PI*220*t)+0.15*sin(2*PI*277.18*t)+0.15*sin(2*PI*329.63*t):d=64:s=16000" $ENC karya-fiktif-2.mkv
```

## Changelog

### 2026-11-07 - v1.0.0

- Baseline: dua klip contoh buatan sendiri sebagai karya fiktif yang dikutip dan audio contoh buatan saat dijalankan; tidak ada aset pihak ketiga.
