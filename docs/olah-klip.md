# Olah klip: efek saat ekstraksi

## Metadata

- Version: `v1.2.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan efek kunciWarna (chroma key, keluaran PNG beralfa; tahap alfa) dan stabil (vidstab dua pass dengan cadangan deshake, deteksi kemampuan ffmpeg dengan pesan jelas; tahap pra), urutan tahap pra, alfa, warna, serta format PNG otomatis untuk efek beralfa.`

`scripts/klip.mjs` dapat mengolah klip **sekali, saat ekstraksi frame**, lewat blok `efek` di `sumber.json` (stabilisasi, chroma key, LUT, koreksi warna). Frame yang sampai ke komposisi sudah berefek, jadi komposisi tetap menggambar frame ke-n klip sebagai fungsi murni dari nomor frame (`klipGambar`) tanpa tahu efeknya. Tidak ada grading per frame di Chromium. Manifest, lisensi, cache, dan pemakaian klip di komposisi ada di [video-tertanam-audio.md](video-tertanam-audio.md); dokumen ini hanya mengurai efek. Keputusan di baliknya ada di [log-keputusan.md](log-keputusan.md).

```mermaid
flowchart LR
    M[sumber.json<br/>klip.efek] --> V[validasi<br/>jenis, rentang, LUT .cube]
    V -->|pelanggaran: exit 2,<br/>sebelum ekstraksi| X[berhenti]
    V --> Q{efek bergantung<br/>build ffmpeg?}
    Q -->|filter tidak ada: exit 2,<br/>sebelum ekstraksi| X
    Q --> K[kunci cache<br/>efek kanonik + sha256 LUT + mesin]
    K -->|cache hit| H[pakai frame lama]
    K -->|cache miss| A["pass 1, hanya vidstab:<br/>analisis gerak"]
    A --> F["ffmpeg: fps, [stabil], skala + matriks,<br/>[kunciWarna], efek warna"]
    F --> C[frame JPEG, atau PNG<br/>bila beralfa, di cache]
    H --> P[klip-props.json]
    C --> P
```

## Skema `efek`

`klip[].efek` adalah array objek; setiap objek punya `jenis` dan parameter jenis itu. Urutan array adalah urutan penerapan dalam satu tahap (urutan antar-tahap tetap: lihat Rantai ekstraksi). Kunci yang tidak dikenal, jenis yang tidak dikenal, nilai di luar rentang, dan lebih dari 16 butir ditolak dengan kode keluar `2` sebelum ffmpeg berjalan, dengan pesan yang menyebut klip, nomor butir, dan jenisnya (contoh: `klip "k1": efek[0] (warna): "saturasi" harus angka 0..4`). Klip tanpa `efek` diekstrak persis seperti sebelumnya, termasuk kunci cache-nya.

```json
{
  "id": "hangat", "sumber": "pola-uji", "lebar": 480, "tinggi": 270, "dari": 0, "panjang": 2,
  "efek": [
    { "jenis": "lut", "berkas": "lut/hangat.cube", "interpolasi": "tetrahedral" },
    { "jenis": "warna", "kontras": 1.1, "saturasi": 0.8 },
    { "jenis": "keseimbangan", "bayangan": [0, 0, 0.06], "sorotan": [0.05, 0, -0.03] }
  ]
}
```

Contoh stabilisasi dan chroma key (klip berlatar hijau, keluaran PNG beralfa):

```json
{ "id": "pembicara", "sumber": "layar-hijau", "lebar": 640, "tinggi": 360,
  "efek": [
    { "jenis": "stabil", "goyangan": 6 },
    { "jenis": "kunciWarna", "warna": "#00ff00", "toleransi": 0.3, "halus": 0.1, "metode": "yuv" }
  ] }
```

