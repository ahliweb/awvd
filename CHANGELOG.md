# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/). Versi paket di `package.json`: `0.1.0` (belum dirilis; belum ada tag).

## [Unreleased]

### Ditambahkan

- Renderer `scripts/render.mjs`: komposisi web -> MP4 H.264 lewat Chromium headless, PNG pipe, dan ffmpeg; mode `--still`, rentang `--dari`/`--sampai`, `--skala`, `--crf`, `--audio`, `--subtitle`, `--bahasa`, `--props`, `--browser`.
- Runtime `scripts/runtime.js`: `defineVideo`, `interpolasi`, `easing`, `pegas`, `urutan`, `fade`, `acak`, dan mode pratinjau `?preview`.
- Template `templates/contoh-dasar`.
- Uji otomatis `bun run uji` dan CI GitHub Actions `uji`.
- Dokumentasi: README, AGENTS.md, CLAUDE.md.
- Aturan dokumentasi di AGENTS.md §Dokumentasi: setiap perubahan konsep/fitur wajib disertai pembaruan dokumen, dengan peta pemicu dan checklist.
- Template PR `.github/pull_request_template.md` dan `templates/contoh-dasar/ASET.md`.
- Pedoman orchestrator di AGENTS.md beserta subagent `.claude/agents/pelaksana-kompleks.md` dan `pelaksana-sederhana.md`; bagian Skill, Git dan PR, serta Rilis dan Deployment.
- README: bagian Klasifikasi repo dan Rilis.
- Renderer: flag `--kenyaringan <web|siaran|mati>` (bawaan `web` bila ada `--audio`): normalisasi `loudnorm` dua-pass linear, web -16 LUFS / -1,5 dBTP, siaran -23 LUFS / -1 dBTP (EBU R 128). Setelah encode, kenyaringan hasil dilaporkan (`kenyaringan: I=.. LUFS, TP=.. dBTP`). Uji (i) dan penegasan baru di (a) dan (e).
- Helper runtime generik di `scripts/runtime.js` (murni dan deterministik; global dan `window.VideoTerprogram`): `areaAman` (area aksi 93% dan grafis 90%, EBU R 95), `ms` dan `durasi` (preset milidetik, token Material Design 3), preset `easing` `standar`/`percepat`/`perlambat`/`ditekankanMasuk`/`ditekankanKeluar`, `luminansRelatif`/`kontras`/`pilihTeksKontras` (WCAG 2.2 SC 1.4.3), `durasiBaca`, `pecahBaris`, `captionAktif` beserta `parseVtt`/`parseSrt` (burn-in caption deterministik di DOM), dan `berjenjang` (stagger). Easing dan API lama tidak berubah. Memengaruhi repo proyek: helper baru tersedia setelah naik versi, tanpa perubahan wajib.
- Uji unit `scripts/uji-runtime.mjs` (script `bun run uji:runtime`); `bun run uji` menjalankannya lebih dulu, lalu uji renderer.
- Alat QC pasca-render `scripts/periksa.mjs` (`bun run periksa <video.mp4>`): memeriksa encoding (H.264 High, yuv420p, BT.709 rentang TV, faststart, AAC 48 kHz; YouTube Help), kenyaringan (web -16 LUFS atau siaran -23 LUFS, true peak <= -1 dBTP; EBU R 128, AES TD1004/TD1008), kilatan fotosensitif umum dan merah (penyaringan konservatif WCAG 2.2 SC 2.3.1, bukan sertifikasi PEAT/Harding), subtitle `--subtitle` (Netflix Timed Text Style Guide: 42 karakter, 2 baris, cps, durasi cue, tumpang tindih), dan durasi `--jenis` (Guo, Kim & Rubin 2014). Flag `--kenyaringan`, `--jenis`, `--cps`, `--json`; exit 0 lolos, 1 gagal, 2 argumen salah. Uji `scripts/uji-periksa.mjs` (`bun run uji:periksa`) dijalankan oleh `bun run uji` di antara uji runtime dan uji renderer. Tanpa dependensi baru.
- SOP sebagai bahan dokumen dan video: `scripts/sop.mjs` (script `bun run sop`) memvalidasi `sop.json` secara fail-closed (kode keluar 2 dengan daftar galat, termasuk pemindai pola data pribadi) lalu menghasilkan `sop.html` (dokumen cetak A4 landscape berformat SOP AP menurut PermenPAN-RB 35/2012: identitas, matriks swimlane dengan lima simbol dan segilima penghubung antar halaman, lembar pengesahan), `sop.pdf` (`--pdf`, PDF bertag; tanpa klaim PDF/UA), `video-props.json` (adegan, jadwal deterministik dari `--cps`/`--wpm`, segmen 3-5 langkah dengan `--jeda-segmen`), dan `caption.vtt`. Modul perutean garis alir `scripts/sop-alir.js`, template `templates/sop` (diagram swimlane bertahap, sorotan langkah, caption burn-in) dengan `sop.json` fiktif, uji `scripts/uji-sop.mjs` (script `bun run uji:sop`; `bun run uji` menjalankannya sebelum uji renderer). Memengaruhi repo proyek: fitur baru, tanpa perubahan wajib; `render.mjs` dan `runtime.js` tidak berubah. Utang teknis: pencarian browser untuk `--pdf` menduplikasi `cariBrowser()` di `render.mjs`.
- Video di dalam video: `scripts/klip.mjs` (script `bun run klip`) memvalidasi manifest sumber (`sumber.json`: lisensi CC BY, CC BY-SA dengan `lisensiKeluaran` kompatibel, CC BY-NC bila nonkomersial, CC0, PDM, `STOK:<penyedia>` dengan bukti; ND, lisensi kosong atau tak dikenal, atribusi kosong, `sha256` tidak cocok, dan sumber HDR ditolak dengan kode keluar 2 sebelum Chromium diluncurkan), lalu mengekstrak frame JPEG/PNG per nomor frame komposisi lewat ffmpeg (matriks warna eksplisit dari tag ffprobe, tak bertag = bt709) ke cache berkunci `.cache/awvd/klip` (cache hit tidak mengekstrak ulang), menulis `klip-props.json`, `atribusi.txt` (format TASL), `props-gabungan.json` (`--gabung`), dan `audio.wav` per klip. Elemen `<video>` tidak dipakai.
- Timeline audio: `scripts/audio.mjs` (script `bun run audio`) merakit narasi induk, musik induk, dan audio klip menjadi satu WAV 48 kHz stereo deterministik dengan pemegang suara eksklusif: mode klip `bergantian` (gagal dengan rentang frame bila narasi tumpang tindih), `campur` (audio klip diturunkan 8..20 dB, bawaan 12, selama narasi), dan `bisu`; musik di-duck (bawaan 12 dB di bawah ucapan) dan dibisukan saat klip bergantian; fade 200 ms; penyamaan level per sumber (ebur128); tabel pemegang suara per rentang frame. Hasilnya diberikan ke `render.mjs --audio` (dinormalisasi `--kenyaringan`).
- Helper runtime (murni dan deterministik): `gambarKosong`, `indeksFrameKlip`, `jalurFrameKlip`, `klipGambar` (target `<canvas>` dianjurkan), `kreditKlip`, `angka`/`persen`/`rupiah` (format id-ID ditulis manual, `Rp1.000` tanpa spasi), dan `kenBurns`. API lama tidak berubah. Memengaruhi repo proyek: helper baru tersedia setelah naik versi, tanpa perubahan wajib.
- Template `templates/klip-tertanam` (PiP dengan dua klip buatan proyek, kredit TASL di layar dan kredit akhir, caption, rencana audio bergantian dan campur dengan narasi nada sinus, `buat-audio.mjs`, `ASET.md`) beserta dua klip kecil `.mkv` buatan sendiri (ffmpeg lavfi, CC0 dan CC BY milik proyek).
- Uji `scripts/uji-klip.mjs` (script `bun run uji:klip`; `bun run uji` menjalankannya setelah uji unit runtime): penolakan manifest, ekstraksi deterministik dan cache hit, PSNR area PiP pada video hasil render, validasi audio bergantian, level audio campur dan musik (-12 dB, ukur RMS), WAV identik antar-run, helper, dan templat (termasuk dua render identik).
- `.gitignore`: `.cache/`.

