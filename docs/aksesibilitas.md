# Aksesibilitas

## Metadata

- Version: `v1.7.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan caption dari audio tanpa naskah (ASR whisper.cpp lokal) ke tabel fitur dengan syarat wajib ditinjau manusia, dan stempel kata ASR untuk sorot kata. Sebelumnya: menambahkan label suara sintetis untuk video bersuara TTS (kredit dan metadata).`

Aksesibilitas video yang dihasilkan awvd dan antarmuka pratinjaunya.

## Praktik dasar

- **Subtitle lunak:** `--subtitle teks.vtt` menyematkan trek `mov_text` yang bisa dinyalakan atau dimatikan pemutar.
- **Berkas sidecar:** simpan `.vtt`/`.srt` berdampingan dengan MP4 untuk platform yang meminta berkas terpisah.
- Pastikan kontras teks memadai dan jangan menyampaikan informasi hanya lewat warna atau audio.
- Kontrol pratinjau memiliki label ARIA (`Kontrol pratinjau video`, `Posisi frame`).

## Fitur yang tersedia

| Kebutuhan | Fitur | Dokumen |
| --- | --- | --- |
| Caption ucapan di dalam frame | `captionAktif`, `pecahBaris`, `durasiBaca`, `parseVtt`/`parseSrt` | [api-runtime.md](api-runtime.md) |
| Caption sinkron dengan voice over (cue VTT/SRT dari naskah dan WAV narasi, lint cps profil audiens) | `bun run narasi` | [narasi-caption.md](narasi-caption.md) |
| Caption burn-in yang tidak menutupi isi penting dan terbaca (lima mode, posisi bawah/atas/auto/dekat penutur, area aman 16:9 dan 9:16, kontras >= 4,5:1 terhadap latar terburuk) | `rencanaCaption`, `keadaanCaption`, `captionHtml`, `areaAmanVertikal`; sorot kata hanya isyarat tambahan (kalimat penuh tetap tampil); caption burn-in tidak dapat disetel pemirsa, jadi sediakan trek lunak | [narasi-caption.md](narasi-caption.md#mode-dan-posisi-caption), [api-runtime.md](api-runtime.md) |
| Caption dari audio tanpa naskah (ASR lokal): **hasil mentah, wajib ditinjau manusia sebelum tayang**; VTT ber-`NOTE`, `kata.json` dan `laporan.json` bertanda `belum-ditinjau`, `PERLU-TINJAUAN.txt`, daftar kata berkeyakinan rendah | `bun run narasi transkripsi <audio>` (whisper.cpp opsional, tidak dibundel) | [narasi-caption.md](narasi-caption.md#caption-dari-audio-tanpa-naskah) |
| Sorot kata yang mengikuti ucapan lebih rapat (stempel kata dari ASR, skor rendah jatuh ke estimasi) | `bun run narasi --selaras whisper`; sorot kata tetap hanya isyarat tambahan | [narasi-caption.md](narasi-caption.md#penyelarasan-narasi) |
| Pengungkapan suara sintetis (video bersuara TTS wajib berlabel: kredit layar, deskripsi, metadata) | `suara-kredit.json` dan `kredit-suara.txt` dari `bun run narasi` dengan mesin TTS | [narasi-caption.md](narasi-caption.md#label-suara-sintetis) |
| Caption sebagai trek lunak | `--subtitle`, `--bahasa` | [cli.md](cli.md) |
| Kontras teks | `luminansRelatif`, `kontras`, `pilihTeksKontras` (WCAG 2.2 SC 1.4.3); preset jenis tidak boleh menurunkan kontras di bawah 4,5:1 | [api-runtime.md](api-runtime.md), [konsep-jenis-alur.md](konsep-jenis-alur.md) |
| Area aman layar | `areaAman` | [api-runtime.md](api-runtime.md) |
| Penonton buta warna | `periksaPalet`, `simulasiButaWarna`, `bedaWarna`, `paletOkabeIto` (WCAG 2.2 SC 1.4.1 dan 1.4.11) | [visual-audiens.md](visual-audiens.md#warna-dan-buta-warna) |
| Ukuran teks terbaca | `ukuranTeks` (menurut sudut pandang, konteks tonton, dan audiens) | [visual-audiens.md](visual-audiens.md#ukuran-teks) |
| Lansia, low vision, dan anak | Profil di `data/audiens.json` (ukuran teks, kontras 7:1, cps 13, tempo, elemen per adegan); `bun run konsep -- baru --audiens` | [visual-audiens.md](visual-audiens.md#profil-audiens) |
| Kilatan fotosensitif | Pemeriksa kilatan di `bun run periksa` (penyaringan konservatif, bukan sertifikasi) | [pemeriksaan-mutu.md](pemeriksaan-mutu.md) |
| Batas subtitle (baris, cps, durasi cue) | Lint subtitle di `bun run periksa --subtitle` | [pemeriksaan-mutu.md](pemeriksaan-mutu.md) |
| Gerak dan kilatan pada transisi dan animasi | `kurangiGerak` (mengganti jenis gerak besar dan berkilat dengan `pudar`; kamera, paralaks, getar mati), profil `lansia`/`anak`, durasi minimum jenis berkilat, `periksaKilatan` tingkat rencana. `kurangiGerak` adalah praktik terbaik, bukan klaim kepatuhan WCAG 2.3.3. Dipilih lewat props, termasuk dari `konsep.json` (`kurangiGerak: true` atau `audiens.profil`) | [transisi-animasi.md](transisi-animasi.md#aksesibilitas) |
| Teks alternatif gambar, logo, dan SVG | Bidang `teksAlternatif` wajib di `aset.json` kecuali `peran: "dekoratif"` (WCAG 1.1.1); teks di dalam gambar hanya untuk logotype (WCAG 1.4.5); `aset-props.json` meneruskannya ke komposisi; helper runtime `asetGambar`, `logo`, dan `ikon` melempar galat untuk aset informatif tanpa teks dan memasang `alt=""` plus `aria-hidden` pada aset dekoratif | [aset.md](aset.md) |
| Ketajaman aset | Pemeriksa resolusi menolak aset yang akan di-upscale (buram) pada skala render yang dipakai | [aset.md](aset.md) |
| Penonton tanpa suara | Field `audiens.tanpaSuara` dan `caption.burnIn` di `konsep.json` | [konsep-jenis-alur.md](konsep-jenis-alur.md) |

Caption yang dibuat ASR tidak boleh dianggap setara caption akurat tanpa tinjauan: ASR dapat salah dengar, melewatkan kata, atau mengarang kata, dan nama diri, istilah, serta angka paling rawan. Standar caption (misalnya WCAG SC 1.2.2) menuntut caption yang setara dengan ucapan; awvd tidak memeriksa tinjauan itu, jadi menyuntingnya dan menandainya selesai adalah tanggung jawab proyek. Penerapan standar itu pada caption otomatis belum diverifikasi dari sumber primer.

PDF SOP bertag (outline, bahasa `id`, tabel `th scope`) tetapi **tidak** mengklaim PDF/UA; lihat [sop.md](sop.md).

## Changelog

### 2026-11-07 - v1.7.0

- Menambahkan caption dari audio tanpa naskah (ASR lokal, wajib ditinjau manusia) dan sorot kata dari stempel ASR ke tabel fitur, beserta catatan ketepatan caption otomatis.

### 2026-11-07 - v1.6.0

- Menambahkan label suara sintetis (kredit layar, deskripsi, metadata) untuk video bersuara TTS ke tabel fitur.

### 2026-11-07 - v1.5.0

- Menambahkan mode dan posisi caption burn-in ke tabel fitur.

### 2026-11-07 - v1.4.1

- Baris gerak dan kilatan: profil gerak dapat diturunkan dari `konsep.json` dan dipilih lewat props (isu #28).

### 2026-11-07 - v1.4.0

- Menambahkan `bun run narasi` (caption sinkron voice over dengan lint cps profil audiens) ke tabel fitur.

### 2026-11-07 - v1.3.1

- Baris teks alternatif aset memuat penegakan oleh helper runtime aset.

### 2026-11-07 - v1.3.0

- Menambahkan teks alternatif aset dan pemeriksaan resolusi aset ke tabel Fitur yang tersedia.

### 2026-11-07 - v1.2.0

- Menambahkan baris peta fitur Gerak dan kilatan pada transisi dan animasi.

### 2026-11-07 - v1.1.0

- Peta fitur: buta warna, ukuran teks, dan profil audiens.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Aksesibilitas); isi dipertahankan.
- Menambahkan tabel Fitur yang tersedia sebagai penunjuk ke fitur aksesibilitas yang sudah ada di dokumen lain.