| Jenis | Parameter | Filter ffmpeg |
| --- | --- | --- |
| `stabil` | `mesin` (`otomatis` bawaan: vidstab bila ada, cadangan deshake; `vidstab`; `deshake`), `goyangan` bilangan bulat 1..10 (bawaan 5), `halus` bilangan bulat 1..100 (bawaan 15; hanya vidstab). Maksimal satu per klip. | `vidstabdetect` dan `vidstabtransform` (dua pass), atau `deshake` |
| `kunciWarna` | `warna` (`#rrggbb`, warna latar; wajib), `toleransi` 0.01..1 (bawaan 0.3), `halus` 0..1 (kelembutan tepi, bawaan 0.1), `metode` (`rgb` bawaan, atau `yuv`). Maksimal satu per klip. Menghasilkan kanal alfa. | `colorkey` (`rgb`) atau `chromakey` (`yuv`) |
| `lut` | `berkas` (jalur `.cube`, relatif terhadap folder manifest; wajib), `interpolasi` (`nearest`, `trilinear`, `tetrahedral` bawaan, `pyramid`, `prism`), `sha256` (opsional; bila diisi harus cocok dengan isi berkas) | `lut3d` |
| `warna` | `kecerahan` -1..1 (bawaan 0), `kontras` 0..4 (bawaan 1), `saturasi` 0..4 (bawaan 1; 0 = abu-abu), `gamma` 0.1..10 (bawaan 1; di atas 1 mencerahkan tengah). Sedikitnya satu parameter wajib. | `lutrgb` dan `colorchannelmixer` |
| `keseimbangan` | `bayangan`, `tengah`, `sorotan`: masing-masing `[merah, hijau, biru]` berisi tiga angka -1..1; `jagaTerang` (boolean, mempertahankan kecerahan). Sedikitnya satu dari tiga wajib. | `colorbalance` |

**`stabil`.** Meredam goyangan kamera genggam. `vidstab` (libvidstab) bekerja dua pass: pass pertama (`vidstabdetect`, `shakiness` = `goyangan`, `accuracy=15`) memperkirakan gerak seluruh klip dan menulis jejaknya ke berkas sementara di folder kerja ekstraksi, pass kedua (`vidstabtransform`, `smoothing` = `halus`) menggeser frame mengikuti lintasan yang dihaluskan; `halus` adalah jumlah frame di tiap sisi yang dirata-ratakan, jadi makin besar makin mantap tetapi gerak kamera yang disengaja ikut diredam. Bingkai diperbesar sedikit otomatis (`optzoom=1`, bawaan filter) untuk menyembunyikan tepi hitam, sehingga hasilnya sedikit lebih ketat daripada sumber. Berkas jejak dihapus setelah ekstraksi dan tidak ikut cache. `deshake` adalah satu pass bawaan ffmpeg: `rx` dan `ry` adalah jangkauan geser maksimum yang harus kelipatan 16 (maksimal 64), jadi `goyangan` 1..10 dipetakan ke 16, 32, 48, 64 piksel (`16 * min(4, ceil(goyangan / 2.5))`); `halus` tidak berlaku. Stabilisasi dipasang **sebelum** penskalaan, pada frame sumber setelah `fps`, sehingga gerak diperkirakan dan dikoreksi pada resolusi penuh.

**Deteksi filter dan pesan.** Kemampuan build ffmpeg dibaca dari `ffmpeg -filters`, hanya bila ada klip yang memakai `stabil`, dan **sebelum** ekstraksi apa pun. `mesin: "otomatis"` memilih vidstab bila `vidstabdetect` dan `vidstabtransform` keduanya ada; bila tidak, memakai deshake dengan peringatan di stderr (`peringatan: klip "k1": efek[0] (stabil): filter vidstab (...) tidak tersedia di build ffmpeg ini ...; memakai deshake`). `mesin: "vidstab"` yang tak tersedia, atau tidak ada filter stabilisasi sama sekali, berhenti dengan kode keluar `2`, pesan yang menyebut klip, nomor butir, filter yang hilang dan jalan keluarnya (pasang ffmpeg dengan libvidstab, atau pilih `deshake`), tanpa ekstraksi dan tanpa folder hasil. Mesin yang terpilih ikut kunci cache dan `meta.json`, jadi ekstraksi dari build berbeda tidak saling menimpa; baris log menyebutnya (`efek stabil(vidstab)`).

