#!/usr/bin/env bun
/**
 * siapkan.mjs — menyiapkan props templat timeline dari sebuah timeline.json.
 *
 *   bun templates/timeline/siapkan.mjs <timeline.json> [--out .cache/awvd/timeline] [--draf]
 *
 * Urutan (setiap langkah berhenti bila gagal; tidak ada Chromium):
 *   1. bun run klip   : ekstraksi frame klip dari manifes.sumber pada fps timeline (klip-props.json)
 *   2. bun run timeline periksa --klip-props --ketat : validasi (jumlah frame klip pasti)
 *   3. bun run aset periksa : aset-props.json dari manifes.aset
 *   4. menulis <out>/props.json = { timeline, klip, aset, akarAset }
 * Render: bun scripts/render.mjs templates/timeline/index.html --props-file <out>/props.json --out hasil.mp4
 *
 * Tidak ada logika jadwal di sini; hanya menjalankan CLI yang sudah ada dan merakit hasilnya.
 * Kode keluar: 0 sukses; 2 argumen atau timeline tidak valid.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skrip = (n) => join(akar, "scripts", n);

function gagal(pesan, kode = 2) {
  console.error(`siapkan: ${pesan}`);
  process.exit(kode);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}

const { values: o, positionals: p } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string", default: ".cache/awvd/timeline" }, draf: { type: "boolean", default: false } },
});
if (p.length !== 1) gagal("pemakaian: bun templates/timeline/siapkan.mjs <timeline.json> [--out DIR] [--draf]");
const berkas = resolve(p[0]);
if (!existsSync(berkas)) gagal(`timeline tidak ditemukan: ${p[0]}`);
let t;
try { t = JSON.parse(readFileSync(berkas, "utf8")); } catch (e) { gagal(`${p[0]} bukan JSON valid: ${e.message}`); }
const dir = dirname(berkas);
const keluar = resolve(o.out);
mkdirSync(keluar, { recursive: true });
const draf = o.draf ? ["--draf"] : [];

let klip = [];
if (t.manifes?.sumber) {
  const dirKlip = join(keluar, "klip");
  const r = await jalankan(["bun", skrip("klip.mjs"), join(dir, t.manifes.sumber), "--fps", String(t.proyek?.fps), "--out", dirKlip, ...draf]);
  if (r.kode !== 0) gagal(`klip gagal (exit ${r.kode}):\n${r.out}${r.err}`);
  klip = JSON.parse(readFileSync(join(dirKlip, "klip-props.json"), "utf8")).klip;
}

const pk = ["bun", skrip("timeline.mjs"), "periksa", berkas, "--ketat", ...draf];
if (klip.length) pk.push("--klip-props", join(keluar, "klip", "klip-props.json"));
const v = await jalankan(pk);
if (v.kode !== 0) gagal(`timeline ditolak validator (exit ${v.kode}):\n${v.out}${v.err}`);

let aset, akarAset;
if (t.manifes?.aset) {
  const dirAset = join(keluar, "aset");
  const r = await jalankan(["bun", skrip("aset.mjs"), "periksa", join(dir, t.manifes.aset), "--out", dirAset]);
  if (r.kode !== 0) gagal(`aset gagal (exit ${r.kode}):\n${r.out}${r.err}`);
  aset = JSON.parse(readFileSync(join(dirAset, "aset-props.json"), "utf8")).aset;
  akarAset = pathToFileURL(dirname(join(dir, t.manifes.aset))).href;
}

const props = { timeline: t, klip, ...(aset ? { aset, akarAset } : {}) };
writeFileSync(join(keluar, "props.json"), `${JSON.stringify(props, null, 2)}\n`);
console.log(`props: ${join(o.out, "props.json")} (${klip.length} klip${aset ? `, ${Object.keys(aset).length} aset` : ""})`);
