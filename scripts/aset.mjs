#!/usr/bin/env bun
/**
 * awvd / aset.mjs — penambahan aset (gambar, logo, ikon, SVG, font, audio) dengan manifest
 * `aset.json` (skema 1): pencatatan sumber dan lisensi, validasi fail-closed, pembersihan SVG,
 * konversi sRGB, dan keluaran untuk komposisi.
 *
 *   bun scripts/aset.mjs tambah <jenis> <berkas> [--id ID] [--manifest aset.json] [--konversi] [--tanggal YYYY-MM-DD]
 *   bun scripts/aset.mjs impor <daftar.json|folder> [--manifest aset.json] [--konversi]
 *   bun scripts/aset.mjs periksa [aset.json] [--skala N] [--ketat] [--json] [--out DIR]
 *        [--komposisi F]... [--gabung props.json]
 *
 * Alur: manusia mengunduh aset (awvd tidak mengunduh dari URL: anti-hotlink) -> `tambah`/`impor`
 * (salin ke aset/, hitung sha256, bersihkan SVG, konversi sRGB bila diminta, tulis kerangka entri
 * dengan "[isi]" yang gagal validasi sampai diisi) -> manusia melengkapi sumber, lisensi, bukti ->
 * `periksa` (gerbang; semua pelanggaran dikumpulkan; kode keluar 2 sebelum Chromium) -> render
 * (jaringan diblokir) -> terbit bersama atribusi.txt.
 *
 * Kode keluar: 0 berhasil; 1 galat saat menjalankan (browser, ffprobe, berkas); 2 argumen,
 * manifest, atau aset tidak valid (juga peringatan bila --ketat).
 * Ini bukan nasihat hukum. Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  bacaGambar, bangunAtribusi, bangunFontFace, bangunProps, bersihkanSvg,
  JENIS_ASET, perluKonversiSrgb, pindaiJaringan, sha256Berkas, validasiAset, VERSI_SKEMA_ASET,
} from "./aset-lib.js";
import { cariBrowser } from "./browser.js";

const PETUNJUK = `Pemakaian:
  bun scripts/aset.mjs tambah <jenis> <berkas> [--id ID] [--manifest aset.json] [--konversi] [--tanggal YYYY-MM-DD]
  bun scripts/aset.mjs impor <daftar.json|folder> [--manifest aset.json] [--konversi]
  bun scripts/aset.mjs periksa [aset.json] [--skala N] [--ketat] [--json] [--out DIR] [--komposisi F]... [--gabung props.json]
Jenis: ${JENIS_ASET.join(", ")}.
periksa menulis aset-props.json, atribusi.txt, dan font-face.css ke --out (bawaan .cache/awvd/aset).
Kode keluar 2 untuk argumen, manifest, atau aset tidak valid.`;

class GalatCli extends Error {
  constructor(pesan, kode = 2) {
    super(pesan);
    this.kode = kode;
  }
}

const adaObjek = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const BATAS_BERKAS_BYTE = 50_000_000;
const EKSTENSI_JENIS = {
  gambar: [".png", ".jpg", ".jpeg", ".webp"],
  logo: [".svg", ".png", ".jpg", ".jpeg", ".webp"],
  ikon: [".svg"], svg: [".svg"],
  font: [".woff2", ".woff", ".ttf", ".otf"],
  audio: [".wav", ".flac", ".mp3", ".ogg", ".m4a", ".opus"],
};
const JENIS_DARI_EKSTENSI = {
  ".svg": "svg", ".png": "gambar", ".jpg": "gambar", ".jpeg": "gambar", ".webp": "gambar",
  ".woff2": "font", ".woff": "font", ".ttf": "font", ".otf": "font",
  ".wav": "audio", ".flac": "audio", ".mp3": "audio", ".ogg": "audio", ".m4a": "audio", ".opus": "audio",
};

// ------------------------------------------------------------ konversi sRGB (Chromium)
/**
 * Mengonversi gambar ke PNG sRGB 8-bit tanpa profil dengan orientasi EXIF dipanggang, memakai
 * Chromium yang sama dengan renderer (ffmpeg 6 tidak membaca ICC; manajemen warna Chromium =
 * yang dilihat render). Tanpa dependensi baru. Catatan: alpha melewati kanvas pra-kali, piksel
 * semi-transparan bisa berselisih 1 pada satu kanal; build Chromium lain dapat menggeser +-1.
 * @returns {Promise<Buffer>}
 */
