#!/usr/bin/env bun
/**
 * awvd / penyunting.mjs — penyunting pratinjau lokal untuk `timeline.json` (tampilan #54, penyuntingan dan ekspor #55).
 *
 *   bun scripts/penyunting.mjs <timeline.json> [--port N] [--buka] [--draf] [--cache DIR] [--timpa]
 *
 * Server kecil `Bun.serve` yang HANYA mendengarkan 127.0.0.1 dan melayani halaman penyunting
 * (`scripts/penyunting/`), templat render `templates/timeline/index.html` apa adanya (props disuntik
 * lewat satu tag skrip, setara `window.videoProps` oleh render.mjs), dan media yang diwhitelist.
 * Validator `periksaTimeline` (scripts/timeline.mjs) dipanggil langsung di proses ini: browser tidak
 * punya validator sendiri. Frame pratinjau digambar templat lewat protokol `window.video.renderFrame`,
 * bukan oleh penyunting. Rancangan dan pengerasan: docs/penyunting.md (KP-074, KP-075, KP-076).
 *
 * Pemuatan (setara templates/timeline/siapkan.mjs, tanpa Chromium): `klip.mjs` mengekstrak frame klip,
 * `periksaTimeline` memvalidasi, `aset.mjs periksa` menghasilkan props aset. Timeline yang ditolak
 * validator tetap dibuka agar galatnya terlihat; kegagalan langkah klip atau aset dicatat sebagai
 * masalah muat (kode MUAT), bukan menghentikan server. Hanya JSON rusak atau berkas hilang yang
 * menghentikan CLI (kode keluar 2).
 *
 * Penyuntingan (#55): halaman memegang model suntingan dan riwayat urungkan (scripts/penyunting/model.js) dan
 * mengirim timeline PENUH ke dua rute POST: `/api/periksa` (validasi dengan konteks manifest yang di-cache,
 * hasilnya jadi salinan kerja server yang dirender iframe) dan `/api/ekspor` (tulis hanya bila validator
 * lolos). Hanya butir di dalam track yang boleh berubah; bagian lain harus sama dengan berkas sesi (konteks
 * manifest yang di-cache hanya sah untuk itu). Jalur keluaran ditentukan CLI saja (`<nama>.sunting.json` di folder
 * yang sama; `--timpa` menimpa sumber), tidak pernah oleh klien; penulisan atomik (berkas sementara, fsync, rename).
 *
 * Keamanan (diuji di scripts/uji-penyunting.mjs): ikat 127.0.0.1; token acak 128 bit per sesi
 * (header X-Awvd-Token, parameter ?token=, atau cookie HttpOnly SameSite=Strict yang dipasang dari
 * halaman pertama untuk subsumber; POST WAJIB header X-Awvd-Token); pemeriksaan Host, Origin, dan Sec-Fetch-Site;
 * rute daftar putih; POST hanya application/json dengan badan <= 5 MB; CSP ketat (skrip inline templat hanya
 * lewat hash sha256); tautan simbolik keluar folder ditolak. Selain cache klip dan aset, satu-satunya penulisan
 * adalah berkas keluaran ekspor.
 * Kode keluar: 0 berhenti normal; 2 argumen, berkas, atau JSON tidak valid; 1 galat tak terduga.
 * Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BATAS_BERKAS_BYTE, muatKonteks, periksaTimeline, validasiSkema } from "./timeline.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirHalaman = join(akar, "scripts", "penyunting");
const berkasTemplat = join(akar, "templates", "timeline", "index.html");
const skripPublik = new Set(["runtime.js", "transisi.js", "timeline.js"]);
const berkasHalaman = new Set(["penyunting.js", "penyunting.css", "model.js"]);
const BATAS_PESAN_MUAT = 2000;
const BATAS_BODI_BYTE = BATAS_BERKAS_BYTE; // badan POST (timeline penuh, ringkas) sebesar-besarnya sama dengan berkas timeline

const adaObjek = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

class GalatCli extends Error {
  constructor(pesan, kode = 2) {
    super(pesan);
    this.kode = kode;
  }
}

// ======================================================================================
// Pemuatan sesi
// ======================================================================================

async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const potong = (s) => (s.length > BATAS_PESAN_MUAT ? `${s.slice(0, BATAS_PESAN_MUAT)} ...` : s);

/**
 * Menyiapkan sesi dari satu timeline.json. Tidak melempar untuk timeline yang hanya ditolak validator
 * atau gagal di langkah klip/aset; hanya berkas hilang, terlalu besar, atau bukan JSON.
 * `timeline` adalah salinan kerja (berubah lewat /api/periksa dan /api/ekspor); `dasar` tetap sama dengan berkas
 * sesi dan menjadi acuan bagian yang tidak boleh berubah. `keluaran` (jalur mutlak) hanya ditentukan di sini.
 * @returns {Promise<object>} { berkas, tampil, keluaran, keluaranTampil, timpa, dir, dasar, timeline, klip, klipProps, aset, jalurAset, dirKlip, validasi, masalahMuat, draf }
 */
