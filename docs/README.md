# Dokumentasi awvd

## Metadata

- Version: `v1.1.0`
- Last updated: `2026-11-07`
- Changeset: `Mendaftarkan visual-audiens.md (14 dokumen docs/) dan memperbarui versi dokumen yang berubah.`

Pintu masuk ke seluruh dokumentasi rinci awvd. Ringkasan proyek, mulai cepat, dan perintah utama ada di [README akar](../README.md); aturan kerja kontributor dan AI agent ada di [AGENTS.md](../AGENTS.md); riwayat perubahan software ada di [CHANGELOG.md](../CHANGELOG.md).

## Indeks dokumen

Kolom Versi adalah versi dokumen (bukan versi software); nilainya harus sama dengan `Version` di blok Metadata dokumen itu.

| Dokumen | Isi | Versi |
| --- | --- | --- |
| [arsitektur.md](arsitektur.md) | Alur render, konsep komposisi, protokol `window.video`/`renderFrame`, aturan determinisme, peran upstream, memakai awvd di repo proyek | `v1.0.0` |
| [api-runtime.md](api-runtime.md) | Referensi seluruh API `scripts/runtime.js`, mode URL, sumber riset helper | `v1.1.0` |
| [cli.md](cli.md) | Flag `render.mjs`, kode keluar, encode BT.709, kenyaringan, daftar perintah lain | `v1.0.0` |
| [pemeriksaan-mutu.md](pemeriksaan-mutu.md) | `bun run periksa` (termasuk `--konsep`): pemeriksaan, ambang, kilatan fotosensitif | `v1.0.1` |
| [konsep-jenis-alur.md](konsep-jenis-alur.md) | `bun run konsep`, `konsep.json`, 13 jenis video, 5 alur produksi, tingkat bukti, profil audiens | `v1.1.0` |
| [sop.md](sop.md) | SOP sebagai dokumen cetak (PermenPAN-RB 35/2012) dan bahan video | `v1.0.0` |
| [video-tertanam-audio.md](video-tertanam-audio.md) | Video di dalam video (lisensi sumber, `klip.mjs`) dan timeline audio (`audio.mjs`) | `v1.0.0` |
| [visual-audiens.md](visual-audiens.md) | Profil audiens, ukuran teks, buta warna dan jarak warna, ketajaman (garis 2 px, 4:2:0, supersampling), efek dekoratif | `v1.0.0` |
| [aksesibilitas.md](aksesibilitas.md) | Subtitle, kontras, kilatan, kontrol pratinjau, peta fitur aksesibilitas | `v1.1.0` |
| [batasan.md](batasan.md) | Batasan yang diketahui dan penunjuk ke batasan per fitur | `v1.1.0` |
| [lisensi-kepatuhan.md](lisensi-kepatuhan.md) | Lisensi MIT, asal kode, pihak ketiga, tanggung jawab atas aset | `v1.0.0` |
| [pedoman-produksi.md](pedoman-produksi.md) | Pedoman produksi berbasis riset, dipetakan ke fitur awvd, checklist, rencana | `v1.1.0` |
| [log-keputusan.md](log-keputusan.md) | Log keputusan awvd (KP-001 dst.) beserta alasan dan rujukan PR | `v1.1.0` |
| [README.md](README.md) | Indeks ini | `v1.1.0` |

## Peta dokumen

Panah menunjukkan arah rujukan utama: dokumen fitur merujuk ke dokumen dasar, dan pedoman serta log keputusan menjelaskan alasannya.

```mermaid
flowchart TD
    R[README akar<br/>ringkasan + indeks] --> I[docs/README.md<br/>indeks]
    I --> A[arsitektur]
    A --> API[api-runtime]
    A --> CLI[cli]
    CLI --> QC[pemeriksaan-mutu]
    CLI --> KLP[video-tertanam-audio]
    CLI --> SOP[sop]
    CLI --> KON[konsep-jenis-alur]
    KON --> QC
    KON --> VIS[visual-audiens]
    API --> VIS
    I --> PP[pedoman-produksi<br/>dasar riset]
    I --> LK[log-keputusan<br/>alasan]
    I --> AKS[aksesibilitas]
    I --> BAT[batasan]
    I --> LIS[lisensi-kepatuhan]
    KLP --> LIS
    PP -.->|dipetakan ke| API
    PP -.->|dipetakan ke| QC
    AG[AGENTS.md<br/>peta pemicu] -.->|menunjuk dokumen yang<br/>harus diperbarui| I
```

## Menambah atau mengubah dokumen

- Setiap dokumen Markdown di `docs/` wajib memiliki blok `## Metadata` tepat setelah judul (`Version` `vX.Y.Z`, `Last updated` `YYYY-MM-DD`, `Changeset` berisi ringkasan revisi terakhir saja) dan `## Changelog` di bagian bawah dengan entri `### YYYY-MM-DD - vX.Y.Z` terbaru di atas.
- Dokumen baru wajib didaftarkan di tabel Indeks dokumen di atas dan di indeks dokumentasi [README akar](../README.md#dokumentasi).
- Setiap perubahan dokumen menaikkan `Version` dokumen itu dan nilainya di kolom Versi di atas. Patch untuk koreksi, minor untuk bagian baru yang kompatibel, major untuk perubahan struktur atau kebijakan.
- Dokumen harus sama dengan kondisi nyata repo; jangan menulis rencana sebagai fitur. Rencana boleh ditulis di bagian tersendiri tanpa janji tanggal (contoh: [pedoman-produksi.md](pedoman-produksi.md#rencana)).
- Gunakan Mermaid hanya bila diagram menambah informasi (arsitektur, alur, atau keputusan), dengan label singkat.
- Document Changeset (blok Metadata dokumen) tidak sama dengan Release Changeset (tidak dipakai di repo ini) maupun `CHANGELOG.md` software. Aturan lengkap dan peta "perubahan apa memperbarui dokumen mana" ada di [AGENTS.md](../AGENTS.md) §Dokumentasi.
- Dokumen berbahasa Indonesia dan tidak menyebut nama, path, atau tautan repo internal AhliWeb yang privat.

## Changelog

### 2026-11-07 - v1.1.0

- Mendaftarkan `visual-audiens.md` (14 dokumen) dan memperbarui kolom Versi dokumen yang berubah.

### 2026-11-07 - v1.0.0

- Indeks dokumentasi pertama: 13 dokumen docs/ beserta peta dokumen dan aturan menambah dokumen.