export async function konversiSrgb(isi, mime, { browser } = {}) {
  const { chromium } = await import("playwright-core");
  const exe = cariBrowser(browser);
  const b = await chromium.launch({ executablePath: exe, headless: true, args: ["--force-color-profile=srgb"] });
  try {
    const context = await b.newContext();
    await context.route(/^(?!(?:file|data|about|blob):)/i, (r) => r.abort("blockedbyclient"));
    const page = await context.newPage();
    const png = await page.evaluate(async ([b64, tipe]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: tipe }), {
        colorSpaceConversion: "default", imageOrientation: "from-image", premultiplyAlpha: "none",
      });
      const kanvas = new OffscreenCanvas(bmp.width, bmp.height);
      kanvas.getContext("2d", { colorSpace: "srgb" }).drawImage(bmp, 0, 0);
      const ab = new Uint8Array(await (await kanvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let s = "";
      for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode(...ab.subarray(i, i + 0x8000));
      return btoa(s);
    }, [isi.toString("base64"), mime]);
    return Buffer.from(png, "base64");
  } finally {
    await b.close().catch(() => {});
  }
}

// ------------------------------------------------------------ memasukkan berkas
const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 48);

/**
 * Menyalin satu berkas sumber ke <dirManifest>/aset/<id>.<ekstensi>: SVG dibersihkan (ditolak bila
 * rusak), gambar diperiksa (animasi, CMYK, format) dan dikonversi ke sRGB bila `konversi`, font dan
 * audio disalin apa adanya. Menolak menimpa berkas yang ada.
 * @returns {Promise<{ berkas: string, sha256: string, catatan: string[], peringatan: string[] }>}
 */