export async function muatSesi({ berkas, tampil = berkas, cache = ".cache/awvd/penyunting", draf = false, timpa = false }) {
  const jalur = resolve(berkas);
  if (!existsSync(jalur) || !statSync(jalur).isFile()) throw new GalatCli(`timeline tidak ditemukan: ${tampil}`);
  const ukuran = statSync(jalur).size;
  if (ukuran > BATAS_BERKAS_BYTE) throw new GalatCli(`${tampil} berukuran ${(ukuran / 1e6).toFixed(1)} MB, melebihi batas ${BATAS_BERKAS_BYTE / 1e6} MB`);
  let t;
  try { t = JSON.parse(readFileSync(jalur, "utf8")); } catch (e) { throw new GalatCli(`${tampil} bukan JSON valid: ${e.message}`); }
  if (!adaObjek(t)) throw new GalatCli(`${tampil} harus berisi objek JSON`);

  const dir = dirname(jalur);
  const keluar = resolve(cache);
  mkdirSync(keluar, { recursive: true });
  const dirKlip = join(keluar, "klip");
  const dirAset = join(keluar, "aset");
  const masalahMuat = [];
  const gagalMuat = (lok, pesan) => masalahMuat.push({ kode: "MUAT", lok, pesan: potong(pesan.trim()) });
  const tambahDraf = draf ? ["--draf"] : [];
  const skrip = (n) => join(akar, "scripts", n);

  let klip = [];
  const sumber = t.manifes?.sumber;
  if (typeof sumber === "string" && Number.isInteger(t.proyek?.fps) && t.proyek.fps > 0) {
    const r = await jalankan([process.execPath, skrip("klip.mjs"), join(dir, sumber), "--fps", String(t.proyek.fps), "--out", dirKlip, ...tambahDraf]);
    if (r.kode !== 0) gagalMuat("/manifes/sumber", `klip gagal (exit ${r.kode}): ${r.out}${r.err}`);
    else {
      try { klip = JSON.parse(readFileSync(join(dirKlip, "klip-props.json"), "utf8")).klip; } catch (e) { gagalMuat("/manifes/sumber", `klip-props.json tidak terbaca: ${e.message}`); }
    }
  }

  let aset;
  const manifesAset = t.manifes?.aset;
  if (typeof manifesAset === "string") {
    const r = await jalankan([process.execPath, skrip("aset.mjs"), "periksa", join(dir, manifesAset), "--out", dirAset]);
    if (r.kode !== 0) gagalMuat("/manifes/aset", `aset gagal (exit ${r.kode}): ${r.out}${r.err}`);
    else {
      try { aset = JSON.parse(readFileSync(join(dirAset, "aset-props.json"), "utf8")).aset; } catch (e) { gagalMuat("/manifes/aset", `aset-props.json tidak terbaca: ${e.message}`); }
    }
  }

  // whitelist media: hanya berkas yang disebut props (jalur aset bukan audio; folder klip hasil ekstraksi)
  const dirManifesAset = typeof manifesAset === "string" ? dirname(join(dir, manifesAset)) : dir;
  const jalurAset = new Map();
  if (aset) {
    for (const e of Object.values(aset)) {
      if (e && e.jenis !== "audio" && typeof e.jalur === "string") jalurAset.set(e.jalur, join(dirManifesAset, e.jalur));
    }
  }
  const folderKlip = new Set(klip.map((k) => k.folder).filter((f) => typeof f === "string" && /^[A-Za-z0-9_-]+$/.test(f)));

  const nama = (x) => `${x.replace(/\.json$/i, "")}.sunting.json`;
  const sesi = {
    berkas: jalur, tampil, keluaran: timpa ? jalur : nama(jalur), keluaranTampil: timpa ? tampil : nama(tampil), timpa,
    dir, dasar: t, timeline: structuredClone(t), klip, klipProps: klip.length ? { klip } : undefined, aset, jalurAset, dirAset: dirManifesAset, dirKlip, folderKlip,
    validasi: null, masalahMuat, draf, konteksJanji: null, urutan: 0, diterapkan: 0,
  };
  sesi.validasi = await periksaDraf(sesi, t);
  return sesi;
}

