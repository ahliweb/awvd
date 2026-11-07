/**
 * awvd / aset-lib.js — logika bersama fitur aset (dipakai scripts/aset.mjs dan uji).
 *
 * Isi: matriks lisensi per jenis, pembaca header gambar (PNG/JPEG/WebP: dimensi, alpha, animasi,
 * ICC, orientasi EXIF), pemeriksa resolusi, validasi manifest `aset.json` (skema 1, fail-closed),
 * dan pembangun keluaran (`aset-props.json`, `atribusi.txt`, `font-face.css`).
 * Pemeriksa SVG ada di `aset-svg.js` (diekspor ulang di sini).
 *
 * Tidak ada akses jaringan dan tidak ada Chromium di modul ini; hanya ffprobe (opsional untuk
 * sanity dimensi/audio). Karya asli repo ini; format dibaca dari spesifikasi publik
 * (PNG, JFIF/EXIF, ICC v2/v4, RIFF WebP).
 *
 * Ini bukan nasihat hukum: validator menolak yang jelas melanggar aturan teknis dan lisensi yang
 * dikenal, tetapi merek, hak potret, data pribadi, musik, dan hasil AI tetap perlu tinjauan manusia.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { sha256Berkas, uraiLisensi } from "./klip.mjs";
import { bersihkanSvg, periksaSvg } from "./aset-svg.js";

export { bersihkanSvg, periksaSvg, sha256Berkas };

export const VERSI_SKEMA_ASET = 1;
export const JENIS_ASET = ["gambar", "logo", "ikon", "svg", "font", "audio"];
const POLA_ID = /^[a-z0-9][a-z0-9_-]*$/;
const POLA_BERKAS = /^aset\/[A-Za-z0-9._/-]+$/;
const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
const BATAS_BERKAS_BYTE = 50_000_000;
const BATAS_GAMBAR_BERAT = 5_000_000;
const EKSTENSI = {
  raster: [".png", ".jpg", ".jpeg", ".webp"],
  svg: [".svg"],
  font: [".woff2", ".woff", ".ttf", ".otf"],
  audio: [".wav", ".flac", ".mp3", ".ogg", ".m4a", ".opus"],
};

// ---------------------------------------------------------------- lisensi
const PERMISIF = { MIT: "MIT", "Apache-2.0": "Apache-2.0", ISC: "ISC", "BSD-2-Clause": "BSD", "BSD-3-Clause": "BSD", "OFL-1.1": "OFL-1.1" };

/**
 * Mengurai kode lisensi aset (superset kode lisensi klip). Mengembalikan null bila tak dikenal.
 * `kunci` dipakai untuk mencocokkan matriks per jenis.
 */
export function uraiLisensiAset(kode) {
  if (typeof kode !== "string") return null;
  const k = uraiLisensi(kode);
  if (k) {
    const kunci = { cc: `CC-BY${k.sa ? "-SA" : ""}`, cc0: "CC0", pdm: "PDM", stok: "STOK" }[k.jenis];
    return { ...k, kunci };
  }
  if (kode === "MILIK-SENDIRI") return { jenis: "sendiri", kunci: "MILIK-SENDIRI", nc: false, sa: false, nd: false };
  let m = /^IZIN-TERTULIS:(.+)$/.exec(kode);
  if (m && m[1].trim()) return { jenis: "izin", kunci: "IZIN-TERTULIS", pemegang: m[1].trim(), nc: false, sa: false, nd: false };
  if (PERMISIF[kode]) return { jenis: "perangkat", kunci: PERMISIF[kode], nc: false, sa: false, nd: false };
  return null;
}

export function namaLisensiAset(kode) {
  const u = uraiLisensiAset(kode);
  if (!u) return String(kode ?? "");
  if (u.jenis === "cc") return `CC BY${u.nc ? "-NC" : ""}${u.sa ? "-SA" : ""}${u.nd ? "-ND" : ""} ${u.versi[0]}.${u.versi[1]}`;
  if (u.jenis === "cc0") return "CC0 1.0";
  if (u.jenis === "pdm") return "Public Domain Mark 1.0";
  if (u.jenis === "stok") return `Lisensi stok ${u.penyedia}`;
  if (u.jenis === "sendiri") return "Milik sendiri";
  if (u.jenis === "izin") return `Izin tertulis ${u.pemegang}`;
  return kode;
}

function urlLisensiCc(kode) {
  const u = uraiLisensiAset(kode);
  if (u?.jenis === "cc") {
    const unsur = ["by", u.nc ? "nc" : "", u.sa ? "sa" : "", u.nd ? "nd" : ""].filter(Boolean).join("-");
    return `https://creativecommons.org/licenses/${unsur}/${u.versi[0]}.${u.versi[1]}/`;
  }
  if (u?.jenis === "cc0") return "https://creativecommons.org/publicdomain/zero/1.0/";
  if (u?.jenis === "pdm") return "https://creativecommons.org/publicdomain/mark/1.0/";
  return "";
}

/**
 * Matriks lisensi yang diizinkan per jenis (riset aset 2026-11-07, §4.1). `ketat`: lisensi di
 * luar daftar = galat (logo); selain itu = peringatan "tidak lazim". Ini ringkasan teknis,
 * bukan nasihat hukum.
 */
export const MATRIKS_LISENSI = {
  gambar: { izin: ["CC0", "PDM", "CC-BY", "CC-BY-SA", "STOK", "MILIK-SENDIRI", "IZIN-TERTULIS"], ketat: false },
  svg: { izin: ["CC0", "PDM", "CC-BY", "CC-BY-SA", "STOK", "MILIK-SENDIRI", "IZIN-TERTULIS"], ketat: false },
  logo: { izin: ["MILIK-SENDIRI", "IZIN-TERTULIS", "CC0", "PDM"], ketat: true },
  ikon: { izin: ["MIT", "Apache-2.0", "ISC", "BSD", "CC0", "CC-BY", "MILIK-SENDIRI"], ketat: false },
  font: { izin: ["OFL-1.1", "Apache-2.0", "CC0", "MIT", "MILIK-SENDIRI", "IZIN-TERTULIS"], ketat: false },
  audio: { izin: ["CC0", "CC-BY", "CC-BY-SA", "STOK", "MILIK-SENDIRI", "IZIN-TERTULIS"], ketat: false },
};

const wajibAtribusi = (u) => u.jenis === "cc";
// Lisensi yang mewajibkan pemberitahuan hak cipta + salinan lisensi ikut bila berkas didistribusikan.
const wajibNotice = (u, jenis) => u.jenis === "perangkat" || (u.jenis === "cc" && jenis === "ikon");

/** Baris atribusi TASL lengkap (judul, pencipta, sumber, lisensi, perubahan). */
export function kreditAset(a) {
  let t = "";
  if (!a.tanpaJudul && a.judul) t = `"${a.judul}"`;
  if (!a.penciptaAnonim && a.pencipta) t += (t ? " oleh " : "") + a.pencipta;
  const perubahan = String(a.perubahan ?? "").replace(/[.\s]+$/, "");
  const b = [];
  if (t) b.push(t);
  if (a.sumberUrl) b.push(`Sumber: ${a.sumberUrl}`);
  const urlLisensi = a.urlLisensi || urlLisensiCc(a.lisensi);
  b.push(`Lisensi: ${namaLisensiAset(a.lisensi)}${urlLisensi ? ` (${urlLisensi})` : ""}`);
  if (perubahan && !/^tidak ada$/i.test(perubahan)) b.push(`Diubah: ${perubahan}`);
  return `${b.join(". ")}.`;
}

