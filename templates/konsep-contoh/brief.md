# Brief: Mengelola tautan di portal (contoh fiktif)

_Dihasilkan oleh `bun run konsep -- brief` dari konsep.json (id `demo-sop-tautan`, skema versi 1). Jangan diedit tangan: ubah konsep.json lalu hasilkan ulang._

## Ringkasan

| Butir | Isi |
| --- | --- |
| Jenis | Panduan atau tutorial (`panduan`): Panduan langkah, tutorial, dan SOP bergambar. |
| Alur | Instruksional (`instruksional`): ADDIE dengan iterasi prototipe ala SAM untuk edukasi, panduan atau SOP, dan onboarding. |
| Tahap saat ini | T3 Develop 1: Design Proof (produksi) |
| Rasio dan resolusi | 16:9 (1920x1080) |
| Durasi | target 150 s, maksimum 360 s |
| fps | 30 |

## Latar dan tujuan

- Tujuan: Setelah menonton, staf dapat menambah tautan baru di portal latihan tanpa bantuan.
- Tujuan belajar:
  - Membuka menu tautan
  - Mengisi tiga bidang wajib
  - Memverifikasi tautan aktif
- Tujuan umum jenis ini: Memandu penonton menyelesaikan langkah demi langkah.

## Audiens dan konteks tonton

- Audiens: Staf baru unit layanan (peran fiktif untuk contoh)
- Bahasa: id
- Konteks tonton: laptop-kantor
- Ditonton tanpa suara: tidak
- Profil audiens: Umum (dewasa) (`umum`)
- Penyesuaian efektif (yang paling ketat dari preset dan profil; data/audiens.json): caption maksimal 17 cps; kontras teks minimal 4,5:1; kontras non-teks minimal 3:1; pengali ukuran teks 1; paling banyak 4 elemen informatif baru per adegan; pengali tempo adegan 1; pengali kecepatan narasi 1.
- Ukuran teks minimum: `ukuranTeks(tinggiFrame, peran, 1, konteks)` di runtime; konteks dari konteks tonton: laptop.

## Pesan utama

Menambah tautan baru hanya butuh tiga langkah.

## Nada dan bahasa

- Nada: percakapan
- Narasi: mode tts-lokal, gaya percakapan

## CTA

- Teks: Coba sekarang di portal latihan
- Tautan: -

## Struktur adegan

Wajib (urutan):

1. Tujuan dan prasyarat
2. Langkah bernomor (satu tindakan per adegan)
3. Hasil atau verifikasi
4. Kesalahan umum
5. Ringkasan

Umum (opsional):

- Pintasan papan ketik

## Preset terpilih dan tingkat bukti

Preset `panduan` dari data/jenis-video.json. Banyak nilai adalah keputusan desain, bukan hasil riset: kolom Bukti menyatakan asal tiap nilai, dan nilai yang ditimpa lewat `override` ditandai.

