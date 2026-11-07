#!/usr/bin/env bun
/**
 * awvd / timeline.mjs — validator `timeline.json` (skema 1), fail-closed, sebelum Chromium.
 *
 *   bun scripts/timeline.mjs periksa [timeline.json] [--klip-props F] [--ketat] [--json] [--draf]
 *
 * Dua lapis, tanpa dependensi:
 *   1. Skema: `data/skema-timeline.json` (JSON Schema 2020-12) dibaca LANGSUNG oleh pembaca
 *      skema ringkas di sini (subset kata kunci yang dipakai skema itu), jadi skema dan
 *      validator tidak bisa menyimpang. Bidang tak dikenal dan versi skema asing ditolak.
 *   2. Aturan lintas-bidang (R01-R17 galat, W01-W09 peringatan): rujukan ke manifest NYATA
 *      (`aset.json` lewat validasiAset, `sumber.json` lewat validasiManifest, ffprobe untuk
 *      durasi dan audio), tumpang tindih dan transisi, pemetaan waktu klip (permil), audio,
 *      atribusi, logo, kilatan, dan kebijakan kutipan yang dihitung dari durasi tampil.
 *
 * Waktu = frame bilangan bulat pada fps bulat; rentang setengah terbuka [mulai, mulai + durasi).
 * Kode keluar: 0 lolos; 2 timeline atau argumen tidak valid (galat skema, aturan, manifest,
 * berkas tak ditemukan, JSON rusak); 1 galat tak terduga. Galat dikumpulkan sekaligus dengan
 * lokasi berupa JSON pointer (RFC 6901) ke bidang bermasalah.
 *
 * Belum ada di versi ini (issue lain): keyframe properti (#35), render (#32), rencana audio (#34),
 * `--gabung`. Pemetaan waktu klip (R08) memakai helper runtime.js (`petaWaktuKlip`, `frameSumber`,
 * #33) sebagai sumber tunggal; uji kesetaraannya ada di `scripts/uji-timeline.mjs` (m).
 * Karya asli repo ini (rumus waktu dari riset #30).
 */
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeSumber, uraiLisensi, validasiManifest } from "./klip.mjs";
import { jalurDalam, validasiAset } from "./aset-lib.js";
import {
  barisRingkasan, dalamCakupan, gabungInterval, hashGerbang, periksaKutipan, statusGerbang,
} from "./kutipan.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const lokasiSkema = join(akar, "data", "skema-timeline.json");
const muat = createRequire(import.meta.url);
const RT = muat("./runtime.js");
const TR = muat("./transisi.js");

export const VERSI_SKEMA_TIMELINE = 1;
export const BATAS_BERKAS_BYTE = 5_000_000;
export const BATAS_GALAT_TAMPIL = 200;
const POLA_ID = "^[a-z0-9][a-z0-9_-]*$";
const EPS = 1e-6;
const PERAN_UKURAN = { judul: "judul", subjudul: "subjudul", isi: "isi", caption: "caption", keterangan: "keterangan", anotasi: "isi", kredit: "keterangan" };
const JENIS_ASET_GAMBAR = ["gambar", "logo", "ikon", "svg"];

const adaObjek = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);

// =====================================================================================
// Lapis 1: pembaca skema JSON Schema (subset yang dipakai data/skema-timeline.json)
// =====================================================================================

const ptr = (p, k) => `${p}/${String(k).replaceAll("~", "~0").replaceAll("/", "~1")}`;

function cocokTipe(v, t) {
  switch (t) {
    case "null": return v === null;
    case "array": return Array.isArray(v);
    case "object": return adaObjek(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    default: return false;
  }
}
const namaTipe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const tampilNilai = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};
const samaJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const petunjukPola = {
  [POLA_ID]: "id harus huruf kecil, angka, - atau _ (diawali huruf atau angka)",
  "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$": "warna harus berbentuk #rgb atau #rrggbb",
};
const polaCache = new Map();
const regex = (p) => {
  let r = polaCache.get(p);
  if (!r) polaCache.set(p, (r = new RegExp(p)));
  return r;
};

function deref(skemaAkar, ref) {
  if (!ref.startsWith("#/")) throw new Error(`skema: $ref tidak didukung: ${ref}`);
  let n = skemaAkar;
  for (const s of ref.slice(2).split("/")) n = n?.[s.replaceAll("~1", "/").replaceAll("~0", "~")];
  if (n === undefined) throw new Error(`skema: $ref tidak ditemukan: ${ref}`);
  return n;
}

/** Cabang oneOf yang masuk akal untuk nilai ini (dipakai untuk memilih pesan galat yang tepat). */
function kompatibel(skemaAkar, s, v) {
  if (s.$ref) s = deref(skemaAkar, s.$ref);
  if (s.type !== undefined) return (Array.isArray(s.type) ? s.type : [s.type]).some((t) => cocokTipe(v, t));
  if (s.enum) return s.enum.some((e) => typeof e === typeof v);
  return true;
}

/**
 * Memeriksa `v` terhadap skema `s`; menambahkan galat ke `g` ({ lok, pesan }).
 * Mengembalikan himpunan nama properti yang sudah "dievaluasi" (untuk unevaluatedProperties).
 */
