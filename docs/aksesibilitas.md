# Aksesibilitas

## Metadata

- Version: `v1.1.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan baris peta fitur untuk gerak dan transisi (profil kurangiGerak, periksaKilatan, efek berat) yang menunjuk ke transisi-animasi.md.`

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
| Caption sebagai trek lunak | `--subtitle`, `--bahasa` | [cli.md](cli.md) |
| Kontras teks | `luminansRelatif`, `kontras`, `pilihTeksKontras` (WCAG 2.2 SC 1.4.3); preset jenis tidak boleh menurunkan kontras di bawah 4,5:1 | [api-runtime.md](api-runtime.md), [konsep-jenis-alur.md](konsep-jenis-alur.md) |
| Area aman layar | `areaAman` | [api-runtime.md](api-runtime.md) |
| Kilatan fotosensitif | Pemeriksa kilatan di `bun run periksa` (penyaringan konservatif, bukan sertifikasi) | [pemeriksaan-mutu.md](pemeriksaan-mutu.md) |
| Batas subtitle (baris, cps, durasi cue) | Lint subtitle di `bun run periksa --subtitle` | [pemeriksaan-mutu.md](pemeriksaan-mutu.md) |
| Gerak dan kilatan pada transisi dan animasi | `kurangiGerak` (mengganti jenis gerak besar dan berkilat dengan `pudar`; kamera, paralaks, getar mati), profil `lansia`/`anak`, durasi minimum jenis berkilat, `periksaKilatan` tingkat rencana. `kurangiGerak` adalah praktik terbaik, bukan klaim kepatuhan WCAG 2.3.3 | [transisi-animasi.md](transisi-animasi.md#aksesibilitas) |
| Penonton tanpa suara | Field `audiens.tanpaSuara` dan `caption.burnIn` di `konsep.json` | [konsep-jenis-alur.md](konsep-jenis-alur.md) |

PDF SOP bertag (outline, bahasa `id`, tabel `th scope`) tetapi **tidak** mengklaim PDF/UA; lihat [sop.md](sop.md).

## Changelog

### 2026-11-07 - v1.1.0

- Menambahkan baris peta fitur Gerak dan kilatan pada transisi dan animasi.

### 2026-11-07 - v1.0.0

- Dokumen baru, dipindah dari README v1.10.0 (§Aksesibilitas); isi dipertahankan.
- Menambahkan tabel Fitur yang tersedia sebagai penunjuk ke fitur aksesibilitas yang sudah ada di dokumen lain.
