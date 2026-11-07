# AGENTS.md — aturan kerja AI agent di awvd

## Metadata

- Version: `v1.2.0`
- Last updated: `2026-11-07`
- Changeset: `Menambahkan bagian Dokumentasi: setiap perubahan konsep/fitur wajib disertai pembaruan dokumen menurut pedoman ahliweb/personal-coding (standar-dokumen-repo, DL-035, eksekusi-terkelola §7), lengkap dengan peta pemicu dan checklist PR.`

awvd adalah renderer video MP4 dari kode web (lihat [README.md](README.md)). Pusat informasi dan pedoman eksekusi ada di `ahliweb/personal-coding` (skill `video-terprogram`, `eksekusi-terkelola`, dan standar dokumen formal DL-037).

## Aturan

1. **Bun-only.** Tidak ada Node.js di lingkungan ini. Jalankan skrip dengan `bun`/`bunx`, bukan `node`/`npx`.
2. **Determinisme wajib.** Komposisi tidak boleh memakai `Date.now()`, `Math.random()` tak ber-seed (pakai `acak(seed)`), atau CSS animation/transition. Gerak hanya dari nomor frame. Lihat README §Aturan determinisme.
3. **Jangan commit** video keluaran (`*.mp4`, `*.webm`, `*.mov`, folder `out/`) maupun `node_modules`.
4. **Tidak ada data nyata** pasien, pelanggan, atau pegawai di komposisi contoh atau props; pakai data fiktif.
5. **TTS daring hanya untuk konten publik** (rujuk DL-037 di `ahliweb/personal-coding`); konten internal atau sensitif tidak dikirim ke layanan daring.
6. **Larangan menyalin Remotion.** Jangan membaca atau menyalin kode atau teks Remotion maupun repositori skill-nya. awvd adalah karya asli.
7. **Alur perubahan:** setiap perubahan lewat branch dan pull request. Merge hanya bila CI `uji` berstatus SUCCESS. Tidak push langsung ke `main`, tidak force push.
8. **Jalankan `bun run uji`** sampai lolos sebelum membuka PR.
9. **Dokumentasi ikut setiap perubahan konsep atau fitur**, dalam PR yang sama. Dokumen yang basi adalah cacat. Rinciannya di §Dokumentasi.
10. Jangan menyatakan rilis atau tag yang belum ada.

## Lisensi dan Aset

- Dilarang membaca untuk menyalin atau mengadaptasi kode produk sejenis yang lisensinya membatasi (Remotion, dan repo tanpa lisensi).
- Dependensi baru wajib berlisensi permisif (MIT/Apache-2.0/BSD/ISC). Dependensi copyleft perlu keputusan pemilik. Cek lisensi sebelum `bun add`.
- Setiap aset pihak ketiga dicatat di `templates/<nama>/ASET.md` (sumber, lisensi, tanggal).
- Pertahankan atribusi mulberry32 di `scripts/runtime.js`.

## Dokumentasi

Pedoman induk ada di `ahliweb/personal-coding`:

- skill `standar-dokumen-repo`: blok Metadata, versi dokumen `vX.Y.Z`, Changelog, Mermaid;
- `docs/standar-changeset-changelog-versioning.md` (DL-035): Document Changeset, Release Changeset, dan Changelog adalah tiga hal berbeda;
- skill `eksekusi-terkelola` §7: dokumentasi harus menggambarkan kondisi repo yang sebenarnya, bukan rencana atau perilaku lama.

### Kapan wajib

Setiap PR yang mengubah **konsep** (cara kerja komposisi, model render, aturan determinisme, alur kerja) atau **fitur** (API runtime, flag CLI, mode URL, format keluaran, template, uji, CI, dependensi) wajib menyertakan pembaruan dokumen di PR yang sama. Perubahan yang murni internal tanpa efek yang terlihat pengguna tidak wajib, tetapi sebutkan "docs: tidak berlaku" beserta alasannya di deskripsi PR.

### Peta pemicu ke dokumen

