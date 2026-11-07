#!/usr/bin/env bun
/**
 * awvd / klip.mjs — video di dalam video: validasi manifest sumber, lalu ekstraksi
 * frame klip per nomor frame komposisi ke cache.
 *
 *   bun scripts/klip.mjs <sumber.json> --fps N [--out .cache/awvd/klip]
 *        [--gabung props.json] [--paksa] [--draf]
 *
 * Alur (semuanya sebelum Chromium diluncurkan; pelanggaran = kode keluar 2):
 *   1. Manifest divalidasi: lisensi yang mengizinkan penggunaan dengan menyebut sumber,
 *      atribusi lengkap, sha256 cocok, lisensiKeluaran untuk ShareAlike.
 *   2. ffprobe: tag matriks warna dan rentang (tak bertag = bt709), sumber HDR ditolak.
 *   3. ffmpeg mengekstrak frame JPEG/PNG pada fps komposisi, satu berkas per nomor
 *      frame, ke cache berkunci (hash berkas + fps + ukuran + rentang + matriks + ...).
 *      Cache hit tidak mengekstrak ulang. Audio klip diekstrak ke audio.wav.
 *   3b. Sumber berlisensi KUTIPAN-WAJAR atau berblok `kutipan` diperiksa kebijakan kutipan
 *      wajar (scripts/kutipan.mjs: batas durasi, proporsi, komentar aktif) dan gerbang hukum
 *      GH; gerbang belum disetujui = kode keluar 2, atau tanda draf dengan --draf.
 *   4. Menulis klip-props.json (daftar klip untuk props komposisi), atribusi.txt
 *      (format TASL), dan bila --gabung: props-gabungan.json.
 *
 * Elemen <video> tidak dipakai: komposisi menggambar frame ke-n klip sebagai fungsi
 * murni dari nomor frame (runtime.js: klipGambar, jalurFrameKlip, kreditKlip).
 * Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import {
  createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { barisRingkasan, dalamCakupan, periksaKutipan } from "./kutipan.mjs";

const VERSI_SKEMA = 1;
const POLA_ID = /^[a-z0-9][a-z0-9_-]*$/;
const JENIS_FORMAT = ["jpg", "png"];
const TRANSFER_HDR = ["smpte2084", "arib-std-b67"];
// ffprobe color_space -> nilai in_color_matrix filter scale
const MATRIKS = {
  bt709: "bt709", bt470bg: "bt470", smpte170m: "smpte170m", smpte240m: "smpte240m", fcc: "fcc",
  bt2020nc: "bt2020", bt2020c: "bt2020",
};
const PIX_RGB = /^(rgb|bgr|gbr|argb|abgr|rgba|bgra|pal8|gray)/;

// ------------------------------------------------------------------- lisensi
/**
 * Mengurai kode lisensi. Diizinkan: CC-BY-x.y, CC-BY-SA-x.y, CC-BY-NC-x.y,
 * CC-BY-NC-SA-x.y, (varian ND dikenali agar bisa ditolak dengan pesan tepat),
 * CC0-1.0, PDM-1.0, STOK:<penyedia>, KUTIPAN-WAJAR (bukan lisensi: klaim pengecualian hak
 * cipta; wajib blok `kutipan` dan gerbang GH, lihat kutipan.mjs). Selain itu null.
 */
export function uraiLisensi(kode) {
  if (typeof kode !== "string") return null;
  let m = /^CC-BY((?:-NC)?(?:-SA)?(?:-ND)?)-(\d)\.(\d)$/.exec(kode);
  if (m) {
    return {
      jenis: "cc", nc: m[1].includes("-NC"), sa: m[1].includes("-SA"), nd: m[1].includes("-ND"),
      versi: [Number(m[2]), Number(m[3])],
    };
  }
  if (kode === "CC0-1.0") return { jenis: "cc0", nc: false, sa: false, nd: false };
  if (kode === "PDM-1.0") return { jenis: "pdm", nc: false, sa: false, nd: false };
  if (kode === "KUTIPAN-WAJAR") return { jenis: "kutipan", nc: false, sa: false, nd: false };
  m = /^STOK:(.+)$/.exec(kode);
  if (m && m[1].trim()) return { jenis: "stok", penyedia: m[1].trim(), nc: false, sa: false, nd: false };
  return null;
}