// ---------------------------------------------------------------- jalur aman
const adaTeks = (v) => typeof v === "string" && v.trim() !== "";
const adaObjek = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bilanganPositif = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const urlHttp = (v) => {
  try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; }
};
const tanggalSah = (s) => POLA_TANGGAL.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * Jalur relatif di bawah folder manifest: tanpa skema, jalur mutlak, `..`, atau simlink yang keluar.
 * @returns {{ galat: string } | { jalur: string }}
 */
export function jalurDalam(dirManifest, rel, { awalan } = {}) {
  if (!adaTeks(rel)) return { galat: "jalur kosong" };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel) || rel.startsWith("//")) return { galat: `jalur "${rel}" memuat skema (http, file, data, ...) dan ditolak; aset hanya berkas lokal` };
  if (isAbsolute(rel) || rel.startsWith("/") || rel.includes("\\")) return { galat: `jalur "${rel}" harus relatif terhadap folder manifest` };
  const bagian = rel.split("/");
  if (bagian.some((b) => b === ".." || b === "." || b === "")) return { galat: `jalur "${rel}" tidak boleh memuat "..", "." atau segmen kosong` };
  if (awalan && !rel.startsWith(awalan)) return { galat: `jalur "${rel}" harus di bawah ${awalan}` };
  const p = resolve(dirManifest, rel);
  if (!existsSync(p) || !statSync(p).isFile()) return { galat: `berkas tidak ditemukan: ${rel}` };
  try {
    const nyata = realpathSync(p), dasar = realpathSync(dirManifest);
    const luar = relative(awalan ? realpathSync(resolve(dirManifest, awalan)) : dasar, nyata);
    if (luar.startsWith("..") || isAbsolute(luar)) return { galat: `jalur "${rel}" keluar dari folder yang diizinkan lewat simlink` };
  } catch {
    return { galat: `jalur "${rel}" tak dapat diselesaikan` };
  }
  return { jalur: p };
}

// ---------------------------------------------------------------- ICC, EXIF, header gambar
const SRGB_D50 = { r: [0.4361, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971], b: [0.1431, 0.0606, 0.7141] };
const u32 = (b, o) => b.readUInt32BE(o);

/** Membaca profil ICC secukupnya: ruang warna, deskripsi, dan apakah primer RGB-nya = sRGB. */
export function bacaIcc(buf) {
  try {
    if (buf.length < 132 || buf.toString("latin1", 36, 40) !== "acsp") return { sah: false };
    const n = u32(buf, 128);
    const tag = {};
    for (let i = 0; i < n && 132 + i * 12 + 12 <= buf.length; i++) {
      const o = 132 + i * 12;
      tag[buf.toString("latin1", o, o + 4)] = [u32(buf, o + 4), u32(buf, o + 8)];
    }
    let deskripsi = "";
    const d = tag.desc;
    if (d && d[0] + 12 <= buf.length) {
      const t = buf.toString("latin1", d[0], d[0] + 4);
      if (t === "desc") deskripsi = buf.toString("latin1", d[0] + 12, d[0] + 12 + Math.min(Math.max(0, u32(buf, d[0] + 8) - 1), 200));
      else if (t === "mluc" && u32(buf, d[0] + 8) > 0) {
        const len = u32(buf, d[0] + 20), off = u32(buf, d[0] + 24);
        deskripsi = Buffer.from(buf.subarray(d[0] + off, d[0] + off + Math.min(len, 400))).swap16().toString("utf16le");
      }
    }
    let primerSrgb = null;
    if (tag.rXYZ && tag.gXYZ && tag.bXYZ) {
      const xyz = (k) => [0, 4, 8].map((x) => buf.readInt32BE(tag[k][0] + 8 + x) / 65536);
      const p = { r: xyz("rXYZ"), g: xyz("gXYZ"), b: xyz("bXYZ") };
      primerSrgb = ["r", "g", "b"].every((k) => p[k].every((v, i) => Math.abs(v - SRGB_D50[k][i]) < 0.006));
    }
    return { sah: true, ruang: buf.toString("latin1", 16, 20).trim(), deskripsi, primerSrgb };
  } catch {
    return { sah: false };
  }
}

/** Orientasi EXIF (1..8) dari blok TIFF (awalan "Exif\0\0" opsional). */
function orientasiTiff(blok) {
  try {
    const t = blok.toString("latin1", 0, 4) === "Exif" ? blok.subarray(6) : blok;
    const le = t.toString("latin1", 0, 2) === "II";
    if (!le && t.toString("latin1", 0, 2) !== "MM") return 1;
    const r16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)), r32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const o = r32(4), n = r16(o);
    for (let i = 0; i < Math.min(n, 64); i++) {
      const e = o + 2 + i * 12;
      if (r16(e) === 0x0112) return r16(e + 8);
    }
  } catch { /* EXIF rusak dianggap tanpa orientasi */ }
  return 1;
}

const iccAtauNull = (b) => { try { return bacaIcc(inflateSync(b, { maxOutputLength: 4_000_000 })); } catch { return { sah: false }; } };

function bacaPng(b) {
  const r = { format: "png", alpha: false, animasi: false, icc: null, srgbChunk: false, gama: null, kedalamanBit: 0, orientasi: 1 };
  let o = 8;
  while (o + 8 <= b.length) {
    const len = u32(b, o), tipe = b.toString("latin1", o + 4, o + 8);
    const d = b.subarray(o + 8, Math.min(o + 8 + len, b.length));
    if (tipe === "IHDR" && d.length >= 13) { r.lebar = u32(d, 0); r.tinggi = u32(d, 4); r.kedalamanBit = d[8]; r.alpha = d[9] === 4 || d[9] === 6; r.tipeWarna = d[9]; }
    else if (tipe === "tRNS") r.alpha = true;
    else if (tipe === "acTL") r.animasi = true;
    else if (tipe === "sRGB") r.srgbChunk = true;
    else if (tipe === "gAMA" && d.length >= 4) r.gama = u32(d, 0) / 100000;
    else if (tipe === "eXIf") r.orientasi = orientasiTiff(d);
    else if (tipe === "iCCP") { const z = d.indexOf(0); r.icc = z >= 0 ? iccAtauNull(d.subarray(z + 2)) : { sah: false }; }
    else if (tipe === "IDAT") break;
    o += 12 + len;
  }
  return r;
}

function bacaJpeg(b) {
  const r = { format: "jpeg", alpha: false, animasi: false, icc: null, orientasi: 1, komponen: 0 };
  const iccBagian = [];
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    const len = b.readUInt16BE(o + 2), d = b.subarray(o + 4, o + 2 + len);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m) && d.length >= 6) { r.tinggi = d.readUInt16BE(1); r.lebar = d.readUInt16BE(3); r.komponen = d[5]; }
    else if (m === 0xe1 && d.toString("latin1", 0, 4) === "Exif") r.orientasi = orientasiTiff(d);
    else if (m === 0xe2 && d.toString("latin1", 0, 11) === "ICC_PROFILE") iccBagian.push([d[12], d.subarray(14)]);
    else if (m === 0xda) break;
    o += 2 + len;
  }
  if (iccBagian.length) r.icc = bacaIcc(Buffer.concat(iccBagian.sort((a, c) => a[0] - c[0]).map((x) => x[1])));
  return r;
}

