#!/usr/bin/env bun
/**
 * buat-audio.mjs — membuat audio contoh buatan sendiri (nada sinus, bukan suara orang)
 * untuk templat klip-tertanam: narasi-1.wav, narasi-2.wav, musik.wav.
 * Dihasilkan ffmpeg lavfi, jadi tidak ada aset pihak ketiga yang disalin.
 *
 *   bun templates/klip-tertanam/buat-audio.mjs [folder-keluaran]   # bawaan .cache/awvd/contoh
 *
 * Pada proyek nyata, narasi adalah berkas WAV beku hasil rekaman atau TTS berlisensi jelas.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".cache/awvd/contoh");
mkdirSync(dir, { recursive: true });

const sumber = [
  ["narasi-1.wav", "sine=f=330:d=3:sample_rate=24000,tremolo=f=5:d=0.6", ["-ac", "1"]],
  ["narasi-2.wav", "sine=f=262:d=3:sample_rate=24000,tremolo=f=5:d=0.6", ["-ac", "1"]],
  [
    "musik.wav",
    "aevalsrc=0.1*sin(2*PI*220*t)+0.1*sin(2*PI*277.18*t)+0.1*sin(2*PI*329.63*t):d=17:s=48000",
    ["-ac", "2"],
  ],
];
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
