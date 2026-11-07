#!/usr/bin/env bun
/**
 * buat-props.mjs — membuat props komposisi demo caption (templates/narasi-contoh/index.html)
 * dari naskah.json: menjalankan pipeline narasi (scripts/narasi.mjs) pada WAV contoh lalu
 * menulis { lebar, tinggi, vtt, kata } ke berkas props. Tidak ada TTS atau jaringan; WAV contoh
 * dibuat buat-audio.mjs bila belum ada.
 *
 *   bun templates/narasi-contoh/buat-props.mjs [--mode MODE] [--posisi POSISI]
 *        [--ukuran lanskap|potret] [--out props.json]        # bawaan out/narasi-contoh/props.json
 *
 *   MODE    pop-on | roll-up | paint-on | sorot-kata | satu-kata   (bawaan: caption.mode naskah)
 *   POSISI  bawah | atas | auto | dekat-penutur                    (bawaan: caption.posisi naskah)
 *   ukuran  lanskap = 1280x720 (bawaan); potret = 1080x1920 (maksKarakter 28, area aman 9:16)
 *
 * Lalu: bun run render templates/narasi-contoh/index.html --props-file out/narasi-contoh/props.json --out out/caption.mp4
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buatNarasi, validasiNaskah } from "../../scripts/narasi.mjs";

const dirTemplat = dirname(fileURLToPath(import.meta.url));
const akar = resolve(dirTemplat, "..", "..");
const UKURAN = { lanskap: { lebar: 1280, tinggi: 720 }, potret: { lebar: 1080, tinggi: 1920 } };
// Titik pusat caption dekat penutur sebagai pecahan bingkai (lanskap: di samping penutur; potret: di bawah penutur).
const JANGKAR = { lanskap: [0.62, 0.46], potret: [0.5, 0.55] };

/** Membuat props: { lebar, tinggi, vtt, kata }. Melempar galat bila naskah tidak valid atau lint cps gagal. */
export async function buatProps({ mode, posisi, ukuran = "lanskap" } = {}) {
  if (!UKURAN[ukuran]) throw new Error(`ukuran harus lanskap atau potret (dapat ${JSON.stringify(ukuran)})`);
  const wav = join(akar, ".cache", "awvd", "narasi-contoh", "a1.wav");
  if (!existsSync(wav)) {
    const p = Bun.spawn(["bun", join(dirTemplat, "buat-audio.mjs")], { stdout: "ignore", stderr: "pipe" });
    const [err, kode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (kode !== 0) throw new Error(`buat-audio.mjs gagal: ${err.trim()}`);
  }
  const naskah = JSON.parse(readFileSync(join(dirTemplat, "naskah.json"), "utf8"));
  const { lebar, tinggi } = UKURAN[ukuran];
  naskah.ukuran = { lebar, tinggi };
  naskah.caption = { ...naskah.caption };
  if (ukuran === "potret") {
    delete naskah.caption.maksKarakter; // bawaan potret: 28 karakter per baris
    naskah.caption.cps = 20; // cue lebih pendek pada 28 karakter: batas SDH dewasa (peringatan, bukan gagal)
  }
  if (mode !== undefined) naskah.caption.mode = mode;
  if (posisi !== undefined) naskah.caption.posisi = posisi;
  for (const a of naskah.adegan) {
    if (a.jangkarPenutur) a.jangkarPenutur = { x: Math.round(lebar * JANGKAR[ukuran][0]), y: Math.round(tinggi * JANGKAR[ukuran][1]) };
  }
  const v = validasiNaskah(naskah, dirTemplat);
  if (!v.naskah) throw new Error(`naskah tidak valid: ${v.galat.join("; ")}`);
  const hasil = await buatNarasi(v.naskah);
  if (hasil.gagal.length) throw new Error(`lint narasi gagal: ${hasil.gagal.map((x) => x.pesan).join("; ")}`);
  return { lebar, tinggi, vtt: hasil.berkas["caption.vtt"], kata: hasil.kata };
}

if (import.meta.main) {
  let nilai;
  try {
    ({ values: nilai } = parseArgs({ args: process.argv.slice(2), options: { mode: { type: "string" }, posisi: { type: "string" }, ukuran: { type: "string" }, out: { type: "string" } } }));
  } catch (e) {
    console.error(`buat-props: ${e.message}`);
    process.exit(2);
  }
  try {
    const props = await buatProps({ mode: nilai.mode, posisi: nilai.posisi, ukuran: nilai.ukuran });
    const keluar = resolve(nilai.out ?? "out/narasi-contoh/props.json");
    mkdirSync(dirname(keluar), { recursive: true });
    writeFileSync(keluar, JSON.stringify(props, null, 2) + "\n");
    console.log(`props: ${keluar} (${props.lebar}x${props.tinggi}, mode ${props.kata.caption?.mode ?? "pop-on"}, posisi ${props.kata.caption?.posisi ?? "bawah"}, ${props.kata.durasiFrame} frame)`);
    console.log(`render: bun run render templates/narasi-contoh/index.html --props-file ${keluar} --out out/caption.mp4`);
  } catch (e) {
    console.error(`buat-props: ${e.message}`);
    process.exit(1);
  }
}
