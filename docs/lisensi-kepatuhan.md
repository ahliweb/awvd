# Lisensi dan kepatuhan

## Metadata

- Version: `v1.2.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan bagian Aset: ringkasan matriks lisensi per jenis, aturan OFL, merek dan lambang, hak potret, hasil AI, serta rujukan ke docs/aset.md; bukan nasihat hukum.`

Catatan hukum di dokumen ini bukan nasihat hukum.

## Lisensi awvd dan kepatuhan

- awvd berlisensi [MIT](../LICENSE).
- Kode awvd ditulis sendiri. awvd tidak memakai, tidak bergantung pada, dan tidak menyalin kode Remotion maupun remotion-dev/skills. Pemeriksaan 2026-11-07 membandingkan interpolasi, pegas, easing/bezier, dan PRNG dengan sumber Remotion: pendekatan dan implementasinya berbeda. Satu-satunya kesamaan adalah algoritma mulberry32, yang berstatus domain publik (atribusi di `scripts/runtime.js`).
- Konsep "video dari kode yang digambar per frame" adalah ide/metode, bukan ekspresi. Ide dan metode tidak dilindungi hak cipta (UU 28/2014 Pasal 41 huruf b; doktrin dikotomi ide-ekspresi).
- "Remotion" adalah merek milik pemiliknya. Nama itu disebut hanya untuk menjelaskan bahwa awvd tidak memakainya. Tidak ada afiliasi.

## Pihak ketiga