export function namaLisensi(kode) {
  const u = uraiLisensi(kode);
  if (!u) return String(kode ?? "");
  if (u.jenis === "cc") {
    return `CC BY${u.nc ? "-NC" : ""}${u.sa ? "-SA" : ""}${u.nd ? "-ND" : ""} ${u.versi[0]}.${u.versi[1]}`;
  }
  if (u.jenis === "cc0") return "CC0 1.0";
  if (u.jenis === "pdm") return "Public Domain Mark 1.0";
  if (u.jenis === "kutipan") return "KUTIPAN-WAJAR"; // sama dengan runtime.js (kode apa adanya)
  return `Lisensi stok ${u.penyedia}`;
}

function urlLisensiBawaan(kode, bukti) {
  const u = uraiLisensi(kode);
  if (!u) return "";
  if (u.jenis === "cc") {
    const unsur = ["by", u.nc ? "nc" : "", u.sa ? "sa" : "", u.nd ? "nd" : ""].filter(Boolean).join("-");
    return `https://creativecommons.org/licenses/${unsur}/${u.versi[0]}.${u.versi[1]}/`;
  }
  if (u.jenis === "cc0") return "https://creativecommons.org/publicdomain/zero/1.0/";
  if (u.jenis === "pdm") return "https://creativecommons.org/publicdomain/mark/1.0/";
  if (u.jenis === "kutipan") return "";
  return /^https?:\/\//i.test(bukti ?? "") ? bukti : "";
}

/** Baris atribusi TASL lengkap; harus sama dengan kreditKlip(klip, { ringkas: false }) di runtime.js. */
export function kreditLengkap(a) {
  let t = "";
  if (!a.tanpaJudul && a.judul) t = `"${a.judul}"`;
  if (!a.penciptaAnonim && a.pencipta) t += (t ? " oleh " : "") + a.pencipta;
  const perubahan = String(a.perubahan ?? "").replace(/[.\s]+$/, "");
  const b = [];
  if (t) b.push(t);
  b.push(`Sumber: ${a.sumberUrl}`);
  b.push(`Lisensi: ${namaLisensi(a.lisensi)}${a.urlLisensi ? ` (${a.urlLisensi})` : ""}`);
  if (perubahan) b.push(`Diubah: ${perubahan}`);
  return `${b.join(". ")}.`;
}