**`kunciWarna`.** Chroma key: piksel yang mirip `warna` menjadi transparan. `toleransi` adalah `similarity` ffmpeg (seberapa jauh warna boleh menyimpang dan tetap dikunci) dan `halus` adalah `blend` (lebar peralihan alfa di tepi; 0 = tepi keras). `rgb` memakai `colorkey`, jarak di ruang RGB: sederhana dan memadai untuk latar rata. `yuv` memakai `chromakey`, jarak pada kroma saja (terang diabaikan): lebih tahan terhadap latar yang tidak rata terangnya, seperti layar hijau berbayang. Pada `yuv`, hanya kanal alfa yang diambil dari salinan YUV 4:4:4 dan digabung kembali ke RGB asli (`alphamerge`), sehingga warna subjek tidak berubah oleh konversi YUV. Efek dipasang setelah penskalaan dan **sebelum** efek `warna`, `lut`, dan `keseimbangan` apa pun yang ditulis di array (urutan antar-tahap tetap: stabil, kunciWarna, lalu efek warna): `warna` kunci mengacu ke warna sumber, bukan hasil koreksi, dan alfa dibawa melewati efek warna tanpa berubah. Tidak ada despill (penghilangan pantulan hijau pada tepi subjek); tepi subjek berbayang hijau perlu `toleransi` lebih besar atau koreksi `warna` setelahnya.

**Format PNG.** Efek beralfa menghasilkan PNG RGBA. Bila `format` tidak ditulis, klip otomatis berformat `png` (`ekstensi` di `klip-props.json` menjadi `png`; kualitas JPEG tidak berlaku). `"format": "jpg"` bersama `kunciWarna` ditolak dengan kode keluar `2` sebelum ffmpeg (JPEG tidak punya alfa). `klipGambar` menggambar PNG ke `<canvas>` setelah `clearRect`, jadi area transparan menampilkan latar komposisi; PNG jauh lebih besar daripada JPEG dan memperbesar cache.

**`lut`.** Hanya LUT 3D format `.cube` (Adobe/Resolve). Berkas diurai dan diperiksa sebelum ekstraksi dengan sikap yang sama seperti ffmpeg (fail-closed): `LUT_3D_SIZE` wajib dan 2..256, jumlah baris data harus tepat `ukuran^3`, baris data harus tiga bilangan, `DOMAIN_MIN` dan `DOMAIN_MAX` diterima, LUT 1D dan kata kunci lain ditolak. Urutan data: merah paling cepat berubah. Interpolasi `tetrahedral` adalah bawaan ffmpeg dan yang paling setia pada sumbu abu-abu; `trilinear` dipakai bila hasil bit-eksak untuk LUT identitas dibutuhkan (lihat di bawah). Berkas LUT disalin ke folder kerja ekstraksi dan dihapus lagi, sehingga jalur dengan spasi atau karakter khusus filter ffmpeg aman tanpa escape.

**`warna`.** Rumusnya ditulis eksplisit, bukan perilaku internal `eq` (lihat KP-035): nilai kanal `x` (0..1, ruang sRGB/BT.709 ber-gamma) menjadi `clip((x^(1/gamma) - 0.5) * kontras + 0.5 + kecerahan, 0, 1)`; saturasi `s` mencampur tiap kanal dengan luma Rec. 709 (`0.2126 R + 0.7152 G + 0.0722 B`): `kanal' = s * kanal + (1 - s) * luma`. Dengan `s = 0` ketiga kanal sama persis (abu-abu murni sebelum kompresi JPEG).

**`keseimbangan`.** Bobot bayangan, tengah, dan sorotan berasal dari `colorbalance` ffmpeg dan tidak simetris: pada gradasi abu-abu ffmpeg 6.1 `tengah: [0.5, 0, 0]` mengubah nilai 80 (dari 255) tetapi tidak 10, 128, 200, atau 250, sedangkan `sorotan` mengubah nilai 80, 128, 200, dan 250 (tidak 10). Lihat dulu hasilnya pada frame sebelum memilih angka.

Efek yang semua parameternya netral (mis. `warna` dengan `kecerahan: 0`, `kontras: 1`, `saturasi: 1`, `gamma: 1`, atau `keseimbangan` dengan semua nol) dibuang dari rantai dan dari kunci cache, sehingga klipnya sama persis dengan klip tanpa efek.

## Rantai ekstraksi dan urutan