function cek(v, s, p, g, skemaAkar) {
  const ev = new Set();
  const tambah = (set) => { for (const k of set) ev.add(k); };
  if (s === true) return ev;
  if (s === false) { g.push({ lok: p, pesan: "tidak diizinkan di sini" }); return ev; }
  if (s.$ref) tambah(cek(v, deref(skemaAkar, s.$ref), p, g, skemaAkar));

  if (s.type !== undefined) {
    const tipe = Array.isArray(s.type) ? s.type : [s.type];
    if (!tipe.some((t) => cocokTipe(v, t))) {
      g.push({ lok: p, pesan: `harus bertipe ${tipe.join(" atau ")} (dapat ${typeof v === "number" ? tampilNilai(v) : namaTipe(v)})` });
      return ev;
    }
  }
  if ("const" in s && !samaJson(v, s.const)) g.push({ lok: p, pesan: `harus ${tampilNilai(s.const)} (dapat ${tampilNilai(v)})` });
  if (s.enum && !s.enum.some((e) => samaJson(e, v))) {
    g.push({ lok: p, pesan: `harus salah satu dari ${s.enum.join(", ")} (dapat ${tampilNilai(v)})` });
  }

  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) g.push({ lok: p, pesan: `harus >= ${s.minimum} (dapat ${v})` });
    if (s.maximum !== undefined && v > s.maximum) g.push({ lok: p, pesan: `harus <= ${s.maximum} (dapat ${v})` });
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) g.push({ lok: p, pesan: `harus > ${s.exclusiveMinimum} (dapat ${v})` });
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) g.push({ lok: p, pesan: `harus < ${s.exclusiveMaximum} (dapat ${v})` });
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) g.push({ lok: p, pesan: `terlalu pendek: minimal ${s.minLength} karakter` });
    if (s.maxLength !== undefined && v.length > s.maxLength) g.push({ lok: p, pesan: `terlalu panjang: maksimal ${s.maxLength} karakter (dapat ${v.length})` });
    if (s.pattern !== undefined && !regex(s.pattern).test(v)) {
      g.push({ lok: p, pesan: `${petunjukPola[s.pattern] ?? `tidak sesuai pola ${s.pattern}`} (dapat ${tampilNilai(v)})` });
    }
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) g.push({ lok: p, pesan: `minimal ${s.minItems} anggota (dapat ${v.length})` });
    if (s.maxItems !== undefined && v.length > s.maxItems) g.push({ lok: p, pesan: `maksimal ${s.maxItems} anggota (dapat ${v.length})` });
    const awalan = s.prefixItems ?? [];
    v.forEach((x, i) => {
      if (i < awalan.length) cek(x, awalan[i], ptr(p, i), g, skemaAkar);
      else if (s.items !== undefined) cek(x, s.items, ptr(p, i), g, skemaAkar);
    });
  }
  if (adaObjek(v)) {
    for (const r of s.required ?? []) if (!Object.hasOwn(v, r)) g.push({ lok: p, pesan: `bidang wajib "${r}" tidak ada` });
    const props = s.properties ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (!Object.hasOwn(v, k)) continue;
      ev.add(k);
      cek(v[k], sub, ptr(p, k), g, skemaAkar);
    }
    if (s.additionalProperties !== undefined) {
      for (const k of Object.keys(v)) {
        if (Object.hasOwn(props, k)) continue;
        ev.add(k);
        if (s.additionalProperties === false) g.push({ lok: ptr(p, k), pesan: `bidang "${k}" tidak dikenal (fail-closed; periksa salah ketik)` });
        else cek(v[k], s.additionalProperties, ptr(p, k), g, skemaAkar);
      }
    }
  }

  for (const sub of s.allOf ?? []) tambah(cek(v, sub, p, g, skemaAkar));
  if (s.if !== undefined) {
    const uji = [];
    cek(v, s.if, p, uji, skemaAkar);
    if (uji.length === 0) { if (s.then !== undefined) tambah(cek(v, s.then, p, g, skemaAkar)); }
    else if (s.else !== undefined) tambah(cek(v, s.else, p, g, skemaAkar));
  }
  if (s.not !== undefined) {
    const uji = [];
    cek(v, s.not, p, uji, skemaAkar);
    if (uji.length === 0) {
      const r = s.not.required;
      if (adaObjek(v) && Array.isArray(r) && r.length === 1) g.push({ lok: ptr(p, r[0]), pesan: `bidang "${r[0]}" tidak diizinkan di sini (mis. transisi hanya untuk track video)` });
      else g.push({ lok: p, pesan: "cocok dengan bentuk yang dilarang skema" });
    }
  }
  if (s.oneOf) {
    const hasil = s.oneOf.map((sub) => { const e = []; const evs = cek(v, sub, p, e, skemaAkar); return { e, evs, sub }; });
    const lolos = hasil.filter((h) => h.e.length === 0);
    if (lolos.length === 1) tambah(lolos[0].evs);
    else if (lolos.length > 1) g.push({ lok: p, pesan: "cocok dengan lebih dari satu bentuk yang diizinkan" });
    else {
      const kandidat = hasil.filter((h) => kompatibel(skemaAkar, h.sub, v));
      if (kandidat.length === 1) g.push(...kandidat[0].e);
      else g.push({ lok: p, pesan: `tidak cocok dengan bentuk yang diizinkan (dapat ${tampilNilai(v)})` });
    }
  }
  if (adaObjek(v) && s.unevaluatedProperties === false) {
    for (const k of Object.keys(v)) {
      if (!ev.has(k)) g.push({ lok: ptr(p, k), pesan: `bidang "${k}" tidak dikenal untuk jenis ini (fail-closed; periksa salah ketik)` });
      ev.add(k);
    }
  }
  return ev;
}

let skemaTersimpan = null;
/** Muat skema dari data/skema-timeline.json (sekali). */
export function muatSkema() {
  skemaTersimpan ??= JSON.parse(readFileSync(lokasiSkema, "utf8"));
  return skemaTersimpan;
}

/**
 * Validasi bentuk terhadap skema 1. Versi skema asing berhenti di sini (fail-closed).
 * @returns {{ lok: string, pesan: string }[]} galat berlokasi (kosong bila sah)
 */
export function validasiSkema(t, skema = muatSkema()) {
  if (!adaObjek(t)) return [{ lok: "", pesan: "timeline harus objek JSON" }];
  if (Object.hasOwn(t, "skema") && t.skema !== VERSI_SKEMA_TIMELINE) {
    return [{ lok: "/skema", pesan: `versi skema ${tampilNilai(t.skema)} tidak dikenal; validator ini hanya menerima skema ${VERSI_SKEMA_TIMELINE}` }];
  }
  const g = [];
  cek(t, skema, "", g, skema);
  const lihat = new Set();
  return g.filter((x) => { const k = `${x.lok}\u0000${x.pesan}`; if (lihat.has(k)) return false; lihat.add(k); return true; });
}

// =====================================================================================
// Pemetaan waktu klip. Sumber tunggal: runtime.js (petaWaktuKlip, frameSumber, kecepatanPermil;
// docs/api-runtime.md §Pemetaan waktu klip, KP-052). Bidang `waktu` di skema dan objek `waktu`
// runtime bermakna sama, jadi validator tidak punya rumus sendiri.
// =====================================================================================

/**
 * Offset frame sumber (0 = titik masuk `dari`) untuk tiap frame lokal 0..durasi-1; membungkus
 * `RT.petaWaktuKlip`. Melempar Error untuk masukan yang tak sah (bekukan + balik, kecepatan di
 * luar (0, 1000] atau lebih dari 3 desimal, ramp dengan kecepatan <= 0 di suatu frame).
 */
export function petaWaktu({ durasi, kecepatan = 1, balik = false, bekukan = false }) {
  return RT.petaWaktuKlip({ kecepatan, balik, bekukan }, durasi);
}

/**
 * Offset terbesar yang dibaca butir. Offset maju tidak pernah turun dan reverse hanya membalik
 * deretnya, jadi maksimum = offset frame terakhir deret maju. Konstan: satu perhitungan
 * (`RT.frameSumber`); ramp: tabel `RT.petaWaktuKlip` (tanpa Math.max(...tabel), tabel bisa jutaan
 * anggota), supaya kecepatan <= 0 di frame mana pun tetap ditolak seperti di runtime.
 */
export function offsetMaks(durasi, w) {
  if (w.bekukan) return 0;
  const maju = { kecepatan: w.kecepatan ?? 1 };
  if (!Array.isArray(maju.kecepatan)) return RT.frameSumber(maju, durasi - 1, { durasi });
  const tabel = RT.petaWaktuKlip(maju, durasi);
  return tabel[tabel.length - 1];
}

// =====================================================================================
// Lapis 2: aturan lintas-bidang
// =====================================================================================

/** Konteks kosong (timeline tanpa manifest). Diisi `muatKonteks`. */
function konteksKosong() {
  return {
    ring: { klip: Object.create(null), aset: Object.create(null) }, // tanpa prototipe: id "constructor" tidak boleh lolos
    sumber: null, // { manifest, dir, berkas, durasi: {id: detik} }
    aset: null, // { manifest, dir, berkas }
    galat: [], peringatan: [], // galat/peringatan tingkat manifest (sudah berkode)
  };
}

