# Referensi API runtime

## Metadata

- Version: `v1.0.1`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan penunjuk ke modul terpisah scripts/transisi.js (window.Transisi) di pengantar; isi API runtime tidak berubah.`

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
| `durasiBaca(teks, { cps = 17, min = 5/6, maks = 7, fps })` | `{ detik }`, plus `frame` bila `fps` diberikan. Detik = karakter (termasuk spasi; spasi berurutan dirapikan) / `cps`, dijepit ke `[min, maks]`. Netflix Timed Text Style Guide: dewasa maksimal 20 cps, anak 17 cps; angka untuk bahasa Indonesia belum ada sumber primer, jadi bawaan konservatif 17. |
| `pecahBaris(teks, { maks = 42, baris = 2 })` | Mengembalikan **array** baris, dengan properti `melebihi` (boolean) pada array itu. Muat satu baris: satu elemen. Selain itu dipakai jumlah baris minimum dan potongan di spasi dengan prioritas: semua baris <= `maks`; baris atas bukan 1-2 kata; potongan setelah tanda baca (`, . ; : ? !`) atau sebelum kata sambung umum (dan, atau, tetapi, yang, untuk, dengan, di, ke, dari, karena, agar, sehingga); bentuk piramida terbalik (bawah >= atas); baris seimbang. Tidak muat dalam `baris` baris: `melebihi = true` dan array berisi seluruh teks dibungkus greedy (jumlah elemen bisa > `baris`; tidak ada teks hilang). Teks kosong menghasilkan `[]`. Pedoman: Netflix Timed Text Style Guide (maksimal 42 karakter per baris, dua baris). Properti `melebihi` hilang bila array diserialisasi JSON. |
| `captionAktif(cues, frame, fps)` | Cue aktif atau `null`. `cues` = array `{ mulai, akhir, teks }` dalam detik; aktif bila `mulai <= frame/fps < akhir`. Cue tumpang tindih: yang pertama dalam array. Untuk burn-in caption di DOM. |
| `presetJenis(nama)` | Salinan dalam preset jenis video (`formal`, `edukasi`, `kreatif`, `promo`, `produk`, `panduan`, `dokumenter`, `sosial`, `data`, `testimoni`, `psa`, `internal`, `acara`): `{ kunci, label, deskripsi, tujuan, alurBawaan, alurCocok, nilai, bukti, pemeriksaanTambahan }`. Data dimuat lewat `<script src=".../preset-jenis.js">` sebelum dipanggil (lihat [konsep-jenis-alur.md](konsep-jenis-alur.md#preset-di-komposisi-browser)); tanpa itu, atau untuk nama tak dikenal, melempar galat berpetunjuk. Murni dan deterministik. |
| `parseVtt(teks)`, `parseSrt(teks)` | Teks berkas ke array cues. Timestamp `hh:mm:ss.mmm` atau `mm:ss.mmm` (koma juga diterima). Header, `NOTE`, `STYLE`, nomor/id cue, dan pengaturan cue diabaikan; tag seperti `<i>` dan `<v Nama>` dibuang; `parseVtt` juga mengurai `&amp; &lt; &gt; &nbsp;`. Cue kosong atau berakhir sebelum mulai dibuang. |
| `gambarKosong` | String `data:` URI GIF 1x1 transparan, `src` awal untuk target `<img>` (renderer menolak `<img>` tanpa gambar termuat saat halaman dibuka). Target `<canvas>` tidak membutuhkannya. |
| `indeksFrameKlip(klip, frameLokal, { ulang = false, kecepatan = 1 })` | Indeks frame sumber (0 = frame pertama klip) untuk frame lokal klip: `floor(frameLokal * kecepatan)`. Negatif menghasilkan `-1` (belum mulai); melewati akhir ditahan di frame terakhir, atau diulang bila `ulang: true`. Frame diekstrak pada fps komposisi, jadi `kecepatan` <> 1 menduplikasi atau melewati frame tanpa interpolasi. |
| `jalurFrameKlip(klip, frameLokal, opsi)` | URL gambar frame (`akar/folder/000123.jpg`) atau `null` bila belum mulai. `klip` datang dari `klip-props.json` (props `klip[]`). |
| `klipGambar(target, klip, frameLokal, opsi)` | `async`; menggambar frame klip ke `target` lalu menunggu siap, jadi `await klipGambar(...)` di dalam `render` menjamin frame tergambar sebelum screenshot. Mengembalikan `false` (target tidak disentuh) bila belum mulai; melempar galat bila berkas frame tidak termuat. Target `<canvas>` (**dianjurkan**): `Image` lepas didekode (`decode()`) lalu digambar sinkron dengan `drawImage` pada ukuran aslinya. Target `<img>`: `src` diganti lalu `decode()` ditunggu; pada uji, screenshot kadang masih memuat frame sebelumnya (pengecatan gambar baru asinkron), jadi tidak deterministik. |
| `kreditKlip(klip, { ringkas = true })` | Atribusi TASL dari `klip.atribusi`. Ringkas (untuk layar): `"Judul" oleh Pencipta · CC BY 4.0 · diubah`. `ringkas: false` (kredit akhir): `"Judul" oleh Pencipta. Sumber: URL. Lisensi: CC BY 4.0 (URL lisensi). Diubah: ....` Sama persis dengan baris di `atribusi.txt`. |
| `angka(n, { desimal })`, `persen(n, { desimal })`, `rupiah(n, { desimal = 0 })` | Format Indonesia, ditulis manual (bukan `Intl`) agar hasil sama di semua mesin: titik ribuan, koma desimal. `angka(1234567.891)` = `1.234.567,891`; tanpa `desimal` sampai 3 desimal tanpa nol berekor, dengan `desimal` tepat sekian digit. `persen(0.256)` = `25,6%` (n pecahan, tanpa spasi). `rupiah(1500000)` = `Rp1.500.000` (tanpa spasi setelah Rp, negatif `-Rp1.500`). Pembulatan setengah menjauhi nol pada representasi desimal terpendek: `angka(1.005, { desimal: 2 })` = `1,01`. `NaN`, tak hingga, dan nilai >= 1e21 melempar galat. Sumber aturan Rp tanpa spasi: EYD Edisi V (Badan Bahasa, 2022), hanya sumber sekunder; dokumen resmi belum dibaca. |
| `kenBurns(frame, { mulai = 0, durasi, dari: {x,y,skala}, ke: {x,y,skala}, easing })` | Nilai CSS `transform` (`translate(..%, ..%) scale(..)`) untuk pan dan zoom foto diam di dalam wadah `overflow:hidden`. `x`,`y` = titik pusat tampilan (0..1, bawaan 0,5), `skala >= 1` (bawaan 1 lalu 1,2); pusat dijepit agar tepi gambar tidak terbuka. Sebelum `mulai` = `dari`, sesudah `mulai + durasi` = `ke`; easing bawaan linear. Murni dari frame. Hanya gaya estetika: tidak ditemukan bukti eksperimen bahwa efek ini memengaruhi pemahaman atau atensi; parameter (zoom 1,0 ke 1,1-1,3, gerak lambat) adalah praktik. |

Semua helper di atas murni (tanpa `Date`, `Math.random`, atau timer), jadi aman dipakai di `render`.

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
| `durasiBaca`, `pecahBaris`, `captionAktif`, `parseVtt`, `parseSrt` | Netflix Timed Text Style Guide |
| `angka`, `persen`, `rupiah` | EYD Edisi V (Badan Bahasa, 2022), sumber sekunder |
| `kenBurns` | Praktik; tidak ada bukti eksperimen |
| `presetJenis` | Preset bertingkat bukti ([konsep-jenis-alur.md](konsep-jenis-alur.md#tingkat-bukti)) |

## Changelog

### 2026-11-07 - v1.0.1

- Menambahkan penunjuk ke `transisi-animasi.md` untuk modul `scripts/transisi.js`.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Referensi API runtime dan Mode URL); isi dipertahankan, rujukan silang diperbarui.
- Menambahkan ringkasan Sumber riset per helper dari kolom keterangan tabel.