/** Konteks manifest (aset.json, sumber.json, ffprobe) dimuat sekali dari timeline sesi, lalu dipakai ulang tiap validasi. */
function konteksSesi(sesi) {
  sesi.konteksJanji ??= (async () => {
    try { return validasiSkema(sesi.dasar).length === 0 ? await muatKonteks(sesi.dasar, sesi.dir, { klipProps: sesi.klipProps }) : undefined; } catch { return undefined; }
  })();
  return sesi.konteksJanji;
}

/**
 * Memvalidasi timeline (draf kerja) dengan `periksaTimeline`, satu-satunya validator. Konteks manifest di-cache
 * (sah karena manifes, fps, jenisVideo, dan durasi proyek tidak boleh berubah; lihat bagianTetap). Tidak melempar.
 */
export async function periksaDraf(sesi, t, { ketat = false } = {}) {
  try {
    const h = await periksaTimeline(t, { dir: sesi.dir, klipProps: sesi.klipProps, draf: sesi.draf, ketat, konteks: await konteksSesi(sesi) });
    return { lolos: h.lolos, galat: h.galat, peringatan: h.peringatan, ringkasan: h.ringkasan };
  } catch (e) {
    // pemuatan manifest di validator dapat melempar (mis. manifest rusak): tampilkan sebagai galat, jangan matikan sesi
    return { lolos: false, galat: [{ kode: "MUAT", lok: "", pesan: potong(String(e.message)) }], peringatan: [], ringkasan: null };
  }
}

const samaDalam = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => samaDalam(x, b[i]));
  if (adaObjek(a)) {
    if (!adaObjek(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && samaDalam(a[k], b[k]));
  }
  return false;
};

/**
 * Hanya `butir` di dalam track yang boleh berubah di penyunting. Mengembalikan pesan galat, atau null bila sah.
 * Konteks manifest yang di-cache dan keluaran yang diklaim "lolos validator" hanya benar untuk bagian lain yang tetap.
 */
export function bagianTetap(dasar, t) {
  if (!adaObjek(t)) return "timeline harus objek JSON";
  if (!Array.isArray(dasar.track)) return samaDalam(dasar, t) ? null : "timeline sesi tidak memuat track yang dapat disunting";
  for (const k of new Set([...Object.keys(dasar), ...Object.keys(t)])) {
    if (k !== "track" && !samaDalam(dasar[k], t[k])) return `bagian "${k}" tidak boleh diubah di penyunting`;
  }
  if (!Array.isArray(t.track) || t.track.length !== dasar.track.length) return "jumlah track tidak boleh berubah di penyunting";
  for (let i = 0; i < dasar.track.length; i++) {
    const a = dasar.track[i], b = t.track[i];
    if (!adaObjek(a) || !adaObjek(b)) return `track ${i} tidak valid`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k !== "butir" && !samaDalam(a[k], b[k])) return `bagian "track/${i}/${k}" tidak boleh diubah di penyunting`;
    }
    if (!Array.isArray(b.butir)) return `track ${i}: butir harus array`;
  }
  return null;
}