- **playwright-core 1.65.0:** Apache-2.0 (Microsoft). Dependensi npm, bukan kode yang disalin ke repo; LICENSE/NOTICE-nya ikut dalam paket.
- **playwright-core 1.64.1:** Apache-2.0 (Microsoft). Dependensi npm, bukan kode yang disalin ke repo; LICENSE/NOTICE-nya ikut dalam paket.
- **Material Components for Android:** Apache License 2.0 (Copyright Google LLC). Hanya **nilai** yang dipakai di `scripts/transisi.js`, diambil dari dokumentasi Motion dan sumber `MaterialFadeThrough`, `FadeThroughProvider`, `MaterialSharedAxis`, `MaterialFade`, dan `MaterialContainerTransform`: ambang fade through 35 %, skala awal 0,92, durasi 450 ms, token durasi, dan kurva bezier standard dan emphasized. Tidak ada kode yang disalin dan tidak ada dependensi; atribusi ada di komentar kepala `scripts/transisi.js` dan di [transisi-animasi.md](transisi-animasi.md#sumber). Nilai numerik tunggal bukan ekspresi yang dilindungi, tetapi atribusi dicatat sebagai kehati-hatian.
- **Chromium/Chrome:** dipakai dari instalasi lokal dan tidak didistribusikan.
- **ffmpeg:** dipanggil sebagai program sistem lewat CLI dan tidak didistribusikan atau ditautkan, sehingga kewajiban LGPL/GPL (libx264) tidak berlaku untuk repo ini. Video keluaran tidak terkena GPL.
- **H.264:** lisensi paten AVC (dulu MPEG LA, kini Via LA) secara historis tidak memungut royalti untuk video internet yang gratis bagi pengguna akhir. Untuk distribusi berbayar, siaran, atau platform streaming komersial, cek ketentuan Via LA terbaru. Status 2026 belum diverifikasi dari halaman resmi.

## Tanggung jawab pengguna atas aset

Font, musik (`--audio`), gambar, footage, klip tertanam, dan suara TTS wajib berlisensi jelas dan dicatat sumbernya (klip tertanam divalidasi `klip.mjs`). Video yang memuat data pribadi tunduk pada UU 27/2022 tentang Pelindungan Data Pribadi (dasar pemrosesan atau persetujuan). Jangan pakai data nyata di contoh. TTS daring hanya untuk konten publik (DL-037).

Syarat lisensi sumber klip tertanam (CC BY, BY-SA, BY-NC, CC0, PDM, stok) dan lisensi keluaran ada di [video-tertanam-audio.md](video-tertanam-audio.md#aturan-sumber).

## Aset: matriks lisensi (ringkas)

Manifest `aset.json` ([aset.md](aset.md)) mencatat sumber, lisensi, dan bukti tiap aset dan menolak lisensi di luar daftar. Ringkasan di bawah memetakan lisensi umum ke syarat yang divalidasi; ini ringkasan teknis atas teks lisensi yang dibaca pada 2026-11-07, bukan nasihat hukum, dan lisensi dapat berubah.

| Sumber atau jenis | Lisensi | Syarat yang divalidasi atau dicatat |
| --- | --- | --- |
| Ikon permisif (Material Symbols, Lucide, Heroicons) | Apache-2.0, ISC, MIT | `hakCipta` dan `berkasLisensi` (notice ikut terdistribusi); Apache-2.0: tandai berkas yang diubah di `perubahan`; tidak memberi hak merek. |
| Font Awesome Free | Ikon CC BY 4.0; font OFL 1.1; kode MIT | Atribusi CC BY (tampil `layar` atau `akhir`). Apakah komentar CSS memenuhi CC BY belum terverifikasi. Ikon merek = merek dagang pemiliknya. |
| Font SIL OFL 1.1 (mayoritas Google Fonts) | OFL-1.1 | `OFL.txt` dan baris hak cipta ikut bila berkas font didistribusikan; font tidak boleh dijual sendiri; versi modifikasi tidak boleh memakai Reserved Font Name. Video keluaran adalah dokumen yang dibuat dengan font dan tidak wajib OFL. Subset atau konversi WOFF2 sebagai modifikasi belum terverifikasi. |
| Foto stok (Pexels, Unsplash, Pixabay) | `STOK:<penyedia>` | `bukti` (tangkapan halaman lisensi dan tanggal) wajib. Larangan penyedia (menjual tanpa diubah, menyiratkan dukungan, orang teridentifikasi dalam cahaya buruk, konten bermerek) dan hak potret tidak dapat diverifikasi mesin. |
| Wikimedia Commons | CC BY, CC BY-SA, domain publik | TASL lengkap; BY-SA memaksa `proyek.lisensiKeluaran` BY-SA kompatibel; hak merek dan privasi terpisah dari hak cipta. |
| Musik dan efek suara | CC0, CC BY, CC BY-SA, `STOK:`, `MILIK-SENDIRI`, `IZIN-TERTULIS:` | Dua lapis hak (komposisi dan rekaman); ND ditolak; NC hanya proyek nonkomersial; YouTube Audio Library aman hanya di YouTube; Content ID dapat tetap menandai trek CC, jadi simpan bukti. |
| Logo dan lambang | `MILIK-SENDIRI`, `IZIN-TERTULIS:` (CC0, PDM bila memang diterbitkan demikian) | Logo pihak lain, instansi, dan lambang negara = gerbang izin manusia: `izin`, `bukti`, dan (instansi, lambang) `persetujuanHukum`; tanpa rotasi, perubahan warna, atau distorsi. Wajib tinjauan hukum (UU 20/2016, UU 24/2009). |
| Foto orang | sesuai sumber | `modelRelease` ber-hash atau `izin`; anak atau data sensitif wajib `persetujuanHukum`; hak potret (UU 28/2014 Pasal 12) dan UU 27/2022 perlu ditinjau. |
| Hasil AI | sesuai syarat layanan AI | `ai.status`, `alat`, tautan dan tanggal syarat layanan, kontribusi manusia; hasil murni AI belum jelas dapat dilindungi hak cipta di Indonesia (belum terverifikasi primer). |

Lisensi lain (GPL/AGPL, Ubuntu Font License, dan seterusnya) ditolak sampai ada keputusan pemilik, sejalan dengan aturan dependensi di bawah. Aset pihak ketiga di repo ini tidak ada; setiap aset dicatat di `templates/<nama>/ASET.md` dan `aset.json`.

## Aturan bagi kontributor

Ringkasan dari [AGENTS.md](../AGENTS.md) §Lisensi dan Aset:

- Dilarang membaca untuk menyalin atau mengadaptasi kode produk sejenis yang lisensinya membatasi (Remotion, dan repo tanpa lisensi).
- Dependensi baru wajib berlisensi permisif (MIT/Apache-2.0/BSD/ISC); copyleft perlu keputusan pemilik. Cek lisensi sebelum `bun add`.
- Setiap aset pihak ketiga dicatat di `templates/<nama>/ASET.md` (sumber, lisensi, tanggal).
- Atribusi mulberry32 di `scripts/runtime.js` dipertahankan.

## Changelog

### 2026-11-07 - v1.2.0

- Menambahkan bagian Aset: matriks lisensi (ringkas) dengan rujukan ke [aset.md](aset.md).

### 2026-11-07 - v1.1.0

- Menambahkan Material Components for Android (Apache-2.0, hanya nilai) ke daftar Pihak ketiga.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Lisensi dan Kepatuhan, §Pihak ketiga, §Tanggung jawab pengguna atas aset); isi dipertahankan.
- Menambahkan ringkasan Aturan bagi kontributor dari AGENTS.md dan rujukan ke aturan sumber klip.
