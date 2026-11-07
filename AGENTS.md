# AGENTS.md — aturan kerja AI agent di awvd

## Metadata

- Version: `v1.0.0`
- Last updated: `2026-11-07`
- Changeset: `Aturan kerja AI agent awvd: Bun-only, determinisme, data, TTS, larangan Remotion, alur PR dan CI.`

awvd adalah renderer video MP4 dari kode web (lihat [README.md](README.md)). Pusat informasi dan pedoman eksekusi ada di pedoman internal AhliWeb (skill `video-terprogram`, `eksekusi-terkelola`, dan standar dokumen formal DL-037).

## Aturan

1. **Bun-only.** Tidak ada Node.js di lingkungan ini. Jalankan skrip dengan `bun`/`bunx`, bukan `node`/`npx`.
2. **Determinisme wajib.** Komposisi tidak boleh memakai `Date.now()`, `Math.random()` tak ber-seed (pakai `acak(seed)`), atau CSS animation/transition. Gerak hanya dari nomor frame. Lihat README §Aturan determinisme.
3. **Jangan commit** video keluaran (`*.mp4`, `*.webm`, `*.mov`, folder `out/`) maupun `node_modules`.
4. **Tidak ada data nyata** pasien, pelanggan, atau pegawai di komposisi contoh atau props; pakai data fiktif.
5. **TTS daring hanya untuk konten publik** (rujuk DL-037 di pedoman internal AhliWeb); konten internal atau sensitif tidak dikirim ke layanan daring.
6. **Larangan menyalin Remotion.** Jangan membaca atau menyalin kode atau teks Remotion maupun repositori skill-nya. awvd adalah karya asli.
7. **Alur perubahan:** setiap perubahan lewat branch dan pull request. Merge hanya bila CI `uji` berstatus SUCCESS. Tidak push langsung ke `main`, tidak force push.
8. **Jalankan `bun run uji`** sampai lolos sebelum membuka PR.
9. **Perbarui README** (dan CHANGELOG) bila API runtime atau flag CLI berubah; dokumen yang basi adalah cacat.
10. Jangan menyatakan rilis atau tag yang belum ada.

## Changelog

### 2026-11-07 - v1.0.0

- Baseline aturan kerja AI agent.
