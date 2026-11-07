# Roadmap awvd

## Metadata

- Version: `v1.8.0`
- Last updated: `2026-11-07`
- Changeset: `Paritas: sinkron ketukan musik berstatus sebagian (bun run ketukan; diuji pada sinyal sintetis, musik nyata dan tempo berubah belum diuji). Sebelumnya: text-to-speech berstatus ada sebagai adaptor opsional.`

## Visi

awvd menjadi alat produksi video terprogram yang **setara penyunting video konsumen** (misalnya CapCut) untuk video penjelasan, edukasi, promosi, SOP, data, dan reaction, **dengan metode repo ini**:

- deterministik, frame demi frame;
- dapat ditinjau sebagai kode;
- Bun-only;
- patuh lisensi;
- diperiksa mutunya secara otomatis.

Yang **tidak** dikejar:

- **Penyuntingan real-time.** awvd menggambar setiap frame dengan Chromium, jadi tidak bisa secepat penyunting yang merender langsung saat menyunting.
- **Pustaka musik dan stiker berlisensi komersial.** Mengelolanya butuh lisensi dari pemegang hak dan tidak sesuai peran awvd sebagai upstream.
- **Layanan cloud dan aplikasi ponsel.** awvd tetap alat CLI lokal.

## Prinsip

- **Bukan janji tanggal.** Fase berurutan menurut ketergantungan; tanggal milestone, bila ada, hanya indikatif.
- **Fase selesai ditentukan kriteria keluar**, bukan oleh nol issue terbuka.
- **Angka kemajuan dibaca dari GitHub**, tidak diketik di dokumen ini:

  ```bash
  gh api repos/ahliweb/awvd/milestones --jq '.[] | "\(.title): \(.closed_issues)/\(.open_issues + .closed_issues)"'
  ```

- **Satu issue, satu PR.** Setiap issue berformat Context, Goal, Scope, Steps, Acceptance Criteria, Definition of Done, Dependensi, References, Size (ukuran S/M; L dipecah). PR menutup issue dengan `Closes #n`.
- **Fitur cerdas dan mesin pihak ketiga bersifat opsional dan tidak dibundel** (keputusan pemilik untuk TTS, 2026-11-07). Model dengan lisensi membatasi dicatat syaratnya di dokumen fitur.
- Roadmap ditinjau setiap kali milestone selesai.

## Fase

Status memakai `rencana | berjalan | selesai | ditunda | dibatalkan`.