| Atribut | Nilai | Bukti | Rujukan |
| --- | --- | --- | --- |
| fps | 30 | pedoman-industri | Praktik umum 30 fps; YouTube Help 'Recommended upload encoding settings' menerima fps asli. |
| rasio | 16:9 | pedoman-industri | 16:9 adalah rasio bawaan platform video umum (YouTube). |
| rasioAlternatif | (tidak ada) | keputusan-desain | Rasio tambahan menurut saluran distribusi. |
| resolusi | 16:9 1920x1080 | pedoman-industri | 1080p umum (YouTube Help); platform vertikal meminta minimal 720p (TikTok for Business). |
| durasiTarget | 150 s | keputusan-desain | Tidak ada standar untuk jenis ini; target kerja yang boleh diubah. |
| durasiMaks | 360 s | bukti | Guo, Kim & Rubin (2014): keterlibatan menurun setelah sekitar 6 menit. |
| detikPerAdegan | 10 s | keputusan-desain | Tempo rata-rata, bukan nilai tetap; durasi adegan tidak boleh kurang dari durasiBaca(teks). Cutting dkk. (2010) hanya meneliti film naratif. |
| cps | 17 karakter/detik | pedoman-industri | Netflix Indonesian Timed Text Style Guide: subtitle dewasa 17 cps dan anak 13 cps; SDH dewasa 20 cps dan anak 17 cps. Preset memakai subtitle dewasa 17; profil audiens anak menurunkannya ke 13 (data/audiens.json). |
| burnIn | tidak (sidecar) | keputusan-desain | Sidecar .vtt/.srt adalah bawaan; burn-in dipilih bila penonton diperkirakan menonton tanpa suara. |
| modeCaption | pop-on | keputusan-desain | pop-on = satu cue tampil utuh (captionAktif); sorot-kata = penyorotan kata per kata, belum ada helper runtime. |
| transisi | sedang | keputusan-desain | Token durasi gerak Material Design 3 (150/300/500/800 ms); pilihan token per jenis adalah keputusan desain. |
| easing | masuk standar, keluar standar | keputusan-desain | Preset easing Material Design 3; pilihan per jenis adalah keputusan desain. |
| tipografi | judul 7%, isi 5%, caption 4,5% | keputusan-desain | Fraksi tinggi frame; tidak ada standar primer, validasi di layar ponsel. |
| palet | netral | keputusan-desain | Tidak ada bukti kuat untuk warna-emosi (Elliot & Maier 2014); tentukan dari identitas merek dan uji kontras. |
| kontrasMin | 4,5:1 | standar | WCAG 2.2 SC 1.4.3: kontras teks minimal 4,5:1. |
| musik | tidak | keputusan-desain | Tanpa musik mengikuti prinsip koherensi (Mayer 2021) untuk materi instruksional; penerapannya pada panduan adalah keputusan desain. |
| selisihNarasiMusikDb | - | keputusan-desain | Kepuasan memuncak sekitar +8,5 dB dialog terhadap latar (Sugimoto 2026; Ricketts 2026; riset terbatas); 12-14 dB adalah usulan rekayasa. |
| narasi | percakapan | keputusan-desain | Gaya bahasa narasi. |
| kenyaringan | web | pedoman-industri | Web -16 LUFS (AES TD1004/TD1008, rentang -14 sampai -20); siaran -23 LUFS (EBU R 128). |

Pilihan proyek pada konsep.json (menjadi acuan `bun run periksa --konsep`):

- Rasio 16:9; durasi target 150 s.
- Caption: sidecar, mode pop-on, 17 cps, bahasa ind.
- Musik: tidak.
- Kenyaringan: web (-16 LUFS).

## Transisi dan gerak

Preset transisi jenis `panduan` dari `scripts/transisi.js` (`Transisi.presetJenisVideo`); nilainya keputusan desain, bukan hasil riset (docs/transisi-animasi.md). Token durasi `transisi` (sedang) di tabel atas adalah tingkat kasar runtime dan terpisah dari preset ini.

- Profil gerak: `standar` (audiens.profil: umum).
- Efek berat (`gangguan`, grain hidup): mati untuk jenis ini (diganti `pudar`).
- Komposisi memilih profil lewat props: `bun run konsep -- preset konsep.json > preset.json`, lalu `render.mjs --props-file preset.json`; komposisi yang membaca `props.profil` (seperti galeri transisi) memakainya tanpa perubahan kode, dan `props.transisi` memuat preset per peran. Setel `kurangiGerak: true` di konsep.json untuk memaksa profil `kurangiGerak`.

| Peran | Preset | Efektif | Durasi efektif | Catatan |
| --- | --- | --- | --- | --- |
| antarAdegan | pudarMelalui 150 ms | pudarMelalui | 5 frame (167 ms pada 30 fps) | - |
| antarBagian | geser 300 ms, arah kiri | geser | 9 frame (300 ms pada 30 fps) | - |
| pembuka | pudar 400 ms | pudar | 12 frame (400 ms pada 30 fps) | - |
| penutup | pudar 400 ms | pudar | 12 frame (400 ms pada 30 fps) | - |

## Aturan teknis

