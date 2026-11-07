# Catatan analisis kutipan wajar: templat reaction

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Templat catatan analisis transformatif per proyek, diisi dengan contoh fiktif untuk templat reaction.`

Salin berkas ini ke repo proyek video yang memuat kutipan dari karya lain, isi dengan fakta proyekmu, dan simpan bersama `sumber.json`. Catatan ini adalah bahan untuk peninjau hukum (memo gerbang GH) dan bukti bahwa pembuat sudah menimbang tujuan, kebutuhan, dan dampak kutipan. Isinya **bukan nasihat hukum** dan tidak menggantikan peninjauan oleh ahli hukum hak cipta di yurisdiksi tayang. Dasar ringkas dan batas fitur ada di [docs/pelajari-reaction.md](../../docs/pelajari-reaction.md).

Isi di bawah adalah **contoh fiktif** untuk templat ini: dua "karya" buatan proyek awvd (lihat [ASET.md](ASET.md)). Pada proyek nyata, ganti seluruh isian dan hapus petunjuk berbahasa "ganti dengan".

## Identitas proyek

| Isian | Nilai (contoh) |
| --- | --- |
| Judul video | Ulasan: dua karya fiktif |
| Penanggung jawab isi | Penulis contoh (fiktif) |
| Peninjau hukum (peran `KP`) | Ganti dengan nama peninjau; contoh ini tidak punya |
| Yurisdiksi tayang | Indonesia (tambahkan negara lain bila video tayang di sana) |
| Komersial atau iklan | Tidak (`proyek.tujuan` `nonkomersial`, tanpa iklan atau sponsor) |
| Tanggal catatan | 2026-11-07 |

## Karya yang dikutip

Satu baris per sumber di `sumber.json`. Untuk karya pihak ketiga, lisensinya `KUTIPAN-WAJAR` dan `caraPerolehan` wajib salah satu dari `milik-sendiri`, `izin-tertulis`, `rilis-pemegang-hak`, `lisensi-terbuka`, `stok-berbayar`, `arsip-publik`, atau `berkas-sah-pengguna` (dengan bukti). Hasil unduhan platform, rekam layar, dan rip stream ditolak.

| Id | Judul | Pencipta | Sumber URL | Cara perolehan | Bukti | Tanggal akses |
| --- | --- | --- | --- | --- | --- | --- |
| `karya-1` | Karya fiktif satu | Proyek awvd | https://github.com/ahliweb/awvd | milik-sendiri (CC0-1.0) | `aset/karya-fiktif-1.mkv` berhash di manifest | 2026-11-07 |
| `karya-2` | Karya fiktif dua | Proyek awvd | https://github.com/ahliweb/awvd | milik-sendiri (CC-BY-4.0) | `aset/karya-fiktif-2.mkv` berhash di manifest | 2026-11-07 |

## Tujuan dan analisis transformatif

Jawab dengan kalimatmu sendiri; jawaban yang hanya mengulang pertanyaan berarti kutipan belum dibenarkan.

1. **Tujuan kutipan** (salah satu: kritik, ulasan, pendidikan, penelitian, berita-aktual): ulasan. Hiburan, promosi, dan iklan bukan tujuan kutipan.
2. **Apa yang komentarmu tambahkan?** Contoh: komentar membahas ritme pergantian adegan dan gerak objek pada tiap karya, sesuatu yang tidak ada di karya aslinya.
3. **Apakah komentar menyasar isi klip?** Ya: setiap klip dibahas saat tampil (`menyasarKarya` true). Karya yang hanya dipakai sebagai latar tidak memenuhi syarat.
4. **Mengapa klip itu perlu?** Contoh: pergantian latar tidak dapat dijelaskan tanpa memperlihatkannya; klip dipilih sependek mungkin (3 sampai 4 detik).
5. **Apakah klip memuat bagian paling penting dan khas karya** (klimaks, punchline, pokok karya)? Tidak (`bukanBagianKhas` true).
6. **Apakah pemotongan atau penyuntingan mengubah makna** atau memutarbalikkan fakta atau identitas karya? Tidak (`perubahanMakna` false).
7. **Apa yang membedakan videomu dari sekadar menonton karya aslinya?** Contoh: struktur ulasan, analisis ritme, dan kesimpulan yang disusun penulis.

## Angka kutipan

Isi dari keluaran `bun run kutipan -- periksa sumber.json` (atau baris `kutipan:` yang dicetak `bun run klip`). Batas bawaan adalah kebijakan internal awvd yang disetujui pemilik, bukan batas hukum; proyek boleh memperketat dan tidak boleh melonggarkan tanpa catatan izin tertulis.

| Ukuran | Batas bawaan | Nilai proyek (contoh) |
| --- | --- | --- |
| Panjang tiap klip | maks 15 detik | 4, 4, dan 3 detik |
| Total kutipan per sumber | maks 45 detik atau 15% durasi sumber, yang lebih kecil | `karya-1` 7 detik dari batas 9,6; `karya-2` 4 detik dari batas 9,6 |
| Total kutipan terhadap video baru | maks 25% | 11 dari 48 detik = 22,9% |
| Komentar atau narasi asli aktif selama kutipan | min 90% | 100% |
| Audio musik sumber | dibisukan | `karya-2` bermode `bisu`; `karya-1` (ucapan) campur dan bergantian |

## Audio, orang yang dikenali, dan konten sintetis

- **Musik:** dibisukan secara bawaan. Musik hanya terdengar bila musik itu sendiri objek ulasan (`musikDibahas` true), maksimum 10 detik. Rekaman dan komposisi punya hak masing-masing, dan pencocokan otomatis platform dapat tetap menandai video.
- **Orang yang dapat dikenali:** tidak ada (`orangDikenali` false). Bila ada, wajib izin potret tertulis (`izinPotret` `tertulis-ada`) atau kepentingan publik yang terdokumentasi dengan gerbang GH disetujui; hindari kesan dukungan dan data pribadi.
- **Konten sintetis atau AI pada orang nyata:** tidak dipakai; label konten sintetis bila realistis.
- **Watermark dan keterangan pencipta:** tidak dipotong atau dikaburkan.

## Atribusi

Sumber disebut lengkap di layar selama klip tampil (`kreditKlip`), di kredit akhir, dan di `atribusi.txt` hasil `bun run klip` untuk deskripsi video. Atribusi saja tidak membuat kutipan sah, tetapi menjadi syarat pengecualian untuk sumber yang wajib disebut.

## Gerbang hukum GH

Berlaku bila ada sumber `KUTIPAN-WAJAR`. Contoh ini tidak membutuhkannya karena karya yang dikutip milik proyek dan berlisensi CC0/CC BY. Langkahnya untuk karya pihak ketiga:

1. Isi catatan ini dan tulis memo peninjau (`memo-hukum.md`) yang memuat tujuan, penimbangan empat faktor atau Pasal 44 UU 28/2014, konfirmasi cara perolehan, orang yang dikenali, musik, yurisdiksi tayang, dan nama peninjau.
2. Tambahkan `proyek.gerbangHukum` `{ "status": "disetujui", "oleh": "...", "tanggal": "YYYY-MM-DD", "berkas": "memo-hukum.md", "hash": "..." }`; hash dihitung `bun run kutipan -- hash sumber.json`.
3. `bun run klip` menolak render final (kode keluar 2) bila status belum disetujui atau hash tidak cocok, dan `--draf` menghasilkan props bertanda draf (pita DRAF di komposisi) yang tidak boleh dipublikasikan.
4. Mengubah manifest atau memo setelah persetujuan membatalkannya; hitung hash baru dan minta pengesahan ulang.

GH hanya mencatat bahwa peninjauan terjadi. Ia tidak menjamin kutipan sah.

## Changelog

### 2026-11-07 - v1.0.0

- Templat catatan analisis kutipan wajar dengan isian contoh fiktif untuk templat reaction.