/** Penulisan atomik: berkas sementara di folder yang sama (mode dan fsync), lalu rename; sementara dibuang bila gagal. */
export function tulisAtomik(tujuan, isi) {
  const sementara = join(dirname(tujuan), `.${basename(tujuan)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let mode = 0o644;
  try { mode = statSync(tujuan).mode & 0o777; } catch { /* belum ada */ }
  try {
    const fd = openSync(sementara, "wx", mode);
    try { writeSync(fd, isi); fsyncSync(fd); } finally { closeSync(fd); }
    try { chmodSync(sementara, mode); } catch { /* mode bawaan */ }
    renameSync(sementara, tujuan);
  } catch (e) {
    rmSync(sementara, { force: true });
    throw e;
  }
}

/** Props untuk iframe komposisi: jalur media dipetakan dari file:// ke rute /media/... (relatif, satu asal). */
export function propsPratinjau(sesi) {
  const props = {
    timeline: sesi.timeline,
    klip: sesi.klip.map((k) => ({ ...k, akar: "/media/klip" })),
  };
  if (sesi.aset) { props.aset = sesi.aset; props.akarAset = "/media/aset"; }
  return props;
}

// ======================================================================================
// Server
// ======================================================================================

const TIPE = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".otf": "font/otf",
};
const tipeDari = (p) => TIPE[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

const CSP_HALAMAN = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const CSP_MEDIA = "default-src 'none'; sandbox";
const cspKomposisi = (hash) => `default-src 'self'; script-src ${["'self'", ...hash.map((h) => `'sha256-${h}'`)].join(" ")}; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`;

/** Hash sha256 (base64) setiap <script> inline tanpa atribut, untuk script-src berbasis hash (tanpa 'unsafe-inline'). */
export function hashSkripInline(html) {
  const hasil = [];
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) hasil.push(createHash("sha256").update(m[1]).digest("base64"));
  return hasil;
}

const samaToken = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function bacaCookie(header, nama) {
  for (const bagian of (header ?? "").split(";")) {
    const i = bagian.indexOf("=");
    if (i > 0 && bagian.slice(0, i).trim() === nama) return bagian.slice(i + 1).trim();
  }
  return null;
}

/** Memecah path menjadi segmen aman; null bila ada segmen "..", ".", kosong, atau berisi pemisah/NUL. */
export function segmenAman(path) {
  const hasil = [];
  for (const mentah of path.split("/").slice(1)) {
    let s;
    try { s = decodeURIComponent(mentah); } catch { return null; }
    if (s === "" || s === "." || s === ".." || /[\\/\0]/.test(s)) return null;
    hasil.push(s);
  }
  return hasil;
}

/** Berkas reguler di dalam `dasar` setelah realpath (tautan simbolik keluar ditolak); null bila tidak. */
export function berkasDalam(dasar, abs) {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const nyata = realpathSync(abs), basis = realpathSync(dasar);
    return nyata.startsWith(basis + sep) ? nyata : null;
  } catch { return null; }
}

/**
 * Membuat server. `port` 0 = acak. Mengembalikan { server, token, url, berhenti }.
 * @param {object} sesi hasil muatSesi
 */
export function mulaiServer(sesi, { port = 0, token = randomBytes(16).toString("hex") } = {}) {
  const tolak = (status, pesan, tambahan = {}) => new Response(`${pesan}\n`, {
    status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...tambahan },
  });
  const kirim = (isi, tipe, csp, { status = 200, ...tambahan } = {}) => new Response(isi, {
    status,
    headers: {
      "Content-Type": tipe, "Content-Security-Policy": csp, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", ...tambahan,
    },
  });
  const berkasStatik = (abs, csp) => kirim(Bun.file(abs), tipeDari(abs), csp);
  const json = (status, obj) => kirim(JSON.stringify(obj), TIPE[".json"], CSP_HALAMAN, { status });
  let server;

  /** Membaca badan POST dengan batas ukuran (Content-Length dan hitungan aliran); melempar { status, pesan }. */
  async function bacaBodi(req) {
    const cl = req.headers.get("content-length");
    if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > BATAS_BODI_BYTE)) throw { status: 413, pesan: `badan melebihi batas ${BATAS_BODI_BYTE / 1e6} MB` };
    const bagian = [];
    let total = 0;
    if (req.body) {
      const pembaca = req.body.getReader();
      for (;;) {
        const { done, value } = await pembaca.read();
        if (done) break;
        total += value.byteLength;
        if (total > BATAS_BODI_BYTE) { pembaca.cancel().catch(() => {}); throw { status: 413, pesan: `badan melebihi batas ${BATAS_BODI_BYTE / 1e6} MB` }; }
        bagian.push(value);
      }
    }
    try {
      const isi = JSON.parse(Buffer.concat(bagian).toString("utf8"));
      if (!adaObjek(isi)) throw new Error("harus objek JSON");
      return isi;
    } catch (e) {
      throw { status: 400, pesan: `badan bukan JSON objek yang valid: ${e.message}` };
    }
  }

  /** Terima timeline dari klien: bentuk dan bagian tetap diperiksa sebelum validator. Melempar { status, pesan }. */
  function terimaTimeline(isi) {
    if (!adaObjek(isi.timeline)) throw { status: 400, pesan: 'badan harus berbentuk { "timeline": {...} }' };
    const salah = bagianTetap(sesi.dasar, isi.timeline);
    if (salah) throw { status: 422, pesan: salah };
    return isi.timeline;
  }

  async function periksaDanSimpan(t, ketat = false) {
    const n = ++sesi.urutan;
    const h = await periksaDraf(sesi, t, { ketat });
    if (!ketat && n > sesi.diterapkan) { sesi.diterapkan = n; sesi.timeline = t; sesi.validasi = h; }
    return h;
  }

  async function tanganiPost(rute, req) {
    let isi;
    try {
      if ((req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json") throw { status: 415, pesan: "Content-Type harus application/json" };
      isi = await bacaBodi(req);
      const t = terimaTimeline(isi);
      if (rute === "periksa") return json(200, { validasi: await periksaDanSimpan(t) });
      // ekspor: tulis hanya bila validator lolos (ketat: peringatan dianggap galat); jalur keluaran tidak datang dari klien
      const ketat = isi.ketat === true;
      const h = ketat ? await periksaDraf(sesi, t, { ketat }) : await periksaDanSimpan(t);
      if (!h.lolos) return json(422, { galat: `ekspor ditolak: validator menemukan ${h.galat.length} galat${ketat ? " (ekspor ketat)" : ""}; tidak ada berkas yang ditulis`, validasi: h });
      const teks = `${JSON.stringify(t, null, 2)}\n`;
      const byte = Buffer.byteLength(teks);
      if (byte > BATAS_BERKAS_BYTE) throw { status: 413, pesan: `hasil ekspor ${(byte / 1e6).toFixed(1)} MB melebihi batas ${BATAS_BERKAS_BYTE / 1e6} MB yang diterima validator` };
      try { tulisAtomik(sesi.keluaran, teks); } catch (e) { throw { status: 500, pesan: `gagal menulis ${sesi.keluaranTampil}: ${e.code ?? e.message}` }; }
      return json(200, { ok: true, berkas: sesi.keluaranTampil, byte, timpa: sesi.timpa, draf: sesi.draf, ketat, validasi: h });
    } catch (e) {
      if (e && typeof e.status === "number") return json(e.status, { galat: e.pesan });
      throw e;
    }
  }

  async function tangani(req) {
    const url = new URL(req.url);
    const hostSah = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];

    // 1. asal: Host (DNS rebinding), Sec-Fetch-Site dan Origin (CSRF dari halaman lain)
    if (!hostSah.includes(req.headers.get("host") ?? "")) return tolak(403, "Host tidak diizinkan");
    const sf = req.headers.get("sec-fetch-site");
    if (sf && sf !== "same-origin" && sf !== "none") return tolak(403, "Asal permintaan tidak diizinkan");
    const origin = req.headers.get("origin");
    if (origin && !hostSah.some((h) => origin === `http://${h}`)) return tolak(403, "Origin tidak diizinkan");

    // 2. token (header, parameter, atau cookie); kebocoran waktu dicegah timingSafeEqual
    const dariHeader = req.headers.get("x-awvd-token");
    const dariQuery = url.searchParams.get("token");
    const dariCookie = bacaCookie(req.headers.get("cookie"), "awvd_token");
    const sah = [dariHeader, dariQuery, dariCookie].some((t) => typeof t === "string" && samaToken(t, token));
    if (!sah) return tolak(403, "Token tidak ada atau salah");
    const pasangCookie = dariCookie !== null && samaToken(dariCookie, token) ? {} : { "Set-Cookie": `awvd_token=${token}; Path=/; HttpOnly; SameSite=Strict` };

    // 3. metode: POST hanya untuk dua rute API dan wajib membawa token lewat header (bukan cookie atau query)
    const seg = segmenAman(url.pathname);
    const ruteTulis = seg && seg.length === 2 && seg[0] === "api" && (seg[1] === "periksa" || seg[1] === "ekspor") ? seg[1] : null;
    if (ruteTulis) {
      if (req.method !== "POST") return tolak(405, "Metode tidak diizinkan (hanya POST)", { Allow: "POST" });
      if (!(typeof dariHeader === "string" && samaToken(dariHeader, token))) return tolak(403, "POST wajib membawa token lewat header X-Awvd-Token");
      return tanganiPost(ruteTulis, req);
    }
    if (req.method !== "GET") return tolak(405, "Metode tidak diizinkan (hanya GET)", { Allow: "GET" });

    // 4. rute daftar putih (selain itu 404, tanpa daftar direktori)
    if (url.pathname === "/") {
      return kirim(readFileSync(join(dirHalaman, "index.html")), TIPE[".html"], CSP_HALAMAN, pasangCookie);
    }
    if (!seg) return tolak(404, "Tidak ditemukan");
    const [a, b] = seg;
    if (seg.length === 1 && berkasHalaman.has(a)) return berkasStatik(join(dirHalaman, a), CSP_HALAMAN);
    if (seg.length === 2 && a === "scripts" && skripPublik.has(b)) return berkasStatik(join(akar, "scripts", b), CSP_HALAMAN);
    if (seg.length === 1 && a === "komposisi.html") {
      const html = readFileSync(berkasTemplat, "utf8");
      const versi = createHash("sha256").update(JSON.stringify(propsPratinjau(sesi))).digest("hex").slice(0, 16);
      const disuntik = html.replace(/<head>/, `<head>\n<script src="/__props.js?v=${versi}"></script>`);
      return kirim(disuntik, TIPE[".html"], cspKomposisi(hashSkripInline(html)), pasangCookie);
    }
    if (seg.length === 1 && a === "__props.js") {
      return kirim(`window.videoProps = ${JSON.stringify(propsPratinjau(sesi))};\n`, TIPE[".js"], CSP_HALAMAN);
    }
    if (seg.length === 2 && a === "api" && b === "sesi") {
      const { validasi, masalahMuat, timeline, tampil, draf, keluaranTampil, timpa } = sesi;
      return kirim(JSON.stringify({ versi: 2, berkas: tampil, draf, timeline, validasi, masalahMuat, ekspor: { berkas: keluaranTampil, timpa } }), TIPE[".json"], CSP_HALAMAN);
    }
    if (a === "media" && b === "aset" && seg.length >= 3) {
      const rel = seg.slice(2).join("/");
      const abs = sesi.jalurAset.get(rel);
      const nyata = abs && berkasDalam(sesi.dirAset, abs);
      return nyata ? berkasStatik(nyata, CSP_MEDIA) : tolak(404, "Tidak ditemukan");
    }
    if (a === "media" && b === "klip" && seg.length === 4) {
      const [, , folder, nama] = seg;
      if (!sesi.folderKlip.has(folder) || !/^\d{1,9}\.(?:jpg|png)$/.test(nama)) return tolak(404, "Tidak ditemukan");
      const dasar = join(sesi.dirKlip, folder);
      const nyata = berkasDalam(dasar, join(dasar, nama));
      return nyata ? berkasStatik(nyata, CSP_MEDIA) : tolak(404, "Tidak ditemukan");
    }
    return tolak(404, "Tidak ditemukan");
  }

  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: BATAS_BODI_BYTE + 4096,
    async fetch(req) {
      try { return await tangani(req); } catch (e) { return tolak(500, `Galat server: ${e?.message ?? e}`); }
    },
  });
  return {
    server, token,
    url: `http://127.0.0.1:${server.port}/?token=${token}`,
    berhenti: () => server.stop(true),
  };
}

