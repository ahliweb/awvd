#!/usr/bin/env bun
/**
 * uji-segmentasi.mjs — uji scripts/segmentasi-lib.js dan scripts/segmentasi.mjs (hapus latar lokal).
 *
 * Bagian tanpa onnxruntime (selalu jalan, juga di CI): skema registri dan pemvalidasinya,
 * fail-closed (ORT tidak ada, bobot tidak ada, ukuran dan sha256 salah, registri kustom),
 * pra/pasca-proses, ambang, EMA, ubah ukuran bilangan bulat, dan CLI. ORT PALSU (modul CJS kecil
 * yang mencatat panggilan) membuktikan bahwa bobot yang ditolak tidak pernah sampai ke ORT dan
 * menguji jalur sesi. Semua data sintetis; tidak ada data orang.
 *
 * Bagian dengan onnxruntime sungguhan hanya jalan bila AWVD_ORT diset (folder paket
 * onnxruntime-node); selain itu dilewati dengan pesan jelas:
 *   - model ONNX mini buatan sendiri (ReduceMean, ditulis sebagai protobuf oleh skrip ini, tanpa
 *     dependensi) sebagai model kustom: nilai mask diperiksa terhadap acuan JS, hasil identik antar-run
 *     dan antar-jumlah thread (1 dan 4), urutan EMA identik;
 *   - model registri sungguhan (selfie, modnet) hanya bila bobotnya ada di AWVD_MODEL_DIR (nama
 *     berkas dari registri); sha256 tetap diverifikasi.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-segmentasi.mjs
 *   AWVD_ORT=/jalur/onnxruntime-node AWVD_MODEL_DIR=/jalur/bobot bun scripts/uji-segmentasi.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BATAS_BOBOT_BYTE, GalatSegmentasi, JALUR_REGISTRI_BAWAAN, LISENSI_PERMISIF, buatEma, buatLut, buatSegmenter, cariBobot,
  muatRegistri, pascaProses, pastikanOrt, praProses, ubahUkuran, ukuranMasukan, validasiRegistri, verifikasiBobot,
} from "./segmentasi-lib.js";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(akar, "scripts", "segmentasi.mjs");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-segmentasi-"));
const j = (...p) => join(tmp, ...p);

function tegas(kondisi, pesan) { if (!kondisi) throw new Error(pesan); }
function samaDengan(nyata, harapan, nama) {
  const a = JSON.stringify(nyata), b = JSON.stringify(harapan);
  tegas(a === b, `${nama}: dapat ${a}, harapan ${b}`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const salin = (x) => JSON.parse(JSON.stringify(x));
async function galat(fn, kode, nama) {
  try { await fn(); } catch (e) {
    tegas(e instanceof GalatSegmentasi, `${nama}: galat bukan GalatSegmentasi: ${e?.stack ?? e}`);
    tegas(e.kode === kode, `${nama}: kode ${e.kode} (${e.message}), harapan ${kode}`);
    return e;
  }
  throw new Error(`${nama}: tidak melempar`);
}
async function bun(skrip, args, env) {
  const p = Bun.spawn(["bun", skrip, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
// lingkungan tanpa konfigurasi segmentasi (uji tidak boleh bergantung pada env mesin ini)
const envBersih = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWVD_(ORT|MODEL_DIR|REGISTRI_SEGMENTASI)$/.test(k)));

// PRNG bersemai untuk data sintetis (mulberry32)
function acak(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Bingkai rgb24 sintetis: gradasi, elips "orang", derau bersemai. */
function bingkaiSintetis(l, t, seed = 1) {
  const r = acak(seed), b = new Uint8Array(l * t * 3);
  for (let y = 0; y < t; y++) for (let x = 0; x < l; x++) {
    const dx = (x - l / 2) / (l * 0.2), dy = (y - t / 2) / (t * 0.35), dalam = dx * dx + dy * dy < 1;
    const i = (y * l + x) * 3;
    b[i] = dalam ? 200 : Math.floor((x / l) * 120);
    b[i + 1] = dalam ? 150 : Math.floor((y / t) * 120);
    b[i + 2] = dalam ? 120 : 60;
    for (let c = 0; c < 3; c++) b[i + c] = Math.min(255, b[i + c] + Math.floor(r() * 12));
  }
  return b;
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

const bawaan = JSON.parse(readFileSync(JALUR_REGISTRI_BAWAAN, "utf8"));

// ------------------------------------------------------------------ registri
daftar("registri bawaan: skema valid, hanya selfie dan modnet, sha256 dan ukuran wajib, lisensi permisif", () => {
  const v = validasiRegistri(bawaan);
  samaDengan(v.galat, [], "galat registri bawaan");
  samaDengan(Object.keys(bawaan.model).sort(), ["modnet", "selfie"], "id model bawaan");
  for (const [id, m] of Object.entries(bawaan.model)) {
    tegas(/^[0-9a-f]{64}$/.test(m.sha256), `${id}: sha256 tidak valid`);
    tegas(Number.isInteger(m.ukuranByte) && m.ukuranByte > 0, `${id}: ukuranByte`);
    tegas(LISENSI_PERMISIF.includes(m.lisensiKode) && LISENSI_PERMISIF.includes(m.lisensiBobot), `${id}: lisensi tidak permisif`);
    tegas(m.lisensiBobot === "Apache-2.0", `${id}: lisensi bobot harus Apache-2.0 (keputusan pemilik), dapat ${m.lisensiBobot}`);
    tegas(m.unduh.url.startsWith("https://") && m.unduh.jenis === "konversi-komunitas", `${id}: unduh`);
    tegas(/\/resolve\/[0-9a-f]{40}\//.test(m.unduh.url) && m.unduh.url.includes(m.unduh.revisi), `${id}: URL unduh harus terkunci ke revisi commit`);
    tegas(m.sumberAsli.startsWith("https://github.com/"), `${id}: sumberAsli`);
  }
  // keputusan pemilik (KP-080): RVM (GPL-3.0), BRIA RMBG, model AGPL, dan BiRefNet tidak masuk registri
  for (const terlarang of ["robustvideomatting", "rvm", "rmbg", "bria", "yolo", "birefnet"]) {
    tegas(!Object.keys(bawaan.model).some((id) => id.includes(terlarang)), `registri memuat id terlarang: ${terlarang}`);
    tegas(!Object.values(bawaan.model).some((m) => String(m.nama).toLowerCase().includes(terlarang)), `registri memuat nama terlarang: ${terlarang}`);
  }
  for (const m of Object.values(bawaan.model)) tegas(!/gpl/i.test(`${m.lisensiKode} ${m.lisensiBobot}`), "lisensi copyleft di registri");
});

daftar("registri bawaan: sha256 yang sama tercatat di docs/segmentasi-latar.md dan docs/lisensi-kepatuhan.md", () => {
  for (const berkas of ["segmentasi-latar.md", "lisensi-kepatuhan.md"]) {
    const teks = readFileSync(join(akar, "docs", berkas), "utf8");
    for (const [id, m] of Object.entries(bawaan.model)) tegas(teks.includes(m.sha256), `docs/${berkas} tidak memuat sha256 ${id}`);
  }
});

daftar("onnxruntime TIDAK menjadi dependensi (dependencies, optionalDependencies, dev, peer) dan tidak ada di lockfile", () => {
  const pkg = JSON.parse(readFileSync(join(akar, "package.json"), "utf8"));
  for (const bagian of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]) {
    tegas(!Object.keys(pkg[bagian] ?? {}).some((k) => /onnx/i.test(k)), `package.json ${bagian} memuat onnx`);
  }
  for (const kunci of ["bun.lock", "bun.lockb"]) {
    if (existsSync(join(akar, kunci))) tegas(!/onnx/i.test(readFileSync(join(akar, kunci)).toString("latin1")), `${kunci} memuat onnx`);
  }
});

daftar("validasiRegistri menolak registri bawaan yang cacat (fail-closed) dan menerima kustom tanpa sha256 dengan peringatan", () => {
  const cacat = (ubah, potongan, kustom = false) => {
    const r = salin(bawaan); ubah(r);
    const v = validasiRegistri(r, { kustom });
    tegas(v.galat.some((g) => g.includes(potongan)), `harus menolak (${potongan}); galat: ${JSON.stringify(v.galat)}`);
  };
  cacat((r) => { delete r.model.selfie.sha256; }, "sha256 wajib");
  cacat((r) => { r.model.selfie.sha256 = null; }, "sha256 wajib");
  cacat((r) => { r.model.selfie.sha256 = "ABC"; }, "64 heksadesimal");
  cacat((r) => { r.model.selfie.sha256 = r.model.selfie.sha256.toUpperCase(); }, "64 heksadesimal");
  cacat((r) => { delete r.model.selfie.ukuranByte; }, "ukuranByte wajib");
  cacat((r) => { r.model.selfie.ukuranByte = BATAS_BOBOT_BYTE + 1; }, "ukuranByte");
  cacat((r) => { r.model.selfie.lisensiBobot = "GPL-3.0"; }, "bukan lisensi permisif");
  cacat((r) => { r.model.selfie.lisensiKode = "AGPL-3.0"; }, "bukan lisensi permisif");
  cacat((r) => { delete r.model.selfie.lisensiBobot; }, "lisensiBobot wajib");
  cacat((r) => { r.model.selfie.berkas = "../x.onnx"; }, "berkas wajib");
  cacat((r) => { r.model.selfie.berkas = "x.bin"; }, "berkas wajib");
  cacat((r) => { r.model.selfie.unduh.url = "http://contoh.test/m.onnx"; }, "unduh.url");
  cacat((r) => { delete r.model.selfie.unduh; }, "unduh wajib");
  cacat((r) => { r.model.selfie.unduh.jenis = "resmi?"; }, "unduh.jenis");
  cacat((r) => { delete r.model.selfie.sumberAsli; }, "sumberAsli wajib");
  cacat((r) => { delete r.model.selfie.tanggalSha256; }, "tanggalSha256 wajib");
  cacat((r) => { r.model.selfie.tanggalSha256 = "08-11-2026"; }, "tanggalSha256");
  cacat((r) => { r.model.selfie.rahasia = 1; }, 'kunci tidak dikenal "rahasia"');
  cacat((r) => { r.model.selfie.masukan.tetap = [256]; }, "tetap");
  cacat((r) => { r.model.selfie.masukan.dinamis = { kelipatan: 32, min: 64, maks: 2048, sisiPanjangBawaan: 512 }; }, "tepat satu");
  cacat((r) => { delete r.model.selfie.masukan; }, "masukan wajib");
  cacat((r) => { r.model.modnet.masukan.dinamis.sisiPanjangBawaan = 4000; }, "dinamis");
  cacat((r) => { r.model.modnet.masukan.bagi = 0; }, "bagi");
  cacat((r) => { r.model["Salah Id"] = r.model.selfie; }, "id harus cocok");
  cacat((r) => { r.versi = 2; }, "versi harus");
  cacat((r) => { r.model = {}; }, "minimal satu model");
  samaDengan(validasiRegistri([], {}).galat.length, 1, "bukan objek");
  // kustom: sha256 tidak wajib (peringatan), lisensi non-permisif jadi peringatan
  const k = salin(bawaan);
  for (const m of Object.values(k.model)) { delete m.sha256; delete m.ukuranByte; delete m.tanggalSha256; delete m.sumberAsli; delete m.unduh; m.lisensiBobot = "CC-BY-NC-4.0"; }
  const v = validasiRegistri(k, { kustom: true });
  samaDengan(v.galat, [], "kustom tanpa sha256 valid");
  tegas(v.peringatan.some((p) => p.includes("tanpa sha256")) && v.peringatan.some((p) => p.includes("bukan lisensi permisif")), `peringatan kustom: ${JSON.stringify(v.peringatan)}`);
});

daftar("muatRegistri: bawaan rusak ditolak; kustom tidak boleh memakai id bawaan; kustom tergabung dan ditandai", () => {
  const rusak = salin(bawaan); delete rusak.model.modnet.sha256;
  writeFileSync(j("bawaan-rusak.json"), JSON.stringify(rusak));
  let e;
  try { muatRegistri({ jalurBawaan: j("bawaan-rusak.json") }); } catch (x) { e = x; }
  tegas(e instanceof GalatSegmentasi && e.kode === "registri-tidak-valid" && e.message.includes("sha256"), `bawaan rusak: ${e?.message}`);
  const timpa = { versi: 1, model: { selfie: { nama: "x", berkas: "x.onnx", lisensiKode: "MIT", lisensiBobot: "MIT", masukan: { tetap: [64, 64] } } } };
  writeFileSync(j("kustom-timpa.json"), JSON.stringify(timpa));
  try { muatRegistri({ kustom: j("kustom-timpa.json") }); e = null; } catch (x) { e = x; }
  tegas(e?.kode === "registri-tidak-valid" && e.message.includes("id bawaan"), `timpa id bawaan harus ditolak: ${e?.message}`);
  const baik = { versi: 1, model: { milikku: { nama: "x", berkas: "x.onnx", lisensiKode: "MIT", lisensiBobot: "MIT", masukan: { tetap: [64, 64] } } } };
  writeFileSync(j("kustom-baik.json"), JSON.stringify(baik));
  const r = muatRegistri({ kustom: j("kustom-baik.json") });
  tegas(r.model.milikku.kustom === true && r.model.selfie.kustom === false, "penanda kustom");
  tegas(r.peringatan.some((p) => p.includes("tanpa sha256")), "peringatan tanpa sha256");
  const lewatEnv = muatRegistri({ env: { AWVD_REGISTRI_SEGMENTASI: j("kustom-baik.json") } });
  tegas("milikku" in lewatEnv.model, "AWVD_REGISTRI_SEGMENTASI dipakai");
  writeFileSync(j("bukan.json"), "{ bukan json");
  try { muatRegistri({ kustom: j("bukan.json") }); e = null; } catch (x) { e = x; }
  tegas(e?.kode === "registri-tidak-valid", "kustom bukan JSON");
  try { muatRegistri({ kustom: j("tidak-ada.json") }); e = null; } catch (x) { e = x; }
  tegas(e?.kode === "registri-tidak-valid", "kustom tidak ada");
});

// ------------------------------------------------------------------ ORT tidak ada
daftar("pastikanOrt: env kosong, jalur tidak ada, modul bukan onnxruntime -> galat jelas", async () => {
  const a = await galat(() => pastikanOrt({}), "ort-tidak-diset", "env kosong");
  tegas(a.message.includes("AWVD_ORT") && a.keluar === 1, "pesan menyebut AWVD_ORT, keluar 1");
  tegas(a.message.includes("tidak membundel"), "pesan menjelaskan tidak dibundel");
  await galat(() => pastikanOrt({ AWVD_ORT: j("tidak-ada") }), "ort-tidak-ditemukan", "jalur tidak ada");
  writeFileSync(j("bukan-ort.cjs"), "module.exports = { halo: 1 };");
  await galat(() => pastikanOrt({ AWVD_ORT: j("bukan-ort.cjs") }), "ort-tidak-valid", "bukan onnxruntime");
  writeFileSync(j("rusak-ort.cjs"), "throw new Error('gagal muat biner');");
  const e = await galat(() => pastikanOrt({ AWVD_ORT: j("rusak-ort.cjs") }), "ort-tidak-valid", "gagal dimuat");
  tegas(e.message.includes("gagal muat biner"), "pesan memuat sebab");
});

daftar("buatSegmenter tanpa AWVD_ORT: galat, tidak ada keluaran; opsi salah ditolak lebih dulu", async () => {
  await galat(() => buatSegmenter({ model: "selfie", env: {} }), "ort-tidak-diset", "tanpa ORT");
  await galat(() => buatSegmenter({ model: "selfie", env: {}, thread: 0 }), "opsi-tidak-valid", "thread 0");
  await galat(() => buatSegmenter({ model: "selfie", env: {}, ema: 0 }), "opsi-tidak-valid", "ema 0");
  await galat(() => buatSegmenter({ model: "selfie", env: {}, ambang: [0.9, 0.1] }), "opsi-tidak-valid", "ambang terbalik");
  await galat(() => buatSegmenter({ model: "selfie", env: {}, ukuranInput: [128, 128] }), "opsi-tidak-valid", "ukuran tetap");
  await galat(() => buatSegmenter({ env: {} }), "opsi-tidak-valid", "tanpa model");
  const e = await galat(() => buatSegmenter({ model: "rvm", env: {} }), "model-tidak-dikenal", "RVM tidak ada di registri");
  tegas(e.message.includes("selfie") && e.message.includes("modnet"), "pesan menyebut model yang tersedia");
});

// ------------------------------------------------------------------ bobot
daftar("verifikasiBobot: fail-closed untuk model registri (sha256 dan ukuran salah, bobot tidak ada)", async () => {
  const spec = bawaan.model.selfie;
  mkdirSync(j("mdl"), { recursive: true });
  await galat(() => cariBobot("selfie", spec, { env: {} }), "bobot-tidak-ada", "tanpa jalur dan AWVD_MODEL_DIR");
  const e1 = await galat(() => cariBobot("selfie", spec, { env: { AWVD_MODEL_DIR: j("mdl") } }), "bobot-tidak-ada", "berkas tidak ada");
  tegas(e1.message.includes(spec.unduh.url) && e1.message.includes("tidak mengunduh"), "pesan memuat tautan unduh");
  writeFileSync(j("mdl", spec.berkas), Buffer.alloc(spec.ukuranByte)); // ukuran benar, isi salah
  const p = cariBobot("selfie", spec, { env: { AWVD_MODEL_DIR: j("mdl") } });
  const e2 = await galat(() => verifikasiBobot("selfie", spec, p), "sha256-salah", "sha256 salah");
  tegas(e2.keluar === 2 && e2.message.includes(spec.sha256) && e2.message.includes(sha(Buffer.alloc(spec.ukuranByte))), "pesan memuat kedua hash");
  writeFileSync(j("mdl", spec.berkas), Buffer.alloc(10));
  await galat(() => verifikasiBobot("selfie", spec, p), "ukuran-salah", "ukuran salah");
  await galat(() => verifikasiBobot("selfie", spec, j("mdl")), "bobot-tidak-ada", "direktori bukan berkas");
  // jalur eksplisit menang atas AWVD_MODEL_DIR
  tegas(cariBobot("selfie", spec, { jalur: p, env: { AWVD_MODEL_DIR: "/tidak/ada" } }) === p, "jalur eksplisit diutamakan");
  // cocok: berkas dengan sha256 dan ukuran yang benar diterima
  const isi = Buffer.from("isi model palsu untuk uji");
  const ok = verifikasiBobot("x", { sha256: sha(isi), ukuranByte: isi.length }, (writeFileSync(j("ok.onnx"), isi), j("ok.onnx")));
  tegas(ok.sha256 === sha(isi) && Buffer.compare(ok.data, isi) === 0, "bobot cocok diterima");
});

daftar("verifikasiBobot: model kustom tanpa sha256 hanya peringatan; sha256 yang dideklarasikan dan salah ditolak", async () => {
  const isi = Buffer.from("model kustom");
  writeFileSync(j("kustom.onnx"), isi);
  const peringatan = [];
  const r = verifikasiBobot("kus", { berkas: "kustom.onnx" }, j("kustom.onnx"), { peringatan });
  tegas(r.sha256 === sha(isi) && peringatan.length === 1 && peringatan[0].includes("TIDAK diverifikasi") && peringatan[0].includes(sha(isi)), `peringatan: ${JSON.stringify(peringatan)}`);
  await galat(() => verifikasiBobot("kus", { sha256: "0".repeat(64) }, j("kustom.onnx")), "sha256-salah", "sha256 kustom yang salah");
});

// ------------------------------------------------------------------ ORT palsu
const ortPalsu = j("ort-palsu");
mkdirSync(ortPalsu, { recursive: true });
writeFileSync(join(ortPalsu, "package.json"), JSON.stringify({ name: "onnxruntime-palsu", main: "index.js" }));
writeFileSync(join(ortPalsu, "index.js"), `
const ada = () => (globalThis.__ortPalsu ??= { create: [], run: 0, release: 0, mode: {} });
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
exports.Tensor = Tensor;
exports.env = { versions: { node: "0.0.0-palsu" } };
exports.InferenceSession = { async create(bytes, opsi) {
  const catatan = ada(), m = catatan.mode;
  catatan.create.push({ panjang: bytes.length, opsi, sha: require("node:crypto").createHash("sha256").update(bytes).digest("hex"), adalahBuffer: Buffer.isBuffer(bytes) });
  if (m.gagalMuat) throw new Error("grafik tidak valid\\nbaris kedua");
  const masuk = m.masuk ?? ["pixel_values"], keluar = m.keluar ?? ["alphas"];
  return { inputNames: masuk, outputNames: keluar,
    async run(feeds) {
      catatan.run++;
      if (m.gagalJalan) throw new Error("kernel gagal");
      const t = feeds[masuk[0]]; const h = t.dims[2], w = t.dims[3];
      if (m.dimsSalah) return { [keluar[0]]: new Tensor("float32", new Float32Array(3), [1, 3, 1, 1]) };
      if (m.nan) return { [keluar[0]]: new Tensor("float32", new Float32Array(h * w).fill(NaN), [1, 1, h, w]) };
      const d = new Float32Array(h * w); for (let i = 0; i < d.length; i++) d[i] = t.data[i]; // kanal R
      catatan.terakhirDims = t.dims;
      return { [keluar[0]]: new Tensor("float32", d, [1, 1, h, w]) };
    },
    async release() { catatan.release++; } }; } };
`);
const palsu = () => globalThis.__ortPalsu;
const isiPalsu = Buffer.from("bukan model sungguhan, hanya byte uji");
writeFileSync(j("palsu.onnx"), isiPalsu);
function tulisRegistriPalsu(ubah = () => {}) {
  const r = { versi: 1, model: { palsu: { nama: "Model palsu", berkas: "palsu.onnx", sha256: sha(isiPalsu), ukuranByte: isiPalsu.length, lisensiKode: "MIT", lisensiBobot: "MIT",
    masukan: { nama: "pixel_values", dinamis: { kelipatan: 1, min: 16, maks: 4096, sisiPanjangBawaan: 64 }, bagi: 255, kurang: 0 }, keluaran: { nama: "alphas" } } } };
  ubah(r);
  writeFileSync(j("registri-palsu.json"), JSON.stringify(r));
  return j("registri-palsu.json");
}
const envPalsu = () => ({ AWVD_ORT: ortPalsu, AWVD_MODEL_DIR: tmp });
function reset(mode = {}) { globalThis.__ortPalsu = { create: [], run: 0, release: 0, mode }; }

daftar("ORT palsu: bobot registri yang ditolak TIDAK PERNAH sampai ke ORT", async () => {
  reset();
  const dir = j("mdl-ditolak");
  mkdirSync(dir, { recursive: true });
  const env = { AWVD_ORT: ortPalsu, AWVD_MODEL_DIR: dir };
  await galat(() => buatSegmenter({ model: "selfie", env }), "bobot-tidak-ada", "bobot tidak ada");
  writeFileSync(join(dir, "selfie-segmentation.onnx"), Buffer.alloc(bawaan.model.selfie.ukuranByte));
  await galat(() => buatSegmenter({ model: "selfie", env }), "sha256-salah", "sha256 salah");
  writeFileSync(join(dir, "selfie-segmentation.onnx"), Buffer.alloc(5));
  await galat(() => buatSegmenter({ model: "selfie", env }), "ukuran-salah", "ukuran salah");
  writeFileSync(join(dir, "modnet.onnx"), Buffer.alloc(bawaan.model.modnet.ukuranByte));
  await galat(() => buatSegmenter({ model: "modnet", env }), "sha256-salah", "sha256 modnet salah");
  samaDengan(palsu().create.length, 0, "panggilan InferenceSession.create");
});

daftar("ORT palsu: model kustom: sha256 cocok dimuat dari byte terverifikasi; sha256 salah ditolak; tanpa sha256 diperingatkan", async () => {
  reset();
  const reg = tulisRegistriPalsu();
  const peringatan = [];
  const s = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg, thread: 4, peringatan });
  samaDengan(palsu().create.length, 1, "create dipanggil sekali");
  const c = palsu().create[0];
  tegas(c.adalahBuffer && c.sha === sha(isiPalsu), "ORT menerima byte yang sama dengan yang di-hash");
  samaDengan(c.opsi, { executionProviders: ["cpu"], interOpNumThreads: 1, intraOpNumThreads: 4 }, "opsi sesi");
  tegas(s.info.kustom === true && s.info.versiOrt === "0.0.0-palsu" && s.info.lokal === true && s.info.sha256 === sha(isiPalsu) && s.info.thread === 4, `info: ${JSON.stringify(s.info)}`);
  await s.tutup();
  samaDengan(palsu().release, 1, "release");
  // sha256 salah di registri kustom
  reset();
  const reg2 = tulisRegistriPalsu((r) => { r.model.palsu.sha256 = "1".repeat(64); });
  await galat(() => buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg2 }), "sha256-salah", "kustom sha256 salah");
  samaDengan(palsu().create.length, 0, "tidak sampai ke ORT");
  // tanpa sha256: jalan dengan peringatan
  const reg3 = tulisRegistriPalsu((r) => { delete r.model.palsu.sha256; delete r.model.palsu.ukuranByte; });
  const p3 = [];
  const s3 = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg3, peringatan: p3 });
  tegas(p3.filter((x) => x.includes("sha256")).length >= 1 && palsu().create.length === 1, `peringatan sha256: ${JSON.stringify(p3)}`);
  await s3.tutup();
});