### Diubah

- Dokumentasi tidak lagi menyebut nama, path, atau tautan repo pedoman internal AhliWeb yang privat.
- Klasifikasi repo ditetapkan dan pengaturan GitHub (proteksi `main`, check wajib, merge commit saja) didokumentasikan.
- awvd ditetapkan hanya sebagai upstream (renderer, runtime, template contoh generik, uji), bukan repo proyek video. Pemakaian di repo proyek (dependensi git terkunci SHA, struktur repo proyek, naik versi, lisensi) didokumentasikan di README §Peran repo: upstream, dengan aturan 11 di AGENTS.md dan checklist baru di template PR. Tidak ada perubahan kode.

- Renderer: encode video kini mengonversi RGB ke YUV 4:2:0 BT.709 rentang TV secara eksplisit dan menandai metadata warna SDR BT.709; profil H.264 High, B-frame 2, GOP tertutup sepanjang setengah fps. Audio `--audio` kini AAC-LC 48 kHz stereo 384 kbps (sebelumnya 192k) dan dinormalisasi secara bawaan. Mengikuti YouTube Help "Recommended upload encoding settings", EBU R 128, dan AES TD1004/TD1008. Memengaruhi repo proyek: warna dan audio hasil render berubah (render ulang video yang terdampak; level audio bawaan kini -16 LUFS, gunakan `--kenyaringan mati` untuk perilaku lama).

### Diperbaiki

- Renderer: `--out` ke folder yang belum ada gagal di mode video (ffmpeg tidak membuat folder), sedangkan mode `--still` berhasil. Kini folder tujuan dibuat otomatis di kedua mode; uji (g) mencakup kasus ini. Memengaruhi repo proyek: tidak perlu lagi membuat `out/` sendiri.