export async function masukkanBerkas({ jenis, sumber, dirManifest, id, konversi = false, browser }) {
  if (!JENIS_ASET.includes(jenis)) throw new GalatCli(`jenis tidak dikenal: "${jenis}" (pilih ${JENIS_ASET.join(", ")})`);
  if (!existsSync(sumber) || !statSync(sumber).isFile()) throw new GalatCli(`berkas sumber tidak ditemukan: ${sumber}`);
  if (statSync(sumber).size > BATAS_BERKAS_BYTE) throw new GalatCli(`berkas sumber melebihi ${BATAS_BERKAS_BYTE / 1e6} MB: ${sumber}`);
  const ekstensi = extname(sumber).toLowerCase();
  if (!EKSTENSI_JENIS[jenis].includes(ekstensi)) throw new GalatCli(`ekstensi ${ekstensi || "(kosong)"} tidak cocok untuk jenis ${jenis} (pakai ${EKSTENSI_JENIS[jenis].join(", ")})`);
  const isi = readFileSync(sumber);
  const catatan = [], peringatan = [];
  let keluar = isi, ekstensiKeluar = ekstensi;

  if (ekstensi === ".svg") {
    const r = bersihkanSvg(isi.toString("utf8"));
    if (!r.svg) throw new GalatCli(`SVG ditolak (${basename(sumber)}): ${r.galat.join("; ")}`);
    keluar = Buffer.from(r.svg);
    if (r.dibuang.length) {
      catatan.push(`dibersihkan sanitasi SVG (${r.dibuang.length} konstruk dibuang)`);
      for (const d of r.dibuang) peringatan.push(`SVG dibuang: ${d}`);
    }
  } else if (EKSTENSI_JENIS.gambar.includes(ekstensi)) {
    const h = bacaGambar(isi);
    if (!["png", "jpeg", "webp"].includes(h.format)) throw new GalatCli(`${basename(sumber)} bukan gambar PNG, JPEG, atau WebP yang sah (${h.format}${h.format === "gif" ? "; GIF beranimasi dilarang" : ""})`);
    if (h.animasi) throw new GalatCli(`${basename(sumber)} beranimasi (APNG/WebP animasi): gerak harus dari nomor frame; ekstrak frame atau pakai klip.mjs`);
    if (h.komponen === 4) throw new GalatCli(`${basename(sumber)} JPEG CMYK tidak didukung: konversi ke RGB lebih dulu`);
    const alasan = perluKonversiSrgb(h);
    if (alasan.length && konversi) {
      keluar = await konversiSrgb(isi, MIME[h.format], { browser });
      ekstensiKeluar = ".png";
      catatan.push(`dikonversi ke PNG sRGB tanpa profil lewat Chromium (${alasan.join("; ")}); orientasi EXIF dinormalkan`);
    } else if (alasan.length) {
      peringatan.push(`${alasan.join("; ")}: ulangi dengan --konversi (tanpa itu \`periksa\` akan gagal bila orientasi EXIF bukan 1, atau memberi peringatan untuk profil non-sRGB)`);
    }
  }

  const tujuan = join(dirManifest, "aset", `${id}${ekstensiKeluar}`);
  if (existsSync(tujuan)) throw new GalatCli(`menolak menimpa berkas yang ada: aset/${id}${ekstensiKeluar}`);
  mkdirSync(dirname(tujuan), { recursive: true });
  writeFileSync(tujuan, keluar);
  return { berkas: `aset/${id}${ekstensiKeluar}`, sha256: await sha256Berkas(tujuan), catatan, peringatan };
}

/** Kerangka entri manifest: bidang manusia berisi "[isi]" sehingga validasi gagal sampai diisi. */
export function kerangkaEntri(jenis, id, masuk, tanggal) {
  const isi = "[isi]";
  const e = {
    id, jenis, berkas: masuk.berkas, sha256: masuk.sha256,
    judul: isi, pencipta: isi, sumberUrl: isi, lisensi: isi, tanggalAkses: tanggal,
    perubahan: masuk.catatan.length ? masuk.catatan.join("; ") : isi,
    bukti: isi,
  };
  if (["gambar", "logo", "svg"].includes(jenis)) { e.teksAlternatif = isi; e.ai = { status: isi }; }
  if (jenis === "audio") e.ai = { status: isi };
  if (["gambar", "logo"].includes(jenis) && extname(masuk.berkas) !== ".svg") e.tampil = { lebar: isi, tinggi: isi, fit: "contain", zoomMaks: 1 };
  if (jenis === "gambar") e.orang = { ada: isi };
  if (jenis === "logo") e.merek = { kategori: isi, pemilik: isi };
  if (jenis === "ikon") e.ikon = { keluarga: isi };
  if (jenis === "font") { e.font = { famili: isi, bobot: 400, gaya: "normal" }; e.hakCipta = isi; e.berkasLisensi = isi; }
  return e;
}

// ------------------------------------------------------------ manifest
function bacaManifestAtauKerangka(berkas) {
  if (!existsSync(berkas)) return { skema: VERSI_SKEMA_ASET, proyek: { tujuan: "[isi]" }, aset: [] };
  try {
    const m = JSON.parse(readFileSync(berkas, "utf8"));
    if (!adaObjek(m) || !Array.isArray(m.aset)) throw new Error('harus objek dengan array "aset"');
    return m;
  } catch (e) {
    throw new GalatCli(`${berkas} bukan manifest aset yang sah: ${e.message}`);
  }
}
const tulisManifest = (berkas, m) => writeFileSync(berkas, `${JSON.stringify(m, null, 2)}\n`);