/**
 * Memuat manifest nyata yang dirujuk timeline: aset.json (validasiAset), sumber.json
 * (validasiManifest + ffprobe untuk durasi dan audio), klip-props opsional.
 */
export async function muatKonteks(t, dir, { klipProps } = {}) {
  const k = konteksKosong();
  const G = (kode, lok, pesan) => k.galat.push({ kode, lok, pesan });
  const W = (kode, lok, pesan) => k.peringatan.push({ kode, lok, pesan });
  const fps = t.proyek.fps;
  const m = t.manifes ?? {};

  const bacaJson = (rel, lok) => {
    const r = jalurDalam(dir, rel);
    if (r.galat) { G("R02", lok, `manifest: ${r.galat}`); return null; }
    try { return { berkas: r.jalur, isi: JSON.parse(readFileSync(r.jalur, "utf8")) }; } catch (e) {
      G("R02", lok, `${rel} bukan JSON valid: ${e.message}`);
      return null;
    }
  };

  if (m.aset !== undefined) {
    const b = bacaJson(m.aset, "/manifes/aset");
    if (b) {
      k.aset = { manifest: b.isi, dir: dirname(b.berkas), berkas: m.aset };
      const hasil = await validasiAset(b.isi, k.aset.dir);
      for (const x of hasil.galat) G("R02", m.aset, x);
      for (const x of hasil.peringatan) W("W09", m.aset, x);
      for (const [id, i] of Object.entries(hasil.aset)) {
        k.ring.aset[id] = {
          id, jenis: i.jenis, peran: i.audio?.peran ?? null,
          durasiFrame: Number.isFinite(i.durasi) ? Math.ceil(i.durasi * fps - EPS) : null,
          rasio: i.rasio ?? null, merek: i.merek ?? null, atribusiTampil: i.atribusiTampil ?? "tidak",
        };
      }
    }
  }

  if (m.sumber !== undefined) {
    const b = bacaJson(m.sumber, "/manifes/sumber");
    if (b) {
      k.sumber = { manifest: b.isi, dir: dirname(b.berkas), berkas: m.sumber, durasi: Object.create(null) };
      const hasil = await validasiManifest(b.isi, k.sumber.dir);
      for (const x of hasil.galat) G("R02", m.sumber, x);
      for (const x of hasil.peringatan) W("W09", m.sumber, x);
      const sumberPerId = new Map((Array.isArray(b.isi.sumber) ? b.isi.sumber : []).filter(adaObjek).map((s) => [s.id, s]));
      k.sumber.perId = sumberPerId;
      const probe = new Map();
      const props = new Map((klipProps?.klip ?? []).filter(adaObjek).map((x) => [x.id, x]));
      for (const kl of (Array.isArray(b.isi.klip) ? b.isi.klip : []).filter(adaObjek)) {
        const s = sumberPerId.get(kl.sumber);
        if (!s || typeof kl.id !== "string") continue;
        const rusak = hasil.galat.some((x) => x.startsWith(`sumber "${s.id}":`));
        if (!probe.has(s.id)) {
          let info = null;
          if (!rusak && typeof s.berkas === "string" && hasil.hash[s.id]) {
            try { info = await probeSumber(join(k.sumber.dir, s.berkas)); } catch (e) { G("R02", m.sumber, `sumber "${s.id}": ${e.message}`); }
            if (info?.galat) { G("R02", m.sumber, `sumber "${s.id}": ${info.galat}`); info = null; }
          }
          probe.set(s.id, info);
          if (info?.durasi) k.sumber.durasi[s.id] = info.durasi;
        }
        const info = probe.get(s.id);
        const p = props.get(kl.id);
        if (p && p.fps !== undefined && p.fps !== fps) G("R02", "klip-props", `klip "${kl.id}" diekstrak pada ${p.fps} fps, timeline ${fps} fps; jalankan ulang klip.mjs --fps ${fps}`);
        let jumlah = null, perkiraan = false;
        if (p && Number.isInteger(p.jumlah) && p.jumlah >= 1) jumlah = p.jumlah;
        else if (typeof kl.panjang === "number" && kl.panjang > 0) { jumlah = Math.floor(kl.panjang * fps + EPS); perkiraan = true; }
        else if (info?.durasi) { jumlah = Math.floor((info.durasi - (kl.dari ?? 0)) * fps + EPS); perkiraan = true; }
        k.ring.klip[kl.id] = {
          id: kl.id, sumber: s.id, jumlah, jumlahPerkiraan: perkiraan && !(typeof kl.panjang === "number" && kl.panjang > 0),
          audio: p ? !!p.audio : info ? info.adaAudio === true : null, dari: kl.dari ?? 0, panjang: kl.panjang ?? null,
          mulaiVideoManual: kl.mulaiVideo,
        };
      }
    }
  }

  if (m.konsep !== undefined) {
    const r = jalurDalam(dir, m.konsep);
    if (r.galat) G("R02", "/manifes/konsep", `manifest: ${r.galat}`);
    else W("W09", m.konsep, "manifes.konsep terbaca tetapi belum dipakai validator ini");
  }

  const jvAset = k.aset?.manifest?.proyek?.jenisVideo;
  if (jvAset !== undefined && t.proyek.jenisVideo !== undefined && jvAset !== t.proyek.jenisVideo) {
    G("R02", "/proyek/jenisVideo", `jenisVideo "${t.proyek.jenisVideo}" berbeda dari ${m.aset} ("${jvAset}"); keduanya harus sama atau salah satunya dihapus`);
  }
  return k;
}

/**
 * Pasangan [a, b] dengan rentang [mulai, akhir) yang saling tumpang tindih, a dari A dan b dari B
 * (A === B: tiap pasangan sekali, tanpa pasangan dengan diri sendiri). Sapuan O((n + m) log) agar
 * ribuan butir audio tidak membuat pemeriksaan kuadratis; dibatasi `maks` pasangan.
 */
function pasanganTumpang(A, B, maks = 50) {
  const sama = A === B;
  const urutA = A.map((x, i) => ({ x, i })).sort((p, q) => p.x.mulai - q.x.mulai || p.i - q.i);
  const urutB = (sama ? urutA : B.map((x, i) => ({ x, i })).sort((p, q) => p.x.mulai - q.x.mulai || p.i - q.i));
  const hasil = [];
  let aktifB = [], ptr = 0;
  for (const { x: a, i } of urutA) {
    while (ptr < urutB.length && urutB[ptr].x.mulai < a.akhir) aktifB.push(urutB[ptr++]);
    aktifB = aktifB.filter((e) => e.x.akhir > a.mulai);
    for (const e of aktifB) {
      if (sama && e.i <= i) continue;
      if (e.x.mulai < a.akhir && e.x.akhir > a.mulai) { hasil.push([a, e.x]); if (hasil.length >= maks) return hasil; }
    }
  }
  return hasil;
}