| Fase | Milestone | Tujuan | Kriteria keluar | Status | Epik |
| --- | --- | --- | --- | --- | --- |
| F1 | F1 Fondasi produksi | Melengkapi alat produksi dasar | Pemeriksa visual, transisi, aset (P0–P1 dan helper runtime), reaction dan kutipan wajar, serta narasi (caption sinkron voice over, adaptor TTS opsional) ter-merge dengan uji dan dokumen; bug determinisme `--skala` diperbaiki | berjalan | [#17](https://github.com/ahliweb/awvd/issues/17) |
| F2 | F2 Timeline deklaratif | Mengubah "tulis kode per video" menjadi "isi `timeline.json`" yang dirender templat generik | Format `timeline.json` (track video/audio/teks/overlay; klip in, out, speed, reverse, freeze; keyframe; transisi) tervalidasi dan dirender templat generik; contoh dan uji determinisme lolos | rencana | [#29](https://github.com/ahliweb/awvd/issues/29) |
| F3 | F3 Pemrosesan klip | Olah klip di tahap ekstraksi dengan cache | `klip.mjs` mendukung LUT/filter warna, chroma key, stabilisasi, peredam bising, dan speed ramp; uji lolos | rencana | [#37](https://github.com/ahliweb/awvd/issues/37) |
| F4 | F4 Kinerja render | Render footage panjang dalam waktu layak | Render paralel per rentang frame dengan framemd5 identik terhadap render serial; percepatan terukur dan didokumentasikan | rencana | [#43](https://github.com/ahliweb/awvd/issues/43) |
| F5 | F5 Fitur cerdas lokal | Fitur cerdas lokal yang opsional | ASR whisper.cpp opsional, deteksi ketukan, reframe, dan hapus latar opsional dengan model berlisensi permisif yang tidak dibundel; masing-masing beruji dan terdokumentasi | rencana | [#47](https://github.com/ahliweb/awvd/issues/47) |
| F6 | F6 Penyunting pratinjau | Alat bantu visual penyusun timeline | Halaman pratinjau lokal dengan scrubber dan daftar track yang mengekspor `timeline.json`; uji E2E Playwright lolos | rencana | [#52](https://github.com/ahliweb/awvd/issues/52) |

```mermaid
flowchart LR
    F1[F1 Fondasi produksi] --> F2[F2 Timeline deklaratif]
    F1 --> F3[F3 Pemrosesan klip]
    F2 --> F3
    F1 --> F4[F4 Kinerja render]
    F1 --> F5[F5 Fitur cerdas lokal]
    F2 --> F5
    F2 --> F6[F6 Penyunting pratinjau]
    F4 -.->|disarankan sebelum footage panjang| F6
```

F3 boleh dimulai untuk butir yang tidak bergantung pada timeline (LUT, chroma key, peredam bising). Speed ramp (F3/05) menunggu pemetaan frame F2/04. F4 tidak bergantung pada F2 dan boleh berjalan paralel.

## Paritas fitur

Peta kesiapan awvd terhadap kelompok fitur penyunting video konsumen. Status mengikuti kondisi `main`.

| Kelompok fitur | Status di `main` | Fase atau issue |
| --- | --- | --- | --- | --- | --- |
| Teks, judul, animasi teks | ada | — |
| Transisi dan animasi elemen | ada ([transisi-animasi.md](transisi-animasi.md)) | F1/02 (selesai) |
| Grafik data, tabel, angka, rupiah | ada ([api-runtime.md](api-runtime.md)) | — |
| SOP dan diagram alir | ada ([sop.md](sop.md)) | — |
| Gambar, Ken Burns | ada | — |
| Logo, ikon, aset berlisensi | ada: CLI aset dan helper runtime ([aset.md](aset.md#helper-runtime)); uji-tayang per frame dan Lottie belum | F1/03 (selesai), F1/04 (selesai) |
| Video di dalam video | ada ([video-tertanam-audio.md](video-tertanam-audio.md)) | — |
| Reaction dan kutipan wajar | ada ([pelajari-reaction.md](pelajari-reaction.md)) | F1/05 (selesai) |
| Pemeriksa visual dan profil audiens | ada ([visual-audiens.md](visual-audiens.md)) | F1/01 (selesai) |
| Caption sinkron voice over | sebagian: naskah, estimasi timing, cue VTT/SRT, rencana audio, serta mode dan posisi tampil caption ada ([narasi-caption.md](narasi-caption.md)); adaptor TTS belum | F1/06A (selesai), F1/06B (selesai), F1/06C |
| Text-to-speech | ada sebagai adaptor opsional yang tidak dibundel ([narasi-caption.md](narasi-caption.md#tts-lokal-sherpa-onnx)); layanan daring dan suara kustom belum | F1/06C (selesai) |
| Ducking, fade, kenyaringan | ada | — |
| QC kenyaringan, kilatan, subtitle | ada ([pemeriksaan-mutu.md](pemeriksaan-mutu.md)) | — |
| Timeline multitrack | belum | F2 |
| Trim, speed, reverse, freeze | ada sebagai helper pemetaan frame ([api-runtime.md](api-runtime.md#pemetaan-waktu-klip); `petaWaktuKlip`, `frameSumber`, ramp kecepatan); tanpa interpolasi gerak, audio tidak ikut diregangkan | F2/04 (selesai) |
| Keyframe generik | sebagian (`interpolasi`, `urutan`) | F2/06 |
| Filter dan LUT warna | ada ([olah-klip.md](olah-klip.md)) | F3/01 (selesai) |
| Chroma key | ada ([olah-klip.md](olah-klip.md); `kunciWarna`, keluaran PNG beralfa) | F3/02 (selesai) |
| Stabilisasi | ada ([olah-klip.md](olah-klip.md); `stabil`: vidstab, cadangan deshake) | F3/03 (selesai) |
| Peredam bising, pengubah suara | ada ([video-tertanam-audio.md](video-tertanam-audio.md#olah-suara-per-trek)); `arnndn` butuh model milik pengguna | F3/04 (selesai) |
| Render cepat untuk footage panjang | belum (serial) | F4 |
| Caption otomatis dari audio (ASR) | belum | F5/01 |
| Sinkron ketukan musik | sebagian: deteksi ketukan dan tempo tetap dari audio lokal ke `ketukan.json` dengan helper komposisi ada ([ketukan.md](ketukan.md)); diuji pada sinyal sintetis, musik nyata dan tempo berubah belum diuji | F5/02 (selesai) |
| Reframe 16:9 ke 9:16 | belum | F5/03 |
| Hapus latar tanpa layar hijau | belum | F5/04 |
| Penyunting visual | belum (ada mode `?preview`) | F6 |

## Label dan milestone

- **Milestone:** satu per fase (`F1` sampai `F6`). Deskripsinya memuat kriteria keluar.
- **Label:** setiap issue punya tepat satu label dari masing-masing kelompok berikut:
  - `jenis:` (`feat`, `fix`, `docs`, `test`, `ci`, `chore`, `refactor`, `riset`);
  - `prioritas:` (`P0` sampai `P3`);
  - `ukuran:` (`S`, `M`).

  Label pelengkap:
  - `area:` (`runtime`, `render`, `audio`, `klip`, `aset`, `transisi`, `konsep`, `sop`, `periksa`, `timeline`, `narasi`, `cerdas`);
  - `status:diblokir` dan `status:perlu-keputusan`;
  - `epik` untuk issue induk per fase.
- **Judul:** `[F<n>/<SEQ>] <jenis>: <ringkasan>`. Sub-issue ditautkan ke epiknya sebagai sub-issue GitHub.
- **Formulir issue** ada di [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/): tugas, bug, riset, dan epik.

## Changelog

### 2026-11-07 - v1.8.0

- Paritas "Sinkron ketukan musik" diubah menjadi sebagian (deteksi ketukan F5/02; tempo tetap, bukti hanya sinyal sintetis).

### 2026-11-07 - v1.7.0

- Paritas "Trim, speed, reverse, freeze" diubah menjadi ada (helper pemetaan frame, F2/04).

### 2026-11-07 - v1.6.0

- Paritas "Text-to-speech" diubah menjadi ada (adaptor TTS lokal opsional, F1/06C).

### 2026-11-07 - v1.5.0

- Tabel paritas: caption sinkron voice over memuat mode dan posisi tampil caption (F1/06B selesai).

### 2026-11-07 - v1.4.0

- Tabel paritas: chroma key (F3/02) dan stabilisasi (F3/03) menjadi ada.

### 2026-11-07 - v1.3.0

- Tabel paritas: peredam bising dan pengubah suara menjadi ada (F3/04: `bersih` dan `suara` di rencana audio).

### 2026-11-07 - v1.2.0

- Tabel paritas: caption sinkron voice over menjadi sebagian (F1/06A selesai).

### 2026-11-07 - v1.1.0

- Paritas "Filter dan LUT warna" diubah menjadi ada (F3/01: `klip[].efek` jenis `lut`, `warna`, `keseimbangan`).

### 2026-11-07 - v1.0.1

- Baris paritas Logo, ikon, aset berlisensi: helper runtime aset ada (F1/04 selesai); uji-tayang per frame dan Lottie belum.

### 2026-11-07 - v1.0.0

- Baseline roadmap enam fase, tabel paritas fitur, label dan milestone, dipetakan ke epik #17, #29, #37, #43, #47, #52.