function dapatkanId(sumber, ada, idPilihan) {
  const id = idPilihan ?? slug(basename(sumber, extname(sumber)));
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new GalatCli(`id tidak valid: "${id}" (huruf kecil, angka, - atau _; pakai --id)`);
  if (ada.has(id)) throw new GalatCli(`id sudah ada di manifest: ${id}`);
  return id;
}

// ------------------------------------------------------------ perintah
async function perintahTambah(argv) {
  const { values: o, positionals: p } = parseArgs({
    args: argv, allowPositionals: true,
    options: { id: { type: "string" }, manifest: { type: "string", default: "aset.json" }, konversi: { type: "boolean", default: false }, tanggal: { type: "string" }, browser: { type: "string" } },
  });
  if (p.length !== 2) throw new GalatCli(`tambah butuh <jenis> <berkas>.\n${PETUNJUK}`);
  const [jenis, sumber] = p;
  const tanggal = o.tanggal ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) throw new GalatCli("--tanggal harus YYYY-MM-DD");
  const berkasManifest = resolve(o.manifest), dir = dirname(berkasManifest);
  const manifest = bacaManifestAtauKerangka(berkasManifest);
  const id = dapatkanId(sumber, new Set(manifest.aset.map((a) => a?.id)), o.id);
  const masuk = await masukkanBerkas({ jenis, sumber: resolve(sumber), dirManifest: dir, id, konversi: o.konversi, browser: o.browser });
  manifest.aset.push(kerangkaEntri(jenis, id, masuk, tanggal));
  tulisManifest(berkasManifest, manifest);
  console.log(`ditambahkan: ${masuk.berkas} (id ${id}, sha256 ${masuk.sha256.slice(0, 12)}...) -> ${o.manifest}`);
  for (const c of masuk.catatan) console.log(`  perubahan: ${c}`);
  for (const w of masuk.peringatan) console.error(`  peringatan: ${w}`);
  console.log('Isi semua bidang "[isi]" (sumber, lisensi, bukti, ...), lalu jalankan: bun run aset periksa');
  return 0;
}