/** Semua string di timeline yang masih berupa placeholder "[isi...]". */
function cariPlaceholder(n, p, hasil) {
  if (typeof n === "string") { if (/^\s*\[isi/.test(n)) hasil.push(p); }
  else if (Array.isArray(n)) n.forEach((x, i) => cariPlaceholder(x, ptr(p, i), hasil));
  else if (adaObjek(n)) for (const [k, v] of Object.entries(n)) cariPlaceholder(v, ptr(p, k), hasil);
}

function nilaiMin(spec) {
  return Array.isArray(spec) ? Math.min(...spec.map((x) => x.nilai)) : spec;
}

/**
 * Aturan lintas-bidang untuk timeline yang sudah lolos skema.
 * @param {object} t timeline
 * @param {object} konteks hasil muatKonteks (atau konteksKosong)
 * @param {{ ketat?: boolean, draf?: boolean }} opsi
 * @returns {{ galat: object[], peringatan: object[], turunan: object, ringkasan: object }}
 */
export function periksaAturan(t, konteks, { draf = false } = {}) {
  const galat = [...konteks.galat], peringatan = [...konteks.peringatan];
  const G = (kode, lok, pesan) => galat.push({ kode, lok, pesan });
  const W = (kode, lok, pesan) => peringatan.push({ kode, lok, pesan });
  const { fps, durasi: total, lebar, tinggi, profil, jenisVideo } = t.proyek;
  const { ring } = konteks;
  const adaSumber = konteks.sumber !== null, adaAset = konteks.aset !== null;
  const turunan = {};

  // daftar datar: semua butir (struktur diperiksa untuk semua; track aktif:false tetap divalidasi)
  const semua = [];
  t.track.forEach((tr, i) => tr.butir.forEach((b, j) => semua.push({ tr, b, i, j, lok: `/track/${i}/butir/${j}`, akhir: b.mulai + b.durasi, aktif: tr.aktif !== false })));
  const aktif = semua.filter((x) => x.aktif);

  // ------------------------------------------------------------------ R01 id unik
  const idTrack = new Set(), idButir = new Set();
  t.track.forEach((tr, i) => {
    if (idTrack.has(tr.id)) G("R01", `/track/${i}/id`, `id track ganda "${tr.id}"`);
    idTrack.add(tr.id);
  });
  for (const x of semua) {
    if (idButir.has(x.b.id)) G("R01", `${x.lok}/id`, `id butir ganda "${x.b.id}" (harus unik di seluruh timeline)`);
    idButir.add(x.b.id);
  }
  const idPenanda = new Set();
  (t.penanda ?? []).forEach((pn, i) => {
    if (idPenanda.has(pn.id)) G("R01", `/penanda/${i}/id`, `id penanda ganda "${pn.id}"`);
    idPenanda.add(pn.id);
    if (pn.pada >= total) G("R03", `/penanda/${i}/pada`, `penanda di frame ${pn.pada} melewati proyek.durasi (${total})`);
  });

  // -------------------------------------------- R02 rujukan, R03 batas, R07 R15 R16 properti
  const phNilai = [];
  cariPlaceholder(t, "", phNilai);
  for (const p of phNilai) G("R02", p, 'placeholder "[isi]" harus diganti');

  const rusakKf = new Set();
  for (const x of semua) {
    const { b, lok } = x;
    if (b.klip !== undefined) {
      if (!adaSumber) G("R02", `${lok}/klip`, `butir merujuk klip "${b.klip}" tetapi manifes.sumber tidak diisi atau tidak terbaca`);
      else if (!ring.klip[b.klip]) G("R02", `${lok}/klip`, `klip "${b.klip}" tidak tercatat di ${konteks.sumber.berkas} (klip[].id)`);
    }
    if (b.aset !== undefined) {
      const a = ring.aset[b.aset];
      if (!adaAset) G("R02", `${lok}/aset`, `butir merujuk aset "${b.aset}" tetapi manifes.aset tidak diisi atau tidak terbaca`);
      else if (!a) G("R02", `${lok}/aset`, `aset "${b.aset}" tidak tercatat di ${konteks.aset.berkas} (aset[].id)`);
      else if (b.jenis === "gambar" && !JENIS_ASET_GAMBAR.includes(a.jenis)) G("R02", `${lok}/aset`, `aset "${b.aset}" berjenis ${a.jenis}; butir gambar butuh ${JENIS_ASET_GAMBAR.join("/")}`);
      else if (b.jenis === "audio") {
        if (a.jenis !== "audio") G("R02", `${lok}/aset`, `aset "${b.aset}" berjenis ${a.jenis}; butir audio butuh audio`);
        else if (!["musik", "narasi", "efek"].includes(a.peran)) G("R02", `${lok}/aset`, `aset "${b.aset}" tidak punya audio.peran ("musik", "narasi", atau "efek") di ${konteks.aset.berkas}; timeline mengambil peran dari aset`);
      }
    }
    if (b.jenis === "teks" && b.gaya?.font !== undefined) {
      const a = ring.aset[b.gaya.font];
      if (!adaAset) G("R02", `${lok}/gaya/font`, `font "${b.gaya.font}" dirujuk tetapi manifes.aset tidak diisi atau tidak terbaca`);
      else if (!a) G("R02", `${lok}/gaya/font`, `font "${b.gaya.font}" tidak tercatat di ${konteks.aset.berkas}`);
      else if (a.jenis !== "font") G("R02", `${lok}/gaya/font`, `aset "${b.gaya.font}" berjenis ${a.jenis}, bukan font`);
    }
    if (x.akhir > total) G("R03", lok, `rentang ${b.mulai}..${x.akhir} melewati proyek.durasi (${total})`);

    const periksaKf = (kfs, nama) => {
      if (!Array.isArray(kfs)) return;
      kfs.forEach((kf, n) => {
        if (kf.pada >= b.durasi) { G("R07", `${lok}/${nama}/${n}/pada`, `pada ${kf.pada} >= durasi butir (${b.durasi}); pada adalah frame lokal butir`); rusakKf.add(b.id); }
        if (n > 0 && kf.pada <= kfs[n - 1].pada) { G("R07", `${lok}/${nama}/${n}/pada`, "pada harus naik tegas"); rusakKf.add(b.id); }
        if (n === kfs.length - 1 && kf.easing !== undefined) G("R07", `${lok}/${nama}/${n}/easing`, "keyframe terakhir tidak punya segmen berikutnya; hapus easing");
      });
    };
    for (const [pr, v] of Object.entries(b.properti ?? {})) periksaKf(v, `properti/${pr}`);
    periksaKf(b.waktu?.kecepatan, "waktu/kecepatan");
    if (b.kenBurns && b.properti && ["x", "y", "skala"].some((n) => n in b.properti)) G("R16", `${lok}/kenBurns`, "kenBurns tidak boleh bersama properti x/y/skala (pilih satu)");
    if (b.animasi) {
      const m = b.animasi.masuk?.durasi ?? 0, k = b.animasi.keluar?.durasi ?? 0;
      if (m + k > b.durasi) G("R15", `${lok}/animasi`, `animasi masuk (${m}) + keluar (${k}) melebihi durasi butir (${b.durasi})`);
      (b.animasi.penekanan ?? []).forEach((pk, n) => { if (pk.mulai + pk.durasi > b.durasi) G("R15", `${lok}/animasi/penekanan/${n}`, `penekanan ${pk.mulai}..${pk.mulai + pk.durasi} melewati durasi butir (${b.durasi})`); });
    }
  }

  // ------------------------------------------------------ R04 R05 tumpang tindih dan transisi
  const jendela = []; // { mulai, akhir, lok, jenis, durasi, ti }
  const sesudah = new Map(); // id butir -> butir berikutnya di track (terurut), untuk aturan audio
  t.track.forEach((tr, i) => {
    const urut = tr.butir.map((b, j) => ({ b, j })).sort((p, q) => p.b.mulai - q.b.mulai || p.j - q.j);
    let berjalan = [];
    const jTrack = [];
    urut.forEach(({ b, j }, n) => {
      berjalan = berjalan.filter((y) => y.b.mulai + y.b.durasi > b.mulai);
      const lok = `/track/${i}/butir/${j}`;
      const prev = n > 0 ? urut[n - 1] : null;
      if (prev) sesudah.set(prev.b.id, b);
      const lawan = berjalan.length ? berjalan.reduce((a, y) => (y.b.mulai + y.b.durasi > a.b.mulai + a.b.durasi ? y : a)) : null;
      const tumpang = lawan ? lawan.b.mulai + lawan.b.durasi - b.mulai : 0;
      if (berjalan.length >= 2) G("R04", lok, `tiga butir tumpang tindih di track "${tr.id}" (juga "${berjalan.map((y) => y.b.id).join('", "')}"); satu titik waktu maksimal dua butir`);
      if (b.transisi) {
        if (!prev) G("R05", `${lok}/transisi`, "tidak ada butir sebelumnya untuk ditransisikan (transisi ada di butir masuk)");
        else if (tumpang !== b.transisi.durasi) {
          G("R05", `${lok}/transisi/durasi`, `transisi.durasi (${b.transisi.durasi}) harus sama dengan tumpang tindih dengan "${(lawan ?? prev).b.id}" (${tumpang} frame; mulai ${b.mulai}, akhir butir sebelumnya ${(lawan ?? prev).b.mulai + (lawan ?? prev).b.durasi})`);
        } else if (tumpang > Math.min(b.durasi, lawan.b.durasi)) {
          G("R05", `${lok}/transisi/durasi`, `tumpang tindih ${tumpang} melebihi durasi salah satu butir (${lawan.b.id}: ${lawan.b.durasi}, ${b.id}: ${b.durasi})`);
        } else {
          const opsiT = { ...b.transisi, mulai: b.mulai, durasi: tumpang, fps, lebar, tinggi, profil, jenisVideo };
          let tuju = tumpang;
          try {
            tuju = TR.durasiTransisi({ jenis: b.transisi.jenis, durasi: tumpang, fps, profil, jenisVideo });
            if (tuju !== tumpang) G("R05", `${lok}/transisi/durasi`, `durasi ${tumpang} frame di bawah minimum jenis "${b.transisi.jenis}" (${tuju} frame pada ${fps} fps); perlebar tumpang tindih dan samakan transisi.durasi`);
            const uji = TR.transisi(b.mulai, opsiT);
            for (const pg of uji.peringatan) W("W07", `${lok}/transisi`, pg);
          } catch (e) {
            G("R05", `${lok}/transisi`, `transisi tidak dapat dibangun: ${e.message}`);
          }
          jTrack.push({ mulai: b.mulai, akhir: b.mulai + tumpang, lok, jenis: b.transisi.jenis, durasi: tumpang, track: i });
        }
      } else if (tumpang > 0) {
        G("R04", lok, `tumpang tindih ${tumpang} frame dengan "${lawan.b.id}" di track "${tr.id}" tanpa transisi (butir yang bertumpuk wajib punya transisi.durasi = ${tumpang})`);
      }
      berjalan.push({ b, j });
    });
    // dua jendela transisi di satu track tidak boleh bertumpuk
    jTrack.sort((p, q) => p.mulai - q.mulai);
    for (let n = 1; n < jTrack.length; n++) {
      if (jTrack[n].mulai < jTrack[n - 1].akhir) G("R05", jTrack[n].lok, `dua transisi berurutan saling tumpang (${jTrack[n - 1].lok} frame ${jTrack[n - 1].mulai}..${jTrack[n - 1].akhir - 1}); beri jarak minimal satu frame`);
    }
    jendela.push(...jTrack);
  });
  // R06: satu transisi aktif per frame di seluruh timeline (id filter SVG transisi.js bersifat global)
  const jt = jendela.slice().sort((p, q) => p.mulai - q.mulai || p.akhir - q.akhir);
  let terjauh = null;
  for (const w of jt) {
    if (terjauh && w.mulai < terjauh.akhir && w.track !== terjauh.track) {
      G("R06", w.lok, `transisi bersamaan dengan ${terjauh.lok} (frame ${w.mulai}..${Math.min(w.akhir, terjauh.akhir) - 1}); v1: satu transisi aktif per frame di seluruh timeline`);
    }
    if (!terjauh || w.akhir > terjauh.akhir) terjauh = w;
  }
  // R14: kilatan (WCAG 2.3.1) lewat Transisi.periksaKilatan; pertahanan berlapis di atas R05/R06
  const kil = TR.periksaKilatan(jendela.map((w) => ({ jenis: w.jenis, mulai: w.mulai, durasi: w.durasi })), fps);
  for (const x of kil.galat) G("R14", "/track", x);
  for (const x of kil.peringatan) W("W06", "/track", x);

  // ------------------------------------------------------------- R08 R09 pemetaan waktu dan audio klip
  const suara = []; // rentang audio efektif butir video bersuara
  for (const x of semua) {
    const { b, lok } = x;
    if (b.jenis !== "video") continue;
    const k = ring.klip[b.klip];
    const w = b.waktu ?? {};
    if (w.bekukan && w.balik) G("R08", `${lok}/waktu`, "bekukan dan balik tidak dapat digabung");
    const kecs = Array.isArray(w.kecepatan) ? w.kecepatan.map((q) => q.nilai) : w.kecepatan !== undefined ? [w.kecepatan] : [];
    let kecepatanSah = true; // aturan kecepatan milik runtime (RT.kecepatanPermil): 3 desimal, > 0
    for (const v of kecs) {
      try { RT.kecepatanPermil(v); } catch { kecepatanSah = false; G("R08", `${lok}/waktu/kecepatan`, `kecepatan ${v}: maksimal 3 desimal, > 0 dan <= 1000 (aritmetika permil, lihat RT.kecepatanPermil)`); }
    }
    const identitas = !w.bekukan && !w.balik && (w.kecepatan === undefined || w.kecepatan === 1);
    if (k && !(w.bekukan && w.balik) && (kecepatanSah || w.bekukan) && !rusakKf.has(b.id) && b.durasi <= total) {
      if (k.jumlah === null) {
        W("W08", lok, `jumlah frame klip "${b.klip}" tidak diketahui; batas pembacaan tidak diperiksa (beri --klip-props)`);
      } else {
        let maks = null;
        try { maks = (b.dari ?? 0) + offsetMaks(b.durasi, w); } catch (e) { G("R08", `${lok}/waktu`, e.message); }
        const habis = w.habis ?? "tolak";
        if (maks !== null && maks > k.jumlah - 1 && habis === "tolak") {
          G("R08", lok, `membaca frame klip ${maks} padahal klip "${b.klip}" hanya ${k.jumlah} frame (0..${k.jumlah - 1})${k.jumlahPerkiraan ? " (perkiraan dari durasi sumber; beri --klip-props)" : ""}; kurangi durasi atau kecepatan, ubah dari, atau set waktu.habis ("tahan" atau "ulang")`);
        }
        if (maks !== null && (b.dari ?? 0) > k.jumlah - 1) G("R08", `${lok}/dari`, `dari ${b.dari} di luar klip "${b.klip}" (${k.jumlah} frame)`);
      }
    }
    // audio klip (R09)
    const mode = b.audio?.mode ?? "bisu";
    if (mode !== "bisu") {
      if (k && k.audio === false) G("R09", `${lok}/audio/mode`, `klip "${b.klip}" tidak beraudio; mode harus "bisu"`);
      if (!identitas) G("R09", `${lok}/audio/mode`, 'audio klip tidak mendukung speed, reverse, atau freeze (audio.mjs tidak meregangkan waktu); set mode "bisu"');
      const sumberObj = k && adaSumber ? konteks.sumber.perId.get(k.sumber) : null;
      if (sumberObj && dalamCakupan(sumberObj) && (sumberObj.kutipan?.isiAudio ?? "musik") === "musik") {
        if (sumberObj.kutipan?.musikDibahas === true) W("W08", `${lok}/audio/mode`, `sumber kutipan "${sumberObj.id}" berisi musik yang dibahas; batas 10 detik diperiksa saat rakit audio`);
        else G("R09", `${lok}/audio/mode`, `audio musik sumber kutipan "${sumberObj.id}" wajib "bisu" (musikDibahas false)`);
      }
      if (x.aktif) {
        let akhir = x.akhir;
        const berikut = sesudah.get(b.id);
        if (berikut?.transisi && berikut.mulai < akhir) akhir = berikut.mulai; // A-3: audio butir keluar berakhir di awal transisi
        suara.push({ id: b.id, mode, mulai: b.mulai, akhir, lok });
      }
    }
  }

  // -------------------------------------------------------------- R10 R11 audio dan pemegang suara
  const narasi = [], musik = [];
  for (const x of aktif.filter((y) => y.b.jenis === "audio")) {
    const { b, lok } = x;
    const a = ring.aset[b.aset];
    if (!a || a.jenis !== "audio") continue;
    if (a.peran === "efek") G("R10", `${lok}/aset`, "peran efek belum didukung audio.mjs (skema 1)");
    if (a.peran === "narasi") {
      if (a.durasiFrame !== null && ((b.dari ?? 0) !== 0 || b.durasi !== a.durasiFrame)) {
        G("R10", lok, `narasi tidak dapat dipotong (audio.mjs): dari harus 0 dan durasi harus ${a.durasiFrame} (ceil(durasi berkas x fps)); dapat dari=${b.dari ?? 0}, durasi=${b.durasi}`);
      }
      narasi.push({ id: b.id, mulai: b.mulai, akhir: x.akhir, lok });
    }
    if (a.peran === "musik") {
      if (b.mulai !== 0) G("R10", `${lok}/mulai`, "skema 1: musik harus mulai di frame 0 (audio.mjs belum mendukung offset musik)");
      if (a.durasiFrame !== null && (b.dari ?? 0) + b.durasi > a.durasiFrame) G("R10", lok, `membaca ${(b.dari ?? 0) + b.durasi} frame dari berkas ${a.durasiFrame} frame`);
      musik.push(b.id);
    }
    if (b.ducking && a.peran !== "musik") G("R10", `${lok}/ducking`, "ducking hanya untuk butir musik");
  }
  if (musik.length > 1) G("R10", "/track", `skema 1: satu butir musik saja (dapat ${musik.length}: ${musik.join(", ")})`);
  const irisanR = (p, q) => `${Math.max(p.mulai, q.mulai)}..${Math.min(p.akhir, q.akhir) - 1}`;
  for (const [a, c] of pasanganTumpang(narasi, narasi)) G("R11", a.lok, `dua narasi tumpang tindih: "${a.id}" dan "${c.id}" pada frame ${irisanR(a, c)}`);
  for (const [kl, n] of pasanganTumpang(suara.filter((s) => s.mode === "bergantian"), narasi)) {
    G("R11", kl.lok, `narasi "${n.id}" tumpang tindih audio klip "${kl.id}" mode bergantian pada frame ${irisanR(kl, n)}; set mode "campur" atau "bisu", atau geser narasi`);
  }
  for (const [a, c] of pasanganTumpang(suara, suara)) G("R11", a.lok, `dua klip bersuara tumpang tindih: "${a.id}" dan "${c.id}" pada frame ${irisanR(a, c)}`);
  for (const [kl, n] of pasanganTumpang(suara.filter((s) => s.mode === "campur"), narasi)) {
    const pesan = `narasi "${n.id}" tumpang tindih klip "${kl.id}" mode campur pada frame ${irisanR(kl, n)}`;
    if (t.audio?.ketatCampur) G("R11", kl.lok, pesan); else W("W05", kl.lok, pesan);
  }

  // ------------------------------------------------------------------- R12 atribusi, R13 logo
  const adaKredit = aktif.some((x) => x.b.jenis === "kredit");
  const perluAkhir = [];
  const dipakai = new Set();
  for (const x of aktif) {
    const { b, lok } = x;
    let tampil = "tidak", nama = null;
    if (b.klip !== undefined && ring.klip[b.klip] && adaSumber) {
      const s = konteks.sumber.perId.get(ring.klip[b.klip].sumber);
      tampil = uraiLisensi(s?.lisensi)?.jenis === "cc" ? "akhir" : "tidak"; // sumber.json tidak punya atribusiTampil
      nama = `klip "${b.klip}" (sumber "${s?.id}")`;
    } else if (b.aset !== undefined && ring.aset[b.aset]) {
      tampil = ring.aset[b.aset].atribusiTampil;
      nama = `aset "${b.aset}"`;
    }
    if (!nama) continue;
    if (tampil === "layar") {
      if (b.kreditLayar !== true) G("R12", `${lok}/kreditLayar`, `${nama} mewajibkan atribusi di layar; set kreditLayar: true${b.kreditLayar === false ? " (kreditLayar: false ditolak)" : ""}`);
    } else if (tampil === "akhir" && !dipakai.has(nama)) {
      perluAkhir.push(nama);
    }
    dipakai.add(nama);
  }
  if (perluAkhir.length && !adaKredit) G("R12", "/track", `${perluAkhir.join(", ")} mewajibkan atribusi (CC BY atau atribusiTampil "akhir") tetapi tidak ada butir jenis "kredit" di track aktif`);
  for (const x of aktif.filter((y) => y.b.jenis === "gambar")) {
    const a = ring.aset[x.b.aset];
    const aturan = a?.merek?.aturan;
    if (!a || a.jenis !== "logo" || !aturan) continue;
    const tata = x.b.tata ?? {};
    const lb = tata.lebar ?? lebar, tg = tata.tinggi ?? tinggi, fit = tata.fit ?? "contain";
    const rasio = a.rasio ?? null;
    let efektif = fit === "contain" && rasio ? Math.min(lb, tg * rasio) : lb;
    if (x.b.properti?.skala !== undefined) efektif *= nilaiMin(x.b.properti.skala);
    if (typeof aturan.ukuranMinPx === "number" && efektif < aturan.ukuranMinPx - EPS) {
      G("R13", `${x.lok}/tata`, `lebar tampil logo "${x.b.aset}" ${f2(efektif)} px < ukuranMinPx ${aturan.ukuranMinPx} (pedoman merek di ${konteks.aset.berkas})`);
    }
    const larang = Array.isArray(aturan.larangan) ? aturan.larangan : [];
    if (larang.includes("rotasi") && x.b.properti?.rotasi !== undefined) G("R13", `${x.lok}/properti/rotasi`, `pedoman merek logo "${x.b.aset}" melarang rotasi`);
    if (larang.includes("distorsi") && fit === "fill" && rasio && Math.abs(lb / tg / rasio - 1) > 0.01) G("R13", `${x.lok}/tata/fit`, `pedoman merek logo "${x.b.aset}" melarang distorsi: fit "fill" pada kotak ${lb}x${tg} meregangkan rasio ${f2(rasio)}`);
  }

  // ------------------------------------------------------------ R17 kebijakan kutipan (turunan dari timeline)
  const butirKutipan = adaSumber ? aktif.filter((x) => x.b.klip !== undefined && ring.klip[x.b.klip] && dalamCakupan(konteks.sumber.perId.get(ring.klip[x.b.klip].sumber))) : [];
  if (butirKutipan.length) {
    const sm = konteks.sumber.manifest, lokSumber = konteks.sumber.berkas;
    const komentar = [];
    for (const n of narasi) komentar.push({ mulai: n.mulai / fps, akhir: n.akhir / fps, jenis: "narasi" });
    for (const x of aktif) if (x.b.jenis === "teks" && ["caption", "anotasi"].includes(x.b.peran)) komentar.push({ mulai: x.b.mulai / fps, akhir: x.akhir / fps, jenis: x.b.peran });
    const klon = structuredClone(sm);
    klon.proyek = { ...(klon.proyek ?? {}), durasiVideoDetik: total / fps, komentar };
    klon.klip = butirKutipan.map((x) => ({
      id: x.b.id, sumber: ring.klip[x.b.klip].sumber, dari: (x.b.dari ?? 0) / fps, panjang: x.b.durasi / fps, mulaiVideo: x.b.mulai / fps,
      lebar: 1, tinggi: 1,
    }));
    // gerbang hukum GH: dinilai pada manifest ASLI (hash mengikat sumber.json apa adanya).
    // Salinan turunan hanya dipakai untuk angka kebijakan; hash-nya disamakan agar cabang
    // `kepentinganPublik` di periksaKutipan mengikuti status gerbang asli.
    const gerbang = statusGerbang(sm, konteks.sumber.dir);
    if (gerbang.perlu && gerbang.disetujui) klon.proyek.gerbangHukum = { ...sm.proyek.gerbangHukum, hash: hashGerbang(klon, konteks.sumber.dir).hash };
    const r = periksaKutipan(klon, konteks.sumber.dir, konteks.sumber.durasi);
    for (const x of r.galat) G("R17", lokSumber, x);
    for (const x of r.peringatan) W("W09", lokSumber, x);
    if (gerbang.perlu && !gerbang.disetujui) {
      if (draf) W("W09", lokSumber, `DRAF: ${gerbang.pesan}; hasil tidak boleh dipublikasikan`);
      else G("R17", lokSumber, gerbang.pesan);
    }
    if (r.ringkasan) { turunan.kutipan = { ...r.ringkasan, baris: barisRingkasan(r) }; }
    // nilai manual di sumber.json tidak boleh bertentangan dengan jadwal turunan (sumber tunggal = timeline)
    const pm = sm.proyek ?? {};
    if (pm.durasiVideoDetik !== undefined && Math.abs(pm.durasiVideoDetik - total / fps) > EPS) {
      G("R17", `${lokSumber}/proyek/durasiVideoDetik`, `durasiVideoDetik ${pm.durasiVideoDetik} s bertentangan dengan timeline (${total} frame / ${fps} fps = ${f2(total / fps)} s); hapus bidang itu, nilainya diturunkan dari timeline`);
    }
    if (pm.komentar !== undefined) {
      const manual = gabungInterval(Array.isArray(pm.komentar) ? pm.komentar.filter(adaObjek).map((c) => [c.mulai, c.akhir]) : []);
      const turun = gabungInterval(komentar.map((c) => [c.mulai, c.akhir]));
      const sama = manual.length === turun.length && manual.every((c, i) => Math.abs(c[0] - turun[i][0]) < EPS && Math.abs(c[1] - turun[i][1]) < EPS);
      if (!sama) G("R17", `${lokSumber}/proyek/komentar`, "komentar di sumber.json bertentangan dengan narasi, caption, dan anotasi di timeline; hapus bidang itu, jadwal komentar diturunkan dari timeline");
    }
    for (const [id, kl] of Object.entries(ring.klip)) {
      if (typeof kl.mulaiVideoManual !== "number") continue;
      const mulaiAda = aktif.filter((x) => x.b.klip === id).map((x) => x.b.mulai / fps);
      if (mulaiAda.length && !mulaiAda.some((m) => Math.abs(m - kl.mulaiVideoManual) < EPS)) {
        G("R17", `${lokSumber}/klip/${id}/mulaiVideo`, `mulaiVideo ${kl.mulaiVideoManual} s bertentangan dengan timeline (butir klip "${id}" mulai di ${mulaiAda.map(f2).join(", ")} s); hapus bidang itu`);
      }
    }
  }

  // --------------------------------------------------------------------------- peringatan
  const A = RT.areaAman(lebar, tinggi).grafis;
  for (const x of aktif) {
    const { b, lok } = x;
    if (b.jenis !== "teks" && b.jenis !== "kredit") continue;
    const peran = b.peran ?? "kredit";
    const min = RT.ukuranTeks(tinggi, PERAN_UKURAN[peran], "umum", "ponselLanskap").px;
    const u = b.gaya?.ukuran;
    if (u !== undefined && u < min) W("W01", `${lok}/gaya/ukuran`, `ukuran ${u} px < minimum ${min} px untuk peran ${peran} (ukuranTeks, konteks ponselLanskap)`);
    const q = b.tata;
    if (q && q.x !== undefined && q.y !== undefined && q.lebar !== undefined && q.tinggi !== undefined
      && (q.x < A.x || q.y < A.y || q.x + q.lebar > A.x + A.w || q.y + q.tinggi > A.y + A.h)) {
      W("W02", `${lok}/tata`, "kotak teks keluar dari area aman grafis (EBU R 95)");
    }
  }
  const visual = aktif.filter((x) => x.tr.jenis !== "audio");
  const akhirMaks = visual.reduce((m, x) => (x.akhir > m ? x.akhir : m), 0);
  if (akhirMaks < total) W("W04", "/proyek/durasi", `${total - akhirMaks} frame terakhir tanpa butir visual (hanya warna latar proyek)`);
  const selisih = new Int32Array(total + 2);
  for (const x of aktif) {
    if (x.b.jenis !== "video" || x.b.mulai >= total) continue;
    selisih[x.b.mulai]++;
    selisih[Math.min(x.akhir, total)]--;
  }
  let sekarang = 0, bebanMaks = 0;
  for (let f = 0; f < total; f++) { sekarang += selisih[f]; if (sekarang > bebanMaks) bebanMaks = sekarang; }
  if (bebanMaks > 4) W("W03", "/track", `hingga ${bebanMaks} butir video tampil bersamaan (ambang 4 belum terukur; beban render naik)`);

  const hitungButir = semua.length;
  return {
    galat, peringatan, turunan,
    ringkasan: { track: t.track.length, butir: hitungButir, transisi: jendela.length, frame: total, fps, detik: total / fps },
  };
}

// =====================================================================================
// Antarmuka
// =====================================================================================

/**
 * Memeriksa timeline (objek) sepenuhnya: skema, lalu manifest dan aturan.
 * @param {object} t timeline hasil JSON.parse
 * @param {{ dir: string, klipProps?: object, ketat?: boolean, draf?: boolean, konteks?: object }} opsi
 *   `dir` = folder tempat manifes.* dirujuk; `konteks` (opsional) memakai ulang hasil muatKonteks.
 */
export async function periksaTimeline(t, { dir, klipProps, ketat = false, draf = false, konteks } = {}) {
  const gSkema = validasiSkema(t);
  if (gSkema.length) {
    return { lolos: false, galat: gSkema.map((x) => ({ kode: "SKEMA", ...x })), peringatan: [], ringkasan: null, turunan: {} };
  }
  const k = konteks ?? await muatKonteks(t, dir, { klipProps });
  const r = periksaAturan(t, k, { draf });
  const galat = r.galat;
  const peringatan = r.peringatan;
  if (ketat) for (const w of peringatan) galat.push({ ...w, kode: w.kode, pesan: `${w.pesan} (peringatan dijadikan galat oleh --ketat)` });
  return { lolos: galat.length === 0, galat, peringatan: ketat ? [] : peringatan, ringkasan: r.ringkasan, turunan: r.turunan };
}

const PETUNJUK = `Pemakaian:
  bun scripts/timeline.mjs periksa [timeline.json] [--klip-props klip-props.json] [--ketat] [--json] [--draf]
periksa memvalidasi timeline.json (skema 1, data/skema-timeline.json), rujukan ke aset.json dan
sumber.json (lewat validator aset dan klip yang sudah ada, termasuk ffprobe), tumpang tindih dan
transisi, pemetaan waktu klip, audio, atribusi, logo, dan kebijakan kutipan. Tidak menulis berkas.
  --klip-props  klip-props.json hasil klip.mjs (jumlah frame klip yang pasti; tanpa ini diperkirakan)
  --ketat       peringatan dijadikan galat
  --json        keluaran JSON { lolos, galat[], peringatan[], ringkasan, turunan }
  --draf        gerbang hukum GH yang belum disetujui menjadi peringatan (hasil bukan untuk publikasi)
Kode keluar: 0 lolos; 2 timeline atau argumen tidak valid; 1 galat tak terduga.`;

class GalatCli extends Error {
  constructor(pesan, kode = 2) {
    super(pesan);
    this.kode = kode;
  }
}

function cetak(hasil, berkas, json, ketat) {
  if (json) {
    console.log(JSON.stringify({ lolos: hasil.lolos, galat: hasil.galat, peringatan: hasil.peringatan, ringkasan: hasil.ringkasan, turunan: hasil.turunan }, null, 2));
    return;
  }
  const baris = (jenis, x) => `  ${jenis} [${x.kode}] ${x.lok === "" ? "(akar)" : x.lok}: ${x.pesan}`;
  const r = hasil.ringkasan;
  if (r) console.log(`${berkas}: ${r.track} track, ${r.butir} butir, ${r.transisi} transisi, ${r.frame} frame @ ${r.fps} fps (${f2(r.detik)} s)`);
  hasil.galat.slice(0, BATAS_GALAT_TAMPIL).forEach((x) => console.log(baris("galat", x)));
  if (hasil.galat.length > BATAS_GALAT_TAMPIL) console.log(`  ... dan ${hasil.galat.length - BATAS_GALAT_TAMPIL} galat lagi (pakai --json untuk semuanya)`);
  hasil.peringatan.slice(0, BATAS_GALAT_TAMPIL).forEach((x) => console.log(baris("peringatan", x)));
  if (hasil.turunan?.kutipan) console.log(`  ${hasil.turunan.kutipan.baris}`);
  console.log(hasil.lolos ? `LOLOS${hasil.peringatan.length ? `: ${hasil.peringatan.length} peringatan` : ""}` : `GAGAL: ${hasil.galat.length} galat${ketat ? " (--ketat)" : ""}`);
}

async function perintahPeriksa(argv) {
  const { values: o, positionals: p } = parseArgs({
    args: argv, allowPositionals: true,
    options: { "klip-props": { type: "string" }, ketat: { type: "boolean", default: false }, json: { type: "boolean", default: false }, draf: { type: "boolean", default: false } },
  });
  if (p.length > 1) throw new GalatCli(`periksa menerima paling banyak satu timeline.json.\n${PETUNJUK}`);
  const berkas = resolve(p[0] ?? "timeline.json");
  if (!existsSync(berkas) || !statSync(berkas).isFile()) throw new GalatCli(`timeline tidak ditemukan: ${p[0] ?? "timeline.json"}`);
  const ukuran = statSync(berkas).size;
  if (ukuran > BATAS_BERKAS_BYTE) throw new GalatCli(`${p[0] ?? "timeline.json"} berukuran ${(ukuran / 1e6).toFixed(1)} MB, melebihi batas ${BATAS_BERKAS_BYTE / 1e6} MB`);
  let t;
  try { t = JSON.parse(readFileSync(berkas, "utf8")); } catch (e) { throw new GalatCli(`${p[0] ?? "timeline.json"} bukan JSON valid: ${e.message}`); }
  let klipProps;
  if (o["klip-props"]) {
    try { klipProps = JSON.parse(readFileSync(o["klip-props"], "utf8")); } catch (e) { throw new GalatCli(`--klip-props tidak terbaca atau bukan JSON valid: ${e.message}`); }
    if (!adaObjek(klipProps) || !Array.isArray(klipProps.klip)) throw new GalatCli('--klip-props harus objek dengan array "klip" (keluaran klip.mjs)');
  }
  const hasil = await periksaTimeline(t, { dir: dirname(berkas), klipProps, ketat: o.ketat, draf: o.draf });
  cetak(hasil, p[0] ?? "timeline.json", o.json, o.ketat);
  return hasil.lolos ? 0 : 2;
}

async function utama() {
  const [perintah, ...sisa] = process.argv.slice(2);
  try {
    if (!perintah || perintah === "-h" || perintah === "--help") {
      console.log(PETUNJUK);
      process.exit(perintah ? 0 : 2);
    }
    if (perintah !== "periksa") throw new GalatCli(`perintah tidak dikenal: "${perintah}"\n${PETUNJUK}`);
    process.exit(await perintahPeriksa(sisa));
  } catch (e) {
    console.error(`timeline.mjs: ${e.message}`);
    process.exit(e.kode ?? (e.code?.startsWith?.("ERR_PARSE_ARGS") ? 2 : 1));
  }
}

if (import.meta.main) await utama();
