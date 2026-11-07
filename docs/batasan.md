# Batasan yang diketahui

## Metadata

- Version: `v1.6.1`
- Last updated: `2026-11-07`
- Changeset: `Penunjuk batasan narasi memuat ASR lokal opsional. Sebelumnya: menambahkan penunjuk batasan deteksi ketukan.`

Batasan lintas fitur. Batasan khusus tiap fitur ada di dokumen fiturnya (lihat bagian akhir).

## Renderer dan keluaran

- Determinisme `--skala` di atas 1 (clip.scale) diuji pada contoh-dasar saja (tiga render, 30 frame, dua kali percobaan, skala 1,5 dan 2, tanpa selisih); tidak ada uji otomatis dan jaminannya lebih lemah daripada skala 1 dan di bawah 1.
- Render serial, sekitar 21 fps pada mesin pengembangan (komposisi contoh); tidak ada paralelisasi antar frame.
- Hanya Linux yang diuji.
- Elemen `<video>` di DOM tidak di-seek per frame. Untuk video di dalam video pakai fitur klip tertanam ([video-tertanam-audio.md](video-tertanam-audio.md): frame diekstrak ke cache lalu digambar per nomor frame); untuk gambar diam pakai `<img>` atau `<canvas>`.
- Keluaran hanya H.264 (MP4) dan PNG (still). Tidak ada WebM/ProRes/GIF.
- Hanya SDR BT.709; tidak ada HDR atau ruang warna lain. Normalisasi kenyaringan memakai `loudnorm` linear; bila mode linear tidak dapat dicapai tanpa melewati batas true peak, ffmpeg beralih ke mode dinamis, dan hasil ukur bisa menyimpang dari target (periksa laporan `kenyaringan:`). Hasil dikodekan AAC setelah normalisasi, jadi true peak akhir dapat berbeda sedikit.
- Tidak ada akses jaringan saat render: semua permintaan selain `file:`, `data:`, `about:`, `blob:` diblokir dan menggagalkan render (kode keluar `3`; [cli.md](cli.md#jaringan-dan-font)). Font web, CDN, dan gambar jarak jauh harus diunduh manual dan dimasukkan sebagai aset lokal ([aset.md](aset.md)); `--izinkan-jaringan` hanya untuk pratinjau.
- Resolusi dasar diambil dari `width`/`height` komposisi; ubah ukuran akhir dengan `--skala`. `--skala` di atas 1 membuat raster tajam pada ukuran akhir tetapi keluaran ikut membesar; `--skala` di bawah 1 menangkap pada skala 1 lalu memperkecil lewat `ffmpeg` (deterministik; waktu render sama dengan skala 1, bukan lebih cepat); supersampling (render lebih besar lalu diperkecil ke ukuran keluaran) belum didukung renderer. Garis berwarna 1 px melemah pada 4:2:0 (pakai >= 2 px); lihat [visual-audiens.md](visual-audiens.md#ketajaman-dan-encode).

## Batasan di dokumen lain

| Fitur | Batasan |
| --- | --- |
| Klip tertanam | [video-tertanam-audio.md](video-tertanam-audio.md#batasan) |
| Konsep dan preset | [konsep-jenis-alur.md](konsep-jenis-alur.md#batasan-konsep) |
| Pemeriksaan mutu | [pemeriksaan-mutu.md](pemeriksaan-mutu.md#batasan) |
| Kilatan fotosensitif | [pemeriksaan-mutu.md](pemeriksaan-mutu.md#kilatan-fotosensitif) |
| Transisi dan animasi | [transisi-animasi.md](transisi-animasi.md#keterbatasan-dan-hal-yang-belum-terverifikasi) |
| SOP | [sop.md](sop.md#keputusan-desain-bukan-aturan-regulasi) |
| Visual dan audiens (ukuran teks, palet buta warna, profil, efek) | [visual-audiens.md](visual-audiens.md#kesenjangan) |
| Aset (gambar, logo, ikon, SVG, font, audio) | [aset.md](aset.md#batasan) |
| Narasi dan caption sinkron (estimasi timing, mesin suara, TTS dan ASR lokal opsional) | [narasi-caption.md](narasi-caption.md#batasan) |
| Deteksi ketukan musik (hanya sinyal sintetis yang diuji, tempo tetap) | [ketukan.md](ketukan.md#batasan) |
| Mempelajari gaya video dan kutipan wajar | [pelajari-reaction.md](pelajari-reaction.md#batasan) |

## Changelog

### 2026-11-07 - v1.6.1

- Penunjuk batasan narasi memuat ASR lokal opsional (koreksi in-sample, belum diuji suara manusia, hasil transkripsi wajib ditinjau).

### 2026-11-07 - v1.6.0

- Menambahkan penunjuk batasan deteksi ketukan (bukti hanya dari sinyal sintetis, tempo tetap, ketukan lemah).

### 2026-11-07 - v1.5.1

- Penunjuk batasan narasi memuat TTS lokal opsional (keluaran tidak deterministik, kata di luar leksikon, label dan konten medis).

### 2026-11-07 - v1.5.0

- Menambahkan penunjuk batasan narasi dan caption.

### 2026-11-07 - v1.4.1

- Batasan `--skala` diperbarui setelah perbaikan determinisme skala di bawah 1 (isu #26); menambahkan catatan bahwa determinisme skala di atas 1 hanya diuji pada sampel.

### 2026-11-07 - v1.4.0

- Menambahkan penunjuk batasan pelajari dan kebijakan kutipan wajar.

### 2026-11-07 - v1.3.0

- Menambahkan batasan jaringan dan penunjuk ke batasan aset.

### 2026-11-07 - v1.2.0

- Menambahkan penunjuk batasan transisi dan animasi.

### 2026-11-07 - v1.1.0

- Menambahkan batasan `--skala` dan supersampling, garis berwarna 1 px, dan penunjuk ke batasan visual dan audiens.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Batasan yang diketahui); isi dipertahankan, rujukan silang diperbarui.
- Menambahkan tabel Batasan di dokumen lain.