// ---------------------------------------------------------------- validasi
const adaTeks = (v) => typeof v === "string" && v.trim() !== "";
const bulatPositif = (v) => Number.isInteger(v) && v > 0;
function urlHttp(v) {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
const mutlak = (dir, p) => (isAbsolute(p) ? p : resolve(dir, p));

export function sha256Berkas(berkas) {
  return new Promise((selesai, gagalKe) => {
    const h = createHash("sha256");
    createReadStream(berkas).on("data", (d) => h.update(d)).on("end", () => selesai(h.digest("hex"))).on("error", gagalKe);
  });
}

/**
 * Validasi manifest tanpa ffprobe/ffmpeg. Mengembalikan { galat[], peringatan[], hash }
 * dengan hash = { idSumber: sha256 nyata }. Semua pelanggaran dikumpulkan sekaligus.
 */
export async function validasiManifest(manifest, dirManifest) {
  const galat = [], peringatan = [], hash = {};
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { galat: ["manifest harus objek JSON"], peringatan, hash };
  }
  const proyek = manifest.proyek;
  let komersial = true;
  if (proyek === null || typeof proyek !== "object" || Array.isArray(proyek)) {
    galat.push('proyek: objek { "tujuan": "komersial"|"nonkomersial", "lisensiKeluaran"? } wajib ada');
  } else if (proyek.tujuan !== "komersial" && proyek.tujuan !== "nonkomersial") {
    galat.push(`proyek.tujuan wajib "komersial" atau "nonkomersial" (dapat ${JSON.stringify(proyek.tujuan)})`);
  } else {
    komersial = proyek.tujuan === "komersial";
  }
  const lisensiKeluaran = proyek && typeof proyek === "object" ? proyek.lisensiKeluaran : undefined;

  const sumber = Array.isArray(manifest.sumber) ? manifest.sumber : null;
  if (!sumber || sumber.length === 0) galat.push("sumber: array tidak kosong wajib ada");
  const idSumber = new Set();
  const lisensiSA = []; // { id, lisensi, u }
  for (const [i, s] of (sumber ?? []).entries()) {
    const nama = s && typeof s === "object" && adaTeks(s.id) ? `sumber "${s.id}"` : `sumber[${i}]`;
    const g = (pesan) => galat.push(`${nama}: ${pesan}`);
    if (s === null || typeof s !== "object" || Array.isArray(s)) { g("harus objek"); continue; }
    if (!adaTeks(s.id) || !POLA_ID.test(s.id)) g("id wajib (huruf kecil, angka, - atau _)");
    else if (idSumber.has(s.id)) g("id ganda");
    else idSumber.add(s.id);

    // lisensi
    if (!adaTeks(s.lisensi)) {
      g("lisensi kosong ditolak; isi CC-BY-x.y, CC-BY-SA-x.y, CC0-1.0, PDM-1.0, atau STOK:<penyedia>");
    } else {
      const u = uraiLisensi(s.lisensi);
      if (!u) {
        g(`lisensi "${s.lisensi}" tidak dikenal; yang diizinkan: CC-BY-x.y, CC-BY-SA-x.y, CC0-1.0, PDM-1.0, STOK:<penyedia>, KUTIPAN-WAJAR (blok kutipan + gerbang GH) (CC-BY-NC-* hanya bila tujuan nonkomersial)`);
      } else if (u.nd) {
        g(`lisensi ${s.lisensi} (ND) ditolak: ND tidak mengizinkan adaptasi, dan frame klip dibuat ulang (di-resample, dipotong, ditimpa elemen komposisi)`);
      } else if (u.nc && komersial) {
        g(`lisensi ${s.lisensi} (NC) ditolak untuk proyek komersial; ubah proyek.tujuan menjadi "nonkomersial" bila memang tidak komersial`);
      } else {
        if (u.jenis === "stok" && !adaTeks(s.bukti)) {
          g(`lisensi ${s.lisensi} wajib disertai "bukti" (berkas atau URL lisensi tertulis dari penyedia)`);
        }
        if (u.sa) lisensiSA.push({ id: s.id, lisensi: s.lisensi, u });
      }
    }

    // atribusi
    if (!adaTeks(s.judul) && s.tanpaJudul !== true) g('atribusi kosong: "judul" wajib (atau tanpaJudul: true bila memang tidak ada)');
    if (!adaTeks(s.pencipta) && s.penciptaAnonim !== true) g('atribusi kosong: "pencipta" wajib (atau penciptaAnonim: true bila pencipta anonim)');
    if (!adaTeks(s.sumberUrl)) g('atribusi kosong: "sumberUrl" wajib');
    else if (!urlHttp(s.sumberUrl)) g(`sumberUrl bukan URL http(s) yang valid: ${s.sumberUrl}`);
    if (!adaTeks(s.perubahan)) g('"perubahan" wajib (pernyataan modifikasi; mis. "dipotong 00:12-00:20; diperkecil; dibuat ulang per frame")');
    if (adaTeks(s.bukti) && !/^https?:\/\//i.test(s.bukti) && !existsSync(mutlak(dirManifest, s.bukti))) {
      g(`bukti tidak ditemukan: ${s.bukti}`);
    }

    // berkas + hash
    if (!adaTeks(s.berkas)) {
      g('"berkas" wajib');
    } else {
      const p = mutlak(dirManifest, s.berkas);
      if (!existsSync(p) || !statSync(p).isFile()) g(`berkas tidak ditemukan: ${s.berkas}`);
      else if (typeof s.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(s.sha256)) g('"sha256" wajib (64 digit heksadesimal)');
      else {
        const nyata = await sha256Berkas(p);
        hash[s.id] = nyata;
        if (nyata !== s.sha256.toLowerCase()) g(`hash tidak cocok: sha256 ${s.berkas} adalah ${nyata}, manifest menulis ${s.sha256.toLowerCase()}`);
      }
    }
  }

  // ShareAlike: keluaran harus dilisensikan SA kompatibel (konservatif: klip yang
  // di-resample, dipotong, dan ditimpa elemen komposisi diperlakukan sebagai Adapted Material).
  if (lisensiSA.length) {
    const daftar = lisensiSA.map((x) => `"${x.id}" (${x.lisensi})`).join(", ");
    const adaNcSa = lisensiSA.some((x) => x.u.nc);
    const adaBySa = lisensiSA.some((x) => !x.u.nc);
    if (adaNcSa && adaBySa) {
      galat.push(`ShareAlike tidak kompatibel: sumber ${daftar} mencampur BY-SA dan BY-NC-SA, tidak ada satu lisensi keluaran yang memenuhi keduanya`);
    } else {
      const perlu = adaNcSa ? "CC-BY-NC-SA" : "CC-BY-SA";
      const versiMin = lisensiSA.reduce((a, x) => (x.u.versi[0] * 100 + x.u.versi[1] > a ? x.u.versi[0] * 100 + x.u.versi[1] : a), 0);
      const m = adaTeks(lisensiKeluaran) ? new RegExp(`^${perlu}-(\\d)\\.(\\d)$`).exec(lisensiKeluaran) : null;
      if (!adaTeks(lisensiKeluaran)) {
        galat.push(`proyek.lisensiKeluaran wajib diisi ${perlu}-x.y (versi >= sumber) karena ada sumber ShareAlike: ${daftar}`);
      } else if (!m) {
        galat.push(`proyek.lisensiKeluaran "${lisensiKeluaran}" tidak kompatibel dengan ShareAlike sumber ${daftar}; pakai ${perlu}-x.y`);
      } else if (Number(m[1]) * 100 + Number(m[2]) < versiMin) {
        galat.push(`proyek.lisensiKeluaran "${lisensiKeluaran}" lebih lama daripada versi lisensi sumber ShareAlike ${daftar}`);
      }
    }
  }

  // klip
  const klip = Array.isArray(manifest.klip) ? manifest.klip : null;
  if (!klip || klip.length === 0) galat.push("klip: array tidak kosong wajib ada (id, sumber, lebar, tinggi, dari, panjang)");
  const idKlip = new Set(), dipakai = new Set();
  for (const [i, k] of (klip ?? []).entries()) {
    const nama = k && typeof k === "object" && adaTeks(k.id) ? `klip "${k.id}"` : `klip[${i}]`;
    const g = (pesan) => galat.push(`${nama}: ${pesan}`);
    if (k === null || typeof k !== "object" || Array.isArray(k)) { g("harus objek"); continue; }
    if (!adaTeks(k.id) || !POLA_ID.test(k.id)) g("id wajib (huruf kecil, angka, - atau _)");
    else if (idKlip.has(k.id)) g("id ganda");
    else idKlip.add(k.id);
    if (!adaTeks(k.sumber) || !idSumber.has(k.sumber)) g(`sumber "${k.sumber}" tidak ada di daftar sumber`);
    else dipakai.add(k.sumber);
    if (!bulatPositif(k.lebar) || !bulatPositif(k.tinggi)) g("lebar dan tinggi wajib bilangan bulat positif (ukuran tampil x skala render)");
    if (k.dari !== undefined && !(typeof k.dari === "number" && k.dari >= 0)) g("dari (detik) harus angka >= 0");
    if (k.panjang !== undefined && !(typeof k.panjang === "number" && k.panjang > 0)) g("panjang (detik) harus angka > 0");
    if (k.format !== undefined && !JENIS_FORMAT.includes(k.format)) g(`format harus salah satu dari ${JENIS_FORMAT.join(", ")}`);
    if (k.kualitas !== undefined && !(Number.isInteger(k.kualitas) && k.kualitas >= 1 && k.kualitas <= 31)) g("kualitas (q:v JPEG, 1 terbaik) harus bilangan bulat 1..31");
  }
  for (const id of idSumber) if (!dipakai.has(id) && klip && klip.length) peringatan.push(`sumber "${id}" tidak dipakai klip mana pun`);
  return { galat, peringatan, hash };
}

