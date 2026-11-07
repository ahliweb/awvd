#!/usr/bin/env bun
/**
 * buat-audio.mjs — membuat WAV narasi contoh buatan sendiri untuk templat narasi-contoh.
 * Isinya nada sinus bertremolo (bukan suara orang, bukan TTS) yang dihasilkan ffmpeg lavfi:
 * lari "bicara" dan jeda senyap disusun supaya jeda jatuh di tanda baca naskah.json
 * (titik: 0,7 s; koma: 0,3 s). Panjang lari bicara mengikuti perkiraan bobot kata naskah.
 *
 *   bun templates/narasi-contoh/buat-audio.mjs [folder-keluaran]   # bawaan .cache/awvd/narasi-contoh
 *
 * Pada proyek nyata, narasi adalah WAV beku hasil rekaman atau TTS berlisensi jelas.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".cache/awvd/narasi-contoh");
mkdirSync(dir, { recursive: true });

// [jenis, detik]: b = bicara, s = senyap. Satu entri berkas per WAV di naskah.json.
const BERKAS = {
  "a1.wav": [["b", 3.6], ["s", 0.7], ["b", 0.55], ["s", 0.3], ["b", 3.45], ["s", 0.7], ["b", 0.4], ["s", 0.3], ["b", 2.5]],
  "a2-1.wav": [["b", 3.5]],
  "a2-2.wav": [["b", 0.95], ["s", 0.3], ["b", 1.8]],
};
const SR = 24000;

for (const [nama, lari] of Object.entries(BERKAS)) {
  const masuk = [], rantai = [];
  lari.forEach(([jenis, d], i) => {
    masuk.push("-f", "lavfi", "-i", jenis === "b"
      ? `sine=f=${200 + (i % 3) * 20}:d=${d}:sample_rate=${SR},tremolo=f=4:d=0.5`
      : `anullsrc=r=${SR}:cl=mono:d=${d}`);
    rantai.push(`[${i}:a]`);
  });
  const filter = `${rantai.join("")}concat=n=${lari.length}:v=0:a=1[k]`;
  const p = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...masuk, "-filter_complex", filter, "-map", "[k]", "-ac", "1",
      "-c:a", "pcm_s16le", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", join(dir, nama)],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [err, kode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) {
    console.error(`buat-audio.mjs: ffmpeg gagal untuk ${nama}: ${err.trim()}`);
    process.exit(1);
  }
  console.log(`dibuat: ${join(dir, nama)}`);
}
