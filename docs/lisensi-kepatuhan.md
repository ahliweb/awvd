# Lisensi dan kepatuhan

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Dokumen baru dipindah dari README v1.10.0: lisensi MIT awvd, asal kode, pihak ketiga, dan tanggung jawab pengguna atas aset; ditambah ringkasan aturan lisensi dan aset dari AGENTS.md.`

Catatan hukum di dokumen ini bukan nasihat hukum.

## Lisensi awvd dan kepatuhan

- awvd berlisensi [MIT](../LICENSE).
- Kode awvd ditulis sendiri. awvd tidak memakai, tidak bergantung pada, dan tidak menyalin kode Remotion maupun remotion-dev/skills. Pemeriksaan 2026-11-07 membandingkan interpolasi, pegas, easing/bezier, dan PRNG dengan sumber Remotion: pendekatan dan implementasinya berbeda. Satu-satunya kesamaan adalah algoritma mulberry32, yang berstatus domain publik (atribusi di `scripts/runtime.js`).
- Konsep "video dari kode yang digambar per frame" adalah ide/metode, bukan ekspresi. Ide dan metode tidak dilindungi hak cipta (UU 28/2014 Pasal 41 huruf b; doktrin dikotomi ide-ekspresi).
- "Remotion" adalah merek milik pemiliknya. Nama itu disebut hanya untuk menjelaskan bahwa awvd tidak memakainya. Tidak ada afiliasi.

## Pihak ketiga

- **playwright-core 1.65.0:** Apache-2.0 (Microsoft). Dependensi npm, bukan kode yang disalin ke repo; LICENSE/NOTICE-nya ikut dalam paket.
- **Chromium/Chrome:** dipakai dari instalasi lokal dan tidak didistribusikan.
- **ffmpeg:** dipanggil sebagai program sistem lewat CLI dan tidak didistribusikan atau ditautkan, sehingga kewajiban LGPL/GPL (libx264) tidak berlaku untuk repo ini. Video keluaran tidak terkena GPL.
- **H.264:** lisensi paten AVC (dulu MPEG LA, kini Via LA) secara historis tidak memungut royalti untuk video internet yang gratis bagi pengguna akhir. Untuk distribusi berbayar, siaran, atau platform streaming komersial, cek ketentuan Via LA terbaru. Status 2026 belum diverifikasi dari halaman resmi.

## Tanggung jawab pengguna atas aset

Font, musik (`--audio`), gambar, footage, klip tertanam, dan suara TTS wajib berlisensi jelas dan dicatat sumbernya (klip tertanam divalidasi `klip.mjs`). Video yang memuat data pribadi tunduk pada UU 27/2022 tentang Pelindungan Data Pribadi (dasar pemrosesan atau persetujuan). Jangan pakai data nyata di contoh. TTS daring hanya untuk konten publik (DL-037).

Syarat lisensi sumber klip tertanam (CC BY, BY-SA, BY-NC, CC0, PDM, stok) dan lisensi keluaran ada di [video-tertanam-audio.md](video-tertanam-audio.md#aturan-sumber).

## Aturan bagi kontributor

Ringkasan dari [AGENTS.md](../AGENTS.md) §Lisensi dan Aset:

- Dilarang membaca untuk menyalin atau mengadaptasi kode produk sejenis yang lisensinya membatasi (Remotion, dan repo tanpa lisensi).
- Dependensi baru wajib berlisensi permisif (MIT/Apache-2.0/BSD/ISC); copyleft perlu keputusan pemilik. Cek lisensi sebelum `bun add`.
- Setiap aset pihak ketiga dicatat di `templates/<nama>/ASET.md` (sumber, lisensi, tanggal).
- Atribusi mulberry32 di `scripts/runtime.js` dipertahankan.

## Changelog

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Lisensi dan Kepatuhan, §Pihak ketiga, §Tanggung jawab pengguna atas aset); isi dipertahankan.
- Menambahkan ringkasan Aturan bagi kontributor dari AGENTS.md dan rujukan ke aturan sumber klip.