// --------------------------------------------------------------- ffprobe/ffmpeg
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}

async function versiFfmpeg() {
  const r = await jalankan(["ffmpeg", "-version"]);
  const m = /ffmpeg version (\S+)/.exec(r.out);
  return m ? m[1] : "tidak-diketahui";
}

/** ffprobe sumber: dimensi tampil, tag warna, durasi, ada audio. */
export async function probeSumber(berkas) {
  const r = await jalankan(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", berkas]);
  if (r.kode !== 0) throw new Error(`ffprobe gagal untuk ${berkas}: ${r.err.trim()}`);
  const j = JSON.parse(r.out);
  const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) return { galat: "tidak ada trek video" };
  const rot = Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0);
  const putar = Math.abs(rot) % 180 === 90;
  const sar = /^(\d+):(\d+)$/.exec(v.sample_aspect_ratio ?? "");
  const sarNilai = sar && Number(sar[1]) > 0 && Number(sar[2]) > 0 ? Number(sar[1]) / Number(sar[2]) : 1;
  let lebar = Number(v.width) * sarNilai, tinggi = Number(v.height);
  if (putar) [lebar, tinggi] = [tinggi, lebar];
  const durasi = Number(v.duration ?? j.format?.duration);
  return {
    lebar, tinggi, sar: sarNilai, durasi: Number.isFinite(durasi) ? durasi : undefined,
    colorSpace: v.color_space, colorRange: v.color_range, colorTransfer: v.color_transfer,
    pixFmt: v.pix_fmt ?? "",
    adaAudio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/** Matriks dan rentang untuk ekstraksi. Tak bertag = bt709 (cara Chromium mendekode video tak bertag). */
function matriksRentang(info) {
  if (PIX_RGB.test(info.pixFmt)) return { matriks: "rgb", rentang: "pc" };
  const cs = info.colorSpace;
  let matriks = "bt709";
  if (cs && cs !== "unknown" && cs !== "unspecified" && cs !== "rgb") {
    matriks = MATRIKS[cs];
    if (!matriks) return { galat: `matriks warna "${cs}" tidak didukung` };
  }
  const cr = info.colorRange;
  const rentang = cr === "pc" || cr === "jpeg" ? "pc" : cr === "tv" || cr === "mpeg" ? "tv" : info.pixFmt.startsWith("yuvj") ? "pc" : "tv";
  return { matriks, rentang };
}

function argsEkstrak({ berkas, dir, fps, k, info, m }) {
  const format = k.format ?? "jpg";
  const rantai = [`fps=${fps}`];
  if (Math.abs(info.sar - 1) > 1e-6) rantai.push("scale=trunc(iw*sar):ih", "setsar=1");
  let skala = `scale=${k.lebar}:${k.tinggi}:flags=bicubic`;
  if (m.matriks !== "rgb") skala += `:in_color_matrix=${m.matriks}:in_range=${m.rentang}:out_range=full`;
  rantai.push(skala, "format=rgb24");
  const a = ["-hide_banner", "-loglevel", "error", "-y"];
  if (k.dari) a.push("-ss", String(k.dari));
  a.push("-i", berkas);
  if (k.panjang) a.push("-t", String(k.panjang));
  a.push("-an", "-sn", "-vf", rantai.join(","), "-fflags", "+bitexact", "-flags", "+bitexact");
  if (format === "jpg") a.push("-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-q:v", String(k.kualitas ?? 2));
  else a.push("-c:v", "png", "-pix_fmt", "rgb24");
  a.push("-start_number", "0", join(dir, `%06d.${format}`));
  return a;
}

function argsAudio({ berkas, tujuan, k }) {
  const a = ["-hide_banner", "-loglevel", "error", "-y"];
  if (k.dari) a.push("-ss", String(k.dari));
  a.push("-i", berkas);
  if (k.panjang) a.push("-t", String(k.panjang));
  a.push("-vn", "-sn", "-map", "0:a:0", "-ar", "48000", "-c:a", "pcm_s16le",
    "-fflags", "+bitexact", "-flags", "+bitexact", "-map_metadata", "-1", tujuan);
  return a;
}

function kunciCache(params) {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
}

function berkasFrame(dir, format) {
  const pola = new RegExp(`^\\d{6}\\.${format}$`);
  return readdirSync(dir).filter((f) => pola.test(f)).sort();
}

function cacheSah(dir, format) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    if (meta.skema !== VERSI_SKEMA || !(meta.jumlah >= 1)) return null;
    if (berkasFrame(dir, format).length !== meta.jumlah) return null;
    if (meta.audio && !existsSync(join(dir, meta.audio))) return null;
    return meta;
  } catch {
    return null;
  }
}

