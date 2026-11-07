#!/usr/bin/env bun
/**
 * buat-lut.mjs — membangkitkan LUT 3D contoh buatan sendiri (format .cube) untuk templat
 * klip-tertanam: identitas.cube (tidak mengubah warna) dan hangat.cube (merah naik 10%
 * dengan batas putih, biru turun 15%, hijau tetap: putih menjadi krem hangat, hitam tetap hitam).
 *
 *   bun templates/klip-tertanam/buat-lut.mjs [folder-keluaran]   # bawaan templates/klip-tertanam/lut
 *
 * Keluaran deterministik (angka ditulis dengan 6 desimal), jadi berkas yang di-commit di lut/
 * sama dengan hasil skrip ini; scripts/uji-klip.mjs memeriksanya. Urutan data .cube: merah
 * paling cepat berubah, lalu hijau, lalu biru.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UKURAN = 17;

/** Teks .cube untuk fungsi warna f([r,g,b] 0..1) -> [r,g,b] 0..1. */
export function bangkitkanCube(judul, f, ukuran = UKURAN) {
  const baris = [`TITLE "${judul}"`, "# Dibangkitkan templates/klip-tertanam/buat-lut.mjs (milik proyek awvd, CC0-1.0)", `LUT_3D_SIZE ${ukuran}`];
  const n = ukuran - 1;
  for (let b = 0; b < ukuran; b++) {
    for (let g = 0; g < ukuran; g++) {
      for (let r = 0; r < ukuran; r++) baris.push(f([r / n, g / n, b / n]).map((x) => x.toFixed(6)).join(" "));
    }
  }
  return `${baris.join("\n")}\n`;
}

export const LUT = {
  "identitas.cube": ["identitas", (c) => c],
  "hangat.cube": ["hangat", ([r, g, b]) => [Math.min(1, r * 1.1), g, b * 0.85]],
};

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "lut"));
  mkdirSync(dir, { recursive: true });
  for (const [nama, [judul, f]] of Object.entries(LUT)) writeFileSync(join(dir, nama), bangkitkanCube(judul, f));
  console.log(`LUT contoh ditulis ke ${dir}: ${Object.keys(LUT).join(", ")}`);
}
