# Lisensi dan kepatuhan

## Metadata

- Version: `v1.6.0`
- Last updated: `2026-11-08`
- Changeset: `Menambahkan bagian Model segmentasi latar (rancangan disetujui, belum diimplementasikan): MediaPipe Selfie Segmentation dan MODNet (Apache-2.0) disetujui, BiRefNet tidak didukung, RVM (GPL-3.0), BRIA RMBG, dan model AGPL ditolak; lisensi dicatat dari sumber asli. Sebelumnya: Menambahkan bagian ASR lokal (whisper.cpp): kode MIT dan bobot Whisper (MIT menurut README OpenAI; metadata Hugging Face mencatat MIT atau Apache-2.0), tidak dibundel, berjalan lokal sehingga boleh untuk naskah internal, kewajiban tinjauan hasil, pencatatan, dan baris whisper.cpp di Pihak ketiga.`

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
- **sherpa-onnx, Supertonic 3, Kokoro:** mesin dan model TTS opsional untuk `bun run narasi` (adaptor `scripts/narasi-tts.mjs`). Dipanggil sebagai program eksternal yang dipasang pengguna; **tidak dibundel, tidak didistribusikan, dan tidak ditautkan** oleh awvd. Lisensi dan syaratnya di [Model TTS dan OpenRAIL-M](#model-tts-dan-openrail-m).
- **whisper.cpp dan model Whisper (GGML):** ASR opsional untuk `bun run narasi` (adaptor `scripts/narasi-asr.mjs`). Dipanggil sebagai program eksternal yang dipasang pengguna; **tidak dibundel, tidak didistribusikan, dan tidak ditautkan** oleh awvd. Lisensi dan syaratnya di [ASR lokal (whisper.cpp)](#asr-lokal-whispercpp).
- **Chromium/Chrome:** dipakai dari instalasi lokal dan tidak didistribusikan.
- **ffmpeg:** dipanggil sebagai program sistem lewat CLI dan tidak didistribusikan atau ditautkan, sehingga kewajiban LGPL/GPL (libx264) tidak berlaku untuk repo ini. Video keluaran tidak terkena GPL.
- **H.264:** lisensi paten AVC (dulu MPEG LA, kini Via LA) secara historis tidak memungut royalti untuk video internet yang gratis bagi pengguna akhir. Untuk distribusi berbayar, siaran, atau platform streaming komersial, cek ketentuan Via LA terbaru. Status 2026 belum diverifikasi dari halaman resmi.

## Tanggung jawab pengguna atas aset

Font, musik (`--audio`), gambar, footage, klip tertanam, LUT warna (`.cube`), dan suara TTS wajib berlisensi jelas dan dicatat sumbernya (klip tertanam divalidasi `klip.mjs`). Video yang memuat data pribadi tunduk pada UU 27/2022 tentang Pelindungan Data Pribadi (dasar pemrosesan atau persetujuan). Jangan pakai data nyata di contoh. TTS daring hanya untuk konten publik (DL-037).

LUT warna dari pihak ketiga tunduk pada lisensinya sendiri (lihat [olah-klip.md](olah-klip.md#lisensi-dan-atribusi)).

Syarat lisensi sumber klip tertanam (CC BY, BY-SA, BY-NC, CC0, PDM, stok) dan lisensi keluaran ada di [video-tertanam-audio.md](video-tertanam-audio.md#aturan-sumber).

## Model TTS dan OpenRAIL-M

Adaptor TTS ([narasi-caption.md](narasi-caption.md#tts-lokal-sherpa-onnx)) bersifat opsional: pengguna mengunduh biner dan model sendiri, dan awvd tidak membundel bobot apa pun. Ringkasan di bawah dari lisensi dan kartu model yang dibaca pada riset 2026-11-07; ini bukan nasihat hukum, lisensi dapat berubah, dan teks lengkapnya wajib dibaca pemakai.

| Komponen | Lisensi | Hal yang relevan bagi pemakai awvd |
| --- | --- | --- |
| sherpa-onnx (CLI `sherpa-onnx-offline-tts`) | Apache-2.0 | Dipanggil sebagai program eksternal. Versi 2.x tidak memakai espeak-ng (GPL) sehingga tidak ada kewajiban copyleft dari jalur ini. |
| Supertonic 3 (Supertone), konversi int8 dari rilis sherpa-onnx | Contoh kode MIT; **bobot OpenRAIL-M** (BigScience Open RAIL-M, 2022-08-18) | Boleh komersial, tetapi membawa pembatasan penggunaan yang ikut berlaku bila bobot atau turunannya didistribusikan ulang (awvd tidak mendistribusikannya). Butir yang paling relevan: **(e) konten wajib dinyatakan sebagai buatan mesin**, **(l) dilarang untuk nasihat medis atau interpretasi hasil medis**, **(g) dilarang menirukan orang tanpa izin**; juga dilarang informasi palsu untuk mencelakai (c), keputusan otomatis yang merugikan hak hukum individu (h), dan administrasi peradilan atau penegakan hukum (m). Pemberi lisensi berhak membatasi penggunaan jarak jauh bila ada pelanggaran. Hak atas keluaran tidak diklaim pemberi lisensi; tanggung jawab atas keluaran ada pada pemakai. |
| Kokoro-82M v1.0 (hexgrad) | Apache-2.0 (kode dan bobot) | Tanpa pembatasan penggunaan seperti OpenRAIL-M. Kartu model menyatakan data pelatihan permisif tetapi mencakup audio sintetis dari TTS komersial tertutup (risiko sisa kecil, tercatat). Tidak mendukung bahasa Indonesia. |

Perwujudannya di awvd:

- **Label suara sintetis wajib** untuk setiap video bersuara TTS (butir e Supertonic; kebijakan awvd untuk mesin lain): `suara-kredit.json` dan `kredit-suara.txt` ([cara pelabelan](narasi-caption.md#label-suara-sintetis)).
- **Konten medis** tidak memakai bobot dengan larangan medis: `jenisKonten: "medis"` ditolak untuk Supertonic; gunakan rekaman manusia atau layanan daring untuk konten publik. Edukasi kesehatan umum berada di wilayah abu-abu dan diperingatkan ([konten medis](narasi-caption.md#konten-medis)). Keputusan pemilik 2026-11-07.
- **Tidak menirukan orang**: karakter wajib menyatakan `orangNyata`; `true` mewajibkan `izinBerkas`. Suara kustom atau kloning hanya dengan izin tertulis pemilik suara; rekaman suara orang diperlakukan hati-hati sebagai data pribadi (UU 27/2022; status hukum rekaman suara sebagai data pribadi belum diverifikasi).
- **Pencatatan**: catat versi mesin dan model, lisensinya, tanggal unduh, dan hash model di `ASET.md` repo proyek; `suara.json` memuat `lisensiKode`, `lisensiBobot`, `syaratPakai`, dan `sumber` yang dikeluarkan ke `suara-kredit.json`.
- **TTS daring** hanya untuk konten publik (aturan 5 AGENTS.md); mesin berpenanda `daring` ditolak untuk naskah berklasifikasi `internal`.
- Mesin lain (Piper dan suara turunannya, MMS-TTS, F5-TTS, XTTS) tidak didukung bawaan karena lisensi data atau bobotnya membatasi atau asal datanya tidak jelas (riset awvd 2026-11-07); `suara.json` kustom boleh mendaftarkannya atas tanggung jawab pemakai.

## ASR lokal (whisper.cpp)

Adaptor ASR ([narasi-caption.md](narasi-caption.md#asr-lokal-whispercpp)) bersifat opsional: pengguna membangun biner dan mengunduh model sendiri, dan awvd tidak membundel biner maupun bobot. Ringkasan di bawah dari berkas lisensi dan metadata yang dibaca pada riset 2026-11-07; ini bukan nasihat hukum, lisensi dapat berubah, dan teks lengkapnya wajib dibaca pemakai.

| Komponen | Lisensi | Hal yang relevan bagi pemakai awvd |
| --- | --- | --- |
| whisper.cpp (CLI `whisper-cli`, commit `727d3e7`) | MIT (berkas LICENSE: "Copyright (c) 2023-2026 The ggml authors") | Dipanggil sebagai program eksternal; tidak ada kewajiban copyleft. Dibangun sendiri oleh pengguna. |
| Bobot Whisper dalam format GGML (`ggml-base-q5_1.bin`, `ggml-small-q5_1.bin`) | MIT menurut README OpenAI Whisper (kode dan bobot); metadata Hugging Face `ggerganov/whisper.cpp` mencatat MIT dan metadata `openai/whisper-*` mencatat apache-2.0. Keduanya permisif | Tidak ada pembatasan penggunaan seperti OpenRAIL-M. Periksa lisensi pada halaman model yang Anda unduh; model hasil penyesuaian pihak ketiga punya lisensinya sendiri. |

Perwujudannya di awvd:

- **Lokal, bukan daring.** whisper.cpp berjalan di mesin pengguna tanpa jaringan; audio tidak keluar dari mesin. Karena itu ASR ini boleh dipakai untuk naskah dan rekaman berklasifikasi `internal`, tidak seperti ASR atau TTS daring yang hanya untuk konten publik (aturan 5 AGENTS.md). `laporan.json` mencatat `asr.lokal: true` dan `asr.daring: false`. Memilih biner atau model yang memanggil jaringan (mis. lewat pembungkus pihak ketiga) menjadi tanggung jawab pemakai.
- **Hasil ASR wajib ditinjau manusia** sebelum tayang: transkripsi dari audio tanpa naskah ditandai "hasil ASR, wajib ditinjau manusia" di VTT, `kata.json`, `laporan.json`, dan `PERLU-TINJAUAN.txt` ([aksesibilitas.md](aksesibilitas.md)).
- **Data pribadi.** Rekaman suara dapat memuat data pribadi (UU 27/2022; status hukum rekaman suara sebagai data pribadi belum diverifikasi). Pakai rekaman yang sah Anda miliki, dan perlakukan transkrip yang memuat data pribadi sebagai data pribadi.
- **Pencatatan**: catat versi whisper.cpp, nama dan hash model, lisensinya, dan tanggal unduh di `ASET.md` repo proyek; `laporan.json` mencatat nama dan ukuran model serta preset DTW.

## Model segmentasi latar (rancangan)

Status: **rancangan disetujui pemilik 2026-11-08, belum diimplementasikan** ([#88](https://github.com/ahliweb/awvd/issues/88), [#89](https://github.com/ahliweb/awvd/issues/89)). Fitur hapus latar lokal ([segmentasi-latar.md](segmentasi-latar.md)) bersifat opsional: `onnxruntime-node` (MIT) dan bobot model tidak dibundel. Ini bukan nasihat hukum; lisensi dibaca dari sumber asli penulis pada 2026-11-08 dan wajib dibaca ulang pemakai.

| Model | Putusan | Lisensi (sumber asli) |
| --- | --- | --- |
| MediaPipe Selfie Segmentation | Disetujui (registri bawaan) | Kode dan bobot Apache-2.0 (kartu model resmi) |
| MODNet | Disetujui (registri bawaan) | Kode dan bobot Apache-2.0 (README repo); data latih tidak dikaji, risiko sisa diterima pemilik |
| BiRefNet | Tidak didukung | MIT; ditolak karena tidak praktis di CPU, bukan karena lisensi |
| RobustVideoMatting | Ditolak | GPL-3.0 (copyleft) |
| BRIA RMBG | Ditolak | Lisensi "other", berbayar untuk komersial |
| Model keluarga YOLO-seg dan lain-lain berlisensi AGPL | Ditolak | AGPL-3.0 (copyleft) |

- Lisensi dicatat dari **sumber asli**, bukan dari label mirror ONNX komunitas di Hugging Face; satu mirror RVM berlabel `apache-2.0` keliru.
- Berjalan lokal: bingkai sumber tidak keluar dari mesin. Gambar orang tetap tunduk pada ketentuan "Foto orang" di bagian Aset di bawah (izin atau hak potret).
- Pemakai mencatat model, sha256, lisensi, dan tanggal unduh bobot di `ASET.md` repo proyek.
- Matriks lisensi lengkap (versi, sha256 kanonik, sumber) ditambahkan saat #88 diimplementasikan.

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

## Video pihak ketiga dan kutipan wajar

**Peringatan hukum.** awvd tidak menyediakan dan tidak akan menyediakan pengunduh atau perekam video platform (YouTube, TikTok, Facebook, Instagram, X, dan sejenisnya). Ketentuan layanan platform umumnya melarang pengunduhan dan akses otomatis di luar fitur resmi. Fitur sumber hanya menerima berkas yang sah dimiliki: milik sendiri, izin tertulis, lisensi terbuka (CC BY, CC BY-SA, CC0), stok berlisensi, atau arsip publik, dengan manifest `sumber.json` dan atribusi otomatis.

`KUTIPAN-WAJAR` (kritik, ulasan, pendidikan, penelitian, berita aktual) adalah klaim pengecualian hak cipta (UU 28/2014 Pasal 44; di yurisdiksi lain fair use atau fair dealing), **bukan lisensi**. awvd hanya memeriksa syarat terukur yang merupakan kebijakan internal (bukan batas hukum) dan mensyaratkan persetujuan peninjau hukum tercatat (gerbang `GH`). `bun run pelajari` mengekstrak statistik gaya dari berkas lokal yang sah dan tidak menyimpan frame, audio, atau teks sumber; menyalin naskah, karakter, musik, gaya grafis khas, atau merek tetap dilarang. Dokumentasi ini bukan nasihat hukum; konsultasikan ahli hukum sebelum menayangkan, terutama untuk penggunaan komersial, orang yang dapat dikenali, dan musik. Rincian: [pelajari-reaction.md](pelajari-reaction.md).

## Aturan bagi kontributor

Ringkasan dari [AGENTS.md](../AGENTS.md) §Lisensi dan Aset:

- Dilarang membaca untuk menyalin atau mengadaptasi kode produk sejenis yang lisensinya membatasi (Remotion, dan repo tanpa lisensi).
- Dependensi baru wajib berlisensi permisif (MIT/Apache-2.0/BSD/ISC); copyleft perlu keputusan pemilik. Cek lisensi sebelum `bun add`.
- Setiap aset pihak ketiga dicatat di `templates/<nama>/ASET.md` (sumber, lisensi, tanggal).
- Atribusi mulberry32 di `scripts/runtime.js` dipertahankan.

## Changelog

### 2026-11-08 - v1.6.0

- Menambahkan bagian Model segmentasi latar (rancangan): model yang disetujui dan ditolak, lisensi dari sumber asli, data pribadi; matriks lengkap menyusul di #88.

### 2026-11-07 - v1.5.0

- Menambahkan bagian ASR lokal (whisper.cpp): lisensi kode dan bobot, berjalan lokal (boleh untuk naskah internal), kewajiban tinjauan hasil, data pribadi, dan pencatatan; baris whisper.cpp di Pihak ketiga.

### 2026-11-07 - v1.4.0

- Bagian Model TTS dan OpenRAIL-M (sherpa-onnx, Supertonic 3, Kokoro; kewajiban label, larangan medis, izin suara, pencatatan) dan baris sherpa-onnx, Supertonic, Kokoro di Pihak ketiga.

### 2026-11-07 - v1.3.1

- Menyebut LUT warna sebagai aset berlisensi di Tanggung jawab pengguna atas aset.

### 2026-11-07 - v1.3.0

- Bagian baru Video pihak ketiga dan kutipan wajar (tanpa pengunduh platform, `KUTIPAN-WAJAR` bukan lisensi, gerbang GH, bukan nasihat hukum).

### 2026-11-07 - v1.2.0

- Menambahkan bagian Aset: matriks lisensi (ringkas) dengan rujukan ke [aset.md](aset.md).

### 2026-11-07 - v1.1.0

- Menambahkan Material Components for Android (Apache-2.0, hanya nilai) ke daftar Pihak ketiga.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Lisensi dan Kepatuhan, §Pihak ketiga, §Tanggung jawab pengguna atas aset); isi dipertahankan.
- Menambahkan ringkasan Aturan bagi kontributor dari AGENTS.md dan rujukan ke aturan sumber klip.
