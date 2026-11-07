# Pemeriksaan mutu (bun run periksa)

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Dokumen baru dipindah dari README v1.10.0: alat QC periksa.mjs, flag termasuk --konsep, tabel pemeriksaan beserta ambang dan sumbernya, pemeriksa kilatan, dan batasannya.`

Alat QC pasca-render `scripts/periksa.mjs`. Dasar riset ambang ada di [pedoman-produksi.md](pedoman-produksi.md); flag `--konsep` memakai `konsep.json` dari [konsep-jenis-alur.md](konsep-jenis-alur.md).

## Pemakaian

```text
bun run periksa <video.mp4> [--subtitle F.vtt|.srt] [--kenyaringan web|siaran]
                [--jenis penjelasan|promo] [--cps 17] [--konsep konsep.json] [--json]
```

Alat QC pasca-render: memeriksa berkas MP4 hasil render dengan `ffprobe`/`ffmpeg` sistem (tanpa dependensi baru) dan mencetak tabel `LOLOS`/`GAGAL`/`PERINGATAN` per pemeriksaan (`INFO` dan `LEWATI` untuk yang tidak dinilai). `--json` mencetak satu objek JSON (`lolos`, `ringkasan`, `pemeriksaan[]` dengan `id`, `status`, `wajib`, `ringkas`, `rincian`, `data`) untuk CI. Kode keluar `0` bila semua pemeriksaan **wajib** lolos, `1` bila ada yang gagal, `2` untuk argumen salah (flag tidak valid, berkas tidak ada, berkas tanpa trek video atau tidak terbaca ffprobe).

## Flag

| Flag | Bawaan | Keterangan |
| --- | --- | --- |
| `--subtitle F` | - | `.vtt` atau `.srt`; mengaktifkan pemeriksaan subtitle. |
| `--kenyaringan M` | `web` | Target kenyaringan: `web` atau `siaran`. |
| `--jenis J` | - | `penjelasan` atau `promo`; menentukan penilaian durasi. |
| `--cps N` | `17` | Batas karakter per detik subtitle (Netflix dewasa: 20). |
| `--konsep F` | - | `konsep.json` (lihat [konsep-jenis-alur.md](konsep-jenis-alur.md)): kenyaringan dan cps diambil dari konsep (flag eksplisit `--kenyaringan`/`--cps` menang), durasi dinilai terhadap durasi maks preset jenis (dengan `override`), rasio video dibandingkan dengan rasio konsep (`GAGAL` bila beda, wajib), dan harapan burn-in dicatat sebagai `INFO` (tidak bisa dideteksi otomatis). `--jenis` diabaikan bila `--konsep` dipakai. Konsep tidak valid: exit `2`. Tanpa flag ini perilaku tidak berubah. |
| `--json` | mati | Cetak hasil sebagai JSON, bukan tabel. |

## Pemeriksaan

| Pemeriksaan | Wajib | Ambang | Sumber |
| --- | --- | --- | --- |
| Encoding | ya | Video: H.264 profil High, `yuv420p`, `color_primaries`/`color_transfer`/`color_space` = `bt709`, `color_range` = `tv`. Kontainer: `moov` sebelum `mdat` (faststart; dibaca dari urutan kotak tingkat atas MP4). Audio (bila ada): AAC, 48000 Hz. | YouTube Help "Recommended upload encoding settings" |
| Kenyaringan | ya bila ada audio (tanpa audio: `LEWATI`) | `web`: I = -16 LUFS +-1 LU, true peak <= -1,0 dBTP. `siaran`: I = -23 LUFS +-1 LU, true peak <= -1,0 dBTP. Diukur dengan `ebur128=peak=true`. | EBU R 128; AES TD1004/TD1008 |
| Kilatan umum dan kilatan merah | ya | Gagal bila ada lebih dari 3 flash (lebih dari 6 transisi berlawanan) dalam jendela geser 1 detik pada area uji (lihat di bawah). | WCAG 2.2 SC 2.3.1 Three Flashes or Below Threshold |
| Subtitle | ya bila `--subtitle` | Gagal bila baris > 42 karakter, > 2 baris per cue, cps > `--cps`, durasi cue < 5/6 detik atau > 7 detik, atau cue tumpang tindih. `PERINGATAN` bila `pecahBaris` menghasilkan pemecahan baris yang berbeda dari yang ada. Nomor cue = urutan cue yang terurai (mulai 1; cue yang tidak sah dibuang parser). | Netflix Timed Text Style Guide |
| Durasi | tidak (hanya peringatan) | `--jenis penjelasan`: `PERINGATAN` bila > 6 menit. `promo`: hanya `INFO` (tidak ada ambang berbasis bukti). Tanpa `--jenis`: `INFO`. Dengan `--konsep`: `PERINGATAN` bila melebihi durasi maks preset jenis (mis. 360 s untuk `edukasi`, 60 s untuk `promo`); target konsep dicantumkan. | Guo, Kim & Rubin (2014), keterlibatan penonton video pembelajaran; tingkat bukti ambang preset lain tertera di `data/jenis-video.json` |
| Rasio (hanya `--konsep`) | ya | Lebar:tinggi video sama dengan `rasio` konsep (toleransi 1%). | konsep.json |
| Burn-in (hanya `--konsep`) | tidak (`INFO`) | Mencatat apakah konsep mengharapkan caption burn-in atau sidecar. | konsep.json |

## Kilatan fotosensitif

Video didekode `ffmpeg` pada fps aslinya, diskalakan (`scale=48:48:flags=area`, rata-rata area) ke kisi sampel 48x48, dialirkan sebagai `rgb24` mentah (tidak ada frame yang disimpan; memori konstan). Tiap sampel dilinearisasi sRGB dan dirata-ratakan per blok, lalu luminans relatif WCAG dihitung dari rata-rata RGB linear blok. Satu **flash** adalah pasangan transisi berlawanan (naik lalu turun, atau sebaliknya) dengan selisih luminans relatif >= 0,10 dan sisi lebih gelap < 0,80. Transisi dihitung per blok dengan penyaring zig-zag per frame dan jendela geser 1 detik (jumlah frame = fps); gagal bila ada blok dengan lebih dari 6 transisi dalam jendela mana pun. **Flash merah** dihitung terpisah: transisi dengan selisih `(R-G-B)*320` >= 20 yang salah satu sisinya merah jenuh (`R/(R+G+B)` >= 0,8, nilai RGB linear).

Aproksimasi area uji: WCAG menguji flash yang luasnya lebih dari sekitar 0,006 steradian (persegi 341x256 piksel pada layar 1024x768, sekitar 11% luas layar). Alat ini memakai blok seluas 1/9 layar (sekitar 11%) dan menggesernya per setengah blok (jendela 5x5 yang tumpang tindih; kisi 3x3 sejajar adalah himpunan bagiannya) agar hasil tidak bergantung pada posisi flash terhadap kisi.

> **Penting.** Ini penyaringan konservatif untuk menangkap kilatan yang jelas, **bukan sertifikasi** PEAT/Harding atau bukti kepatuhan WCAG. Batasannya: (1) blok dirata-ratakan, sehingga elemen kecil berkontras penuh yang berkedip (sekitar 1% layar atau lebih) sudah bisa memicu `GAGAL` meski WCAG tidak menganggapnya pelanggaran (positif palsu); (2) rata-rata area dilakukan pada nilai sRGB sebelum linearisasi, jadi luminans campuran sedikit meleset; (3) tidak memodelkan sudut pandang 10 derajat atau ukuran layar nyata; (4) dihitung dari video yang sudah dikompresi, bukan master. Untuk siaran atau kebutuhan regulasi, pakai alat uji tersertifikasi.

## Batasan

Batasan lain: encoding hanya memeriksa trek video pertama; subtitle dinilai dari berkas `.vtt`/`.srt`, bukan trek `mov_text` di dalam MP4; waktu kilatan mengasumsikan fps konstan. Contoh waktu: video 6 detik 1280x720 selesai dalam sekitar 0,3 detik.

## Changelog

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Pemeriksaan mutu); isi dipertahankan, rujukan silang diperbarui.