daftar("ORT palsu: model tidak cocok dengan registri, ORT gagal memuat atau menjalankan, keluaran tidak valid", async () => {
  const reg = tulisRegistriPalsu();
  reset({ masuk: ["lain"] });
  await galat(() => buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg }), "model-tidak-cocok", "nama masukan beda");
  samaDengan(palsu().release, 1, "sesi dilepas setelah ketidakcocokan");
  reset({ gagalMuat: true });
  const e = await galat(() => buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg }), "ort-gagal", "gagal memuat");
  tegas(e.message.includes("grafik tidak valid") && !e.message.includes("baris kedua"), "hanya baris pertama galat ORT");
  const rgb = bingkaiSintetis(32, 24);
  reset({ gagalJalan: true });
  let s = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg });
  await galat(() => s.segmentasi(rgb, 32, 24), "ort-gagal", "gagal jalan");
  reset({ dimsSalah: true });
  s = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg });
  await galat(() => s.segmentasi(rgb, 32, 24), "keluaran-tidak-valid", "dims salah");
  reset({ nan: true });
  s = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg });
  await galat(() => s.segmentasi(rgb, 32, 24), "keluaran-tidak-valid", "semua NaN");
});

daftar("ORT palsu: segmentasi mengikuti kanal R, ambang dan EMA berurutan, ukuran bingkai berubah ditolak, hasil identik antar-segmenter", async () => {
  const reg = tulisRegistriPalsu();
  const l = 40, t = 30;
  const rgb = new Uint8Array(l * t * 3);
  for (let i = 0; i < l * t; i++) { rgb[i * 3] = 200; rgb[i * 3 + 1] = 10; rgb[i * 3 + 2] = 99; }
  reset();
  const s = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg, ukuranInput: [l, t] });
  const m = await s.segmentasi(rgb, l, t);
  tegas(m.length === l * t && m.every((v) => v === 200), "mask = kanal R konstan 200 pada ukuran sama");
  samaDengan(Array.from(palsu().terakhirDims), [1, 3, t, l], "dims tensor NCHW");
  // ukuran masukan model berbeda dari bingkai: mask diubah ukurannya kembali ke bingkai
  const s2 = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg, ukuranInput: [20, 16] });
  const m2 = await s2.segmentasi(rgb, l, t);
  tegas(m2.length === l * t && m2.every((v) => v === 200), "mask konstan tetap 200 setelah ubah ukuran bolak-balik");
  samaDengan(Array.from(palsu().terakhirDims), [1, 3, 16, 20], "dims tensor 20x16");
  // ambang dan EMA
  const gelap = Uint8Array.from(rgb), terang = Uint8Array.from(rgb);
  for (let i = 0; i < l * t; i++) { gelap[i * 3] = 0; terang[i * 3] = 255; }
  const urut = async (opsi) => {
    const sg = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg, ukuranInput: [l, t], ...opsi });
    const hasil = [];
    for (const b of [gelap, terang, terang, terang]) hasil.push((await sg.segmentasi(b, l, t))[0]);
    return hasil;
  };
  samaDengan(await urut({}), [0, 255, 255, 255], "tanpa EMA");
  samaDengan(await urut({ ema: 0.5 }), [0, 128, 191, 223], "EMA 0,5");
  const dgAmbang = await urut({ ambang: [0.2, 0.8] });
  samaDengan(dgAmbang, [0, 255, 255, 255], "ambang pada nilai ekstrem tetap");
  const a = await urut({ ema: 0.5 }), b = await urut({ ema: 0.5 });
  samaDengan(a, b, "EMA identik antar-segmenter");
  // ulang EMA dan ukuran bingkai
  const sg = await buatSegmenter({ model: "palsu", env: envPalsu(), registriKustom: reg, ukuranInput: [l, t], ema: 0.5 });
  await sg.segmentasi(gelap, l, t);
  sg.ulangEma();
  samaDengan((await sg.segmentasi(terang, l, t))[0], 255, "setelah ulangEma bingkai pertama tanpa pelicinan");
  await galat(() => sg.segmentasi(new Uint8Array(20 * 10 * 3), 20, 10), "opsi-tidak-valid", "ukuran bingkai berubah");
  await galat(() => sg.segmentasi(new Uint8Array(5), l, t), "opsi-tidak-valid", "panjang data salah");
});