Rantai filter ffmpeg untuk satu klip: `fps` (dan koreksi SAR bila perlu), tahap **pra** (`stabil`, pada frame sumber), `scale` ke ukuran klip dengan matriks dan rentang warna eksplisit (lihat Warna di [video-tertanam-audio.md](video-tertanam-audio.md#scriptsklipmjs)), `format=rgb24`, tahap **alfa** (`kunciWarna`: `format=rgba`, filter kunci, `format=rgba`), lalu tahap **warna** bila ada efek: `format=gbrp` (atau `gbrap` bila ada alfa), filter efek berurutan, `format=rgb24` (atau `rgba`). Efek warna diterapkan **setelah penskalaan**, pada frame ukuran akhir dalam RGB 8 bit ber-gamma (konversi `rgb24` dan `gbrp` tanpa kehilangan), sehingga LUT melihat nilai yang sama dengan yang akan ditampilkan; filter warna tidak menyentuh kanal alfa. Untuk vidstab, pass analisis memakai awalan rantai yang sama (`fps`, koreksi SAR) lalu `vidstabdetect`, tanpa keluaran frame. Audio klip (`audio.wav`) tidak diolah.

Urutan antar-tahap tetap (pra, alfa, warna) dan tidak mengikuti urutan array; dalam satu tahap, urutan efek mengikuti urutan array (urutan penting: LUT lalu koreksi berbeda dengan koreksi lalu LUT).

## Cache

Kunci cache menambahkan `efek` ke kunci lama: daftar efek kanonik (parameter berisi nilai bawaan yang sudah terisi, tanpa efek netral) dan, untuk `lut`, **sha256 isi berkas LUT** dan interpolasi; untuk `stabil`, mesin yang terpilih (`vidstab` atau `deshake`, sesudah `otomatis` diselesaikan); untuk `kunciWarna`, warna (huruf kecil), toleransi, halus, dan metode. Format berkas frame (`png` otomatis untuk efek beralfa) juga ikut kunci. Akibatnya:

- manifest yang sama menghasilkan cache hit dan tidak menjalankan ffmpeg;
- mengubah parameter, urutan, atau **isi LUT** (walau jalurnya sama) menghasilkan kunci baru; folder cache lama dibiarkan (seperti perubahan fps);
- memindahkan proyek ke jalur lain tidak mengubah kunci, karena jalur mutlak tidak ikut dihash;
- klip tanpa efek tidak berubah kuncinya, jadi cache lama tetap berlaku.

`meta.json` di folder cache memuat daftar `efek` kanonik dan `framesSha256` seluruh frame; baris log `klip "id": ...` menyebut efek yang dipakai (`efek lut+warna`).

## LUT identitas dan ketepatan

LUT identitas (setiap warna dipetakan ke dirinya) adalah uji kebenaran rantai. Hasil terukur (ffmpeg 6.1, klip uji 480x270):

| Interpolasi | Hasil dibanding klip tanpa LUT |
| --- | --- |
| `trilinear` | Identik byte demi byte: `framesSha256` sama untuk JPEG maupun PNG. |
| `tetrahedral` (bawaan) | Hampir identik, bukan bit-eksak: ffmpeg membulatkan hasil float sehingga sebagian kecil piksel meleset satu level; PSNR 82,6 dB pada PNG dan sekitar 65 dB setelah JPEG (galat satu level ikut terkuantisasi ulang). |

Uji `scripts/uji-klip.mjs` menegakkan keduanya. LUT nyata bukan identitas, jadi pilih interpolasi berdasarkan mutu (`tetrahedral`), bukan berdasarkan uji identitas.

## Lisensi dan atribusi

- LUT adalah aset: LUT dari paket komersial atau pihak ketiga tunduk pada lisensinya (banyak paket melarang redistribusi berkas `.cube`). Jangan meng-commit LUT yang lisensinya tidak mengizinkan; catat sumber dan lisensinya di `ASET.md` repo proyek (AGENTS.md §Lisensi dan Aset). LUT contoh di `templates/klip-tertanam/lut/` dibangkitkan skrip buatan sendiri dan milik proyek (CC0-1.0).
- Koreksi warna adalah modifikasi atas karya sumber. Untuk sumber berlisensi CC, sebutkan di `perubahan` sumber (mis. "diberi koreksi warna"); atribusi TASL memakai teks itu apa adanya.

## Batasan

- Hanya RGB 8 bit; sumber 10 bit didekode lalu diturunkan ke 8 bit di tahap penskalaan yang sudah ada. Sumber HDR tetap ditolak.
- LUT dianggap berlaku pada RGB BT.709 hasil dekode (ruang tampil). LUT yang dirancang untuk masukan log (konversi log ke Rec. 709) hanya benar bila sumbernya memang log; hal ini belum diverifikasi dengan footage log nyata.
- Tidak ada grading per frame atau keyframe efek; efek konstan sepanjang klip. Jadwal tampil klip tetap milik komposisi.
- Stabilisasi hanya meredam gerak kamera global (geser, dan rotasi kecil oleh vidstab) dengan perkiraan satu lintasan per klip; objek yang bergerak besar di bingkai dapat menyesatkan perkiraan, dan klip yang terlalu pendek (beberapa frame) tidak berguna. deshake jauh lebih lemah daripada vidstab pada sumber yang tidak bertekstur. Kualitas pada rekaman genggam nyata belum diverifikasi; uji memakai kamera sintetis (tekstur statis dengan offset acak ber-seed).
- Chroma key tidak punya despill, penghalus matte (erode atau blur alfa), atau pemisahan layar hijau yang tidak rata di luar yang dikerjakan `chromakey`. Hasilnya diuji pada latar hijau sintetis berwarna rata, bukan pada rekaman layar hijau nyata. Penghapusan latar tanpa layar warna (segmentasi AI) bukan bagian fitur ini.
- Efek beralfa hanya berformat PNG: berkas jauh lebih besar daripada JPEG.
- Kunci cache memuat versi ffmpeg; mengganti versi ffmpeg mengekstrak ulang.

## Menambah jenis efek

Jenis efek berikutnya (mis. yang tercatat di [roadmap.md](roadmap.md) fase F3) didaftarkan di registri `EFEK` pada `scripts/klip.mjs` tanpa mengubah skema: satu entri berisi `tahap` (`pra`, `alfa`, atau `warna`), `kunci` (kunci manifest yang sah), `periksa` (validasi, pesan galat), `kanonik` (bentuk untuk kunci cache; `null` bila netral), dan `saring` (filter ffmpeg, berkas yang perlu disalin, dan bila perlu `analisis`: filter pass pertama). Kunci opsional: `maks` (jumlah maksimal per klip), `alfa: true` (klip menjadi PNG), dan `kemampuan(e, kemampuan)` (memeriksa filter yang ada di build ffmpeg sebelum ekstraksi). Efek yang butuh tahap lain menambah satu entri di `TAHAP` dan satu slot di `argsEkstrak`; efek yang sudah ada tidak berubah.

## Templat

[`templates/klip-tertanam/sumber-warna.json`](../templates/klip-tertanam/sumber-warna.json) memuat tiga klip dari satu sumber: `asli`, `hangat` (LUT), dan `kusam` (warna dan keseimbangan). LUT contoh `lut/identitas.cube` dan `lut/hangat.cube` dibangkitkan `templates/klip-tertanam/buat-lut.mjs` (keluaran deterministik; uji memastikan berkas yang di-commit sama dengan keluaran skrip).

```bash
bun scripts/klip.mjs templates/klip-tertanam/sumber-warna.json --fps 30 --out .cache/awvd/klip-warna
bun templates/klip-tertanam/buat-lut.mjs .cache/awvd/lut   # membangkitkan ulang LUT contoh
```

## Changelog

### 2026-11-07 - v1.2.0

- Efek `stabil` (F3/03): vidstab dua pass dengan cadangan deshake, `goyangan` dan `halus`, tahap `pra` sebelum penskalaan, deteksi filter lewat `ffmpeg -filters` dengan pesan jelas (kode keluar 2) bila build tidak memilikinya, mesin terpilih ikut kunci cache, batasan stabilisasi.

### 2026-11-07 - v1.1.0

- Efek `kunciWarna` (F3/02): chroma key `colorkey` atau `chromakey`, keluaran PNG beralfa (otomatis bila `format` tidak ditulis; `jpg` ditolak), tahap `alfa` sebelum efek warna, alfa terbawa melewati efek warna, urutan tahap pra, alfa, warna, serta batasan.

### 2026-11-07 - v1.0.0

- Dokumen baru: skema `klip[].efek`, jenis `lut`, `warna`, `keseimbangan`, rantai ekstraksi, kunci cache, LUT identitas, lisensi LUT, batasan, dan titik perluasan.