// ======================================================================================
// CLI
// ======================================================================================

const PETUNJUK = `Pemakaian:
  bun scripts/penyunting.mjs <timeline.json> [--port N] [--buka] [--draf] [--cache DIR] [--timpa]
Membuka penyunting pratinjau lokal: scrubber, daftar track, frame yang sama dengan render, dan penyuntingan dasar
(pindah, potong, ubah durasi, urungkan, ulangi) dengan ekspor yang hanya berhasil bila validator lolos, di server
yang hanya mendengarkan 127.0.0.1. Mencetak URL berisi token sesi.
  --port N     port tetap (bawaan 0 = acak)
  --buka       buka URL di peramban bawaan (xdg-open, open, atau start)
  --draf       gerbang hukum GH yang belum disetujui menjadi peringatan (seperti timeline periksa --draf)
  --cache DIR  folder cache frame klip dan props aset (bawaan .cache/awvd/penyunting)
  --timpa      ekspor menimpa timeline.json sumber (bawaan: menulis <nama>.sunting.json di folder yang sama)
Penulisan atomik; jalur keluaran hanya ditentukan opsi ini, tidak pernah oleh halaman.
Kode keluar: 0 berhenti normal (Ctrl+C); 2 argumen, berkas, atau JSON tidak valid; 1 galat tak terduga.`;