async function perintahImpor(argv) {
  const { values: o, positionals: p } = parseArgs({
    args: argv, allowPositionals: true,
    options: { manifest: { type: "string", default: "aset.json" }, konversi: { type: "boolean", default: false }, tanggal: { type: "string" }, browser: { type: "string" } },
  });
  if (p.length !== 1) throw new GalatCli(`impor butuh <daftar.json|folder>.\n${PETUNJUK}`);
  const tanggal = o.tanggal ?? new Date().toISOString().slice(0, 10);
  const berkasManifest = resolve(o.manifest), dir = dirname(berkasManifest);
  const manifest = bacaManifestAtauKerangka(berkasManifest);
  const ada = new Set(manifest.aset.map((a) => a?.id));
  const sumberArg = resolve(p[0]);
  if (!existsSync(sumberArg)) throw new GalatCli(`tidak ditemukan: ${p[0]}`);

  // rencana: [{ jenis, sumber, id, entri? }]; semua divalidasi sebelum ada berkas yang disalin
  const rencana = [];
  if (statSync(sumberArg).isDirectory()) {
    for (const f of readdirSync(sumberArg).sort()) {
      const jenis = JENIS_DARI_EKSTENSI[extname(f).toLowerCase()];
      if (!jenis) { console.error(`dilewati (ekstensi tak dikenal): ${f}`); continue; }
      rencana.push({ jenis, sumber: join(sumberArg, f), id: dapatkanId(f, new Set([...ada, ...rencana.map((r) => r.id)])) });
    }
  } else {
    let daftar;
    try { daftar = JSON.parse(readFileSync(sumberArg, "utf8")); } catch (e) { throw new GalatCli(`${p[0]} bukan JSON valid: ${e.message}`); }
    if (!adaObjek(daftar) || !Array.isArray(daftar.aset)) throw new GalatCli('daftar impor harus objek dengan array "aset" (tiap entri memuat sumberBerkas dan bidang manifest selain berkas/sha256)');
    for (const [i, e] of daftar.aset.entries()) {
      if (!adaObjek(e) || typeof e.sumberBerkas !== "string" || typeof e.jenis !== "string") throw new GalatCli(`aset[${i}]: wajib objek dengan "jenis" dan "sumberBerkas"`);
      const id = dapatkanId(e.sumberBerkas, new Set([...ada, ...rencana.map((r) => r.id)]), e.id);
      rencana.push({ jenis: e.jenis, sumber: resolve(dirname(sumberArg), e.sumberBerkas), id, entri: e });
    }
  }
  if (!rencana.length) throw new GalatCli("tidak ada berkas yang dapat diimpor");

  for (const r of rencana) {
    const masuk = await masukkanBerkas({ jenis: r.jenis, sumber: r.sumber, dirManifest: dir, id: r.id, konversi: o.konversi, browser: o.browser });
    let entri;
    if (r.entri) {
      entri = { ...r.entri, id: r.id, berkas: masuk.berkas, sha256: masuk.sha256 };
      delete entri.sumberBerkas;
      if (masuk.catatan.length) entri.perubahan = [entri.perubahan, ...masuk.catatan].filter(Boolean).join("; ");
    } else entri = kerangkaEntri(r.jenis, r.id, masuk, tanggal);
    manifest.aset.push(entri);
    console.log(`diimpor: ${masuk.berkas} (id ${r.id})`);
    for (const w of masuk.peringatan) console.error(`  peringatan: ${w}`);
  }
  tulisManifest(berkasManifest, manifest);
  console.log(`${rencana.length} aset ditulis ke ${o.manifest}; memeriksa...`);
  return laporkan(await validasiAset(manifest, dir), false, false);
}

/** Mencetak laporan galat dan peringatan; mengembalikan kode keluar. */
function laporkan({ galat, peringatan, aset }, ketat, json) {
  const gagalTotal = galat.length > 0 || (ketat && peringatan.length > 0);
  if (json) {
    console.log(JSON.stringify({ lolos: !gagalTotal, galat, peringatan, aset }, null, 2));
    return gagalTotal ? 2 : 0;
  }
  for (const id of Object.keys(aset)) {
    const bergalat = galat.some((g) => g.startsWith(`aset "${id}":`)), berperingatan = peringatan.some((g) => g.startsWith(`aset "${id}":`));
    const i = aset[id];
    const dim = i.lebar ? ` ${i.lebar}x${i.tinggi}` : "";
    console.log(`${bergalat ? "GAGAL " : "LOLOS "} ${id} (${i.jenis}) ${i.jalur}${i.format ? ` ${i.format}` : ""}${dim}${i.rasioResolusi ? ` rasio=${i.rasioResolusi}` : ""}${!bergalat && berperingatan ? " [peringatan]" : ""}`);
  }
  for (const g of galat) console.log(`  galat: ${g}`);
  for (const w of peringatan) console.log(`  peringatan${ketat ? " (galat karena --ketat)" : ""}: ${w}`);
  console.log(gagalTotal ? `GAGAL: ${galat.length} galat${ketat ? `, ${peringatan.length} peringatan` : ""}` : `LOLOS: ${Object.keys(aset).length} aset${peringatan.length ? `, ${peringatan.length} peringatan` : ""}`);
  return gagalTotal ? 2 : 0;
}