function bacaWebp(b) {
  const r = { format: "webp", alpha: false, animasi: false, icc: null, orientasi: 1 };
  let o = 12;
  while (o + 8 <= b.length) {
    const t = b.toString("latin1", o, o + 4), len = b.readUInt32LE(o + 4);
    const d = b.subarray(o + 8, Math.min(o + 8 + len, b.length));
    if (t === "VP8X" && d.length >= 10) { r.animasi = !!(d[0] & 2); r.alpha = !!(d[0] & 16); r.lebar = 1 + d.readUIntLE(4, 3); r.tinggi = 1 + d.readUIntLE(7, 3); }
    else if (t === "ICCP") r.icc = bacaIcc(d);
    else if (t === "EXIF") r.orientasi = orientasiTiff(d);
    else if (t === "ANIM" || t === "ANMF") r.animasi = true;
    else if (t === "VP8 " && r.lebar === undefined && d.length >= 10) { r.lebar = d.readUInt16LE(6) & 0x3fff; r.tinggi = d.readUInt16LE(8) & 0x3fff; }
    else if (t === "VP8L" && r.lebar === undefined && d.length >= 5) { const v = d.readUInt32LE(1); r.lebar = (v & 0x3fff) + 1; r.tinggi = ((v >> 14) & 0x3fff) + 1; r.alpha = !!((v >> 28) & 1); }
    o += 8 + len + (len & 1);
  }
  return r;
}

/** Membaca header gambar. format: png | jpeg | webp | gif | tak-dikenal | rusak. */
export function bacaGambar(buf) {
  try {
    if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return bacaPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return bacaJpeg(buf);
    if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return bacaWebp(buf);
    if (buf.toString("latin1", 0, 3) === "GIF") return { format: "gif", animasi: true, lebar: buf.readUInt16LE(6), tinggi: buf.readUInt16LE(8), icc: null, orientasi: 1 };
    return { format: "tak-dikenal" };
  } catch {
    return { format: "rusak" };
  }
}

/** Ya bila gambar perlu dikonversi ke sRGB tanpa profil dan/atau orientasi dinormalkan. */
export function perluKonversiSrgb(info) {
  const alasan = [];
  if (info.icc?.sah && info.icc.ruang === "RGB" && info.icc.primerSrgb === false) alasan.push(`profil ICC "${info.icc.deskripsi || "tanpa nama"}" bukan sRGB`);
  if (info.icc?.sah && info.icc.ruang === "GRAY") alasan.push("profil ICC abu-abu");
  if (info.icc && !info.icc.sah) alasan.push("profil ICC tertanam tak dapat diurai");
  if (info.orientasi && info.orientasi !== 1) alasan.push(`orientasi EXIF ${info.orientasi}`);
  return alasan;
}

/**
 * Resolusi: rasio = piksel sumber / piksel yang diperlukan = 1 / (faktor skala fit x skala render x zoom).
 * `contain` memakai faktor terkecil (gambar muat di kotak); `cover` dan `fill` faktor terbesar
 * (sumbu terburuk). rasio < 1 berarti di-upscale (buram).
 */
export function hitungResolusi({ lebar, tinggi }, tampil, skala = 1) {
  const zoom = tampil.zoomMaks ?? 1, fit = tampil.fit ?? "contain";
  const sx = tampil.lebar / lebar, sy = tampil.tinggi / tinggi;
  const f = fit === "contain" ? Math.min(sx, sy) : Math.max(sx, sy);
  const rasio = 1 / (f * skala * zoom);
  return { rasio, perlu: [Math.ceil(lebar / rasio), Math.ceil(tinggi / rasio)], zoom, skala, fit };
}

// ---------------------------------------------------------------- ffprobe
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}