async function hashFrame(dir, daftar) {
  const h = createHash("sha256");
  for (const f of daftar) h.update(`${f}:${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}\n`);
  return h.digest("hex");
}

/** Ekstrak satu klip ke cache (atau cache hit). Mengembalikan { dir, kunci, meta, hit }. */
async function ekstrakKlip({ k, sumber, berkas, sha256, info, m, fps, keluar, paksa, versi }) {
  const format = k.format ?? "jpg";
  const params = {
    skema: VERSI_SKEMA, sha256, fps, lebar: k.lebar, tinggi: k.tinggi, dari: k.dari ?? 0,
    panjang: k.panjang ?? null, matriks: m.matriks, rentang: m.rentang, format,
    kualitas: format === "jpg" ? (k.kualitas ?? 2) : null, ffmpeg: versi,
  };
  const kunci = kunciCache(params);
  const dir = join(keluar, kunci);
  if (!paksa) {
    const meta = cacheSah(dir, format);
    if (meta) return { dir, kunci, meta, hit: true };
  }
  const tmp = join(keluar, `.tmp-${kunci}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const r = await jalankan(["ffmpeg", ...argsEkstrak({ berkas, dir: tmp, fps, k, info, m })]);
  if (r.kode !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`ffmpeg gagal mengekstrak frame klip "${k.id}" (exit ${r.kode}):\n${r.err.trim()}`);
  }
  const daftar = berkasFrame(tmp, format);
  if (daftar.length === 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`klip "${k.id}": tidak ada frame hasil ekstraksi (dari=${k.dari ?? 0}, panjang=${k.panjang ?? "sampai akhir"}); periksa rentang`);
  }
  let audio = null;
  if (info.adaAudio) {
    const ra = await jalankan(["ffmpeg", ...argsAudio({ berkas, tujuan: join(tmp, "audio.wav"), k })]);
    if (ra.kode !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`ffmpeg gagal mengekstrak audio klip "${k.id}" (exit ${ra.kode}):\n${ra.err.trim()}`);
    }
    audio = "audio.wav";
  }
  const meta = {
    skema: VERSI_SKEMA, ...params, sumber, jumlah: daftar.length, ekstensi: format, digit: 6, audio,
    framesSha256: await hashFrame(tmp, daftar),
  };
  writeFileSync(join(tmp, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return { dir, kunci, meta, hit: false };
}

// ------------------------------------------------------------------------ CLI
function gagal(pesan, kode = 1) {
  console.error(`klip.mjs: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun scripts/klip.mjs <sumber.json> --fps N [--out .cache/awvd/klip] [--gabung props.json] [--paksa] [--draf]
Keluaran di --out: klip-props.json, atribusi.txt, <kunci>/ (frame + audio.wav + meta.json),
dan props-gabungan.json bila --gabung. Kode keluar 2 untuk manifest/argumen tidak valid.
--draf: izinkan sumber KUTIPAN-WAJAR yang gerbang hukum GH-nya belum disetujui; props memuat
"draf": true (komposisi wajib menampilkan tanda draf). Pelanggaran angka kutipan tidak bisa dilewati.`;

async function utama() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        fps: { type: "string" },
        out: { type: "string", default: ".cache/awvd/klip" },
        gabung: { type: "string" },
        paksa: { type: "boolean", default: false },
        draf: { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const { values: o, positionals } = args;
  if (o.help) {
    console.log(PETUNJUK);
    return;
  }
  if (positionals.length !== 1) gagal(`harus tepat satu manifest.\n${PETUNJUK}`, 2);
  const fps = Number(o.fps);
  if (o.fps === undefined || !Number.isFinite(fps) || fps <= 0) gagal(`--fps wajib angka positif.\n${PETUNJUK}`, 2);
  const berkasManifest = resolve(positionals[0]);
  if (!existsSync(berkasManifest)) gagal(`manifest tidak ditemukan: ${positionals[0]}`, 2);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(berkasManifest, "utf8"));
  } catch (e) {
    gagal(`manifest bukan JSON valid: ${e.message}`, 2);
  }
  let dasar = null;
  if (o.gabung) {
    try {
      dasar = JSON.parse(readFileSync(o.gabung, "utf8"));
    } catch (e) {
      gagal(`--gabung bukan JSON valid atau tidak terbaca: ${e.message}`, 2);
    }
    if (dasar === null || typeof dasar !== "object" || Array.isArray(dasar)) gagal("--gabung harus objek JSON", 2);
    if ("klip" in dasar) gagal('props dasar (--gabung) tidak boleh memuat kunci "klip"; kunci itu diisi dari manifest', 2);
  }
  const dirManifest = dirname(berkasManifest);

  // 1. validasi manifest (lisensi, atribusi, hash)
  const v = await validasiManifest(manifest, dirManifest);
  for (const p of v.peringatan) console.error(`peringatan: ${p}`);
  if (v.galat.length) {
    console.error(`klip.mjs: manifest ditolak (${v.galat.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
    for (const g of v.galat) console.error(`  - ${g}`);
    process.exit(2);
  }

  // 2. ffprobe: HDR, matriks warna, rentang
  const sumberPerId = new Map(manifest.sumber.map((s) => [s.id, s]));
  const infoSumber = new Map();
  const galatMedia = [];
  for (const k of manifest.klip) {
    if (infoSumber.has(k.sumber)) continue;
    const s = sumberPerId.get(k.sumber);
    const berkas = mutlak(dirManifest, s.berkas);
    let info;
    try {
      info = await probeSumber(berkas);
    } catch (e) {
      galatMedia.push(`sumber "${s.id}": ${e.message}`);
      continue;
    }
    if (info.galat) { galatMedia.push(`sumber "${s.id}": ${info.galat}`); continue; }
    if (TRANSFER_HDR.includes(info.colorTransfer)) {
      galatMedia.push(`sumber "${s.id}": sumber HDR (${info.colorTransfer}) tidak didukung; tonemap ke SDR BT.709 lebih dulu`);
      continue;
    }
    const m = matriksRentang(info);
    if (m.galat) { galatMedia.push(`sumber "${s.id}": ${m.galat}`); continue; }
    infoSumber.set(k.sumber, { info, m });
  }
  for (const k of manifest.klip) {
    const x = infoSumber.get(k.sumber);
    if (!x) continue;
    if (x.info.durasi !== undefined && (k.dari ?? 0) >= x.info.durasi) {
      galatMedia.push(`klip "${k.id}": dari=${k.dari} melewati durasi sumber (${x.info.durasi.toFixed(2)} s)`);
    }
    const asal = x.info.lebar / x.info.tinggi, tujuan = k.lebar / k.tinggi;
    if (Math.abs(asal / tujuan - 1) > 0.01) {
      console.error(`peringatan: klip "${k.id}": rasio ${k.lebar}x${k.tinggi} berbeda dari sumber (${x.info.lebar.toFixed(0)}x${x.info.tinggi.toFixed(0)}); gambar akan melar`);
    }
  }
  if (galatMedia.length) {
    console.error(`klip.mjs: sumber ditolak (${galatMedia.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
    for (const g of galatMedia) console.error(`  - ${g}`);
    process.exit(2);
  }

  // 2b. kebijakan kutipan wajar + gerbang hukum GH (butuh durasi sumber dari ffprobe)
  const durasiSumber = {};
  for (const [id, x] of infoSumber) if (x.info.durasi !== undefined) durasiSumber[id] = x.info.durasi;
  const kutipan = periksaKutipan(manifest, dirManifest, durasiSumber);
  for (const p of kutipan.peringatan) console.error(`peringatan: ${p}`);
  if (kutipan.galat.length) {
    console.error(`klip.mjs: kebijakan kutipan wajar dilanggar (${kutipan.galat.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
    for (const g of kutipan.galat) console.error(`  - ${g}`);
    process.exit(2);
  }
  if (kutipan.ringkasan) console.log(barisRingkasan(kutipan));
  let draf = false;
  if (kutipan.gerbang.perlu && !kutipan.gerbang.disetujui) {
    if (!o.draf) {
      console.error(`klip.mjs: render final ditolak: ${kutipan.gerbang.pesan}`);
      console.error("  Dapatkan persetujuan peninjau hukum (memo ber-hash, lihat docs/pelajari-reaction.md), atau jalankan dengan --draf untuk hasil bertanda draf (bukan untuk publikasi).");
      process.exit(2);
    }
    draf = true;
    console.error(`peringatan: DRAF: ${kutipan.gerbang.pesan}; props memuat "draf": true dan hasil tidak boleh dipublikasikan`);
  } else if (kutipan.gerbang.perlu) {
    console.log(kutipan.gerbang.pesan);
  }

  // 3. ekstraksi ke cache
  const keluar = resolve(o.out);
  try {
    mkdirSync(keluar, { recursive: true });
  } catch (e) {
    gagal(`tidak bisa membuat folder keluaran ${o.out}: ${e.message}`, 2);
  }
  const versi = await versiFfmpeg();
  const akar = pathToFileURL(keluar).href.replace(/\/+$/, "");
  const props = [];
  for (const k of manifest.klip) {
    const s = sumberPerId.get(k.sumber);
    const { info, m } = infoSumber.get(k.sumber);
    let hasil;
    try {
      hasil = await ekstrakKlip({
        k, sumber: s.id, berkas: mutlak(dirManifest, s.berkas), sha256: v.hash[s.id], info, m, fps, keluar, paksa: o.paksa, versi,
      });
    } catch (e) {
      gagal(e.message);
    }
    const { meta, kunci, hit } = hasil;
    console.log(`klip "${k.id}": ${hit ? "cache hit" : "ekstraksi"} ${meta.jumlah} frame ${k.lebar}x${k.tinggi} @ ${fps} fps (matriks ${m.matriks}, rentang ${m.rentang}) -> ${kunci}`);
    props.push({
      id: k.id, sumber: s.id, akar, folder: kunci, ekstensi: meta.ekstensi, digit: meta.digit,
      jumlah: meta.jumlah, fps, lebar: k.lebar, tinggi: k.tinggi,
      audio: meta.audio ? `${kunci}/${meta.audio}` : null,
      atribusi: {
        judul: s.judul ?? "", tanpaJudul: s.tanpaJudul === true,
        pencipta: s.pencipta ?? "", penciptaAnonim: s.penciptaAnonim === true,
        sumberUrl: s.sumberUrl, lisensi: s.lisensi,
        urlLisensi: s.urlLisensi || urlLisensiBawaan(s.lisensi, s.bukti),
        perubahan: s.perubahan,
      },
      ...(dalamCakupan(s) ? { kutipan: { isiAudio: s.kutipan?.isiAudio ?? "musik", musikDibahas: s.kutipan?.musikDibahas === true } } : {}),
    });
  }

  // 4. keluaran: klip-props.json, atribusi.txt, props-gabungan.json
  writeFileSync(join(keluar, "klip-props.json"), `${JSON.stringify({ klip: props, ...(draf ? { draf: true } : {}) }, null, 2)}\n`);
  const urut = [];
  for (const p of props) if (!urut.some((x) => x.sumber === p.sumber)) urut.push({ sumber: p.sumber, atribusi: p.atribusi, klip: [] });
  for (const p of props) urut.find((x) => x.sumber === p.sumber).klip.push(p.id);
  const baris = ["ATRIBUSI KLIP TERTANAM (format TASL: Title, Author, Source, License)", ""];
  if (draf) baris.unshift("DRAF: gerbang hukum GH belum disetujui; bukan untuk publikasi.", "");
  urut.forEach((x, i) => {
    baris.push(`${i + 1}. ${kreditLengkap(x.atribusi)}`, `   Dipakai di klip: ${x.klip.join(", ")}`);
  });
  const keluaranSA = manifest.proyek.lisensiKeluaran;
  if (adaTeks(keluaranSA)) baris.push("", `Lisensi keluaran video: ${namaLisensi(keluaranSA)}`);
  if (props.some((x) => x.atribusi.lisensi === "KUTIPAN-WAJAR")) {
    baris.push("", "KUTIPAN-WAJAR bukan lisensi: klip dikutip sebagai kritik, ulasan, atau pendidikan dengan menyebut sumber; hak cipta tetap pada pencipta.");
  }
  writeFileSync(join(keluar, "atribusi.txt"), `${baris.join("\n")}\n`);
  if (dasar) writeFileSync(join(keluar, "props-gabungan.json"), `${JSON.stringify({ ...dasar, klip: props, ...(draf ? { draf: true } : {}) }, null, 2)}\n`);
  console.log(`selesai: ${props.length} klip -> ${join(keluar, "klip-props.json")}${dasar ? `, ${join(keluar, "props-gabungan.json")}` : ""}`);
}

if (import.meta.main) await utama();