function bukaPeramban(url) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch (e) { console.error(`penyunting: tidak bisa membuka peramban (${e.message}); buka URL secara manual`); }
}

async function utama() {
  try {
    const { values: o, positionals: p } = parseArgs({
      allowPositionals: true,
      options: {
        port: { type: "string", default: "0" },
        buka: { type: "boolean", default: false },
        draf: { type: "boolean", default: false },
        cache: { type: "string", default: ".cache/awvd/penyunting" },
        timpa: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (o.help) { console.log(PETUNJUK); return; }
    if (p.length !== 1) throw new GalatCli(`butuh tepat satu timeline.json.\n${PETUNJUK}`);
    if (!/^\d+$/.test(o.port) || Number(o.port) > 65535) throw new GalatCli(`--port tidak valid: "${o.port}" (0..65535)`);

    const sesi = await muatSesi({ berkas: p[0], tampil: p[0], cache: o.cache, draf: o.draf, timpa: o.timpa });
    const v = sesi.validasi;
    const r = v.ringkasan;
    if (r) console.log(`${p[0]}: ${r.track} track, ${r.butir} butir, ${r.frame} frame @ ${r.fps} fps`);
    console.log(v.lolos ? `validator: lolos (${v.peringatan.length} peringatan)` : `validator: DITOLAK (${v.galat.length} galat); galat tampil di panel masalah`);
    for (const m of sesi.masalahMuat) console.error(`peringatan muat [${m.lok}]: ${m.pesan.split("\n")[0]}`);

    const s = mulaiServer(sesi, { port: Number(o.port) });
    console.log(`ekspor: ${sesi.keluaranTampil}${o.timpa ? " (menimpa sumber)" : ""}`);
    console.log(`penyunting: ${s.url}`);
    console.log("Hanya mendengarkan 127.0.0.1. Tekan Ctrl+C untuk berhenti.");
    if (o.buka) bukaPeramban(s.url);
    for (const sinyal of ["SIGINT", "SIGTERM"]) process.on(sinyal, () => { s.berhenti(); process.exit(0); });
  } catch (e) {
    console.error(`penyunting.mjs: ${e.message}`);
    process.exit(e.kode ?? (e.code?.startsWith?.("ERR_PARSE_ARGS") ? 2 : 1));
  }
}

if (import.meta.main) await utama();