/** ffprobe aliran pertama jenis `aliran` ("v:0" atau "a:0"); null bila gagal. */
export async function ffprobeAliran(berkas, aliran) {
  let r;
  try {
    r = await jalankan(["ffprobe", "-v", "error", "-select_streams", aliran, "-show_entries", "stream=width,height,codec_name,sample_rate,channels:format=duration", "-of", "json", berkas]);
  } catch (e) {
    throw new Error(`ffprobe tidak tersedia: ${e.message}`);
  }
  if (r.kode !== 0) return null;
  try {
    const j = JSON.parse(r.out);
    const s = j.streams?.[0];
    return s ? { ...s, durasi: Number(j.format?.duration) } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- font
function formatFont(buf) {
  const m = buf.toString("latin1", 0, 4);
  if (m === "wOF2") return "woff2";
  if (m === "wOFF") return "woff";
  if (m === "OTTO") return "otf";
  if (m === "\u0000\u0001\u0000\u0000" || m === "true") return "ttf";
  return null;
}
const FORMAT_CSS = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };

// ---------------------------------------------------------------- validasi manifest
const BIDANG_UMUM = new Set([
  "id", "jenis", "berkas", "sha256", "judul", "tanpaJudul", "pencipta", "penciptaAnonim", "sumberUrl", "lisensi",
  "urlLisensi", "tanggalAkses", "perubahan", "bukti", "atribusiTampil", "teksAlternatif", "hakCipta", "berkasLisensi",
  "izin", "ai", "catatan", "peran",
]);
const BIDANG_JENIS = {
  gambar: ["orang", "tampil", "fokus"], logo: ["merek", "tampil", "fokus"], svg: ["tampil"],
  ikon: ["ikon", "tampil"], font: ["font"], audio: ["audio"],
};
const KATEGORI_MEREK = ["milik-sendiri", "merek-pihak-lain", "instansi-pemerintah", "lambang-negara"];
const STATUS_AI = ["tidak", "dibantu", "dihasilkan"];

function kumpulkanPlaceholder(nilai, jejak, hasil) {
  if (typeof nilai === "string" && /^\[isi/.test(nilai.trim())) hasil.push(jejak);
  else if (Array.isArray(nilai)) nilai.forEach((v, i) => kumpulkanPlaceholder(v, `${jejak}[${i}]`, hasil));
  else if (adaObjek(nilai)) for (const [k, v] of Object.entries(nilai)) kumpulkanPlaceholder(v, `${jejak}.${k}`, hasil);
}

/**
 * Validasi manifest aset (skema 1) tanpa Chromium. Semua pelanggaran dikumpulkan sekaligus.
 * @param {object} manifest
 * @param {string} dirManifest folder yang memuat aset.json (dan aset/)
 * @param {{ skala?: number }} opsi
 * @returns {Promise<{ galat: string[], peringatan: string[], aset: object }>}
 *   `aset` = id -> info hasil pemeriksaan (jenis, jalur, ukuran, hash, ...), dipakai pembangun keluaran.
 */
export async function validasiAset(manifest, dirManifest, { skala = 1 } = {}) {
  const galat = [], peringatan = [], hasil = {};
  if (!adaObjek(manifest)) return { galat: ["manifest harus objek JSON"], peringatan, aset: hasil };
  if (manifest.skema !== VERSI_SKEMA_ASET) galat.push(`skema harus ${VERSI_SKEMA_ASET} (dapat ${JSON.stringify(manifest.skema)})`);
  for (const k of Object.keys(manifest)) if (!["skema", "proyek", "aset"].includes(k)) peringatan.push(`bidang tingkat atas "${k}" tidak dikenal (abaikan atau perbaiki salah ketik)`);

  const proyek = manifest.proyek;
  let komersial = true;
  if (!adaObjek(proyek)) galat.push('proyek: objek { "tujuan": "komersial"|"nonkomersial", "lisensiKeluaran"?, "jenisVideo"? } wajib ada');
  else if (proyek.tujuan !== "komersial" && proyek.tujuan !== "nonkomersial") galat.push(`proyek.tujuan wajib "komersial" atau "nonkomersial" (dapat ${JSON.stringify(proyek.tujuan)})`);
  else komersial = proyek.tujuan === "komersial";
  const lisensiKeluaran = adaObjek(proyek) ? proyek.lisensiKeluaran : undefined;
  const jenisVideo = adaObjek(proyek) ? proyek.jenisVideo : undefined;

  const daftar = Array.isArray(manifest.aset) ? manifest.aset : null;
  if (!daftar || daftar.length === 0) galat.push("aset: array tidak kosong wajib ada");

  const idDipakai = new Set(), lisensiSA = [], keluargaIkon = new Set(), fontDipakai = new Map();
  const logoFormal = [];

  for (const [i, a] of (daftar ?? []).entries()) {
    const nama = adaObjek(a) && adaTeks(a.id) ? `aset "${a.id}"` : `aset[${i}]`;
    const g = (p) => galat.push(`${nama}: ${p}`), w = (p) => peringatan.push(`${nama}: ${p}`);
    if (!adaObjek(a)) { g("harus objek"); continue; }

    const kosong = [];
    kumpulkanPlaceholder(a, "", kosong);
    for (const j of kosong) g(`bidang ${j.replace(/^\./, "")} belum diisi (masih "[isi]")`);

    if (!adaTeks(a.id) || !POLA_ID.test(a.id)) g("id wajib (huruf kecil, angka, - atau _)");
    else if (idDipakai.has(a.id)) g("id ganda");
    else idDipakai.add(a.id);

    if (a.jenis === "lottie") { g("jenis lottie belum didukung (rencana); jenis yang ada: " + JENIS_ASET.join(", ")); continue; }
    if (!JENIS_ASET.includes(a.jenis)) { g(`jenis wajib salah satu dari ${JENIS_ASET.join(", ")} (dapat ${JSON.stringify(a.jenis)})`); continue; }
    const jenis = a.jenis;
    const diizinkan = new Set([...BIDANG_UMUM, ...BIDANG_JENIS[jenis]]);
    for (const k of Object.keys(a)) if (!diizinkan.has(k)) w(`bidang "${k}" tidak dikenal untuk jenis ${jenis} (abaikan atau perbaiki salah ketik)`);

    // ---- lisensi
    const u = adaTeks(a.lisensi) ? uraiLisensiAset(a.lisensi) : null;
    const sendiri = u?.jenis === "sendiri";
    if (!adaTeks(a.lisensi)) g("lisensi kosong ditolak; isi CC0-1.0, PDM-1.0, CC-BY-x.y, CC-BY-SA-x.y, OFL-1.1, MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, STOK:<penyedia>, MILIK-SENDIRI, atau IZIN-TERTULIS:<pemegang>");
    else if (!u) g(`lisensi "${a.lisensi}" tidak dikenal; yang diizinkan: CC0-1.0, PDM-1.0, CC-BY-x.y, CC-BY-SA-x.y (CC-BY-NC-* hanya bila tujuan nonkomersial), OFL-1.1, MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, STOK:<penyedia>, MILIK-SENDIRI, IZIN-TERTULIS:<pemegang>`);
    else if (u.nd) g(`lisensi ${a.lisensi} (ND) ditolak: ND tidak mengizinkan adaptasi, dan aset diskalakan, dipotong, atau digambar ulang oleh renderer`);
    else if (u.nc && komersial) g(`lisensi ${a.lisensi} (NC) ditolak untuk proyek komersial; ubah proyek.tujuan menjadi "nonkomersial" bila memang tidak komersial`);
    else {
      const matriks = MATRIKS_LISENSI[jenis];
      if (!matriks.izin.includes(u.kunci)) {
        if (matriks.ketat) g(`lisensi ${a.lisensi} tidak diizinkan untuk jenis ${jenis} (diizinkan: ${matriks.izin.join(", ")})`);
        else w(`lisensi ${a.lisensi} tidak lazim untuk jenis ${jenis} (lazim: ${matriks.izin.join(", ")}); periksa ulang`);
      }
      if ((u.jenis === "stok" || u.jenis === "izin") && !adaTeks(a.bukti)) g(`lisensi ${a.lisensi} wajib disertai "bukti" (berkas di folder proyek atau URL lisensi tertulis)`);
      if (u.sa) lisensiSA.push({ id: a.id, lisensi: a.lisensi, u });
      if (u.jenis === "stok" && u.penyedia === "youtube-audio-library") w("YouTube Audio Library dinyatakan aman hanya di YouTube; di luar YouTube belum terverifikasi");
      if (wajibNotice(u, jenis)) {
        if (!adaTeks(a.hakCipta)) g(`lisensi ${a.lisensi} wajib "hakCipta" (baris hak cipta pemegang) agar pemberitahuan ikut terdistribusi`);
        if (!adaTeks(a.berkasLisensi)) g(`lisensi ${a.lisensi} wajib "berkasLisensi" (salinan teks lisensi di folder proyek)`);
      }
      if (wajibAtribusi(u) && a.atribusiTampil === "tidak") g(`lisensi ${a.lisensi} mewajibkan atribusi: atribusiTampil harus "layar" atau "akhir"`);
    }
    if (a.atribusiTampil !== undefined && !["tidak", "layar", "akhir"].includes(a.atribusiTampil)) g('atribusiTampil harus "tidak", "layar", atau "akhir"');

    // ---- atribusi TASL dan bukti
    if (!adaTeks(a.judul) && a.tanpaJudul !== true) g('atribusi kosong: "judul" wajib (atau tanpaJudul: true)');
    if (!adaTeks(a.pencipta) && a.penciptaAnonim !== true) g('atribusi kosong: "pencipta" wajib (atau penciptaAnonim: true)');
    if (adaTeks(a.sumberUrl)) { if (!urlHttp(a.sumberUrl)) g(`sumberUrl bukan URL http(s) yang valid: ${a.sumberUrl}`); }
    else if (!sendiri) g('atribusi kosong: "sumberUrl" wajib (kecuali MILIK-SENDIRI)');
    if (a.urlLisensi !== undefined && a.urlLisensi !== "" && !urlHttp(a.urlLisensi)) g(`urlLisensi bukan URL http(s) yang valid: ${a.urlLisensi}`);
    if (adaTeks(a.tanggalAkses)) { if (!tanggalSah(a.tanggalAkses)) g(`tanggalAkses harus YYYY-MM-DD yang sah (dapat "${a.tanggalAkses}")`); }
    else if (!sendiri) g('"tanggalAkses" (YYYY-MM-DD) wajib (kecuali MILIK-SENDIRI)');
    if (!adaTeks(a.perubahan)) g('"perubahan" wajib (pernyataan modifikasi; tulis "tidak ada" bila dipakai apa adanya)');
    if (adaTeks(a.bukti) && !urlHttp(a.bukti)) { const r = jalurDalam(dirManifest, a.bukti); if (r.galat) g(`bukti: ${r.galat}`); }
    if (adaTeks(a.berkasLisensi)) { const r = jalurDalam(dirManifest, a.berkasLisensi); if (r.galat) g(`berkasLisensi: ${r.galat}`); }
    if (a.izin !== undefined && !(adaObjek(a.izin) && adaTeks(a.izin.jenis))) g('izin harus objek dengan "jenis" (mis. "izin-tertulis", "pedoman-publik", "milik-sendiri")');
    const izin = adaObjek(a.izin) ? a.izin : {};

    // ---- alt teks
    if (["gambar", "logo", "svg"].includes(jenis)) {
      if (a.peran !== undefined && !["informatif", "dekoratif"].includes(a.peran)) g('peran harus "informatif" atau "dekoratif"');
      if (a.peran !== "dekoratif" && !adaTeks(a.teksAlternatif)) g('"teksAlternatif" wajib untuk aset informatif (atau peran: "dekoratif")');
    }

    // ---- AI
    const wajibAi = ["gambar", "logo", "svg", "audio"].includes(jenis);
    if (a.ai === undefined) { if (wajibAi) g('ai.status wajib ("tidak", "dibantu", atau "dihasilkan")'); }
    else if (!adaObjek(a.ai) || !STATUS_AI.includes(a.ai.status)) g(`ai.status wajib salah satu dari ${STATUS_AI.join(", ")}`);
    else {
      if (a.ai.status === "dihasilkan") {
        if (!adaTeks(a.ai.alat)) g('ai.alat wajib untuk status "dihasilkan"');
        if (!adaTeks(a.ai.lisensiLayanan) || !urlHttp(a.ai.lisensiLayanan)) g('ai.lisensiLayanan (URL syarat layanan AI yang dibaca) wajib untuk status "dihasilkan"');
        if (!adaTeks(a.ai.tanggal) || !tanggalSah(a.ai.tanggal)) g('ai.tanggal (YYYY-MM-DD, saat syarat layanan dibaca) wajib untuk status "dihasilkan"');
        w("hasil murni AI belum jelas dapat dilindungi hak cipta (UU 28/2014 mendefinisikan pencipta sebagai manusia; belum terverifikasi primer): orang lain mungkin boleh menyalinnya; baca syarat layanan AI");
      }
      if (a.ai.status === "dibantu" && !adaTeks(a.ai.kontribusiManusia)) g('ai.kontribusiManusia wajib untuk status "dibantu"');
    }

    // ---- berkas dan hash
    const info = { id: a.id, jenis, atribusi: null };
    let abs = null, isi = null;
    if (!adaTeks(a.berkas)) g('"berkas" wajib (mis. "aset/logo.svg")');
    else if (!POLA_BERKAS.test(a.berkas)) g(`berkas "${a.berkas}" harus berbentuk aset/<nama> dengan karakter huruf, angka, titik, garis bawah, strip, atau /`);
    else {
      const r = jalurDalam(dirManifest, a.berkas, { awalan: "aset/" });
      if (r.galat) g(r.galat);
      else {
        abs = r.jalur;
        const bytes = statSync(abs).size;
        if (bytes > BATAS_BERKAS_BYTE) { g(`berkas ${(bytes / 1e6).toFixed(1)} MB melebihi batas ${BATAS_BERKAS_BYTE / 1e6} MB`); abs = null; }
        else if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(a.sha256)) { g('"sha256" wajib (64 digit heksadesimal)'); abs = null; }
        else {
          info.sha256 = await sha256Berkas(abs);
          info.bytes = bytes;
          if (info.sha256 !== a.sha256.toLowerCase()) { g(`hash tidak cocok: sha256 ${a.berkas} adalah ${info.sha256}, manifest menulis ${a.sha256.toLowerCase()}`); abs = null; }
        }
      }
    }
    info.jalur = a.berkas;
    if (abs) isi = readFileSync(abs);
    const ekstensi = adaTeks(a.berkas) ? `.${a.berkas.split(".").pop().toLowerCase()}` : "";

    // ---- pemeriksaan per jenis
    if (abs) {
      if (["gambar", "logo", "svg", "ikon"].includes(jenis)) {
        const adalahSvg = EKSTENSI.svg.includes(ekstensi);
        if ((jenis === "svg" || jenis === "ikon") && !adalahSvg) g(`jenis ${jenis} wajib berkas .svg (dapat ${ekstensi || "tanpa ekstensi"})`);
        else if (jenis === "gambar" && adalahSvg) g('berkas .svg dicatat sebagai jenis "svg", "logo", atau "ikon", bukan "gambar"');
        else if (adalahSvg) {
          periksaBerkasSvg(isi, jenis, info, g, w);
          if (a.tampil !== undefined) info.tampil = validasiTampil(a.tampil, g) ?? undefined;
        }
        else if (ekstensi === ".gif") g("GIF ditolak: GIF (beranimasi) dilarang karena gerak harus dari nomor frame; ekstrak frame atau pakai klip.mjs");
        else if (!EKSTENSI.raster.includes(ekstensi)) g(`ekstensi ${ekstensi || "(kosong)"} tidak didukung untuk jenis ${jenis}; pakai ${[...EKSTENSI.raster, ".svg"].join(", ")}`);
        else await periksaBerkasRaster(abs, isi, jenis, a, info, skala, g, w);
      } else if (jenis === "font") {
        periksaBerkasFont(isi, ekstensi, a, info, fontDipakai, g, w);
      } else if (jenis === "audio") {
        await periksaBerkasAudio(abs, ekstensi, a, info, g);
      }
    }

    // ---- logo dan merek
    if (jenis === "logo") periksaMerek(a, u, izin, info, g, w, logoFormal);
    // ---- ikon
    if (jenis === "ikon" && a.ikon !== undefined) {
      if (!adaObjek(a.ikon)) g("ikon harus objek { keluarga, gaya }");
      else {
        if (a.ikon.gaya !== undefined && !["outline", "solid"].includes(a.ikon.gaya)) g('ikon.gaya harus "outline" atau "solid"');
        if (adaTeks(a.ikon.keluarga)) keluargaIkon.add(a.ikon.keluarga);
        info.ikon = a.ikon;
      }
    }
    // ---- orang
    if (jenis === "gambar") periksaOrang(a, izin, dirManifest, g, w);
    // ---- fokus dan tampil
    if (a.fokus !== undefined && !(adaObjek(a.fokus) && [a.fokus.x, a.fokus.y].every((v) => typeof v === "number" && v >= 0 && v <= 1))) g("fokus harus { x, y } dengan nilai 0..1");
    else if (a.fokus) info.fokus = a.fokus;

    info.atribusi = {
      judul: a.judul ?? null, pencipta: a.pencipta ?? null, sumberUrl: a.sumberUrl ?? null, lisensi: a.lisensi ?? null,
      urlLisensi: a.urlLisensi || urlLisensiCc(a.lisensi) || null, perubahan: a.perubahan ?? null,
      tanggalAkses: a.tanggalAkses ?? null, tanpaJudul: a.tanpaJudul === true, penciptaAnonim: a.penciptaAnonim === true,
    };
    info.atribusiTampil = a.atribusiTampil ?? (u && wajibAtribusi(u) ? "akhir" : "tidak");
    info.hakCipta = a.hakCipta ?? null;
    info.berkasLisensi = a.berkasLisensi ?? null;
    info.namaLisensi = namaLisensiAset(a.lisensi);
    info.teksAlternatif = a.teksAlternatif ?? null;
    info.peran = a.peran ?? (["gambar", "logo", "svg"].includes(jenis) ? "informatif" : null);
    info.ai = a.ai ?? { status: "tidak" };
    if (adaTeks(a.id)) hasil[a.id] = info;
  }

  if (keluargaIkon.size > 1) peringatan.push(`ikon berasal dari ${keluargaIkon.size} keluarga (${[...keluargaIkon].join(", ")}): satu keluarga per proyek menjaga gaya konsisten`);

  // ShareAlike: keluaran harus dilisensikan SA kompatibel (konservatif, sama dengan klip.mjs;
  // tafsir ShareAlike untuk video gabungan belum terverifikasi dari sumber primer).
  if (lisensiSA.length) {
    const daftarSA = lisensiSA.map((x) => `"${x.id}" (${x.lisensi})`).join(", ");
    const adaNcSa = lisensiSA.some((x) => x.u.nc), adaBySa = lisensiSA.some((x) => !x.u.nc);
    if (adaNcSa && adaBySa) galat.push(`ShareAlike tidak kompatibel: aset ${daftarSA} mencampur BY-SA dan BY-NC-SA`);
    else {
      const perlu = adaNcSa ? "CC-BY-NC-SA" : "CC-BY-SA";
      const versiMin = Math.max(...lisensiSA.map((x) => x.u.versi[0] * 100 + x.u.versi[1]));
      const m = adaTeks(lisensiKeluaran) ? new RegExp(`^${perlu}-(\\d)\\.(\\d)$`).exec(lisensiKeluaran) : null;
      if (!adaTeks(lisensiKeluaran)) galat.push(`proyek.lisensiKeluaran wajib diisi ${perlu}-x.y (versi >= aset) karena ada aset ShareAlike: ${daftarSA}`);
      else if (!m) galat.push(`proyek.lisensiKeluaran "${lisensiKeluaran}" tidak kompatibel dengan ShareAlike aset ${daftarSA}; pakai ${perlu}-x.y`);
      else if (Number(m[1]) * 100 + Number(m[2]) < versiMin) galat.push(`proyek.lisensiKeluaran "${lisensiKeluaran}" lebih lama daripada versi lisensi aset ShareAlike ${daftarSA}`);
    }
  }

  // Video formal: minimal satu logo bukan merek pihak lain dengan izin terisi.
  if (jenisVideo === "formal" && !logoFormal.some((l) => l.kategori !== "merek-pihak-lain" && l.izinAda)) {
    galat.push('proyek.jenisVideo "formal" wajib memuat minimal satu logo ber-kategori milik-sendiri, instansi-pemerintah, atau lambang-negara dengan izin terisi');
  }
  return { galat, peringatan, aset: hasil };
}

// ---------------------------------------------------------------- pemeriksaan per jenis
function periksaBerkasSvg(isi, jenis, info, g, w) {
  const teks = isi.toString("utf8");
  const r = periksaSvg(teks);
  r.galat.forEach((p) => g(`SVG: ${p}`));
  r.peringatan.forEach((p) => w(`SVG: ${p}`));
  if (r.peringatan.some((p) => /dibuang bersih|ditambahkan/.test(p))) w("SVG: jalankan `bun run aset tambah`/`impor` (atau bersihkanSvg) agar metadata editor dibuang dari berkas tersimpan");
  info.format = "svg";
  info.lebar = r.lebar; info.tinggi = r.tinggi; info.rasio = r.rasio;
  info.vektor = true;
  if (jenis === "logo" && !r.rasio) g("logo SVG wajib viewBox (rasio dikunci dari viewBox)");
}

function validasiTampil(t, g) {
  if (!adaObjek(t) || !bilanganPositif(t.lebar) || !bilanganPositif(t.tinggi)) { g("tampil.lebar dan tampil.tinggi wajib angka > 0"); return null; }
  if (t.fit !== undefined && !["contain", "cover", "fill"].includes(t.fit)) { g('tampil.fit harus "contain", "cover", atau "fill"'); return null; }
  if (t.zoomMaks !== undefined && !(typeof t.zoomMaks === "number" && t.zoomMaks >= 1)) { g("tampil.zoomMaks harus angka >= 1"); return null; }
  if (t.rotasi !== undefined && typeof t.rotasi !== "number") { g("tampil.rotasi harus angka (derajat)"); return null; }
  return t;
}

async function periksaBerkasRaster(abs, isi, jenis, a, info, skala, g, w) {
  const h = bacaGambar(isi);
  info.format = h.format;
  if (h.format === "gif") { g("GIF ditolak: GIF (beranimasi) dilarang karena gerak harus dari nomor frame; ekstrak frame atau pakai klip.mjs"); return; }
  if (!["png", "jpeg", "webp"].includes(h.format)) { g(`bukan gambar PNG, JPEG, atau WebP yang sah (${h.format})`); return; }
  let fp;
  try { fp = await ffprobeAliran(abs, "v:0"); } catch (e) { g(e.message); return; }
  if (!fp) { g("ffprobe tak dapat membaca berkas (rusak atau format tak didukung)"); return; }
  if (h.lebar !== fp.width || h.tinggi !== fp.height) { g(`dimensi header (${h.lebar}x${h.tinggi}) tak sama dengan ffprobe (${fp.width}x${fp.height}); berkas mencurigakan`); return; }
  if (h.animasi) g("gambar beranimasi (APNG/WebP animasi) dilarang: gerak harus dari nomor frame; ekstrak frame atau pakai klip.mjs");
  if (h.komponen === 4) g("JPEG CMYK (4 komponen) tidak didukung: konversi ke RGB sRGB");
  if (h.icc?.sah && h.icc.ruang && !["RGB", "GRAY"].includes(h.icc.ruang)) g(`profil ICC ruang ${h.icc.ruang} tidak didukung (bukan RGB)`);
  const alasan = perluKonversiSrgb(h);
  if (h.orientasi !== 1 && h.orientasi) g(`EXIF orientasi ${h.orientasi}: Chromium memutar tampilan tetapi ffmpeg/ffprobe tidak; normalkan lewat bun run aset tambah --konversi`);
  const alasanIcc = alasan.filter((x) => !/^orientasi/.test(x));
  if (alasanIcc.length) w(`${alasanIcc.join("; ")}: Chromium mengonversi saat render tetapi ffmpeg mengabaikan profil; konversi ke sRGB saat impor (--konversi)`);
  if (!h.icc && h.format === "png" && !h.srgbChunk && h.gama !== null && Math.abs(h.gama - 0.45455) > 0.01) w(`PNG bergamma ${h.gama} (bukan sRGB ~0.4545): tampilan bisa bergeser`);
  if (h.kedalamanBit === 16) w("PNG 16-bit: dikuantisasi ke 8-bit saat render; konversi untuk mengecilkan berkas");
  let { lebar, tinggi } = h;
  if (h.orientasi >= 5) [lebar, tinggi] = [tinggi, lebar];
  info.lebar = lebar; info.tinggi = tinggi; info.rasio = lebar / tinggi; info.alpha = h.alpha;
  if (info.bytes > BATAS_GAMBAR_BERAT) w(`berkas ${(info.bytes / 1e6).toFixed(1)} MB: pertimbangkan optimasi`);

  // tampil
  if (a.tampil === undefined) { g("tampil wajib untuk gambar raster: { lebar, tinggi, fit?, zoomMaks? } (ukuran tampil dalam piksel komposisi)"); return; }
  const t = validasiTampil(a.tampil, g);
  if (!t) return;
  info.tampil = t;
  const r = hitungResolusi({ lebar, tinggi }, t, skala);
  info.rasioResolusi = Number(r.rasio.toFixed(3));
  if (r.rasio < 1 - 1e-9) g(`resolusi kurang: butuh >= ${r.perlu[0]}x${r.perlu[1]} piksel (tampil ${t.lebar}x${t.tinggi} x skala ${skala} x zoom ${r.zoom}, fit ${r.fit}), sumber ${lebar}x${tinggi} (rasio ${r.rasio.toFixed(2)}): akan di-upscale dan buram`);
  else if (r.rasio < 1.25 && r.zoom === 1) w(`resolusi pas-pasan (rasio ${r.rasio.toFixed(2)}): beri margin >= 1.25 untuk pan/zoom`);
  else if (r.rasio > 4) w(`resolusi berlebih (rasio ${r.rasio.toFixed(1)}): perkecil agar berkas dan memori hemat`);
}

function periksaBerkasFont(isi, ekstensi, a, info, fontDipakai, g, w) {
  if (!EKSTENSI.font.includes(ekstensi)) { g(`ekstensi ${ekstensi || "(kosong)"} tidak didukung untuk font; pakai ${EKSTENSI.font.join(", ")}`); return; }
  const fmt = formatFont(isi);
  if (!fmt) g("berkas bukan font WOFF2, WOFF, TrueType, atau OpenType yang sah (tanda awal berkas tak cocok)");
  else if (`.${fmt}` !== ekstensi) g(`ekstensi ${ekstensi} tidak sesuai isi berkas (${fmt})`);
  else info.format = fmt;
  const f = a.font;
  if (!adaObjek(f)) { g("font wajib objek { famili, bobot, gaya, ... }"); return; }
  if (!adaTeks(f.famili) || !/^[\p{L}\p{N} ._-]{1,64}$/u.test(f.famili)) g("font.famili wajib (huruf, angka, spasi, titik, garis bawah, strip; maks 64)");
  if (!(Number.isInteger(f.bobot) && f.bobot >= 1 && f.bobot <= 1000)) g("font.bobot wajib bilangan bulat 1..1000");
  if (!["normal", "italic", "oblique"].includes(f.gaya ?? "normal")) g('font.gaya harus "normal", "italic", atau "oblique"');
  const kunci = `${f.famili}|${f.bobot}|${f.gaya ?? "normal"}`;
  if (fontDipakai.has(kunci)) g(`kombinasi famili/bobot/gaya sama dengan aset "${fontDipakai.get(kunci)}"`);
  else fontDipakai.set(kunci, a.id);
  if (f.dijualTerpisah === true) g("font.dijualTerpisah: true ditolak (OFL melarang menjual Font Software itu sendiri)");
  if (f.reservedFontName !== undefined && !adaTeks(f.reservedFontName)) g("font.reservedFontName harus teks bila ada");
  if (f.dimodifikasi === true) {
    const adaIzin = adaObjek(a.izin) && a.izin.jenis === "izin-tertulis" && adaTeks(a.bukti);
    if (adaTeks(f.reservedFontName) && !adaIzin) g(`font ber-Reserved Font Name "${f.reservedFontName}" dimodifikasi: nama itu tidak boleh dipakai pada versi modifikasi tanpa izin tertulis (izin.jenis "izin-tertulis" dan bukti)`);
    w("subset atau konversi font dapat dihitung modifikasi; belum terverifikasi apakah RFN berlaku pada subset. Pakai berkas upstream apa adanya bila ragu");
  }
  info.font = { famili: f.famili, bobot: f.bobot, gaya: f.gaya ?? "normal", format: info.format ?? null };
}

async function periksaBerkasAudio(abs, ekstensi, a, info, g) {
  if (!EKSTENSI.audio.includes(ekstensi)) { g(`ekstensi ${ekstensi || "(kosong)"} tidak didukung untuk audio; pakai ${EKSTENSI.audio.join(", ")}`); return; }
  if (a.audio !== undefined && !(adaObjek(a.audio) && (a.audio.peran === undefined || ["musik", "narasi", "efek"].includes(a.audio.peran)))) g('audio.peran harus "musik", "narasi", atau "efek"');
  let fp;
  try { fp = await ffprobeAliran(abs, "a:0"); } catch (e) { g(e.message); return; }
  if (!fp) { g("ffprobe tak menemukan trek audio (rusak atau bukan audio)"); return; }
  info.format = fp.codec_name; info.durasi = Number.isFinite(fp.durasi) ? fp.durasi : null; info.audio = a.audio ?? null;
}

function periksaMerek(a, u, izin, info, g, w, logoFormal) {
  const m = a.merek;
  if (!adaObjek(m) || !KATEGORI_MEREK.includes(m.kategori)) { g(`merek.kategori wajib salah satu dari ${KATEGORI_MEREK.join(", ")}`); return; }
  const lain = m.kategori !== "milik-sendiri";
  if (!lain && u && !["MILIK-SENDIRI", "CC0", "PDM"].includes(u.kunci)) g(`logo kategori milik-sendiri wajib berlisensi MILIK-SENDIRI, CC0-1.0, atau PDM-1.0 (dapat ${a.lisensi})`);
  if (lain) {
    if (!adaTeks(m.pemilik)) g("merek.pemilik wajib untuk logo milik pihak lain, instansi, atau lambang negara");
    if (u && u.kunci !== "IZIN-TERTULIS") g(`logo ${m.kategori} wajib berlisensi IZIN-TERTULIS:<pemegang> (dapat ${a.lisensi}); logo pihak lain, instansi, dan lambang negara adalah gerbang izin manusia`);
    if (!["izin-tertulis", "pedoman-publik"].includes(izin.jenis)) g('izin.jenis wajib "izin-tertulis" atau "pedoman-publik" untuk logo pihak lain, instansi, atau lambang negara');
    if (["instansi-pemerintah", "lambang-negara"].includes(m.kategori) && !adaTeks(izin.persetujuanHukum)) g(`izin.persetujuanHukum (id memo/gate tinjauan hukum) wajib untuk logo ${m.kategori}`);
    w("logo/merek pihak lain, instansi, dan lambang negara wajib ditinjau ahli hukum atau tim hukum/humas sebelum rilis (UU 20/2016, UU 24/2009); validator hanya memeriksa kelengkapan catatan");
    if (a.tampil?.rotasi) g("logo pihak lain, instansi, atau lambang negara tidak boleh diputar (tampil.rotasi)");
    if (m.warnaDiubah === true) g("warna logo pihak lain, instansi, atau lambang negara tidak boleh diubah (merek.warnaDiubah)");
    if (a.tampil && (a.tampil.fit ?? "contain") !== "contain") g('logo pihak lain, instansi, atau lambang negara wajib tampil.fit "contain" (tanpa dipotong atau diregangkan)');
  } else if (a.tampil?.fit === "fill") w('tampil.fit "fill" meregangkan logo; pakai "contain"');
  if (m.kategori === "lambang-negara") {
    if (!bilanganPositif(m.rasio)) g("merek.rasio (lebar:tinggi dari berkas resmi) wajib untuk lambang negara");
    else if (info.rasio && Math.abs(m.rasio / info.rasio - 1) > 0.01) g(`rasio berkas (${info.rasio.toFixed(3)}) menyimpang dari merek.rasio ${m.rasio}: lambang negara tidak boleh didistorsi`);
  }
  const aturan = m.aturan;
  if (aturan !== undefined) {
    if (!adaObjek(aturan)) g("merek.aturan harus objek");
    else {
      if (aturan.ukuranMinPx !== undefined && !bilanganPositif(aturan.ukuranMinPx)) g("merek.aturan.ukuranMinPx harus angka > 0");
      if (aturan.clearSpace !== undefined && !(adaObjek(aturan.clearSpace) && bilanganPositif(aturan.clearSpace.nilai) && ["tinggi", "lebar"].includes(aturan.clearSpace.satuan))) g('merek.aturan.clearSpace harus { nilai > 0, satuan: "tinggi"|"lebar" }');
      if (aturan.warnaDiizinkan !== undefined && !(Array.isArray(aturan.warnaDiizinkan) && aturan.warnaDiizinkan.every((c) => /^#[0-9a-fA-F]{6}$/.test(c)))) g("merek.aturan.warnaDiizinkan harus daftar warna #rrggbb");
      if (aturan.larangan !== undefined && !(Array.isArray(aturan.larangan) && aturan.larangan.every(adaTeks))) g("merek.aturan.larangan harus daftar teks");
      if (bilanganPositif(aturan.ukuranMinPx) && a.tampil && bilanganPositif(a.tampil.lebar) && info.rasio) {
        const lebarTampil = (a.tampil.fit ?? "contain") === "contain" && bilanganPositif(a.tampil.tinggi) ? Math.min(a.tampil.lebar, a.tampil.tinggi * info.rasio) : a.tampil.lebar;
        if (lebarTampil < aturan.ukuranMinPx) g(`logo tampil selebar ${lebarTampil.toFixed(0)} px, di bawah ukuran minimum pedoman merek (${aturan.ukuranMinPx} px)`);
      }
    }
  }
  info.merek = m;
  logoFormal.push({ kategori: m.kategori, izinAda: adaTeks(izin.jenis) });
}

function periksaOrang(a, izin, dirManifest, g, w) {
  const o = a.orang;
  if (!adaObjek(o) || typeof o.ada !== "boolean") { g("orang.ada (true/false) wajib untuk gambar: apakah ada orang yang dapat dikenali"); return; }
  if (!o.ada) return;
  w("foto orang yang dapat dikenali: hak potret (UU 28/2014 Pasal 12) dan pelindungan data pribadi (UU 27/2022) perlu ditinjau; tinjauan manusia wajib");
  const mr = o.modelRelease;
  if (mr !== undefined) {
    if (!adaObjek(mr) || !adaTeks(mr.berkas) || typeof mr.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(mr.sha256)) g("orang.modelRelease harus { berkas, sha256 }");
    else {
      const r = jalurDalam(dirManifest, mr.berkas);
      if (r.galat) g(`orang.modelRelease: ${r.galat}`);
    }
  } else if (!adaTeks(izin.jenis)) g("orang.ada: true wajib disertai orang.modelRelease ({ berkas, sha256 }) atau izin.jenis");
  if ((o.anak === true || o.sensitif === true) && !adaTeks(izin.persetujuanHukum)) g("orang.anak atau orang.sensitif (kesehatan dsb.) wajib izin.persetujuanHukum (id memo/gate tinjauan hukum)");
  if (a.ai?.status === "dihasilkan") g("gambar hasil AI tidak boleh memuat orang (wajah nyata): risiko hak potret dan UU 27/2022");
}

// ---------------------------------------------------------------- pemindai komposisi
const NS_UMUM = /^https?:\/\/(?:www\.w3\.org\/(?:2000\/svg|1999\/xhtml|1999\/xlink)|purl\.org\/dc)/;
/**
 * Pemindaian statis lapis kedua: mencari URL jaringan di berkas komposisi (HTML/CSS/JS).
 * Lapis utama tetap pemblokiran saat render. Mengembalikan daftar temuan "berkas:baris: potongan".
 */
export function pindaiJaringan(teks, nama) {
  const temuan = [];
  teks.split("\n").forEach((baris, i) => {
    const kena = [];
    for (const m of baris.matchAll(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi)) if (!NS_UMUM.test(m[0])) kena.push(m[0]);
    for (const m of baris.matchAll(/(?:\b(?:src|href|action|poster)\s*=\s*["']?|url\(\s*["']?|@import\s+["']?)(\/\/[^\s"')]+)/gi)) kena.push(m[1]);
    for (const k of kena) temuan.push(`${nama}:${i + 1}: ${k.slice(0, 80)}`);
  });
  return temuan;
}

// ---------------------------------------------------------------- keluaran
/** `aset-props.json`: id -> info untuk props komposisi. Jalur relatif terhadap folder manifest. */
export function bangunProps(hasil) {
  const aset = {};
  for (const info of Object.values(hasil)) {
    const e = {
      jenis: info.jenis, jalur: info.jalur, sha256: info.sha256, bytes: info.bytes, format: info.format ?? null,
    };
    for (const k of ["lebar", "tinggi", "rasio", "durasi"]) if (info[k] != null) e[k] = info[k];
    if (info.alpha !== undefined) e.alpha = info.alpha;
    if (info.teksAlternatif) e.teksAlternatif = info.teksAlternatif;
    if (info.peran) e.peran = info.peran;
    if (info.fokus) e.fokus = info.fokus;
    if (info.tampil) e.tampil = info.tampil;
    if (info.merek) e.merek = info.merek;
    if (info.font) e.font = info.font;
    if (info.ikon) e.ikon = info.ikon;
    e.atribusi = { ...info.atribusi, tampil: info.atribusiTampil, kredit: kreditAset({ ...info.atribusi }) };
    e.ai = info.ai;
    aset[info.id] = e;
  }
  return { skema: VERSI_SKEMA_ASET, aset };
}

/** `atribusi.txt`: kredit TASL, pemberitahuan hak cipta/lisensi, dan pengungkapan AI. */
export function bangunAtribusi(hasil) {
  const semua = Object.values(hasil);
  const baris = ["# Atribusi aset", "# Dibangkitkan oleh bun run aset; sertakan saat video diterbitkan (deskripsi, kredit akhir, atau berkas pendamping).", ""];
  const kredit = semua.filter((i) => i.atribusiTampil !== "tidak");
  baris.push("Atribusi:");
  if (kredit.length) for (const i of kredit) baris.push(`- [${i.atribusiTampil}] ${kreditAset({ ...i.atribusi })}`);
  else baris.push("- (tidak ada aset yang wajib atau dipilih untuk atribusi)");
  const notice = semua.filter((i) => i.hakCipta);
  if (notice.length) {
    baris.push("", "Pemberitahuan hak cipta dan lisensi (salinan teks lisensi ikut terdistribusi bersama berkas):");
    for (const i of notice) baris.push(`- ${i.id}: ${i.hakCipta} (${i.namaLisensi}); teks lisensi: ${i.berkasLisensi}`);
  }
  const ai = semua.filter((i) => i.ai?.status && i.ai.status !== "tidak");
  if (ai.length) {
    baris.push("", "Pengungkapan konten AI (platform dapat mewajibkan pengungkapan konten sintetis):");
    for (const i of ai) baris.push(`- ${i.id}: ${i.ai.status === "dihasilkan" ? "dihasilkan AI" : "dibantu AI"}${i.ai.alat ? ` (${i.ai.alat})` : ""}${i.ai.kontribusiManusia ? `; kontribusi manusia: ${i.ai.kontribusiManusia}` : ""}`);
  }
  return `${baris.join("\n")}\n`;
}

/**
 * `font-face.css` dari entri font. Jalur url() relatif terhadap berkas CSS itu sendiri, jadi
 * muat dengan <link rel="stylesheet"> (bukan disalin ke <style> di halaman lain).
 */
export function bangunFontFace(hasil, dirManifest, dirKeluar) {
  const fonts = Object.values(hasil).filter((i) => i.jenis === "font" && i.font?.format);
  const baris = ["/* Dibangkitkan oleh bun run aset. Jalur url() relatif terhadap berkas ini; muat dengan <link rel=\"stylesheet\">. */"];
  if (!fonts.length) baris.push("/* tidak ada aset font */");
  for (const i of fonts) {
    const rel = relative(dirKeluar, resolve(dirManifest, i.jalur)).split(sep).join("/");
    baris.push(
      `@font-face {\n  font-family: "${i.font.famili}";\n  src: url("${rel}") format("${FORMAT_CSS[i.font.format]}");\n  font-weight: ${i.font.bobot};\n  font-style: ${i.font.gaya};\n  font-display: block;\n}`,
    );
  }
  return `${baris.join("\n")}\n`;
}