async function perintahPeriksa(argv) {
  const { values: o, positionals: p } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      skala: { type: "string", default: "1" }, ketat: { type: "boolean", default: false }, json: { type: "boolean", default: false },
      out: { type: "string", default: ".cache/awvd/aset" }, komposisi: { type: "string", multiple: true }, gabung: { type: "string" },
    },
  });
  if (p.length > 1) throw new GalatCli(`periksa menerima paling banyak satu aset.json.\n${PETUNJUK}`);
  const skala = Number(o.skala);
  if (!Number.isFinite(skala) || skala < 0.1) throw new GalatCli(`--skala tidak valid: "${o.skala}"`);
  const berkasManifest = resolve(p[0] ?? "aset.json"), dir = dirname(berkasManifest);
  if (!existsSync(berkasManifest)) throw new GalatCli(`manifest tidak ditemukan: ${p[0] ?? "aset.json"}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(berkasManifest, "utf8")); } catch (e) { throw new GalatCli(`${p[0] ?? "aset.json"} bukan JSON valid: ${e.message}`); }
  let dasar = null;
  if (o.gabung) {
    try { dasar = JSON.parse(readFileSync(o.gabung, "utf8")); } catch (e) { throw new GalatCli(`--gabung bukan JSON valid atau tidak terbaca: ${e.message}`); }
    if (!adaObjek(dasar)) throw new GalatCli("--gabung harus objek JSON");
    if ("aset" in dasar) throw new GalatCli('props dasar (--gabung) tidak boleh memuat kunci "aset"; kunci itu diisi dari manifest');
  }

  const hasil = await validasiAset(manifest, dir, { skala });
  // pemindaian statis komposisi: lapis kedua setelah pemblokiran jaringan saat render
  const terdaftar = new Set(Object.values(hasil.aset).flatMap((i) => [i.jalur]));
  for (const f of o.komposisi ?? []) {
    if (!existsSync(f)) throw new GalatCli(`--komposisi tidak ditemukan: ${f}`);
    const teks = readFileSync(f, "utf8");
    for (const t of pindaiJaringan(teks, f)) hasil.peringatan.push(`komposisi ${t} (permintaan non-lokal akan diblokir saat render)`);
    for (const m of new Set(teks.match(/aset\/[A-Za-z0-9._/-]+/g) ?? [])) {
      if (!terdaftar.has(m)) hasil.peringatan.push(`komposisi ${f} merujuk ${m} yang tidak terdaftar di manifest`);
    }
  }
  const kode = laporkan(hasil, o.ketat, o.json);
  if (kode !== 0) return kode;

  const keluar = resolve(o.out);
  mkdirSync(keluar, { recursive: true });
  const props = bangunProps(hasil.aset);
  writeFileSync(join(keluar, "aset-props.json"), `${JSON.stringify(props, null, 2)}\n`);
  writeFileSync(join(keluar, "atribusi.txt"), bangunAtribusi(hasil.aset));
  writeFileSync(join(keluar, "font-face.css"), bangunFontFace(hasil.aset, dir, keluar));
  if (dasar) writeFileSync(join(keluar, "props-gabungan.json"), `${JSON.stringify({ ...dasar, aset: props.aset }, null, 2)}\n`);
  if (!o.json) console.log(`keluaran: ${join(o.out, "aset-props.json")}, atribusi.txt, font-face.css${dasar ? ", props-gabungan.json" : ""}`);
  return 0;
}

async function utama() {
  const [perintah, ...sisa] = process.argv.slice(2);
  try {
    if (!perintah || perintah === "-h" || perintah === "--help") {
      console.log(PETUNJUK);
      process.exit(perintah ? 0 : 2);
    }
    const tabel = { tambah: perintahTambah, impor: perintahImpor, periksa: perintahPeriksa };
    if (!tabel[perintah]) throw new GalatCli(`perintah tidak dikenal: "${perintah}"\n${PETUNJUK}`);
    process.exit(await tabel[perintah](sisa));
  } catch (e) {
    console.error(`aset.mjs: ${e.message}`);
    process.exit(e.kode ?? (e.code?.startsWith?.("ERR_PARSE_ARGS") ? 2 : 1));
  }
}

if (import.meta.main) await utama();
