# Aset templat transisi-galeri

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Baseline pencatatan aset: galeri transisi dan animasi tidak memuat aset pihak ketiga.`

Catatan sumber dan lisensi setiap aset pihak ketiga yang dipakai templat ini (AGENTS.md §Lisensi dan Aset).

| Aset | Sumber | Lisensi | Tanggal |
| --- | --- | --- | --- |
| - | - | - | - |

Templat ini tidak memuat aset pihak ketiga. Semua adegan adalah gradien dan bentuk CSS buatan sendiri; teks adalah label katalog dan data fiktif ("A 42", angka 12.847). Font diambil dari font sistem lewat `font-family: system-ui, ...` dan tidak didistribusikan. Satu-satunya yang berasal dari luar adalah angka pola Material (ambang fade through, skala awal, token durasi, kurva easing) di `scripts/transisi.js`; itu nilai, bukan aset, dan atribusinya (Material Components for Android, Apache-2.0) tercatat di [docs/lisensi-kepatuhan.md](../../docs/lisensi-kepatuhan.md).

Props (`props.json`): `profil` (`standar`, `lansia`, `anak`, `kurangiGerak`) dan `hud` (`true` menampilkan nama transisi di pojok kiri bawah). Panjang video bergantung profil karena `susunAdegan` menghitung tumpang-tindih: standar 1189 frame (39,6 s), `lansia` 1015 frame, `kurangiGerak` 1224 frame pada 30 fps.

## Changelog

### 2026-11-07 - v1.0.0

- Baseline: tidak ada aset pihak ketiga.