- Caption: baris maksimal 42 karakter, maksimal 2 baris, 17 cps, durasi cue 5/6 sampai 7 detik (Netflix Timed Text Style Guide).
- Kenyaringan: -16 LUFS (AES TD1004/TD1008), true peak maksimal -1 dBTP.
- Kontras teks minimal 4,5:1 (batas bawah WCAG 2.2 SC 1.4.3: 4,5:1).
- Kilatan maksimal tiga per detik (WCAG 2.2 SC 2.3.1); area aman grafis 90% (EBU R 95).
- Encoding H.264 High, yuv420p, BT.709 rentang TV, faststart, AAC 48 kHz.

## Kepatuhan

Dari preset jenis:

- Tanpa kredensial atau data nyata (AGENTS.md aturan 4)
- Caption wajib (WCAG 2.2 SC 1.2.2)

Tingkat bukti kepatuhan: keputusan-desain. Aturan repo dan praktik; caption mengikuti WCAG 2.2 SC 1.2.2.

Isian proyek:

- Dasar hukum: [isi]
- Izin potret: tidak-ada-potret
- Klaim: tidak-ada
- Data nyata: tidak; sensitif: tidak

Pemeriksaan tambahan di luar `bun run periksa` (manual):

- [ ] Nomor langkah berurutan tanpa celah
- [ ] Setiap langkah punya sorot
- [ ] Tidak ada kredensial atau data nyata

Catatan hukum: Rujukan peraturan bukan nasihat hukum. Hanya Perpres 63/2019 Pasal 41 dan UU 28/2014 Pasal 12 yang dibaca dari teks peraturan; Etika Pariwara Indonesia, UU 8/1999, P3SPS, dan ketentuan kehumasan hanya dari sumber sekunder. Tim kepatuhan wajib memeriksa sebelum preset kepatuhan dijadikan aturan keras.

## Rencana alur dan gate

ADDIE dengan iterasi prototipe ala SAM untuk edukasi, panduan atau SOP, dan onboarding. Ronde review: 2; overhead sedang-tinggi; 7 gate.

Tingkat bukti alur: struktur tahap = buku-teks (ADDIE (Branch 2009) untuk struktur dan evaluasi; SAM (Allen & Sites 2012) untuk iterasi: Design Proof, Alpha, Beta, Gold. Isi desain mengikuti Mayer (2021); efek belum diuji untuk bahasa Indonesia.) Jumlah gate dan ronde = keputusan-desain (Jumlah gate, dua ronde review, dan satu uji pelajar adalah usulan awvd; jumlah penguji adalah keputusan proyek. Batasi jumlah iterasi agar tidak berputar tanpa akhir (risiko SAM menurut ulasan sekunder).)

### T1 Analyze: kebutuhan dan tujuan belajar (pra)

Kebutuhan, kesenjangan kinerja, audiens, pengetahuan awal, kendala (durasi, perangkat tonton), pengambil keputusan.

- Artefak: konsep.json (tujuanBelajar, audiens); brief.md
- RACI: R PM; A PS; C AH; I -
- Perintah:

```bash
bun run konsep -- baru --jenis J --alur A --out konsep.json
bun run konsep -- brief konsep.json --out brief.md
```

- [x] **GA Tujuan belajar** (gate, penyetuju PS) disetujui oleh PS pada 2026-11-07
  - [x] Tujuan belajar terukur (kata kerja teramati) disetujui PS dan AH
  - [x] Audiens, pengetahuan awal, perangkat tonton, dan kendala tercatat

### T2 Design: segmen, naskah, asesmen (pra)

Urutan segmen satu ide per segmen, pra-latih istilah, naskah percakapan, storyboard, pertanyaan cek; kerangka semua segmen dulu (breadth before depth).

- Artefak: naskah.json (props); still per adegan; rencana asesmen; sop.json (panduan atau SOP, bila fitur SOP tersedia)
- RACI: R PN; A AH; C PM; I -
- Perintah:

```bash
bun run render komposisi.html --still N --out still/adegan-N.png
```

- [x] **GD Desain** (gate, penyetuju AH) disetujui oleh AH pada 2026-11-07
  - [x] Satu ide per segmen; istilah dikenalkan sebelum dipakai
  - [x] Naskah percakapan; teks layar kata kunci dekat objek dan sinkron dengan narasi
  - [x] Elemen yang dibicarakan disorot; asesmen disusun
  - [x] AH menyetujui kebenaran isi

