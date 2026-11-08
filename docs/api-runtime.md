# Referensi API runtime

## Metadata

- Version: `v1.6.0`
- Last updated: `2026-11-08`
- Changeset: `Menambahkan keyframe(frame, titik, opsi): lintasan nilai (angka atau larik) dengan easing per segmen, memakai ulang easing runtime. Sebelumnya: pemetaan waktu klip.`

Referensi API `scripts/runtime.js`, yang dimuat komposisi lewat `<script src=".../scripts/runtime.js">`. Konsep komposisi dan protokol dengan renderer ada di [arsitektur.md](arsitektur.md); dasar riset dan checklist pemakaian helper ada di [pedoman-produksi.md](pedoman-produksi.md).

Transisi antar adegan dan animasi elemen berada di modul terpisah `scripts/transisi.js` (`window.Transisi`, dimuat setelah `runtime.js`); referensinya ada di [transisi-animasi.md](transisi-animasi.md). Runtime tidak berubah.

## Tabel API

Semua fungsi tersedia sebagai global dan di `window.VideoTerprogram`.

| API | Keterangan |
| --- | --- |
| `defineVideo({ width, height, fps, durationInFrames, render(frame, ctx) })` | Mendaftarkan komposisi dan membuat `window.video`. Semua angka wajib positif; `durationInFrames` bilangan bulat; `render` wajib fungsi. Melempar galat bila tidak valid. |
| `ctx` (argumen kedua `render`) | `{ fps, durationInFrames, width, height, props, detik }`; `detik = frame / fps`. |
| `window.video` | `{ width, height, fps, durationInFrames, renderFrame(n) }`. `renderFrame` membulatkan `n`, menolak di luar `0..durationInFrames-1`, dan menjalankan render secara berurutan (satu pada satu waktu). |
| `interpolasi(frame, masukan[], keluaran[], { clamp = true, easing })` | Pemetaan piecewise-linear. `masukan` naik tegas, panjang sama dengan `keluaran`, minimal 2 titik. `clamp: false` mengekstrapolasi linear. Easing hanya berlaku di dalam segmen. |
| `keyframe(frame, [{ pada, nilai, easing? }], { clamp = true, easing })` | Lintasan nilai sembarang properti dengan easing per segmen. `pada` = frame (angka terhingga, naik tegas, boleh pecahan); `nilai` = angka atau larik angka (panjang sama di semua titik, mis. `[x, y]` atau `[r, g, b]`; hasil larik baru tiap panggilan). `easing` pada titik i berlaku untuk segmen i ke i+1 dan berupa nama easing, `[x1, y1, x2, y2]`, atau fungsi; titik terakhir tidak boleh punya `easing`. Titik tanpa `easing` memakai `opsi.easing`, lalu linear. Nilai di setiap titik persis `nilai`-nya (tanpa galat pembulatan easing), di antara titik mengikuti easing segmen; `clamp: false` mengekstrapolasi linear dari segmen pertama atau terakhir. Argumen tak sah (kurang dari 2 titik, `pada` tak naik, tipe nilai campur, easing tak dikenal) melempar galat. Pemakaian ulang `easing.*`; murni dari frame. Contoh: `keyframe(frame, [{ pada: 0, nilai: [0, 0], easing: "keluarCubic" }, { pada: 30, nilai: [100, 40], easing: "linear" }, { pada: 60, nilai: [100, 0] }])`. |
| `easing.*` | `linear`, `masukQuad`, `keluarQuad`, `masukKeluarQuad`, `masukCubic`, `keluarCubic`, `masukKeluarCubic`, `masukBack`, `keluarBack`, `keluarElastis`, dan `bezier(x1, y1, x2, y2)` (setara `cubic-bezier` CSS). |
| `pegas(frame, fps, { dari = 0, ke = 1, kekakuan = 100, redaman = 10, massa = 1, tunda = 0 })` | Pegas teredam bentuk-tertutup, mulai diam; murni fungsi dari frame. |
| `urutan(frame, { dari = 0, durasi = Infinity })` | Segmen waktu: mengembalikan `{ aktif, lokal, progres }`. Aktif di `[dari, dari + durasi)`. |
| `fade(frame, durasiTotal, { masuk = 15, keluar = 15 })` | Opasitas 0..1: naik selama `masuk` frame pertama, turun selama `keluar` frame terakhir. |
| `acak(seed)` | PRNG ber-seed (mulberry32), seed angka atau string; mengembalikan fungsi `() => [0,1)`. Seed sama menghasilkan urutan sama. |
| `easing.standar`, `percepat`, `perlambat`, `ditekankanMasuk`, `ditekankanKeluar` | Preset easing bezier: `(0.2,0,0,1)`, `(0.3,0,1,1)`, `(0,0,0,1)`, `(0.05,0.7,0.1,1)`, `(0.3,0,0.8,0.15)`. Sumber: token easing Material Design 3. Easing lama tidak berubah. |
| `durasi.*` | Preset milidetik: `pendek` 150, `sedang` 300, `panjang` 500, `sangatPanjang` 800 (token durasi Material Design 3), `masuk` 300, `keluar` 200 (elemen masuk sedikit lebih lama dari keluar; NN/g, Laubheimer 2020). |
| `ms(milidetik, fps)` | Milidetik ke jumlah frame, dibulatkan ke terdekat (setengah naik); input > 0 minimal 1 frame, input 0 menghasilkan 0. Contoh `ms(durasi.sedang, ctx.fps)`; `ms(300, 30)` = 9. |
| `berjenjang(frame, indeks, { mulai = 0, jeda = 6 })` | Frame lokal elemen ke-`indeks`: `frame - mulai - indeks * jeda`. Untuk stagger satu ide per ketukan; negatif berarti belum mulai. |
| `areaAman(lebar, tinggi)` | `{ aksi: {x,y,w,h}, grafis: {x,y,w,h} }`. Area aksi 93% (margin 3,5% per sisi) dan grafis 90% (5% per sisi), EBU R 95 v1.1 (2017) catatan 5. Margin per sisi dibulatkan ke piksel terdekat (setengah naik), lalu dipakai simetris: `w = lebar - 2 * x`. Contoh 1920x1080: aksi `{67,38,1786,1004}`, grafis `{96,54,1728,972}`. |
| `luminansRelatif(warna)`, `kontras(a, b)` | Luminansi relatif dan rasio kontras 1..21 (tidak dibulatkan) menurut WCAG 2.2 SC 1.4.3. `warna` = `[r,g,b]` 0..255 atau `"#rgb"`/`"#rrggbb"`; format lain melempar galat. `kontras("#000","#fff")` = 21; `kontras("#777","#fff")` ≈ 4,48 (di bawah 4,5). |
| `pilihTeksKontras(latar)` | `"#000000"` atau `"#ffffff"`, mana yang rasio kontrasnya lebih tinggi terhadap `latar`. |
| `simulasiButaWarna(warna, jenis, keparahan = 1)` | `[r, g, b]` 0..255 (float, tidak dibulatkan) warna sebagaimana terlihat penonton `protanopia`, `deuteranopia`, atau `tritanopia`. Matriks Machado, Oliveira & Fernandes 2009 (keparahan 1,0) pada RGB linear; `keparahan` 0..1 diinterpolasi linear terhadap identitas (pendekatan). Putih dan hitam tetap. `jenis` atau `keparahan` tak sah melempar galat. |
| `keLab(warna)`, `bedaLab(lab1, lab2)`, `bedaWarna(a, b)` | `keLab` mengubah sRGB ke CIELAB (D65) `[L, a, b]`. `bedaLab` dan `bedaWarna` mengembalikan selisih warna CIEDE2000 (delta E00; Sharma, Wu & Dalal 2005; 0 = identik, hitam-putih = 100). Diuji terhadap data uji Sharma sampai 1e-3. |
| `periksaPalet(palet, { ambang = 10, latar, kontrasMin = 3 })` | Memeriksa palet kategorikal (>= 2 warna): untuk tiap pasangan, delta E00 dalam penglihatan normal dan tiga simulasi buta warna; pasangan di bawah `ambang` dilaporkan. Dengan `latar`, warna berkontras < `kontrasMin` terhadapnya juga dilaporkan (WCAG 2.2 SC 1.4.11, 3:1). Hasil: `{ lolos, minPerKondisi: { normal, protanopia, deuteranopia, tritanopia }, pasangan: [{ a, b, warnaA, warnaB, kondisi, deltaE }], lemahKontras: [{ i, warna, kontras }] }`. `ambang` 10 adalah keputusan desain, bukan standar. Tidak menggantikan redundansi bentuk atau teks (WCAG 1.4.1). |
| `paletOkabeIto` | Array 8 warna Okabe-Ito: `#000000`, `#E69F00`, `#56B4E9`, `#009E73`, `#F0E442`, `#0072B2`, `#D55E00`, `#CC79A7`. Hex dari praktik umum, belum diverifikasi dari teks primer. Hitam tidak berkontras dengan latar gelap. |
| `ukuranTeks(tinggiFrame, peran = "isi", audiens = "umum", konteks = "ponselLanskap")` | `{ px, persenTinggi, tinggiXDerajat }`: ukuran font minimum (dibulatkan, piksel pada bingkai setinggi `tinggiFrame`) agar tinggi-x memenuhi 0,2 derajat (Legge & Bigelow 2011) dikali pengali peran dan audiens. `peran`: `judul`, `subjudul`, `isi`, `caption`, `keterangan`. `audiens`: `umum`, `remaja`, `anak`, `lansia`, `lowVision`, atau pengali angka > 0. `konteks`: `tv`, `laptop`, `ponselLanskap`, `ponselVertikalPenuh`, `ponselPotret169`. Properti `ukuranTeks.konteks`, `.pengaliAudiens`, `.peran`, `.cpsDerajat`, `.rasioTinggiX` memuat tabel yang dipakainya. Geometri dan pengali adalah asumsi dan keputusan desain; lihat [visual-audiens.md](visual-audiens.md). |
| `durasiBaca(teks, { cps = 17, min = 5/6, maks = 7, fps })` | `{ detik }`, plus `frame` bila `fps` diberikan. Detik = karakter (termasuk spasi; spasi berurutan dirapikan) / `cps`, dijepit ke `[min, maks]`. Netflix Indonesian Timed Text Style Guide: subtitle dewasa 17 cps dan anak 13 cps; SDH (caption untuk tuli dan sulit dengar) dewasa 20 cps dan anak 17 cps. Bawaan 17 = subtitle dewasa; untuk anak pakai `cps: 13`. |
| `pecahBaris(teks, { maks = 42, baris = 2 })` | Mengembalikan **array** baris, dengan properti `melebihi` (boolean) pada array itu. Muat satu baris: satu elemen. Selain itu dipakai jumlah baris minimum dan potongan di spasi dengan prioritas: semua baris <= `maks`; baris atas bukan 1-2 kata; potongan setelah tanda baca (`, . ; : ? !`) atau sebelum kata sambung umum (dan, atau, tetapi, yang, untuk, dengan, di, ke, dari, karena, agar, sehingga); bentuk piramida terbalik (bawah >= atas); baris seimbang. Tidak muat dalam `baris` baris: `melebihi = true` dan array berisi seluruh teks dibungkus greedy (jumlah elemen bisa > `baris`; tidak ada teks hilang). Teks kosong menghasilkan `[]`. Pedoman: Netflix Timed Text Style Guide (maksimal 42 karakter per baris, dua baris). Properti `melebihi` hilang bila array diserialisasi JSON. |
| `captionAktif(cues, frame, fps)` | Cue aktif atau `null`. `cues` = array `{ mulai, akhir, teks }` dalam detik; aktif bila `mulai <= frame/fps < akhir`. Cue tumpang tindih: yang pertama dalam array. Untuk burn-in caption di DOM. |
| `presetJenis(nama)` | Salinan dalam preset jenis video (`formal`, `edukasi`, `kreatif`, `promo`, `produk`, `panduan`, `dokumenter`, `sosial`, `data`, `testimoni`, `psa`, `internal`, `acara`): `{ kunci, label, deskripsi, tujuan, alurBawaan, alurCocok, nilai, bukti, pemeriksaanTambahan }`. Data dimuat lewat `<script src=".../preset-jenis.js">` sebelum dipanggil (lihat [konsep-jenis-alur.md](konsep-jenis-alur.md#preset-di-komposisi-browser)); tanpa itu, atau untuk nama tak dikenal, melempar galat berpetunjuk. Murni dan deterministik. |
| `parseVtt(teks)`, `parseSrt(teks)` | Teks berkas ke array cues. Timestamp `hh:mm:ss.mmm` atau `mm:ss.mmm` (koma juga diterima). Header, `NOTE`, `STYLE`, nomor/id cue, dan pengaturan cue diabaikan; tag seperti `<i>` dan `<v Nama>` dibuang; `parseVtt` juga mengurai `&amp; &lt; &gt; &nbsp;`. Cue kosong atau berakhir sebelum mulai dibuang. |
| `areaAmanVertikal(lebar, tinggi)`, `areaCaption(lebar, tinggi)` | `{ x, y, w, h }`. `areaAmanVertikal` adalah area teks aman untuk video 9:16: pada 1080x1920 atas 250, bawah 480, kiri 65, kanan 120 px (diskalakan menurut lebar dan tinggi, dibulatkan, lalu diiriskan dengan area aksi EBU R 95), jadi `{65, 250, 895, 1190}`; menghindari zona antarmuka Reels, Shorts, dan TikTok. Angka zona platform berasal dari sumber sekunder yang saling berbeda dan belum diverifikasi dari spesifikasi resmi, jadi periksa terhadap templat platform saat produksi. `areaCaption` = area caption bawaan: `areaAmanVertikal` bila `tinggi > lebar`, selain itu `areaAman(...).aksi`. |
| `rencanaCaption({ cues, kata, lebar, tinggi, fps, mode = "pop-on", posisi = "bawah", zona, jangkar, area, maksKarakter, maksBaris = 2, ukuranFont, lebarKarakter = 0.6, audiens, konteks, latar = { warna: "#000000", alfa: 0.75 }, warnaTeks, sorot = "#ffd400", sorotTeks })` | Menyusun **rencana** tampil caption (objek JSON murni, dihitung sekali di luar `render`). `cues` = hasil `parseVtt`/`parseSrt` (`{ mulai, akhir, teks }` detik; boleh `mulaiFrame`/`akhirFrame`). `kata` = `kata.json` dari `bun run narasi` (atau arraynya): dipetakan ke cue lewat nomor `cue`, atau lewat waktu bila tak ada; label penutur `[Nama]` di awal teks cue dikenali dan tidak diberi waktu sendiri. Tanpa `kata`, atau bila jumlah kata tidak sama dengan teks cue (peringatan), waktu kata dibagi proporsional menurut karakter sepanjang cue (estimasi kasar; sorot kata dan paint-on presisi butuh stempel kata nyata). **Mode**: `pop-on` (blok utuh), `roll-up` (jendela dua baris; baris baru menggulir naik saat kata pertamanya mulai), `paint-on` (huruf muncul menurut stempel kata), `sorot-kata` (kalimat penuh tampil, kata yang sedang diucapkan disorot), `satu-kata` (satu kata besar per saat). **Posisi**: `bawah`, `atas`, `auto`, `dekat-penutur`. `zona` = array `{ area: "bawah", dari = 0, sampai }` (atau `"atas"`) atau `{ kotak: { x, y, w, h }, dari, sampai }` (frame absolut, `sampai` eksklusif): area penting yang tidak boleh tertutup. `auto` memilih bawah, naik ke atas bila ada zona yang beririsan dengan kotak bawah selama cue dan atas bebas, dan bila keduanya tertutup tetap bawah dengan peringatan. Keputusan posisi per cue, bukan per frame, jadi kotak tidak melompat di tengah cue. `jangkar` = `{ x, y, dari, sampai, penutur }` atau array-nya: **titik pusat kotak caption** untuk `dekat-penutur` (dijepit ke area; entri pertama yang cocok pada awal cue; awvd tidak mendeteksi penutur, jangkar ditentukan penulis); tanpa jangkar yang cocok jatuh ke bawah dengan peringatan. Bukti manfaat caption dekat penutur kecil dan terbelah, jadi ini opsi eksplisit, bukan bawaan. Ukuran font = `min(batas lebar, max(minimum ukuranTeks "caption", 5,5% tinggi (lanskap) atau 3,8% (potret)))`; batas lebar menjamin `maksKarakter` (bawaan 42, 28 pada potret) karakter muat di area dengan taksiran `lebarKarakter` em per karakter (0,6 cukup untuk kalimat biasa; font lebar atau huruf lebar butuh nilai lebih besar). Latar kotak dan teks: teks = `pilihTeksKontras(latar.warna)` kecuali `warnaTeks`; `kontras` pada hasil memuat rasio terburuk di atas gambar hitam maupun putih (ambang 4,5:1, WCAG 2.2 SC 1.4.3); teks sorot dipilih serupa. Hasil: `{ versi, mode, posisi, lebar, tinggi, fps, potret, area, maksKarakter, maksBaris, lebarKarakter, ukuranFont, ukuranFontMin, tinggiBaris, padX, padY, warna, kontras, cue[{ n, mulaiFrame, akhirFrame, teks, penutur, posisi, kotak, sumberKata, baris, kata }], peringatan[] }`. Argumen salah melempar galat; kondisi yang masih bisa dirender (teks tak muat, zona bentrok, kontras rendah, font di bawah minimum) menjadi `peringatan`. |
| `keadaanCaption(rencana, frame)` | `null` bila tak ada cue aktif; selain itu `{ n, mode, posisi, kotak, ukuranFont, tinggiBaris, padX, padY, warna, aktifKata, baris: [{ y, opasitas, kata: [{ teks, terlihat, sorot }] }] }` untuk frame itu. `terlihat` = jumlah karakter yang sudah tampil (paint-on). Roll-up: baris yang masuk dan keluar menggulir selama sekitar 0,12 detik dihitung dari nomor frame; paling banyak dua baris stabil. Murni dari `rencana` dan `frame` (tanpa keadaan tersembunyi; rencana boleh diserialisasi JSON dulu). |
| `captionHtml(keadaan, gaya = {})` | String HTML satu elemen `position:absolute` di koordinat bingkai (`""` bila `keadaan` null); sisipkan ke elemen seukuran bingkai. Teks di-escape; tanpa animasi atau transisi CSS (semua nilai dari frame); sorot kata memakai `box-shadow` sebaran sehingga tata letak tidak bergeser; karakter paint-on yang belum tampil memakai `visibility:hidden` agar teks tidak bergeser. Roll-up memotong keluar-masuk baris dengan `clip-path` vertikal. `gaya`: `{ fontFamily, bobot = 600, radius, bayangan = true }`. Contoh: `el.innerHTML = captionHtml(keadaanCaption(rencana, frame))`. Demo semua mode dan posisi: [narasi-caption.md](narasi-caption.md#mode-dan-posisi-caption). |
| `gambarKosong` | String `data:` URI GIF 1x1 transparan, `src` awal untuk target `<img>` (renderer menolak `<img>` tanpa gambar termuat saat halaman dibuka). Target `<canvas>` tidak membutuhkannya. |
| `indeksFrameKlip(klip, frameLokal, { ulang = false, kecepatan = 1, waktu, durasi, dari })` | Indeks frame sumber (0 = frame pertama klip) untuk frame lokal klip. Tanpa `waktu`: `floor(frameLokal * kecepatan)`; negatif menghasilkan `-1` (belum mulai); melewati akhir ditahan di frame terakhir, atau diulang bila `ulang: true` (perilaku ini tidak berubah). Dengan `waktu`: trim, speed konstan atau ramp, reverse, dan freeze lewat aritmetika bilangan bulat, dengan `habis` dari `waktu.habis`; lihat [Pemetaan waktu klip](#pemetaan-waktu-klip). Frame diekstrak pada fps komposisi, jadi `kecepatan` <> 1 menduplikasi atau melewati frame tanpa interpolasi. |
| `petaWaktuKlip(waktu, durasi)` | Larik `durasi` bilangan bulat: offset frame sumber (0 = titik masuk `dari`) untuk tiap frame lokal `0..durasi-1`. `waktu = { kecepatan = 1 \| [{ pada, nilai, easing? }], balik = false, bekukan = false }`. Murni; melempar galat untuk masukan tidak valid. Lihat [Pemetaan waktu klip](#pemetaan-waktu-klip). |
| `frameSumber(waktu, frameLokal, { durasi, dari = 0 })` | Satu frame sumber: `dari + offset(frameLokal)`, hasil yang sama dengan `dari + petaWaktuKlip(waktu, durasi)[frameLokal]`. `durasi` wajib bila `waktu.balik`. Tidak menerapkan `waktu.habis` (itu tugas `indeksFrameKlip`). |
| `kecepatanPermil(x)` | Kecepatan ke bilangan bulat permil (`1.5` jadi `1500`). Melempar galat bila `x` bukan angka dalam `(0, 1000]` atau lebih dari 3 desimal. Dipakai pemetaan waktu; diekspor agar modul lain (misalnya `scripts/timeline.mjs`) memakai pembulatan yang sama. |
| `jalurFrameKlip(klip, frameLokal, opsi)` | URL gambar frame (`akar/folder/000123.jpg`) atau `null` bila belum mulai. `klip` datang dari `klip-props.json` (props `klip[]`). |
| `klipGambar(target, klip, frameLokal, opsi)` | `async`; menggambar frame klip ke `target` lalu menunggu siap, jadi `await klipGambar(...)` di dalam `render` menjamin frame tergambar sebelum screenshot. Mengembalikan `false` (target tidak disentuh) bila belum mulai; melempar galat bila berkas frame tidak termuat. Target `<canvas>` (**dianjurkan**): `Image` lepas didekode (`decode()`) lalu digambar sinkron dengan `drawImage` pada ukuran aslinya. Target `<img>`: `src` diganti lalu `decode()` ditunggu; pada uji, screenshot kadang masih memuat frame sebelumnya (pengecatan gambar baru asinkron), jadi tidak deterministik. |
| `kreditKlip(klip, { ringkas = true })` | Atribusi TASL dari `klip.atribusi`. Ringkas (untuk layar): `"Judul" oleh Pencipta · CC BY 4.0 · diubah`. `ringkas: false` (kredit akhir): `"Judul" oleh Pencipta. Sumber: URL. Lisensi: CC BY 4.0 (URL lisensi). Diubah: ....` Sama persis dengan baris di `atribusi.txt`. |
| `angka(n, { desimal })`, `persen(n, { desimal })`, `rupiah(n, { desimal = 0 })` | Format Indonesia, ditulis manual (bukan `Intl`) agar hasil sama di semua mesin: titik ribuan, koma desimal. `angka(1234567.891)` = `1.234.567,891`; tanpa `desimal` sampai 3 desimal tanpa nol berekor, dengan `desimal` tepat sekian digit. `persen(0.256)` = `25,6%` (n pecahan, tanpa spasi). `rupiah(1500000)` = `Rp1.500.000` (tanpa spasi setelah Rp, negatif `-Rp1.500`). Pembulatan setengah menjauhi nol pada representasi desimal terpendek: `angka(1.005, { desimal: 2 })` = `1,01`. `NaN`, tak hingga, dan nilai >= 1e21 melempar galat. Sumber aturan Rp tanpa spasi: EYD Edisi V (Badan Bahasa, 2022), hanya sumber sekunder; dokumen resmi belum dibaca. |
| `asetGambar(id, { props, ctx, akar, teksAlternatif, target })` | `Promise` info aset `{ id, jenis, url, lebar, tinggi, rasio, fokus, fit, objectPosition, alt, dekoratif }` dari `aset-props.json` (`props` harus memuat kunci `aset`; `ctx` = jalan pintas `props` dari argumen kedua `render`; `akar` = awalan URL untuk `jalur`). Untuk jenis `gambar`, `svg`, `logo`, `ikon`. Ditolak (promise galat) bila id tak ada, jenis salah, `jalur` bukan berkas lokal relatif, atau aset informatif tanpa `teksAlternatif` (WCAG 1.1.1). Dengan `target` (`<img>`), memasangnya lewat `pasangGambar` dan menunggu decode. Rincian dan aturannya di [aset.md](aset.md#helper-runtime). |
| `pasangGambar(target, deskriptor)` | `Promise<true>`. Memasang deskriptor dari `asetGambar`, `logo`, atau `ikon` ke elemen `<img>`: `src` (tidak ditulis ulang bila sama), `alt`, `aria-hidden` (dekoratif), `position/left/top` dan `width/height` bila deskriptor memuat `x,y,w,h`, `object-fit`, `object-position`, `opacity`, `filter`; lalu menunggu `decode()`. Target selain `<img>` ditolak (aset tidak pernah disisipkan inline); decode gagal = galat berisi URL. Menyentuh hanya elemen yang diberikan. |
| `logo(id, posisi, { props, ctx, lebar, tinggi, ukuran = 10, opacity = 1, latar, varian, akar })` | Murni. `{ id, jenis, url, x, y, w, h, opacity, alt, dekoratif, rasio, posisi, clearSpace, fit: "contain", ukuranMinPx }` (px komposisi). `posisi`: `kiri-atas`, `kanan-atas`, `kiri-bawah`, `kanan-bawah`, `tengah` di dalam `areaAman(lebar, tinggi).grafis`. `ukuran` = persen lebar frame (0..100]; `w = round(lebar * ukuran / 100)`, `h = round(w / rasio)`, jadi rasio terkunci dan tidak ada rotasi/regang (`rotasi`, `regang`, `miring` melempar galat). Aturan `merek.aturan`: `w < ukuranMinPx` melempar (tidak dijepit); `clearSpace` (satuan tinggi atau lebar, dibulatkan ke atas) menjadi margin dari tepi area aman; kotak + clear space harus muat di area aman; `larangan` berisi `transparansi` menolak `opacity < 1`. `latar` (`[r,g,b]` atau hex): kontras >= 3:1 (WCAG 2.2 SC 1.4.11) terhadap setidaknya satu warna di `warnaDiizinkan`, dan dengan `varian: { diLatarTerang, diLatarGelap }` memilih id varian menurut luminans latar (latar terang bila kontras dengan hitam >= dengan putih). Ukuran frame wajib (`lebar`/`tinggi` atau `ctx`). Contoh 1920x1080, `ukuran: 10`, logo rasio 3 dengan clear space 0,25 tinggi: kotak 192x64, clear space 16, kiri-atas di (112, 70). Angka bawaan 10% dan ambang 3:1 adalah keputusan desain. |
| `ikon(id, { props, ctx, ukuran = 24, warna, akar, teksAlternatif })` | Murni. `{ id, jenis, url, w, h, alt, dekoratif, rasio, filter, fit: "contain" }`. `ukuran` = sisi terpanjang (px), sisi lain mengikuti rasio. `warna`: hanya `"putih"` (`filter: brightness(0) invert(1)`) atau `"hitam"` (`brightness(0)`); lainnya melempar galat. Ikon tanpa `peran` dan tanpa `teksAlternatif` dianggap dekoratif (alt kosong, `aria-hidden`); `peran: "informatif"` tanpa teks melempar galat. |
| `kreditAset(ids, { props, ctx, ringkas = true, tampil })` | Teks atribusi aset, satu baris per aset dipisah `\n`. `ids`: `"semua"` (aset yang `atribusi.tampil`-nya `layar` atau `akhir`, urutan manifest; `tampil` menyaring salah satunya), satu id, atau array id (urutan array dipertahankan, id ganda dibuang). `ringkas: true` (layar): `"Judul" oleh Pencipta · CC BY 4.0 · diubah` (kata "diubah" hanya bila `perubahan` bukan `tidak ada`; `MILIK-SENDIRI` tampil `Milik sendiri`). `ringkas: false` (kredit akhir): `atribusi.kredit` dari manifest apa adanya, sama dengan baris di `atribusi.txt`; bila entri tak membawa `kredit`, dibangun dengan format yang sama dengan `bun run aset` (uji membandingkan keduanya). Id tak ada atau entri tanpa `atribusi` = galat; tanpa aset yang perlu dikreditkan = `""`. Beda dengan `kreditKlip`: `perubahan` `tidak ada` tidak menghasilkan "diubah". |
| `pasangFont(ids, { props, ctx, akar })` | `Promise<string[]>` famili yang termuat. Membuat `FontFace(famili, url("...") format("..."), { weight, style, display: "block" })` dari entri `font` (`format`: `woff2`, `woff`, `ttf`, `otf`), menambahkannya ke `document.fonts`, dan menunggu `load()`. Idempoten per famili/bobot/gaya/URL (aman dipanggil di tiap `render`). Gagal dimuat = galat `font gagal dimuat: "Famili" (url)` dan face dibuang; di luar browser (tanpa `FontFace`) = galat jelas. `ids`: `"semua"` (semua aset font), satu id, atau array. Menyentuh hanya `document.fonts`. |
| `kenBurns(frame, { mulai = 0, durasi, dari: {x,y,skala}, ke: {x,y,skala}, easing })` | Nilai CSS `transform` (`translate(..%, ..%) scale(..)`) untuk pan dan zoom foto diam di dalam wadah `overflow:hidden`. `x`,`y` = titik pusat tampilan (0..1, bawaan 0,5), `skala >= 1` (bawaan 1 lalu 1,2); pusat dijepit agar tepi gambar tidak terbuka. Sebelum `mulai` = `dari`, sesudah `mulai + durasi` = `ke`; easing bawaan linear. Murni dari frame. Hanya gaya estetika: tidak ditemukan bukti eksperimen bahwa efek ini memengaruhi pemahaman atau atensi; parameter (zoom 1,0 ke 1,1-1,3, gerak lambat) adalah praktik. |

Semua helper di atas murni (tanpa `Date`, `Math.random`, atau timer), jadi aman dipakai di `render`. Pengecualian yang menyentuh DOM hanya lewat objek yang diberikan: `klipGambar` (target gambar), `pasangGambar` (elemen `<img>`), dan `pasangFont` (`document.fonts`); ketiganya deterministik karena `render` menunggunya sebelum tangkapan.

## Pemetaan waktu klip

`petaWaktuKlip`, `frameSumber`, dan `indeksFrameKlip` (dengan `waktu`) memetakan **frame lokal** butir video ke **frame sumber** klip untuk empat operasi umum penyuntingan. Semuanya murni: hasil satu frame hanya bergantung pada argumennya (tanpa keadaan antar-frame), sehingga render rentang (`--dari`), render penuh, dan render paralel menghasilkan indeks yang sama. Tidak ada interpolasi gerak: speed <> 1 menduplikasi atau melewati frame.

Aritmetika memakai **bilangan bulat dan permil** (`1,5x` = `1500`), bukan float, karena `Math.floor(100 * 0.29)` bernilai `28` padahal hasil yang benar `29`.

| Operasi | Cara memakai | Rumus (frame lokal `f`, `S` = kecepatan dalam permil) |
| --- | --- | --- |
| Trim | `dari` (frame klip tempat membaca mulai); frame keluar tidak disimpan, ia turunan (`dari` + jangkauan) | frame sumber = `dari + offset(f)` |
| Speed konstan | `waktu.kecepatan` angka, maksimal 3 desimal | `offset(f) = floor(f * S / 1000)`; sama dengan `indeksFrameKlip` tanpa `waktu` |
| Speed ramp | `waktu.kecepatan` larik keyframe `[{ pada, nilai, easing? }]` | `posisi(0) = 0`, `posisi(f+1) = posisi(f) + v(f)`, `offset(f) = floor(posisi(f) / 1000)` |
| Reverse | `waktu.balik: true` (butuh `durasi`) | `offset_balik(f) = offset(durasi - 1 - f)`: deret maju dibalik, himpunan frame sama |
| Freeze | `waktu.bekukan: true` | `offset(f) = 0`: frame `dari` ditahan sepanjang durasi |

Aturan:

- `kecepatan` harus `> 0` dan `<= 1000`, maksimal 3 desimal (`0.29`, `1.5`, `3.333` sah; `1.2345` ditolak). Bawaan 1.
- Ramp: keyframe `pada` bilangan bulat `>= 0` dan naik tegas, minimal 2; `nilai` mengikuti aturan kecepatan; `easing` (nama easing runtime, `[x1, y1, x2, y2]`, atau fungsi) berlaku pada segmen yang dimulai di keyframe itu dan dilarang pada keyframe terakhir. Sebelum keyframe pertama dan sesudah yang terakhir kecepatan ditahan. Kecepatan per frame `v(f)` dibulatkan ke permil terdekat (setengah naik); segmen linear dihitung eksak dengan bilangan bulat. Ramp selalu monoton tak turun karena kecepatan `> 0` di tiap frame (galat bila easing membuatnya `<= 0`).
- `bekukan` tidak dapat digabung dengan `balik`; `kecepatan` diabaikan saat `bekukan`.
- Lewat akhir klip (`dari + offset >= klip.jumlah`): `waktu.habis` = `tolak` (bawaan; melempar galat), `tahan` (frame terakhir), atau `ulang` (modulo `jumlah`). Ini hanya dijalankan `indeksFrameKlip`.
- `indeksFrameKlip` dengan `waktu` menolak frame lokal pecahan, menolak `opsi.kecepatan` atau `opsi.ulang` (pakai `waktu.kecepatan` dan `waktu.habis`), dan tetap mengembalikan `-1` untuk frame negatif. `jalurFrameKlip` dan `klipGambar` meneruskan opsi yang sama.
- `frameSumber` untuk ramp menghitung dari frame 0 tiap panggilan; untuk banyak frame hitung tabel sekali dengan `petaWaktuKlip` lalu indeks.

```js
const ramp = { kecepatan: [{ pada: 0, nilai: 1 }, { pada: 60, nilai: 3 }] }; // ramp 1x -> 3x
// di dalam render(frame): frame lokal klip = frame - mulai
await klipGambar(kanvas, klip, frame - mulai, { waktu: ramp, dari: 120 });
// reverse: butuh durasi butir
await klipGambar(kanvas, klip, frame - mulai, { waktu: { balik: true }, durasi: 90, dari: 30 });
// tabel offset sekali, di luar render (untuk memeriksa rentang atau banyak frame)
const peta = petaWaktuKlip(ramp, 61); // peta[60] === 119, frame sumber terbesar = 120 + 119
```

**Audio tidak ikut berubah.** `scripts/audio.mjs` tidak meregangkan waktu, jadi klip yang waktunya bukan identitas (speed <> 1, ramp, reverse, freeze) harus dibisukan di rencana audio agar suara tidak lepas dari gambar.

## Mode URL

Mode URL (tanpa query: diam menunggu renderer): `?preview`, `?frame=N`, `?props={...}`.

## Sumber riset

Sumber tiap helper (rincian dan tingkat buktinya ada di baris tabel di atas dan di [pedoman-produksi.md](pedoman-produksi.md)):

| Helper | Sumber |
| --- | --- |
| `areaAman` | EBU R 95 v1.1 (2017), catatan 5 |
| `easing.standar` dan preset sejenis, `durasi.pendek`..`sangatPanjang` | Token Material Design 3 |
| `durasi.masuk`, `durasi.keluar` | NN/g (Laubheimer 2020) |
| `luminansRelatif`, `kontras`, `pilihTeksKontras` | WCAG 2.2 SC 1.4.3 |
| `simulasiButaWarna` | Machado, Oliveira & Fernandes 2009 (IEEE TVCG 15(6)); matriks dibaca dari halaman sumbernya |
| `keLab`, `bedaLab`, `bedaWarna` | CIEDE2000, Sharma, Wu & Dalal 2005; titik putih D65 |
| `periksaPalet` | WCAG 2.2 SC 1.4.1 dan 1.4.11 (standar); ambang delta E00 10 keputusan desain |
| `paletOkabeIto` | Okabe & Ito, Color Universal Design (jfly); hex dari praktik umum |
| `ukuranTeks` | Legge & Bigelow 2011 (ukuran cetak kritis); pengali dan geometri keputusan desain ([visual-audiens.md](visual-audiens.md)) |
| `durasiBaca`, `pecahBaris`, `captionAktif`, `parseVtt`, `parseSrt` | Netflix Timed Text Style Guide |
| `areaAmanVertikal`, `areaCaption` | EBU R 95 (area aksi); zona antarmuka platform vertikal dari sumber sekunder, belum diverifikasi: keputusan desain konservatif |
| `rencanaCaption`, `keadaanCaption`, `captionHtml` | Mode pop-on, roll-up, paint-on: 47 CFR 79.103(c)(1); posisi dan penghindaran grafis: 47 CFR 79.1(j)(2)(iv), Netflix Timed Text Style Guide, DCMP Captioning Key; dekat penutur: Hu dkk. 2015, Kurzhals dkk. 2017 (bukti kecil dan terbelah); sorot kata: Weingärtner dkk. 2024 (konteks pembelajar bahasa); satu kata: bukti pemahaman menurun pada laju tinggi. Ukuran font, 5,5% dan 3,8% tinggi, padding, taksiran 0,6 em, dan lebar sorot adalah keputusan desain awvd (praktik, bukan standar). Rincian dan batas bukti di [narasi-caption.md](narasi-caption.md#mode-dan-posisi-caption) |
| `angka`, `persen`, `rupiah` | EYD Edisi V (Badan Bahasa, 2022), sumber sekunder |
| `kenBurns` | Praktik; tidak ada bukti eksperimen |
| `petaWaktuKlip`, `frameSumber`, `kecepatanPermil` | Karya asli awvd (riset timeline, issue #30): aritmetika bilangan bulat dan permil; uji batas dan properti ber-seed di `scripts/uji-runtime.mjs` |
| `logo` | EBU R 95 (area aman); WCAG 2.2 SC 1.4.11 (kontras 3:1) dan SC 1.4.5 (logotype boleh gambar teks); ukuran bawaan 10% dan pembulatan: keputusan desain; clear space, ukuran minimum, dan larangan dari pedoman merek pemilik yang dicatat di manifest |
| `asetGambar`, `pasangGambar`, `ikon` | WCAG 2.2 SC 1.1.1 (teks alternatif); `<img>` menonaktifkan skrip dan sumber luar pada SVG (MDN, SVG sebagai gambar; uji lokal Chromium di [aset.md](aset.md#svg-daftar-izin)); ikon dekoratif bila tanpa peran: keputusan desain |
| `kreditAset` | Praktik terbaik atribusi Creative Commons (TASL); format sama dengan `bun run aset` |
| `pasangFont` | Uji lokal: `document.fonts.ready` tidak memuat `@font-face` yang belum dipakai DOM ([aset.md](aset.md#helper-runtime)); `FontFace` + `load()` eksplisit stabil |
| `presetJenis` | Preset bertingkat bukti ([konsep-jenis-alur.md](konsep-jenis-alur.md#tingkat-bukti)) |

## Changelog

### 2026-11-08 - v1.6.0

- Menambahkan `keyframe` (lintasan nilai angka atau larik dengan easing per segmen; nilai tepat di tiap titik). API lain tidak berubah.

### 2026-11-07 - v1.5.0

- Menambahkan `petaWaktuKlip`, `frameSumber`, `kecepatanPermil`, dan opsi `waktu`, `durasi`, `dari` pada `indeksFrameKlip` (trim, speed konstan dan ramp, reverse, freeze) beserta bagian Pemetaan waktu klip. Perilaku `indeksFrameKlip` tanpa `waktu` tidak berubah.

### 2026-11-07 - v1.4.0

- Menambahkan `areaAmanVertikal`, `areaCaption`, `rencanaCaption`, `keadaanCaption`, dan `captionHtml` (lima mode caption, empat posisi, zona dan jangkar penutur) ke tabel API dan Sumber riset.

### 2026-11-07 - v1.3.0

- Menambahkan `asetGambar`, `pasangGambar`, `logo`, `ikon`, `kreditAset`, dan `pasangFont` ke tabel API dan Sumber riset; kalimat helper murni dikecualikan untuk helper yang menyentuh DOM.
### 2026-11-07 - v1.2.0

- Menambahkan penunjuk ke `transisi-animasi.md` untuk modul `scripts/transisi.js`.

### 2026-11-07 - v1.1.0

- Menambahkan `simulasiButaWarna`, `keLab`, `bedaLab`, `bedaWarna`, `periksaPalet`, `paletOkabeIto`, dan `ukuranTeks` beserta sumbernya; rujukan ke [visual-audiens.md](visual-audiens.md).
- Baris `durasiBaca`: batas cps dikoreksi menjadi subtitle dewasa 17 dan anak 13, SDH 20 dan 17 (Netflix Indonesia); catatan kesenjangan dihapus.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Referensi API runtime dan Mode URL); isi dipertahankan, rujukan silang diperbarui.
- Menambahkan ringkasan Sumber riset per helper dari kolom keterangan tabel.