| Perubahan | Dokumen yang diperbarui |
| --- | --- |
| API runtime, `ctx`, mode URL (`?preview`, `?frame`, `?props`) | README §Konsep komposisi, §Referensi API runtime; komentar kepala `scripts/runtime.js` |
| Flag CLI, kode keluar, perilaku renderer | README §Flag CLI, §Alur render; `PETUNJUK` di `scripts/render.mjs` |
| Aturan determinisme | README §Aturan determinisme; aturan 2 di dokumen ini |
| Format keluaran, performa, platform | README §Batasan yang diketahui |
| Template baru atau berubah | README §Struktur repo; `templates/<nama>/ASET.md` |
| Uji atau CI | README §Struktur repo (daftar uji dan opsi `bun run uji`) |
| Dependensi atau lisensi pihak ketiga | README §Pihak ketiga; cek lisensi (§Lisensi dan Aset) |
| Aturan kerja agent | `AGENTS.md` (CLAUDE.md hanya merujuk ke sini) |
| Semua perubahan software di atas | `CHANGELOG.md` bagian `[Unreleased]` |

Skill `video-terprogram` di `ahliweb/personal-coding` merujuk API awvd. Bila API atau flag berubah, catat di deskripsi PR bahwa skill itu perlu disesuaikan; perubahannya dikerjakan lewat PR di repo tersebut.

### Dua jenis versi, jangan dicampur

- **Dokumen ber-metadata** (`README.md`, `AGENTS.md`): naikkan `Version`, ganti `Last updated` dan `Changeset` (ringkasan revisi terakhir saja), lalu tambahkan satu entri di `## Changelog` dokumen tanpa menghapus entri lama. Patch untuk koreksi, minor untuk bagian baru yang kompatibel, major untuk perubahan struktur atau kebijakan.
- **Software** (`CHANGELOG.md`, `package.json`): format Keep a Changelog, perubahan masuk `[Unreleased]`. Versi `package.json` hanya dinaikkan saat rilis yang diputuskan pemilik. Repo ini **tidak** memakai Release Changeset (`.changeset/`); jangan membuatnya.
- Versi dokumen tidak sama dengan versi software. README `v1.2.0` tidak berarti awvd `1.2.0`.

```mermaid
flowchart TD
    U[Perubahan di branch] --> K{Konsep atau\nfitur berubah?}
    K -->|Tidak| N[Tulis 'docs: tidak berlaku'\n+ alasan di PR]
    K -->|Ya| P[Cari dokumen di\npeta pemicu]
    P --> E[Edit isi agar sesuai\nkondisi nyata]
    E --> D{Dokumen punya\nMetadata?}
    D -->|Ya| V[Naikkan Version\n+ Changeset + Changelog]
    D -->|CHANGELOG.md| R[Entri di Unreleased]
    V --> S{API/flag berubah?}
    R --> S
    S -->|Ya| X[Catat penyesuaian skill\nvideo-terprogram di PR]
    S -->|Tidak| C[Checklist PR]
    X --> C
```

### Checklist sebelum membuka PR

- [ ] Isi dokumen sesuai kode yang di-commit (contoh di README dapat dijalankan apa adanya).
- [ ] `Version` berformat `vX.Y.Z` dan konsisten di Metadata serta judul Changelog; `Last updated` berformat `YYYY-MM-DD`.
- [ ] Entri lama di Changelog dokumen dan `CHANGELOG.md` tetap utuh.
- [ ] Tidak ada klaim rilis, tag, atau deploy yang belum terverifikasi.
- [ ] Tidak ada data nyata, secret, atau token di contoh.
- [ ] Bahasa Indonesia, konsisten dengan dokumen sekitarnya.

Template PR di `.github/pull_request_template.md` memuat checklist ini.

## Changelog

### 2026-11-07 - v1.2.0

- Menambahkan bagian Dokumentasi: kewajiban memperbarui dokumen pada setiap perubahan konsep/fitur, peta pemicu, pemisahan versi dokumen dan software (DL-035), diagram alur, dan checklist PR. Aturan 9 kini merujuk ke bagian ini.

### 2026-11-07 - v1.1.0

- Menambahkan bagian Lisensi dan Aset.

### 2026-11-07 - v1.0.0

- Baseline aturan kerja AI agent.