### T3 Develop 1: Design Proof (produksi) <- tahap saat ini

Satu segmen jadi dengan alat produksi akhir.

- Artefak: proof.mp4
- RACI: R DS; A PM; C AH; I -
- Perintah:

```bash
bun run render komposisi.html --skala 0.5 --audio sementara.wav --out rough.mp4
```

- [ ] **GV1 Design Proof** (gate, penyetuju PM)
  - [ ] Satu segmen selesai dengan alat produksi akhir
  - [ ] Gaya, tempo, dan teks layar disetujui

### T4 Develop 2: Alpha (produksi)

Semua konten dibuat dan dicek terhadap desain.

- Artefak: alpha.mp4
- RACI: R DS; A PM; C AH; I -
- Perintah:

```bash
bun run render komposisi.html --skala 1 --audio sementara.wav --subtitle caption.vtt --out fine.mp4
```

- [ ] **GV2 Alpha lengkap** (gate, penyetuju PM)
  - [ ] Semua segmen ada
  - [ ] Dicek terhadap rencana desain dan asesmen

### T5 Develop 3: Beta dan uji pelajar (produksi)

Revisi kesalahan; uji pada pelajar sasaran; catat temuan dan perbaiki.

- Artefak: beta.mp4; catatan uji
- RACI: R PM; A PM; C AH; I -
- Perintah:

```bash
bun run render komposisi.html --skala 1 --audio sementara.wav --subtitle caption.vtt --out fine.mp4
```

- [ ] **GV3 Beta diuji pelajar** (gate, penyetuju PM)
  - [ ] Diuji pelajar sasaran; kriteria lulus ditetapkan di Analyze
  - [ ] Temuan dicatat dan diperbaiki

### T6 Implement: QC dan rilis (pasca)

Caption wajib; periksa lolos; unggah ke LMS atau kanal beserta tautan latihan.

- Artefak: final.mp4; caption.vtt; atribusi.txt; ASET.md
- RACI: R QC, DS; A PS; C -; I -
- Perintah:

```bash
bun run render komposisi.html --skala 1 --audio narasi.wav --subtitle caption.vtt --out final.mp4
bun run periksa final.mp4 --konsep konsep.json --subtitle caption.vtt
```

- [ ] **GI Rilis** (gate, penyetuju PS)
  - [ ] Setiap segmen berdurasi 6 menit atau kurang
  - [ ] Caption ada
  - [ ] bun run periksa lolos

### T7 Evaluate: formatif dan sumatif (evaluasi)

Formatif (di Beta: tanya apa yang membingungkan) dan sumatif (skor uji atau kinerja); keputusan revisi atau arsip.

- Artefak: evaluasi.md
- RACI: R PM; A PS; C AH; I -

- [ ] **GE Evaluasi** (gate, penyetuju PS)
  - [ ] Laporan evaluasi formatif dan sumatif ada
  - [ ] Keputusan revisi atau arsip dicatat
  - [ ] Jumlah iterasi tidak melebihi batas yang disepakati

## Persetujuan

| Gate | Nama | Penyetuju diminta | Status | Oleh | Tanggal | Hash |
| --- | --- | --- | --- | --- | --- | --- |
| GA | Tujuan belajar | PS | disetujui | PS | 2026-11-07 | - |
| GD | Desain | AH | disetujui | AH | 2026-11-07 | - |
| GV1 | Design Proof | PM | menunggu | - | - | - |
| GV2 | Alpha lengkap | PM | menunggu | - | - | - |
| GV3 | Beta diuji pelajar | PM | menunggu | - | - | - |
| GI | Rilis | PS | menunggu | - | - | - |
| GE | Evaluasi | PS | menunggu | - | - | - |

## Kriteria selesai

- [ ] Tujuan belajar tercapai pada uji beta
- [ ] Setiap segmen 6 menit atau kurang
- [ ] Caption ada
- [ ] periksa lolos
- [ ] Laporan evaluasi ada