daftar("CLI: tanpa AWVD_ORT keluar 1 tanpa keluaran standar; sha256 salah keluar 2; daftar keluar 0", async () => {
  let r = await bun(cli, ["periksa", "--model", "selfie"], envBersih);
  tegas(r.kode === 1 && r.out === "" && r.err.includes("AWVD_ORT"), `tanpa ORT: kode ${r.kode} out=${JSON.stringify(r.out)} err=${r.err}`);
  r = await bun(cli, ["periksa"], envBersih);
  tegas(r.kode === 1 && r.out === "", "periksa tanpa --model dan tanpa ORT");
  const dir = j("mdl-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "selfie-segmentation.onnx"), Buffer.alloc(bawaan.model.selfie.ukuranByte));
  r = await bun(cli, ["periksa", "--model", "selfie"], { ...envBersih, AWVD_ORT: ortPalsu, AWVD_MODEL_DIR: dir });
  tegas(r.kode === 2 && r.out === "" && r.err.includes("sha256"), `sha salah: kode ${r.kode} out=${JSON.stringify(r.out)} err=${r.err}`);
  r = await bun(cli, ["periksa", "--model", "selfie"], { ...envBersih, AWVD_ORT: ortPalsu, AWVD_MODEL_DIR: j("kosong") });
  tegas(r.kode === 1 && r.out === "" && r.err.includes("tidak ditemukan"), `bobot tidak ada: kode ${r.kode} err=${r.err}`);
  r = await bun(cli, ["periksa", "--model", "rvm"], { ...envBersih, AWVD_ORT: ortPalsu });
  tegas(r.kode === 2 && r.out === "", "model tidak dikenal keluar 2");
  r = await bun(cli, ["periksa", "--model", "palsu", "--registri", tulisRegistriPalsu()], { ...envBersih, AWVD_ORT: ortPalsu, AWVD_MODEL_DIR: tmp });
  tegas(r.kode === 0 && r.out.includes("siap: model palsu") && r.out.includes("KUSTOM"), `periksa palsu: kode ${r.kode} out=${r.out} err=${r.err}`);
  r = await bun(cli, ["periksa"], { ...envBersih, AWVD_ORT: ortPalsu });
  tegas(r.kode === 0 && r.out.includes("onnxruntime siap"), "periksa ORT palsu");
  r = await bun(cli, ["daftar"], envBersih);
  tegas(r.kode === 0 && r.out.includes("selfie") && r.out.includes("modnet") && !r.out.includes("rvm"), `daftar: ${r.out}`);
  r = await bun(cli, ["daftar", "--json"], envBersih);
  samaDengan(Object.keys(JSON.parse(r.out)).sort(), ["modnet", "selfie"], "daftar --json");
  r = await bun(cli, ["tidak-ada"], envBersih);
  tegas(r.kode === 2 && r.out === "", "perintah tidak dikenal keluar 2");
  r = await bun(cli, ["periksa", "--tidak-ada"], envBersih);
  tegas(r.kode === 2 && r.out === "", "opsi tidak dikenal keluar 2");
  r = await bun(cli, ["--bantuan"], envBersih);
  tegas(r.kode === 0 && r.out.includes("AWVD_ORT"), "bantuan");
});

// ------------------------------------------------------------------ pra/pasca-proses
daftar("ubahUkuran: identitas, konstan tetap konstan, nilai acuan naik dan turun skala, deterministik", () => {
  const a = Uint8Array.from([0, 255]);
  samaDengan(Array.from(ubahUkuran(a, 2, 1, 1, 2, 1)), [0, 255], "identitas");
  samaDengan(Array.from(ubahUkuran(a, 2, 1, 1, 4, 1)), [0, 64, 191, 255], "2 -> 4 (titik tengah piksel)");
  samaDengan(Array.from(ubahUkuran(Uint8Array.from([0, 0, 255, 255]), 4, 1, 1, 2, 1)), [0, 255], "4 -> 2");
  for (const v of [0, 1, 127, 254, 255]) {
    for (const [sl, st, dl, dt] of [[7, 5, 31, 19], [64, 48, 5, 3], [13, 13, 13, 40], [1, 1, 9, 9], [9, 9, 1, 1]]) {
      const o = ubahUkuran(new Uint8Array(sl * st * 3).fill(v), sl, st, 3, dl, dt);
      tegas(o.length === dl * dt * 3 && o.every((x) => x === v), `konstan ${v} ${sl}x${st}->${dl}x${dt}`);
    }
  }
  const r = bingkaiSintetis(63, 41, 7);
  samaDengan(sha(ubahUkuran(r, 63, 41, 3, 29, 17)), sha(ubahUkuran(r, 63, 41, 3, 29, 17)), "dua kali sama");
  tegas(ubahUkuran(r, 63, 41, 3, 63, 41) !== r, "identitas menyalin (bukan alias)");
  // pembatas rentang: tidak pernah di luar 0..255 untuk masukan acak
  const o = ubahUkuran(bingkaiSintetis(50, 50, 3), 50, 50, 3, 200, 120);
  tegas(o.length === 200 * 120 * 3, "ukuran keluaran");
  try { ubahUkuran(new Uint8Array(3), 2, 2, 1, 4, 4); throw new Error("harus melempar"); } catch (e) { tegas(e instanceof GalatSegmentasi, "panjang data salah ditolak"); }
});

daftar("ukuranMasukan: tetap, dinamis (kelipatan, sisi panjang bawaan), opsi tidak valid", () => {
  const selfie = bawaan.model.selfie, modnet = bawaan.model.modnet;
  samaDengan(ukuranMasukan(selfie, 1280, 720), [256, 256], "selfie tetap");
  samaDengan(ukuranMasukan(selfie, 100, 50, [256, 256]), [256, 256], "selfie tetap eksplisit");
  const salah = (fn, nama) => { try { fn(); throw new Error(`${nama}: harus melempar`); } catch (e) { tegas(e instanceof GalatSegmentasi && e.kode === "opsi-tidak-valid", `${nama}: ${e.message}`); } };
  salah(() => ukuranMasukan(selfie, 1280, 720, [128, 128]), "selfie ukuran lain");
  salah(() => ukuranMasukan(selfie, 1280, 720, 256), "selfie angka");
  samaDengan(ukuranMasukan(modnet, 1280, 720), [512, 288], "modnet 1280x720");
  samaDengan(ukuranMasukan(modnet, 720, 1280), [288, 512], "modnet potret");
  samaDengan(ukuranMasukan(modnet, 1920, 1080), [512, 288], "modnet 1080p");
  samaDengan(ukuranMasukan(modnet, 100, 100), [512, 512], "modnet persegi");
  samaDengan(ukuranMasukan(modnet, 1000, 10), [512, 64], "modnet sangat lebar (dijepit ke min)");
  samaDengan(ukuranMasukan(modnet, 1280, 720, 640), [640, 352], "modnet sisi panjang 640");
  samaDengan(ukuranMasukan(modnet, 1280, 720, [896, 512]), [896, 512], "modnet eksplisit");
  salah(() => ukuranMasukan(modnet, 1280, 720, [500, 288]), "bukan kelipatan 32");
  salah(() => ukuranMasukan(modnet, 1280, 720, [32, 32]), "di bawah min");
  salah(() => ukuranMasukan(modnet, 1280, 720, 4096), "di atas maks");
});

daftar("praProses: normalisasi selfie (/255) dan MODNet (/127,5 - 1), tata letak planar NCHW", () => {
  const selfie = bawaan.model.selfie, modnet = bawaan.model.modnet;
  const l = 4, t = 2, rgb = new Uint8Array(l * t * 3);
  for (let i = 0; i < l * t; i++) { rgb[i * 3] = 255; rgb[i * 3 + 1] = 0; rgb[i * 3 + 2] = 128; }
  const s = praProses(rgb, l, t, selfie, [l, t]);
  samaDengan(s.dims, [1, 3, t, l], "dims");
  tegas(s.tensor.length === 3 * l * t && s.tensor instanceof Float32Array, "float32 planar");
  tegas(s.tensor.slice(0, 8).every((v) => v === 1) && s.tensor.slice(8, 16).every((v) => v === 0), "kanal R=1 dan G=0");
  tegas(s.tensor.slice(16, 24).every((v) => v === Math.fround(128 / 255)), "kanal B = 128/255");
  const m = praProses(rgb, l, t, modnet, [l, t]);
  tegas(m.tensor.slice(0, 8).every((v) => v === 1) && m.tensor.slice(8, 16).every((v) => v === -1), "MODNet R=1 dan G=-1");
  tegas(m.tensor.slice(16, 24).every((v) => v === Math.fround(128 / 127.5 - 1)), "MODNet B");
  // ubah ukuran ke ukuran model
  const besar = praProses(bingkaiSintetis(64, 36), 64, 36, selfie, [256, 256]);
  samaDengan(besar.dims, [1, 3, 256, 256], "dims 256");
  for (const bukan of [[new Uint8Array(5), 4, 2], [rgb, 0, 2], [rgb, 4.5, 2], [rgb, 9000, 1]]) {
    try { praProses(bukan[0], bukan[1], bukan[2], selfie, [4, 2]); throw new Error("harus melempar"); } catch (e) { tegas(e instanceof GalatSegmentasi, `bingkai salah ditolak: ${e.message}`); }
  }
});

daftar("pascaProses: kuantisasi 8 bit, penjepitan, NaN menjadi 0, semua NaN ditolak, bentuk salah ditolak", () => {
  const d = Float32Array.from([0, 0.5, 1, 2, -1, NaN]);
  samaDengan(Array.from(pascaProses(d, [1, 1, 2, 3], 3, 2)), [0, 128, 255, 255, 0, 0], "kuantisasi");
  samaDengan(Array.from(pascaProses(Float32Array.from([0.2, 1]), [1, 2], 2, 1)), [51, 255], "dims 2D");
  const naik = pascaProses(Float32Array.from([0, 1]), [1, 1, 1, 2], 4, 1);
  samaDengan(Array.from(naik), [0, 64, 191, 255], "naik skala setelah kuantisasi");
  const salah = (data, dims) => { try { pascaProses(data, dims, 2, 2); throw new Error("harus melempar"); } catch (e) { tegas(e instanceof GalatSegmentasi && e.kode === "keluaran-tidak-valid", e.message); } };
  salah(new Float32Array(4).fill(NaN), [1, 1, 2, 2]);
  salah(new Float32Array(4).fill(Infinity), [1, 1, 2, 2]);
  salah(new Float32Array(3), [1, 3, 1, 1]);
  salah(new Float32Array(4), [1, 2, 2, 1]);
  salah(new Float32Array(5), [1, 1, 2, 2]);
  salah(new Float32Array(4), [4]);
});

daftar("buatLut: identitas, smoothstep di antara ambang, monoton, ambang tidak valid ditolak", () => {
  const id = buatLut();
  tegas(Array.from(id).every((v, i) => v === i), "identitas");
  const l = buatLut([0.2, 0.8]);
  tegas(l[0] === 0 && l[51] === 0 && l[255] === 255 && l[204] === 255, "ujung");
  tegas(Math.abs(l[128] - 128) <= 2, `tengah mendekati 128: ${l[128]}`);
  for (let i = 1; i < 256; i++) tegas(l[i] >= l[i - 1], `monoton di ${i}`);
  tegas(l[77] > 0 && l[77] < 40, `landai di bawah: ${l[77]}`);
  for (const bukan of [[0.8, 0.2], [0.5, 0.5], [-0.1, 0.5], [0, 1.1], [0.1], "a"]) {
    try { buatLut(bukan); throw new Error("harus melempar"); } catch (e) { tegas(e instanceof GalatSegmentasi, `ambang ${JSON.stringify(bukan)} ditolak`); }
  }
});

daftar("buatEma: lintasan acuan, konvergen tepat, ulang, ukuran berubah ditolak, deterministik", () => {
  const e1 = buatEma(1);
  samaDengan([0, 255, 7].map((v) => e1.langkah(new Uint8Array(1).fill(v))[0]), [0, 255, 7], "ema 1 = tanpa pelicinan");
  const e = buatEma(0.5);
  samaDengan([0, 255, 255, 255].map((v) => e.langkah(new Uint8Array(1).fill(v))[0]), [0, 128, 191, 223], "lintasan ema 0,5");
  for (let i = 0; i < 40; i++) e.langkah(new Uint8Array(1).fill(255));
  samaDengan(e.langkah(new Uint8Array(1).fill(255))[0], 255, "konvergen ke 255");
  for (let i = 0; i < 40; i++) e.langkah(new Uint8Array(1).fill(0));
  samaDengan(e.langkah(new Uint8Array(1).fill(0))[0], 0, "konvergen ke 0");
  for (const a of [0.05, 0.3, 0.9]) {
    const x = buatEma(a);
    x.langkah(new Uint8Array(1).fill(0));
    let v = 0;
    for (let i = 0; i < 400; i++) v = x.langkah(new Uint8Array(1).fill(255))[0];
    tegas(v >= 254, `ema ${a} mendekati 255 (${v})`);
  }
  e.ulang();
  samaDengan(e.langkah(new Uint8Array(1).fill(200))[0], 200, "setelah ulang bingkai pertama apa adanya");
  try { e.langkah(new Uint8Array(2)); throw new Error("harus melempar"); } catch (x) { tegas(x instanceof GalatSegmentasi, "ukuran berubah ditolak"); }
  const r = acak(5), urutan = Array.from({ length: 20 }, () => Uint8Array.from({ length: 64 }, () => Math.floor(r() * 256)));
  const jalan = () => { const k = buatEma(0.37); return sha(Buffer.concat(urutan.map((b) => k.langkah(b)))); };
  samaDengan(jalan(), jalan(), "dua jalan sama");
  for (const buruk of [0, -1, 1.01, NaN, "0.5"]) { try { buatEma(buruk); throw new Error("harus melempar"); } catch (x) { tegas(x instanceof GalatSegmentasi, `ema ${buruk} ditolak`); } }
});

// ------------------------------------------------------------------ onnxruntime sungguhan
const ORT_ASLI = process.env.AWVD_ORT;
let dilewati = 0;
const lewati = (nama, alasan) => { dilewati++; console.log(`LEWATI ${nama}: ${alasan}`); };

// ONNX mini buatan sendiri: y = ReduceMean(x, axes=[1], keepdims=1), x float [b,3,h,w] -> y [b,1,h,w].
const varint = (n) => { const b = []; while (n > 127) { b.push((n & 127) | 128); n = Math.floor(n / 128); } b.push(n); return b; };
const tag = (f, w) => varint(f * 8 + w);
const ln = (f, bytes) => [...tag(f, 2), ...varint(bytes.length), ...bytes];
const teks = (f, s) => ln(f, [...Buffer.from(s)]);
const vi = (f, n) => [...tag(f, 0), ...varint(n)];
const dim = (d) => ln(1, typeof d === "number" ? vi(1, d) : teks(2, d));
const nilaiInfo = (nama, dims) => [...teks(1, nama), ...ln(2, ln(1, [...vi(1, 1), ...ln(2, dims.flatMap(dim))]))];
function bangunOnnxMini() {
  const atrAxes = [...teks(1, "axes"), ...vi(8, 1), ...vi(20, 7)];
  const atrKeep = [...teks(1, "keepdims"), ...vi(3, 1), ...vi(20, 2)];
  const node = [...teks(1, "x"), ...teks(2, "y"), ...teks(3, "rata"), ...teks(4, "ReduceMean"), ...ln(5, atrAxes), ...ln(5, atrKeep)];
  const graf = [...ln(1, node), ...teks(2, "mini"), ...ln(11, nilaiInfo("x", ["b", 3, "h", "w"])), ...ln(12, nilaiInfo("y", ["b", 1, "h", "w"]))];
  return Buffer.from([...vi(1, 7), ...teks(2, "awvd-uji"), ...ln(7, graf), ...ln(8, [...teks(1, ""), ...vi(2, 13)])]);
}

daftar("ORT sungguhan: model ONNX mini: nilai mask sesuai acuan, identik antar-run dan antar-thread (1 dan 4), EMA identik", async () => {
  if (!ORT_ASLI) { lewati("ORT sungguhan (model mini)", "AWVD_ORT tidak diset"); return; }
  const onnx = bangunOnnxMini();
  writeFileSync(j("mini.onnx"), onnx);
  const reg = j("registri-mini.json");
  writeFileSync(reg, JSON.stringify({ versi: 1, model: { mini: { nama: "ONNX mini uji (ReduceMean)", berkas: "mini.onnx", sha256: sha(onnx), ukuranByte: onnx.length, lisensiKode: "MIT", lisensiBobot: "MIT",
    masukan: { nama: "x", dinamis: { kelipatan: 1, min: 16, maks: 4096, sisiPanjangBawaan: 96 }, bagi: 255, kurang: 0 }, keluaran: { nama: "y" } } } }));
  const env = { AWVD_ORT: ORT_ASLI, AWVD_MODEL_DIR: tmp };
  const l = 96, t = 64;
  const frames = [bingkaiSintetis(l, t, 1), bingkaiSintetis(l, t, 2), bingkaiSintetis(l, t, 3), bingkaiSintetis(l, t, 4)];
  const jalan = async (thread, ema) => {
    const peringatan = [];
    const s = await buatSegmenter({ model: "mini", env, registriKustom: reg, thread, ukuranInput: [l, t], ema, peringatan });
    tegas(peringatan.length === 0, `tanpa peringatan untuk model ber-sha256: ${JSON.stringify(peringatan)}`);
    const keluar = [];
    for (const f of frames) keluar.push(await s.segmentasi(f, l, t));
    const mentah = await s.mentah(frames[0], l, t);
    const info = s.info;
    await s.tutup();
    return { keluar, mentah, info };
  };
  // nilai: tanpa ukuran-ulang, mask mentah = bulatkan(rata-rata kanal), dengan toleransi 1 (float32)
  const a = await jalan(1, 1);
  const f = frames[0];
  let maksSelisih = 0;
  for (let i = 0; i < l * t; i++) {
    const acuan = (f[i * 3] + f[i * 3 + 1] + f[i * 3 + 2]) / 3;
    maksSelisih = Math.max(maksSelisih, Math.abs(a.mentah[i] - acuan));
  }
  tegas(maksSelisih <= 1, `mask mentah menyimpang dari rata-rata kanal: selisih maks ${maksSelisih}`);
  tegas(a.info.versiOrt && a.info.versiOrt !== "tidak-diketahui", `versi ORT tercatat: ${a.info.versiOrt}`);
  // determinisme: antar-run (sesi baru) dan antar-jumlah thread, tanpa dan dengan EMA
  for (const ema of [1, 0.4]) {
    const r1 = await jalan(1, ema), r1b = await jalan(1, ema), r4 = await jalan(4, ema);
    for (let i = 0; i < frames.length; i++) {
      tegas(Buffer.compare(r1.keluar[i], r1b.keluar[i]) === 0, `antar-run berbeda (ema ${ema}, bingkai ${i})`);
      tegas(Buffer.compare(r1.keluar[i], r4.keluar[i]) === 0, `thread 1 vs 4 berbeda (ema ${ema}, bingkai ${i})`);
    }
    console.log(`  mini ema ${ema}: sha256 mask ${sha(Buffer.concat(r1.keluar)).slice(0, 16)} identik pada 2 run dan thread 1 dan 4 (${frames.length} bingkai ${l}x${t})`);
  }
});

daftar("ORT sungguhan: model registri (selfie, modnet) bila bobotnya ada di AWVD_MODEL_DIR: sha256 diverifikasi, mask masuk akal, identik antar-run dan antar-thread", async () => {
  if (!ORT_ASLI) { lewati("model registri sungguhan", "AWVD_ORT tidak diset"); return; }
  const dir = process.env.AWVD_MODEL_DIR;
  const l = 320, t = 180;
  const f1 = bingkaiSintetis(l, t, 11), f2 = bingkaiSintetis(l, t, 12);
  let dijalankan = 0;
  for (const id of ["selfie", "modnet"]) {
    const spec = bawaan.model[id];
    if (!dir || !existsSync(join(dir, spec.berkas))) { lewati(`model ${id}`, `${spec.berkas} tidak ada di AWVD_MODEL_DIR`); continue; }
    const env = { AWVD_ORT: ORT_ASLI, AWVD_MODEL_DIR: dir };
    const jalan = async (thread) => {
      const s = await buatSegmenter({ model: id, env, thread, ema: 0.6, ambang: [0.1, 0.9] });
      tegas(s.info.sha256 === spec.sha256 && s.info.kustom === false, `${id}: info sha256`);
      const a = await s.segmentasi(f1, l, t), b = await s.segmentasi(f2, l, t);
      await s.tutup();
      return [a, b];
    };
    const r1 = await jalan(1), r1b = await jalan(1), r4 = await jalan(4);
    for (let i = 0; i < 2; i++) {
      tegas(r1[i].length === l * t, `${id}: ukuran mask`);
      tegas(Buffer.compare(r1[i], r1b[i]) === 0, `${id}: antar-run berbeda`);
      tegas(Buffer.compare(r1[i], r4[i]) === 0, `${id}: thread 1 vs 4 berbeda`);
    }
    // masuk akal pada bingkai sintetis (bukan klaim kualitas pada orang nyata): mask tidak seragam
    const nilai = new Set(r1[0]);
    tegas(nilai.size > 1, `${id}: mask seragam (${[...nilai]})`);
    console.log(`  ${id}: sha256 bobot terverifikasi; mask ${l}x${t}, ${nilai.size} nilai berbeda; identik pada 2 run dan thread 1 dan 4`);
    dijalankan++;
  }
  if (dijalankan === 0) lewati("model registri sungguhan", "tidak ada bobot yang tersedia");
});

// ------------------------------------------------------------------ jalankan
let gagal = 0;
for (const [nama, fn] of uji) {
  try { await fn(); console.log(`ok   ${nama}`); } catch (e) {
    gagal++;
    console.log(`GAGAL ${nama}\n     ${String(e?.stack ?? e).split("\n").slice(0, 6).join("\n     ")}`);
  }
}
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${uji.length - gagal}/${uji.length} uji lolos${dilewati ? `, ${dilewati} bagian dilewati` : ""}`);
if (!ORT_ASLI) console.log("catatan: uji onnxruntime sungguhan dilewati (AWVD_ORT tidak diset); bagian lain tetap dijalankan");
process.exit(gagal ? 1 : 0);
