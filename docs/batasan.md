# Batasan yang diketahui

## Metadata

- Version: `v1.1.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan batasan jaringan (semua permintaan non-lokal diblokir) dan penunjuk ke batasan aset.`

Batasan lintas fitur. Batasan khusus tiap fitur ada di dokumen fiturnya (lihat bagian akhir).

## Renderer dan keluaran

- Render serial, sekitar 21 fps pada mesin pengembangan (komposisi contoh); tidak ada paralelisasi antar frame.
- Hanya Linux yang diuji.
- Elemen `<video>` di DOM tidak di-seek per frame. Untuk video di dalam video pakai fitur klip tertanam ([video-tertanam-audio.md](video-tertanam-audio.md): frame diekstrak ke cache lalu digambar per nomor frame); untuk gambar diam pakai `<img>` atau `<canvas>`.
- Keluaran hanya H.264 (MP4) dan PNG (still). Tidak ada WebM/ProRes/GIF.
- Hanya SDR BT.709; tidak ada HDR atau ruang warna lain. Normalisasi kenyaringan memakai `loudnorm` linear; bila mode linear tidak dapat dicapai tanpa melewati batas true peak, ffmpeg beralih ke mode dinamis, dan hasil ukur bisa menyimpang dari target (periksa laporan `kenyaringan:`). Hasil dikodekan AAC setelah normalisasi, jadi true peak akhir dapat berbeda sedikit.
- Tidak ada akses jaringan saat render: semua permintaan selain `file:`, `data:`, `about:`, `blob:` diblokir dan menggagalkan render (kode keluar `3`; [cli.md](cli.md#jaringan-dan-font)). Font web, CDN, dan gambar jarak jauh harus diunduh manual dan dimasukkan sebagai aset lokal ([aset.md](aset.md)); `--izinkan-jaringan` hanya untuk pratinjau.
- Resolusi dasar diambil dari `width`/`height` komposisi; ubah ukuran akhir dengan `--skala`.

## Batasan di dokumen lain

| Fitur | Batasan |
| --- | --- |
| Klip tertanam | [video-tertanam-audio.md](video-tertanam-audio.md#batasan) |
| Konsep dan preset | [konsep-jenis-alur.md](konsep-jenis-alur.md#batasan-konsep) |
| Pemeriksaan mutu | [pemeriksaan-mutu.md](pemeriksaan-mutu.md#batasan) |
| Kilatan fotosensitif | [pemeriksaan-mutu.md](pemeriksaan-mutu.md#kilatan-fotosensitif) |
| SOP | [sop.md](sop.md#keputusan-desain-bukan-aturan-regulasi) |
| Aset (gambar, logo, ikon, SVG, font, audio) | [aset.md](aset.md#batasan) |

## Changelog

### 2026-11-07 - v1.1.0

- Menambahkan batasan jaringan dan penunjuk ke batasan aset.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Batasan yang diketahui); isi dipertahankan, rujukan silang diperbarui.
- Menambahkan tabel Batasan di dokumen lain.
