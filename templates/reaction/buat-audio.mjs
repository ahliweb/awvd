#!/usr/bin/env bun
/**
 * buat-audio.mjs — membuat audio contoh buatan sendiri (nada sinus, bukan suara orang)
 * untuk templat reaction: narasi-1..6.wav dan musik.wav. Dihasilkan ffmpeg lavfi, jadi
 * tidak ada aset pihak ketiga yang disalin.
 *
 *   bun templates/reaction/buat-audio.mjs [folder-keluaran]   # bawaan .cache/awvd/reaction
 *
 * Panjang tiap narasi sama dengan jendela komentarnya (lihat sumber.json dan
 * rencana-audio.json). Pada proyek nyata, narasi adalah berkas WAV beku hasil rekaman atau
 * TTS berlisensi jelas.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".cache/awvd/reaction");
mkdirSync(dir, { recursive: true });

// [nama, frekuensi Hz, durasi detik]
const narasi = [
  ["narasi-1.wav", 330, 3.5], ["narasi-2.wav", 262, 4], ["narasi-3.wav", 294, 4.5],
  ["narasi-4.wav", 349, 4], ["narasi-5.wav", 311, 7], ["narasi-6.wav", 277, 10],
];
const sumber = narasi.map(([nama, f, d]) => [nama, `sine=f=${f}:d=${d}:sample_rate=24000,tremolo=f=5:d=0.6`, ["-ac", "1"]]);
sumber.push([
  "musik.wav",
  "aevalsrc=0.1*sin(2*PI*220*t)+0.1*sin(2*PI*277.18*t)+0.1*sin(2*PI*329.63*t):d=49:s=48000",
  ["-ac", "2"],
]);
for (const [nama, lavfi, opsi] of sumber) {
  const p = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", lavfi, ...opsi,
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
