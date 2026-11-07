#!/usr/bin/env bun
/**
 * konsep.mjs — konsep video: pilihan jenis video dan alur produksi (tanpa dependensi).
 *
 *   bun scripts/konsep.mjs baru --jenis J --alur A --out konsep.json [--judul T] [--audiens P[,P2]] [--timpa]
 *   bun scripts/konsep.mjs daftar [jenis|alur|audiens [kunci]]
 *   bun scripts/konsep.mjs periksa konsep.json [--video F]
 *   bun scripts/konsep.mjs brief konsep.json [--out brief.md]
 *   bun scripts/konsep.mjs setuju konsep.json --gate G --oleh "Peran" --tanggal YYYY-MM-DD
 *                          [--berkas F] [--catatan T]
 *   bun scripts/konsep.mjs preset konsep.json
 *   bun scripts/konsep.mjs sinkron-preset [--periksa] [--keluar F]
 *
 * Sumber kebenaran preset: data/jenis-video.json dan data/alur-produksi.json; profil audiens
 * (ukuran teks, cps, kontras, kepadatan elemen) dari data/audiens.json. Salinan
 * preset untuk komposisi di browser (scripts/preset-jenis.js) dihasilkan dari data itu.
 * Keluaran deterministik: tidak memakai jam sistem, tanggal persetujuan datang dari
 * argumen. Exit 0 berhasil, 1 salinan preset basi (sinkron-preset --periksa), 2 argumen
 * atau konsep tidak valid. Fungsi diekspor agar dipakai periksa.mjs dan uji. Karya asli.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BERKAS = {
  jenis: join(akar, "data", "jenis-video.json"),
  alur: join(akar, "data", "alur-produksi.json"),
  audiens: join(akar, "data", "audiens.json"),
  presetJs: join(akar, "scripts", "preset-jenis.js"),
};

export const ATRIBUT = ["adegan", "fps", "rasio", "rasioAlternatif", "resolusi", "durasiTarget", "durasiMaks",
  "detikPerAdegan", "cps", "burnIn", "modeCaption", "transisi", "easing", "tipografi", "palet", "kontrasMin",
  "musik", "selisihNarasiMusikDb", "narasi", "kenyaringan", "kepatuhan"];
const TINGKAT_JENIS = ["bukti", "standar", "pedoman-industri", "keputusan-desain"];
const TINGKAT_ALUR = ["buku-teks", "praktik", "keputusan-desain"];
const FASE = ["pra", "produksi", "pasca", "distribusi", "evaluasi"];
const KUNCI_KONSEP = ["versi", "id", "judul", "jenis", "alur", "tahap", "tujuan", "tujuanBelajar", "audiens",
  "pesanUtama", "cta", "nada", "durasiTarget", "rasio", "narasi", "musik", "kenyaringan", "caption",
  "kepatuhan", "persetujuan", "override", "overrideAlasan"];
const MODE_NARASI = ["tanpa", "tts-lokal", "tts-daring", "rekaman"];
const IZIN_POTRET = ["tidak-ada-potret", "tertulis-ada", "belum"];
const KLAIM = ["tidak-ada", "berbukti", "belum-diperiksa"];

const adalahObjek = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const teksIsi = (x) => typeof x === "string" && x.trim() !== "";
const angkaPositif = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;
const klon = (x) => JSON.parse(JSON.stringify(x));
export const tulisJson = (x) => JSON.stringify(x, null, 2) + "\n";
const idAngka = (n) => String(n).replace(".", ",");

// ------------------------------------------------------------------ data
let cacheData = null;
export function muatData() {
  if (!cacheData) {
    cacheData = {
      jenis: JSON.parse(readFileSync(BERKAS.jenis, "utf8")),
      alur: JSON.parse(readFileSync(BERKAS.alur, "utf8")),
      audiens: JSON.parse(readFileSync(BERKAS.audiens, "utf8")),
    };
  }
  return cacheData;
}

/** Semua gate suatu alur dalam urutan tahap: [{ ...gate, tahap: id, indeksTahap }]. */
export function daftarGate(alur) {
  const hasil = [];
  alur.tahap.forEach((t, i) => {
    if (t.gate) hasil.push({ ...t.gate, tahap: t.id, indeksTahap: i });
  });
  return hasil;
}

/** Validasi data preset dan alur; `runtime` = window.VideoTerprogram (easing, durasi). */
export function periksaData(data, runtime) {
  const g = [];
  const { jenis: dj, alur: da } = data;
  const en = dj.enum ?? {};
  for (const k of TINGKAT_JENIS) if (!teksIsi(dj.legendaBukti?.[k])) g.push(`legendaBukti.${k}: kosong`);
  for (const e of en.easing ?? []) if (typeof runtime.easing[e] !== "function") g.push(`enum.easing: "${e}" tidak ada di runtime`);
  for (const e of en.transisi ?? []) if (!angkaPositif(runtime.durasi[e])) g.push(`enum.transisi: "${e}" tidak ada di runtime.durasi`);
  const inEnum = (nama, v) => (en[nama] ?? []).includes(v);

  for (const [kj, j] of Object.entries(dj.jenis ?? {})) {
    const p = `jenis.${kj}`;
    for (const f of ["label", "deskripsi", "tujuan"]) if (!teksIsi(j[f])) g.push(`${p}.${f}: kosong`);
    if (!Array.isArray(j.alurCocok) || j.alurCocok.length === 0) g.push(`${p}.alurCocok: kosong`);
    else {
      for (const a of j.alurCocok) if (!da.alur?.[a]) g.push(`${p}.alurCocok: alur "${a}" tidak dikenal`);
      if (j.alurBawaan !== j.alurCocok[0]) g.push(`${p}.alurBawaan harus elemen pertama alurCocok`);
    }
    if (!Array.isArray(j.pemeriksaanTambahan) || !j.pemeriksaanTambahan.every(teksIsi)) g.push(`${p}.pemeriksaanTambahan: harus daftar teks`);
    const n = j.nilai ?? {};
    const sama = JSON.stringify(Object.keys(n)) === JSON.stringify(ATRIBUT);
    if (!sama) g.push(`${p}.nilai: atribut harus tepat ${ATRIBUT.join(", ")} (urut)`);
    const b = j.bukti ?? {};
    for (const k of ATRIBUT) {
      if (!(k in n)) continue;
      const bb = b[k];
      if (!bb) g.push(`${p}.bukti.${k}: tidak ada`);
      else {
        if (!TINGKAT_JENIS.includes(bb.tingkat)) g.push(`${p}.bukti.${k}.tingkat tidak valid: ${bb.tingkat}`);
        if (!teksIsi(bb.rujukan)) g.push(`${p}.bukti.${k}.rujukan: kosong`);
      }
    }
    for (const k of Object.keys(b)) if (!(k in n)) g.push(`${p}.bukti.${k}: atribut tidak ada di nilai`);
    // tipe dan rentang
    if (!angkaPositif(n.fps)) g.push(`${p}.fps: harus angka positif`);
    if (!inEnum("rasio", n.rasio)) g.push(`${p}.rasio tidak valid`);
    const alt = n.rasioAlternatif;
    if (!Array.isArray(alt) || !alt.every((r) => inEnum("rasio", r)) || alt.includes(n.rasio)) g.push(`${p}.rasioAlternatif tidak valid`);
    else {
      const kunciRes = Object.keys(n.resolusi ?? {}).sort().join(",");
      if (kunciRes !== [n.rasio, ...alt].sort().join(",")) g.push(`${p}.resolusi: kunci harus sama dengan rasio dan rasioAlternatif`);
    }
    for (const [r, d] of Object.entries(n.resolusi ?? {})) {
      const [a, c] = r.split(":").map(Number);
      if (!Number.isInteger(d?.lebar) || !Number.isInteger(d?.tinggi) || d.lebar <= 0 || d.tinggi <= 0) g.push(`${p}.resolusi.${r}: lebar dan tinggi harus bilangan bulat positif`);
      else if (Math.abs(d.lebar / d.tinggi - a / c) / (a / c) > 0.01) g.push(`${p}.resolusi.${r}: ${d.lebar}x${d.tinggi} tidak sesuai rasio`);
    }
    if (!angkaPositif(n.durasiTarget) || !angkaPositif(n.durasiMaks) || n.durasiTarget > n.durasiMaks) g.push(`${p}: durasiTarget harus positif dan <= durasiMaks`);
    if (!angkaPositif(n.detikPerAdegan)) g.push(`${p}.detikPerAdegan: harus positif`);
    if (!angkaPositif(n.cps) || n.cps > 20) g.push(`${p}.cps: harus 0..20`);
    if (typeof n.burnIn !== "boolean") g.push(`${p}.burnIn: harus boolean`);
    if (!inEnum("modeCaption", n.modeCaption)) g.push(`${p}.modeCaption tidak valid`);
    if (!inEnum("transisi", n.transisi)) g.push(`${p}.transisi tidak valid`);
    for (const s of ["masuk", "keluar"]) if (!inEnum("easing", n.easing?.[s])) g.push(`${p}.easing.${s} tidak valid`);
    for (const s of new Set(["judul", "isi", "caption", ...Object.keys(n.tipografi ?? {})])) {
      if (!(n.tipografi?.[s] > 0 && n.tipografi[s] < 1)) g.push(`${p}.tipografi.${s}: harus pecahan 0..1`);
    }
    if (!inEnum("palet", n.palet)) g.push(`${p}.palet tidak valid`);
    if (!(n.kontrasMin >= 4.5 && n.kontrasMin <= 21)) g.push(`${p}.kontrasMin: harus 4,5..21 (WCAG 1.4.3)`);
    if (!inEnum("musik", n.musik)) g.push(`${p}.musik tidak valid`);
    if (!(n.selisihNarasiMusikDb === null || (typeof n.selisihNarasiMusikDb === "number" && n.selisihNarasiMusikDb >= 0))) g.push(`${p}.selisihNarasiMusikDb: angka >= 0 atau null`);
    if (!inEnum("narasi", n.narasi)) g.push(`${p}.narasi tidak valid`);
    if (!inEnum("kenyaringan", n.kenyaringan)) g.push(`${p}.kenyaringan tidak valid`);
    if (!Array.isArray(n.kepatuhan) || n.kepatuhan.length === 0 || !n.kepatuhan.every(teksIsi)) g.push(`${p}.kepatuhan: harus daftar teks tidak kosong`);
    if (!Array.isArray(n.adegan?.wajib) || n.adegan.wajib.length === 0 || !n.adegan.wajib.every(teksIsi)) g.push(`${p}.adegan.wajib: harus daftar teks tidak kosong`);
    if (!Array.isArray(n.adegan?.umum) || !n.adegan.umum.every(teksIsi)) g.push(`${p}.adegan.umum: harus daftar teks`);
  }

  if (data.audiens) g.push(...periksaAudiens(data.audiens, runtime));

  const peran = Object.keys(da.peran ?? {});
  if (peran.length === 0) g.push("peran: kosong");
  const idGateUmum = /^[A-Z]{1,2}\d*$/;
  for (const [ka, a] of Object.entries(da.alur ?? {})) {
    const p = `alur.${ka}`;
    for (const f of ["label", "deskripsi", "kapanDipakai", "overhead"]) if (!teksIsi(a[f])) g.push(`${p}.${f}: kosong`);
    if (!Number.isInteger(a.rondeReview) || a.rondeReview < 0) g.push(`${p}.rondeReview: bilangan bulat >= 0`);
    for (const s of ["struktur", "gateDanRonde"]) {
      const bb = a.bukti?.[s];
      if (!bb || !TINGKAT_ALUR.includes(bb.tingkat) || !teksIsi(bb.rujukan)) g.push(`${p}.bukti.${s}: tingkat atau rujukan tidak valid`);
    }
    if (!Array.isArray(a.kriteriaSelesai) || a.kriteriaSelesai.length === 0) g.push(`${p}.kriteriaSelesai: kosong`);
    if (!Array.isArray(a.tahap) || a.tahap.length === 0) { g.push(`${p}.tahap: kosong`); continue; }
    const idT = new Set(), idG = new Set();
    let faseTerakhir = -1;
    a.tahap.forEach((t, i) => {
      const pt = `${p}.tahap[${i}]`;
      if (!teksIsi(t.id) || idT.has(t.id)) g.push(`${pt}.id: kosong atau ganda`);
      idT.add(t.id);
      const fi = FASE.indexOf(t.fase);
      if (fi < 0) g.push(`${pt}.fase tidak valid`);
      else { if (fi < faseTerakhir) g.push(`${pt}.fase: urutan fase mundur`); faseTerakhir = fi; }
      for (const f of ["nama", "kegiatan"]) if (!teksIsi(t[f])) g.push(`${pt}.${f}: kosong`);
      if (!Array.isArray(t.artefak) || t.artefak.length === 0) g.push(`${pt}.artefak: kosong`);
      if (!Array.isArray(t.perintah)) g.push(`${pt}.perintah: harus array`);
      for (const r of ["R", "A", "C", "I"]) {
        const v = t.raci?.[r];
        if (!Array.isArray(v) || !v.every((x) => peran.includes(x))) g.push(`${pt}.raci.${r}: harus daftar kode peran yang dikenal`);
      }
      if (t.raci?.A?.length !== 1) g.push(`${pt}.raci.A: harus tepat satu peran`);
      if (t.gate) {
        const gt = t.gate;
        if (!idGateUmum.test(gt.id ?? "") || idG.has(gt.id)) g.push(`${pt}.gate.id: tidak valid atau ganda`);
        idG.add(gt.id);
        if (gt.jenis !== (String(gt.id).startsWith("R") ? "review" : "gate")) g.push(`${pt}.gate.jenis tidak konsisten dengan id`);
        if (!teksIsi(gt.nama) || !peran.includes(gt.penyetuju)) g.push(`${pt}.gate: nama kosong atau penyetuju tidak dikenal`);
        if (!Array.isArray(gt.kriteria) || gt.kriteria.length === 0) g.push(`${pt}.gate.kriteria: kosong`);
      }
    });
    if (idG.size === 0) g.push(`${p}: tidak ada gate`);
    if (a.urutanKetat === true && ka === "formal") {
      for (const x of ["G1", "G2", "G3", "G4", "G5", "G6"]) if (!idG.has(x)) g.push(`${p}: gate ${x} wajib ada`);
    }
  }
  return g;
}

// ------------------------------------------------------------------ audiens
const ATURAN_ATRIBUT_ANGKA = ["terbesar", "terkecil"];

/** Validasi data/audiens.json; `runtime` = window.VideoTerprogram (ukuranTeks, untuk menjaga kesamaan pengali). */
export function periksaAudiens(da, runtime) {
  const g = [];
  if (da.versi !== 1) g.push("audiens.versi: harus 1");
  for (const k of TINGKAT_JENIS) if (!teksIsi(da.legendaBukti?.[k])) g.push(`audiens.legendaBukti.${k}: kosong`);
  if (!teksIsi(da.aturanKomposisi)) g.push("audiens.aturanKomposisi: kosong");
  const angka = da.atributAngka ?? {};
  const teks = da.atributTeks ?? [];
  for (const [k, a] of Object.entries(angka)) if (!ATURAN_ATRIBUT_ANGKA.includes(a)) g.push(`audiens.atributAngka.${k}: harus ${ATURAN_ATRIBUT_ANGKA.join(" atau ")}`);
  if (!Array.isArray(teks) || !teks.every(teksIsi)) g.push("audiens.atributTeks: harus daftar teks");
  const semua = [...Object.keys(angka), ...(Array.isArray(teks) ? teks : [])];
  const pengaliRuntime = runtime?.ukuranTeks?.pengaliAudiens;
  const konteksRuntime = runtime?.ukuranTeks?.konteks;
  const profil = da.profil ?? {};
  if (Object.keys(profil).length === 0) g.push("audiens.profil: kosong");
  if (pengaliRuntime && JSON.stringify(Object.keys(profil).sort()) !== JSON.stringify(Object.keys(pengaliRuntime).sort())) {
    g.push("audiens.profil: kunci harus sama dengan runtime ukuranTeks.pengaliAudiens");
  }
  for (const [kp, p] of Object.entries(profil)) {
    const pre = `audiens.profil.${kp}`;
    for (const f of ["label", "deskripsi"]) if (!teksIsi(p[f])) g.push(`${pre}.${f}: kosong`);
    const n = p.nilai ?? {}, b = p.bukti ?? {};
    for (const at of semua) {
      if (!(at in n)) g.push(`${pre}.nilai.${at}: tidak ada`);
      const bb = b[at];
      if (!bb) g.push(`${pre}.bukti.${at}: tidak ada`);
      else {
        if (!TINGKAT_JENIS.includes(bb.tingkat)) g.push(`${pre}.bukti.${at}.tingkat tidak valid: ${bb.tingkat}`);
        if (!teksIsi(bb.rujukan)) g.push(`${pre}.bukti.${at}.rujukan: kosong`);
      }
    }
    for (const at of Object.keys(n)) if (!semua.includes(at)) g.push(`${pre}.nilai.${at}: atribut tidak dikenal`);
    for (const at of Object.keys(b)) if (!(at in n)) g.push(`${pre}.bukti.${at}: atribut tidak ada di nilai`);
    for (const at of Object.keys(angka)) if (at in n && !angkaPositif(n[at])) g.push(`${pre}.nilai.${at}: harus angka positif`);
    for (const at of teks) if (at in n && !teksIsi(n[at])) g.push(`${pre}.nilai.${at}: harus teks tidak kosong`);
    if (n.cps > 20) g.push(`${pre}.nilai.cps: harus 0..20`);
    if (!(n.kontrasTeksMin >= 4.5 && n.kontrasTeksMin <= 21)) g.push(`${pre}.nilai.kontrasTeksMin: harus 4,5..21 (WCAG 1.4.3)`);
    if (!(n.kontrasNonTeksMin >= 3 && n.kontrasNonTeksMin <= 21)) g.push(`${pre}.nilai.kontrasNonTeksMin: harus 3..21 (WCAG 1.4.11)`);
    if (!Number.isInteger(n.maksElemenBaru)) g.push(`${pre}.nilai.maksElemenBaru: harus bilangan bulat`);
    if (pengaliRuntime && n.pengaliUkuranTeks !== pengaliRuntime[kp]) g.push(`${pre}.nilai.pengaliUkuranTeks ${n.pengaliUkuranTeks} tidak sama dengan runtime ukuranTeks.pengaliAudiens (${pengaliRuntime[kp]})`);
  }
  const peta = da.petaKonteksTonton ?? {};
  for (const [k, v] of Object.entries(peta)) {
    if (k === "catatan") continue;
    if (konteksRuntime && !konteksRuntime[v]) g.push(`audiens.petaKonteksTonton.${k}: konteks "${v}" tidak ada di runtime ukuranTeks.konteks`);
  }
  return g;
}

/**
 * Nilai audiens efektif dari daftar profil (yang paling ketat, lihat aturanKomposisi) digabung
 * dengan preset jenis: { pengaliUkuranTeks, cps, pengaliTempoAdegan, kontrasTeksMin,
 * kontrasNonTeksMin, maksElemenBaru, pengaliKecepatanNarasi }. null bila tidak ada profil sah.
 * `presetNilai` (opsional) memuat cps dan kontrasMin preset jenis yang ikut dibandingkan.
 */
export function audiensEfektif(data, profil, presetNilai = null) {
  if (!Array.isArray(profil)) return null;
  const daftar = profil.map((k) => data.audiens.profil[k]).filter(Boolean);
  if (daftar.length === 0) return null;
  const hasil = {};
  for (const [at, aturan] of Object.entries(data.audiens.atributAngka)) {
    const v = daftar.map((p) => p.nilai[at]);
    hasil[at] = aturan === "terbesar" ? Math.max(...v) : Math.min(...v);
  }
  if (presetNilai) {
    hasil.cps = Math.min(hasil.cps, presetNilai.cps);
    hasil.kontrasTeksMin = Math.max(hasil.kontrasTeksMin, presetNilai.kontrasMin);
  }
  return hasil;
}

/** Konteks ukuranTeks() (runtime) untuk isian audiens.konteksTonton; isian tak dikenal dilewati. */
export function konteksUkuranTeks(data, konteksTonton) {
  const peta = data.audiens.petaKonteksTonton;
  const hasil = [];
  for (const k of Array.isArray(konteksTonton) ? konteksTonton : []) {
    const v = typeof k === "string" && k !== "catatan" && Object.hasOwn(peta, k) ? peta[k] : null;
    if (v && !hasil.includes(v)) hasil.push(v);
  }
  return hasil;
}

// ------------------------------------------------------------------ preset efektif
function cekNilai(jalur, v, en) {
  const dalam = (nama) => (en[nama].includes(v) ? null : `harus salah satu dari ${en[nama].join(", ")}`);
  switch (jalur) {
    case "rasio": return dalam("rasio");
    case "transisi": return dalam("transisi");
    case "palet": return dalam("palet");
    case "musik": return dalam("musik");
    case "narasi": return dalam("narasi");
    case "kenyaringan": return dalam("kenyaringan");
    case "modeCaption": return dalam("modeCaption");
    case "easing.masuk": case "easing.keluar": return dalam("easing");
    case "rasioAlternatif": return v.every((r) => en.rasio.includes(r)) ? null : `elemen harus salah satu dari ${en.rasio.join(", ")}`;
    case "kontrasMin": return typeof v === "number" && v >= 4.5 && v <= 21 ? null : "harus 4,5..21 (batas WCAG 1.4.3 tidak boleh diturunkan)";
    case "cps": return angkaPositif(v) && v <= 20 ? null : "harus angka 0..20";
    case "selisihNarasiMusikDb": return typeof v === "number" && v >= 0 ? null : "harus angka >= 0";
    case "adegan.wajib": case "adegan.umum": case "kepatuhan": return v.every(teksIsi) ? null : "harus daftar teks tidak kosong";
    default:
      if (/^tipografi\./.test(jalur)) return v > 0 && v < 1 ? null : "harus pecahan 0..1";
      if (/^resolusi\.[^.]+\.(lebar|tinggi)$/.test(jalur)) return Number.isInteger(v) && v > 0 ? null : "harus bilangan bulat positif";
      if (["fps", "durasiTarget", "durasiMaks", "detikPerAdegan"].includes(jalur)) return angkaPositif(v) ? null : "harus angka positif";
      if (jalur === "burnIn") return typeof v === "boolean" ? null : "harus boolean";
      return null;
  }
}

/** Preset jenis + override konsep -> { nilai, galat[] }. Override hanya untuk kunci yang ada. */
export function presetEfektif(data, konsep) {
  const j = data.jenis.jenis[konsep.jenis];
  const galat = [];
  if (!j) return { nilai: null, galat: [`jenis tidak dikenal: ${konsep.jenis}`] };
  const nilai = klon(j.nilai);
  const ov = konsep.override ?? {};
  if (!adalahObjek(ov)) return { nilai, galat: ["override: harus objek"] };
  const en = data.jenis.enum;
  const jalan = (target, sumber, prefix) => {
    for (const [k, v] of Object.entries(sumber)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!Object.hasOwn(target, k)) { galat.push(`override.${p}: kunci tidak dikenal di preset`); continue; }
      const lama = target[k];
      if (adalahObjek(lama)) {
        if (!adalahObjek(v)) galat.push(`override.${p}: harus objek`);
        else jalan(lama, v, p);
        continue;
      }
      const tipeOk = lama === null ? v === null || typeof v === "number" : Array.isArray(lama) ? Array.isArray(v) : typeof lama === typeof v;
      if (!tipeOk) { galat.push(`override.${p}: tipe tidak sesuai preset`); continue; }
      const e = cekNilai(p, v, en);
      if (e) galat.push(`override.${p}: ${e}`);
      else target[k] = klon(v);
    }
  };
  jalan(nilai, ov, "");
  return { nilai, galat };
}

// ------------------------------------------------------------------ data pribadi
const POLA_PRIBADI = [
  ["surel", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ["NIP (18 digit)", /(?<!\d)\d{18}(?!\d)|(?<!\d)\d{8}\s\d{6}\s\d\s\d{3}(?!\d)/],
  ["NIK (16 digit)", /(?<!\d)\d{16}(?!\d)/],
  ["nomor telepon", /(?<![\w+])(?:\+62|62|0)8\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{2,5}(?!\d)|(?<![\w+])(?:\+62|0)\d{2,3}[-\s]\d{6,8}(?!\d)/],
];
const KUNCI_DILEWATI = new Set(["hash", "tanggal"]);
export function cariDataPribadi(x, jalur = "") {
  const temuan = [];
  if (typeof x === "string") {
    for (const [jenis, re] of POLA_PRIBADI) if (re.test(x)) temuan.push({ jalur, jenis });
  } else if (Array.isArray(x)) {
    x.forEach((v, i) => temuan.push(...cariDataPribadi(v, `${jalur}[${i}]`)));
  } else if (adalahObjek(x)) {
    for (const [k, v] of Object.entries(x)) {
      if (KUNCI_DILEWATI.has(k)) continue;
      temuan.push(...cariDataPribadi(v, jalur ? `${jalur}.${k}` : k));
    }
  }
  return temuan;
}

export function tanggalSah(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ------------------------------------------------------------------ validasi konsep
/** { galat[], peringatan[], efektif } */
export function periksaKonsep(data, k) {
  const galat = [];
  const peringatan = [];
  const hasil = (efektif = null) => ({ galat, peringatan, efektif });
  if (!adalahObjek(k)) { galat.push("konsep harus objek JSON"); return hasil(); }
  for (const key of Object.keys(k)) if (!KUNCI_KONSEP.includes(key)) galat.push(`kunci tidak dikenal di konsep: ${key}`);
  if (k.versi !== 1) galat.push("versi: harus 1");
  if (!(typeof k.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(k.id))) galat.push("id: harus huruf kecil, angka, atau tanda hubung");

  const jns = data.jenis.jenis[k.jenis];
  const alr = data.alur.alur[k.alur];
  if (!jns) galat.push(`jenis tidak dikenal: ${JSON.stringify(k.jenis)} (pilihan: ${Object.keys(data.jenis.jenis).join(", ")})`);
  if (!alr) galat.push(`alur tidak dikenal: ${JSON.stringify(k.alur)} (pilihan: ${Object.keys(data.alur.alur).join(", ")})`);
  if (!jns || !alr) return hasil();

  const idTahap = alr.tahap.map((t) => t.id);
  const iTahap = idTahap.indexOf(k.tahap);
  if (iTahap < 0) galat.push(`tahap tidak dikenal untuk alur ${k.alur}: ${JSON.stringify(k.tahap)} (pilihan: ${idTahap.join(", ")})`);
  const lanjut = iTahap >= 1; // brief sudah dilewati: isian inti wajib terisi

  // override dan preset efektif
  const ov = k.override ?? {};
  const pe = presetEfektif(data, k);
  galat.push(...pe.galat);
  const nilai = pe.nilai;
  const adaOverride = adalahObjek(ov) && Object.keys(ov).length > 0;
  if (adaOverride && !teksIsi(k.overrideAlasan)) galat.push("overrideAlasan: wajib diisi bila override tidak kosong (preset tidak memaksa, tetapi penyimpangan perlu alasan)");
  if (adalahObjek(ov) && typeof ov.durasiMaks === "number" && ov.durasiMaks > jns.nilai.durasiMaks && !teksIsi(k.overrideAlasan)) galat.push("durasiMaks melebihi preset tanpa overrideAlasan");

  // isian inti
  const wajibIsi = [["judul", k.judul], ["tujuan", k.tujuan], ["audiens.deskripsi", k.audiens?.deskripsi], ["pesanUtama", k.pesanUtama], ["cta.teks", k.cta?.teks]];
  for (const [nama, v] of wajibIsi) {
    if (!teksIsi(v)) (lanjut ? galat : peringatan).push(`${nama}: belum terisi${lanjut ? " (wajib setelah tahap brief)" : ""}`);
  }
  if (k.alur === "instruksional" && !(Array.isArray(k.tujuanBelajar) && k.tujuanBelajar.some(teksIsi))) {
    (lanjut ? galat : peringatan).push(`tujuanBelajar: belum terisi${lanjut ? " (wajib untuk alur instruksional setelah tahap Analyze)" : ""}`);
  }
  if (!Array.isArray(k.tujuanBelajar)) galat.push("tujuanBelajar: harus array");
  if (!adalahObjek(k.audiens)) galat.push("audiens: harus objek");
  else if (k.audiens.profil !== undefined) {
    const kenal = Object.keys(data.audiens.profil);
    if (!Array.isArray(k.audiens.profil) || !k.audiens.profil.every((x) => kenal.includes(x))) {
      galat.push(`audiens.profil: harus daftar dari ${kenal.join(", ")}`);
    }
  }
  if (!adalahObjek(k.cta)) galat.push("cta: harus objek");

  // bentuk dan waktu
  if (nilai) {
    const rasioSah = [nilai.rasio, ...nilai.rasioAlternatif];
    if (!rasioSah.includes(k.rasio)) galat.push(`rasio ${JSON.stringify(k.rasio)} tidak sesuai preset ${k.jenis} (sah: ${rasioSah.join(", ")})`);
    if (!angkaPositif(k.durasiTarget)) galat.push("durasiTarget: harus angka positif (detik)");
    else if (k.durasiTarget > nilai.durasiMaks) galat.push(`durasiTarget ${k.durasiTarget} s melebihi durasi maks preset ${nilai.durasiMaks} s`);
  }
  if (k.alur === "formal" && lanjut && !(Array.isArray(k.kepatuhan?.dasarHukum) && k.kepatuhan.dasarHukum.some(teksIsi))) {
    galat.push("kepatuhan.dasarHukum: wajib untuk alur formal setelah gate otorisasi");
  }

  // narasi, musik, caption, kenyaringan
  const en = data.jenis.enum;
  if (k.nada !== undefined && !en.narasi.includes(k.nada)) galat.push(`nada: harus salah satu dari ${en.narasi.join(", ")}`);
  if (!adalahObjek(k.narasi) || !MODE_NARASI.includes(k.narasi.mode)) galat.push(`narasi.mode: harus salah satu dari ${MODE_NARASI.join(", ")}`);
  else {
    if (k.narasi.gaya !== undefined && !en.narasi.includes(k.narasi.gaya)) galat.push(`narasi.gaya: harus salah satu dari ${en.narasi.join(", ")}`);
    if (k.narasi.mode === "tts-daring" && (k.jenis === "internal" || k.kepatuhan?.sensitif === true)) galat.push("narasi.mode tts-daring dilarang untuk jenis internal atau kepatuhan.sensitif (TTS daring hanya untuk konten publik)");
  }
  if (!adalahObjek(k.musik) || !en.musik.includes(k.musik.tingkat)) galat.push(`musik.tingkat: harus salah satu dari ${en.musik.join(", ")}`);
  else if (!(k.musik.selisihDb === null || (typeof k.musik.selisihDb === "number" && k.musik.selisihDb >= 0))) galat.push("musik.selisihDb: angka >= 0 atau null");
  if (!en.kenyaringan.includes(k.kenyaringan)) galat.push(`kenyaringan: harus salah satu dari ${en.kenyaringan.join(", ")}`);
  if (!adalahObjek(k.caption)) galat.push("caption: harus objek");
  else {
    if (typeof k.caption.burnIn !== "boolean") galat.push("caption.burnIn: harus boolean");
    if (!angkaPositif(k.caption.cps)) galat.push("caption.cps: harus angka positif");
    else if (k.caption.cps > 20) peringatan.push(`caption.cps ${k.caption.cps} melebihi batas SDH dewasa Netflix Indonesia (20; subtitle dewasa 17)`);
    if (!en.modeCaption.includes(k.caption.mode)) galat.push(`caption.mode: harus salah satu dari ${en.modeCaption.join(", ")}`);
    if (!teksIsi(k.caption.bahasa)) galat.push("caption.bahasa: wajib diisi");
  }

  // profil audiens: nilai yang lebih longgar daripada profil hanya diperingatkan (preset tidak memaksa)
  const efAud = audiensEfektif(data, k.audiens?.profil);
  if (efAud && nilai) {
    if (angkaPositif(k.caption?.cps) && k.caption.cps > efAud.cps) peringatan.push(`caption.cps ${k.caption.cps} melebihi batas profil audiens (${efAud.cps})`);
    if (nilai.kontrasMin < efAud.kontrasTeksMin) peringatan.push(`kontrasMin ${idAngka(nilai.kontrasMin)}:1 di bawah kebutuhan profil audiens (${idAngka(efAud.kontrasTeksMin)}:1); timpa lewat override beralasan`);
  }

  // kepatuhan
  if (!adalahObjek(k.kepatuhan)) galat.push("kepatuhan: harus objek");
  else {
    const kp = k.kepatuhan;
    if (!Array.isArray(kp.dasarHukum) || !kp.dasarHukum.every(teksIsi)) galat.push("kepatuhan.dasarHukum: harus daftar teks");
    if (!IZIN_POTRET.includes(kp.izinPotret)) galat.push(`kepatuhan.izinPotret: harus salah satu dari ${IZIN_POTRET.join(", ")}`);
    if (!KLAIM.includes(kp.klaim)) galat.push(`kepatuhan.klaim: harus salah satu dari ${KLAIM.join(", ")}`);
    if (typeof kp.dataNyata !== "boolean") galat.push("kepatuhan.dataNyata: harus boolean");
    else if (kp.dataNyata) peringatan.push("kepatuhan.dataNyata true: contoh dan templat awvd tidak boleh memuat data nyata; untuk proyek, data pribadi tunduk pada UU 27/2022");
    if (kp.sensitif !== undefined && typeof kp.sensitif !== "boolean") galat.push("kepatuhan.sensitif: harus boolean");
  }

  // persetujuan
  const gateAlur = daftarGate(alr);
  const petaGate = new Map(gateAlur.map((x) => [x.id, x]));
  const dicatat = new Map();
  if (!Array.isArray(k.persetujuan)) galat.push("persetujuan: harus array");
  else {
    k.persetujuan.forEach((e, i) => {
      const p = `persetujuan[${i}]`;
      if (!adalahObjek(e) || !petaGate.has(e.gate)) { galat.push(`${p}.gate tidak dikenal untuk alur ${k.alur}: ${JSON.stringify(e?.gate)}`); return; }
      if (dicatat.has(e.gate)) galat.push(`${p}: gate ${e.gate} ganda`);
      dicatat.set(e.gate, e);
      if (!["menunggu", "disetujui"].includes(e.status)) galat.push(`${p}.status: harus menunggu atau disetujui`);
      if (e.status === "disetujui") {
        if (!teksIsi(e.oleh)) galat.push(`${p}: gate ${e.gate} disetujui tanpa "oleh"`);
        if (!tanggalSah(e.tanggal)) galat.push(`${p}: gate ${e.gate} disetujui tanpa tanggal YYYY-MM-DD yang sah`);
        if (petaGate.get(e.gate).butuhHash && !/^[0-9a-f]{64}$/.test(e.hash ?? "")) galat.push(`${p}: gate ${e.gate} wajib berhash sha256`);
      }
    });
    if (alr.urutanKetat) {
      for (const x of gateAlur) if (!dicatat.has(x.id)) galat.push(`persetujuan: alur ${k.alur} harus memuat gate ${x.id}`);
      let belum = null;
      for (const x of gateAlur) {
        const e = dicatat.get(x.id);
        if (e?.status === "disetujui" && belum) galat.push(`persetujuan: gate ${x.id} disetujui sebelum ${belum} (alur ${k.alur} berurutan)`);
        if (e && e.status !== "disetujui" && !belum) belum = x.id;
      }
    }
  }

  // data pribadi
  for (const t of cariDataPribadi(k)) galat.push(`${t.jalur}: tampak memuat ${t.jenis}; hapus data pribadi (nilai tidak ditampilkan)`);

  return hasil(nilai);
}

/** Membaca berkas konsep dan memvalidasinya: { konsep, efektif, galat, peringatan }. */
export function bacaKonsepBerkas(berkas, data = muatData()) {
  let konsep = null;
  try {
    konsep = JSON.parse(readFileSync(berkas, "utf8"));
  } catch (e) {
    return { konsep: null, efektif: null, galat: [`tidak bisa membaca ${berkas}: ${e.message}`], peringatan: [] };
  }
  const r = periksaKonsep(data, konsep);
  return { konsep, efektif: r.efektif, galat: r.galat, peringatan: r.peringatan };
}

// ------------------------------------------------------------------ baru
function slug(teks) {
  return String(teks).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buatKonsep(data, { jenis, alur, judul = "", audiens = [] }) {
  const j = data.jenis.jenis[jenis];
  const a = data.alur.alur[alur];
  const n = j.nilai;
  const ef = audiensEfektif(data, audiens, n);
  return {
    versi: 1,
    id: slug(judul) || jenis,
    judul,
    jenis,
    alur,
    tahap: a.tahap[0].id,
    tujuan: "",
    tujuanBelajar: [],
    audiens: { deskripsi: "", bahasa: "id", konteksTonton: [], tanpaSuara: n.burnIn, ...(ef ? { profil: [...audiens] } : {}) },
    pesanUtama: "",
    cta: { teks: "", tautan: null },
    nada: n.narasi,
    durasiTarget: n.durasiTarget,
    rasio: n.rasio,
    narasi: { mode: "tts-lokal", gaya: n.narasi, voice: null },
    musik: { tingkat: n.musik, selisihDb: n.selisihNarasiMusikDb },
    kenyaringan: n.kenyaringan,
    caption: { burnIn: n.burnIn, cps: ef ? ef.cps : n.cps, mode: n.modeCaption, bahasa: "ind" },
    kepatuhan: { dasarHukum: [], izinPotret: "tidak-ada-potret", klaim: "tidak-ada", dataNyata: false, sensitif: false },
    persetujuan: daftarGate(a).map((g) => ({
      gate: g.id, nama: g.nama, peranDiminta: g.penyetuju, status: "menunggu", oleh: "", tanggal: null, hash: null, berkas: null, catatan: "",
    })),
    override: {},
    overrideAlasan: "",
  };
}

// ------------------------------------------------------------------ brief
const sel = (x) => String(x ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const isi = (x) => (teksIsi(x) ? x : "[isi]");
const persen = (x) => `${idAngka(Number((x * 100).toFixed(2)))}%`;

function formatNilai(atribut, v, resolusiTeks) {
  switch (atribut) {
    case "easing": return `masuk ${v.masuk}, keluar ${v.keluar}`;
    case "tipografi": return Object.entries(v).map(([k, x]) => `${k} ${persen(x)}`).join(", ");
    case "resolusi": return Object.entries(v).map(([r, d]) => `${r} ${d.lebar}x${d.tinggi}`).join("; ") || resolusiTeks;
    case "rasioAlternatif": return v.length ? v.join(", ") : "(tidak ada)";
    case "burnIn": return v ? "ya" : "tidak (sidecar)";
    case "selisihNarasiMusikDb": return v === null ? "-" : `>= ${idAngka(v)} dB`;
    case "kontrasMin": return `${idAngka(v)}:1`;
    case "durasiTarget": case "durasiMaks": return `${v} s`;
    case "detikPerAdegan": return `${idAngka(v)} s`;
    case "cps": return `${v} karakter/detik`;
    default: return Array.isArray(v) ? v.join("; ") : String(v);
  }
}

function jejakOverride(ov, atribut) {
  return adalahObjek(ov) && Object.hasOwn(ov, atribut);
}

export function buatBrief(data, k) {
  const j = data.jenis.jenis[k.jenis];
  const a = data.alur.alur[k.alur];
  const { nilai: n } = presetEfektif(data, k);
  const gateAlur = daftarGate(a);
  const setuju = new Map((k.persetujuan ?? []).map((e) => [e.gate, e]));
  const iTahap = a.tahap.findIndex((t) => t.id === k.tahap);
  const tahapKini = a.tahap[iTahap];
  const L = [];
  const baris = (...s) => L.push(...s);
  const [lebarRes, tinggiRes] = [n.resolusi[k.rasio]?.lebar, n.resolusi[k.rasio]?.tinggi];

  baris(`# Brief: ${isi(k.judul)}`, "",
    `_Dihasilkan oleh \`bun run konsep -- brief\` dari konsep.json (id \`${k.id}\`, skema versi ${k.versi}). Jangan diedit tangan: ubah konsep.json lalu hasilkan ulang._`, "");

  baris("## Ringkasan", "", "| Butir | Isi |", "| --- | --- |",
    `| Jenis | ${sel(j.label)} (\`${k.jenis}\`): ${sel(j.deskripsi)} |`,
    `| Alur | ${sel(a.label)} (\`${k.alur}\`): ${sel(a.deskripsi)} |`,
    `| Tahap saat ini | ${tahapKini ? `${tahapKini.id} ${sel(tahapKini.nama)} (${tahapKini.fase})` : "[isi]"} |`,
    `| Rasio dan resolusi | ${k.rasio}${lebarRes ? ` (${lebarRes}x${tinggiRes})` : ""} |`,
    `| Durasi | target ${k.durasiTarget} s, maksimum ${n.durasiMaks} s |`,
    `| fps | ${n.fps} |`, "");

  baris("## Latar dan tujuan", "", `- Tujuan: ${isi(k.tujuan)}`);
  if ((k.alur === "instruksional" || (k.tujuanBelajar ?? []).some(teksIsi))) {
    baris("- Tujuan belajar:");
    const tb = (k.tujuanBelajar ?? []).filter(teksIsi);
    if (tb.length === 0) baris("  - [isi]");
    for (const x of tb) baris(`  - ${x}`);
  }
  baris(`- Tujuan umum jenis ini: ${j.tujuan}`, "");

  baris("## Audiens dan konteks tonton", "",
    `- Audiens: ${isi(k.audiens?.deskripsi)}`,
    `- Bahasa: ${isi(k.audiens?.bahasa)}`,
    `- Konteks tonton: ${(k.audiens?.konteksTonton ?? []).filter(teksIsi).join(", ") || "[isi]"}`,
    `- Ditonton tanpa suara: ${k.audiens?.tanpaSuara ? "ya (caption burn-in dianjurkan)" : "tidak"}`);
  const efAud = audiensEfektif(data, k.audiens?.profil, n);
  if (efAud) {
    const konteksTeks = konteksUkuranTeks(data, k.audiens?.konteksTonton);
    baris(`- Profil audiens: ${k.audiens.profil.map((x) => `${data.audiens.profil[x].label} (\`${x}\`)`).join("; ")}`,
      `- Penyesuaian efektif (yang paling ketat dari preset dan profil; data/audiens.json): caption maksimal ${efAud.cps} cps; kontras teks minimal ${idAngka(efAud.kontrasTeksMin)}:1; kontras non-teks minimal ${idAngka(efAud.kontrasNonTeksMin)}:1; pengali ukuran teks ${idAngka(efAud.pengaliUkuranTeks)}; paling banyak ${efAud.maksElemenBaru} elemen informatif baru per adegan; pengali tempo adegan ${idAngka(efAud.pengaliTempoAdegan)}; pengali kecepatan narasi ${idAngka(efAud.pengaliKecepatanNarasi)}.`,
      `- Ukuran teks minimum: \`ukuranTeks(tinggiFrame, peran, ${idAngka(efAud.pengaliUkuranTeks)}, konteks)\` di runtime${konteksTeks.length ? `; konteks dari konteks tonton: ${konteksTeks.join(", ")}` : ""}.`);
  }
  baris("");

  baris("## Pesan utama", "", isi(k.pesanUtama), "");
  baris("## Nada dan bahasa", "", `- Nada: ${isi(k.nada)}`, `- Narasi: mode ${k.narasi?.mode}, gaya ${k.narasi?.gaya ?? k.nada}`, "");
  baris("## CTA", "", `- Teks: ${isi(k.cta?.teks)}`, `- Tautan: ${k.cta?.tautan ?? "-"}`, "");

  baris("## Struktur adegan", "", "Wajib (urutan):", "");
  n.adegan.wajib.forEach((s, i) => baris(`${i + 1}. ${s}`));
  baris("", "Umum (opsional):", "");
  if (n.adegan.umum.length === 0) baris("- (tidak ada)");
  for (const s of n.adegan.umum) baris(`- ${s}`);
  baris("");

  baris("## Preset terpilih dan tingkat bukti", "",
    `Preset \`${k.jenis}\` dari data/jenis-video.json. Banyak nilai adalah keputusan desain, bukan hasil riset: kolom Bukti menyatakan asal tiap nilai, dan nilai yang ditimpa lewat \`override\` ditandai.`, "",
    "| Atribut | Nilai | Bukti | Rujukan |", "| --- | --- | --- | --- |");
  for (const at of ATRIBUT.filter((x) => x !== "adegan" && x !== "kepatuhan")) {
    const ov = jejakOverride(k.override, at);
    const b = j.bukti[at];
    baris(`| ${at}${ov ? " (override)" : ""} | ${sel(formatNilai(at, n[at]))} | ${ov ? "keputusan proyek" : b.tingkat} | ${ov ? sel(`Alasan: ${isi(k.overrideAlasan)}`) : sel(b.rujukan)} |`);
  }
  baris("", "Pilihan proyek pada konsep.json (menjadi acuan `bun run periksa --konsep`):", "",
    `- Rasio ${k.rasio}; durasi target ${k.durasiTarget} s.`,
    `- Caption: ${k.caption?.burnIn ? "burn-in" : "sidecar"}, mode ${k.caption?.mode}, ${k.caption?.cps} cps, bahasa ${k.caption?.bahasa}.`,
    `- Musik: ${k.musik?.tingkat}${k.musik?.selisihDb == null ? "" : `, selisih narasi-musik >= ${idAngka(k.musik.selisihDb)} dB`}.`,
    `- Kenyaringan: ${k.kenyaringan} (${k.kenyaringan === "siaran" ? "-23 LUFS" : "-16 LUFS"}).`, "");

  baris("## Aturan teknis", "",
    `- Caption: baris maksimal 42 karakter, maksimal 2 baris, ${k.caption?.cps} cps, durasi cue 5/6 sampai 7 detik (Netflix Timed Text Style Guide).`,
    `- Kenyaringan: ${k.kenyaringan === "siaran" ? "-23 LUFS (EBU R 128)" : "-16 LUFS (AES TD1004/TD1008)"}, true peak maksimal -1 dBTP.`,
    `- Kontras teks minimal ${idAngka(n.kontrasMin)}:1 (batas bawah WCAG 2.2 SC 1.4.3: 4,5:1).`,
    "- Kilatan maksimal tiga per detik (WCAG 2.2 SC 2.3.1); area aman grafis 90% (EBU R 95).",
    "- Encoding H.264 High, yuv420p, BT.709 rentang TV, faststart, AAC 48 kHz.", "");

  baris("## Kepatuhan", "", "Dari preset jenis:", "");
  for (const s of n.kepatuhan) baris(`- ${s}`);
  const bk = j.bukti.kepatuhan;
  baris("", `Tingkat bukti kepatuhan: ${bk.tingkat}. ${bk.rujukan}`, "", "Isian proyek:", "",
    `- Dasar hukum: ${(k.kepatuhan?.dasarHukum ?? []).filter(teksIsi).join("; ") || "[isi]"}`,
    `- Izin potret: ${k.kepatuhan?.izinPotret}`,
    `- Klaim: ${k.kepatuhan?.klaim}`,
    `- Data nyata: ${k.kepatuhan?.dataNyata ? "ya" : "tidak"}; sensitif: ${k.kepatuhan?.sensitif ? "ya" : "tidak"}`, "",
    "Pemeriksaan tambahan di luar `bun run periksa` (manual):", "");
  for (const s of j.pemeriksaanTambahan) baris(`- [ ] ${s}`);
  baris("", `Catatan hukum: ${data.jenis.catatanHukum}`, "");

  baris("## Rencana alur dan gate", "",
    `${a.deskripsi} Ronde review: ${a.rondeReview}; overhead ${a.overhead}; ${gateAlur.length} gate${a.urutanKetat ? " (berurutan, tidak boleh dilompati)" : ""}.`, "",
    `Tingkat bukti alur: struktur tahap = ${a.bukti.struktur.tingkat} (${a.bukti.struktur.rujukan}) Jumlah gate dan ronde = ${a.bukti.gateDanRonde.tingkat} (${a.bukti.gateDanRonde.rujukan})`, "");
  a.tahap.forEach((t, i) => {
    baris(`### ${t.id} ${t.nama} (${t.fase})${i === iTahap ? " <- tahap saat ini" : ""}`, "", t.kegiatan, "",
      `- Artefak: ${t.artefak.join("; ")}`,
      `- RACI: R ${t.raci.R.join(", ") || "-"}; A ${t.raci.A.join(", ") || "-"}; C ${t.raci.C.join(", ") || "-"}; I ${t.raci.I.join(", ") || "-"}`);
    if (t.perintah.length) baris("- Perintah:", "", "```bash", ...t.perintah, "```");
    if (t.gate) {
      const e = setuju.get(t.gate.id);
      const ok = e?.status === "disetujui";
      const ket = ok ? ` disetujui oleh ${e.oleh} pada ${e.tanggal}${e.hash ? ` (sha256 ${e.hash.slice(0, 12)}...)` : ""}` : "";
      baris("", `- [${ok ? "x" : " "}] **${t.gate.id} ${t.gate.nama}** (${t.gate.jenis === "review" ? "review" : "gate"}, penyetuju ${t.gate.penyetuju})${t.gate.opsional ? " (opsional)" : ""}${t.gate.butuhHash ? " (berhash)" : ""}${ket}`);
      for (const c of t.gate.kriteria) baris(`  - [${ok ? "x" : " "}] ${c}`);
    }
    baris("");
  });

  baris("## Persetujuan", "", "| Gate | Nama | Penyetuju diminta | Status | Oleh | Tanggal | Hash |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const g of gateAlur) {
    const e = setuju.get(g.id);
    baris(`| ${g.id} | ${sel(g.nama)} | ${g.penyetuju} | ${e?.status ?? "menunggu"} | ${sel(e?.oleh) || "-"} | ${e?.tanggal ?? "-"} | ${e?.hash ? `${e.hash.slice(0, 12)}...` : "-"} |`);
  }
  baris("", "## Kriteria selesai", "");
  for (const s of a.kriteriaSelesai) baris(`- [ ] ${s}`);
  baris("");
  return L.join("\n");
}

// ------------------------------------------------------------------ preset-jenis.js
/** Isi scripts/preset-jenis.js yang dihasilkan dari data/jenis-video.json. */
export function bangunPresetJs(data) {
  return `/*!
 * preset-jenis.js — salinan preset jenis video untuk komposisi (browser).
 * DIHASILKAN dari data/jenis-video.json oleh \`bun run konsep -- sinkron-preset\`;
 * JANGAN diedit tangan (uji \`bun run uji\` gagal bila salinan ini basi).
 * Dimuat lewat <script src=".../preset-jenis.js"></script> sebelum memanggil
 * presetJenis(nama) dari runtime.js. Mengisi window.PRESET_JENIS_DATA.
 */
(function () {
  "use strict";
  var g = typeof window !== "undefined" ? window : globalThis;
  var data = ${JSON.stringify(data.jenis)};
  g.PRESET_JENIS_DATA = data;
  if (typeof module !== "undefined" && module.exports) module.exports = data;
})();
`;
}

// ------------------------------------------------------------------ setuju
export function hashBerkas(berkas) {
  return createHash("sha256").update(readFileSync(berkas)).digest("hex");
}

/** { konsep, galat, catatan[] }: konsep baru (tidak mengubah masukan) atau galat. */
export function terapkanSetuju(data, konsep, { gate, oleh, tanggal, hash = null, berkas = null, catatan = "" }) {
  const info = [];
  const a = data.alur.alur[konsep.alur];
  const dasar = periksaKonsep(data, konsep);
  if (dasar.galat.length) return { konsep: null, galat: `konsep tidak valid: ${dasar.galat[0]}`, catatan: info };
  const gateAlur = daftarGate(a);
  const g = gateAlur.find((x) => x.id === gate);
  if (!g) return { konsep: null, galat: `gate ${JSON.stringify(gate)} tidak dikenal untuk alur ${konsep.alur} (pilihan: ${gateAlur.map((x) => x.id).join(", ")})`, catatan: info };
  if (!teksIsi(oleh)) return { konsep: null, galat: "--oleh wajib diisi (peran atau nama penyetuju)", catatan: info };
  if (!tanggalSah(tanggal)) return { konsep: null, galat: "--tanggal wajib berformat YYYY-MM-DD yang sah (tidak memakai jam sistem demi determinisme)", catatan: info };
  if (g.butuhHash && !hash) return { konsep: null, galat: `gate ${gate} berhash: sertakan --berkas <artefak yang disetujui>`, catatan: info };
  const baru = klon(konsep);
  let e = baru.persetujuan.find((x) => x.gate === gate);
  if (!e) { e = { gate, nama: g.nama, peranDiminta: g.penyetuju, status: "menunggu", oleh: "", tanggal: null, hash: null, berkas: null, catatan: "" }; baru.persetujuan.push(e); }
  if (e.status === "disetujui") return { konsep: null, galat: `gate ${gate} sudah disetujui; perubahan setelah persetujuan berarti versi baru dengan pengesahan ulang`, catatan: info };
  const sebelum = gateAlur.slice(0, gateAlur.indexOf(g)).filter((x) => !x.opsional && baru.persetujuan.find((y) => y.gate === x.id)?.status !== "disetujui");
  if (sebelum.length) {
    if (a.urutanKetat) return { konsep: null, galat: `alur ${konsep.alur} berurutan: gate ${gate} tidak boleh disetujui sebelum ${sebelum.map((x) => x.id).join(", ")}`, catatan: info };
    info.push(`catatan: gate ${gate} disetujui sebelum ${sebelum.map((x) => x.id).join(", ")} (alur ${konsep.alur} tidak mewajibkan urutan)`);
  }
  Object.assign(e, { status: "disetujui", oleh, tanggal, hash: hash ?? null, berkas: berkas ? basename(berkas) : null, catatan: catatan ?? "" });
  const iBaru = Math.min(a.tahap.length - 1, Math.max(a.tahap.findIndex((t) => t.id === baru.tahap), g.indeksTahap + 1));
  baru.tahap = a.tahap[iBaru].id;
  const sesudah = periksaKonsep(data, baru);
  if (sesudah.galat.length) return { konsep: null, galat: `lengkapi konsep sebelum menyetujui ${gate}: ${sesudah.galat[0]}`, catatan: info };
  return { konsep: baru, galat: null, catatan: info };
}

// ------------------------------------------------------------------ CLI
const PETUNJUK = `Pemakaian:
  bun scripts/konsep.mjs baru --jenis J --alur A --out konsep.json [--judul T] [--audiens P[,P2]] [--timpa]
  bun scripts/konsep.mjs daftar [jenis|alur|audiens [kunci]]
  bun scripts/konsep.mjs periksa konsep.json [--video F]
  bun scripts/konsep.mjs brief konsep.json [--out brief.md]
  bun scripts/konsep.mjs setuju konsep.json --gate G --oleh "Peran" --tanggal YYYY-MM-DD [--berkas F] [--catatan T]
  bun scripts/konsep.mjs preset konsep.json
  bun scripts/konsep.mjs sinkron-preset [--periksa] [--keluar F]
Exit: 0 berhasil, 1 salinan preset basi (sinkron-preset --periksa), 2 argumen atau konsep tidak valid.`;

function keluarSalah(pesan) {
  console.error(`konsep.mjs: ${pesan}`);
  process.exit(2);
}

function tabel(kolom, baris) {
  const lebar = kolom.map((c, i) => Math.max(c.length, ...baris.map((b) => String(b[i]).length)));
  const fmt = (b) => b.map((x, i) => String(x).padEnd(lebar[i])).join("  ").trimEnd();
  return [fmt(kolom), fmt(lebar.map((l) => "-".repeat(l))), ...baris.map(fmt)].join("\n");
}

function tabelJenis(data) {
  return tabel(["jenis", "label", "durasi (s)", "rasio", "alur (bawaan pertama)", "ringkasan"],
    Object.entries(data.jenis.jenis).map(([k, j]) => [k, j.label, `${j.nilai.durasiTarget}/${j.nilai.durasiMaks}`, [j.nilai.rasio, ...j.nilai.rasioAlternatif].join(","), j.alurCocok.join(","), j.deskripsi]));
}
function tabelAlur(data) {
  const cocok = (ka) => Object.entries(data.jenis.jenis).filter(([, j]) => j.alurCocok.includes(ka)).map(([k]) => k).join(",");
  return tabel(["alur", "label", "gate", "ronde", "overhead", "jenis cocok"],
    Object.entries(data.alur.alur).map(([k, a]) => [k, a.label, daftarGate(a).filter((g) => g.jenis === "gate").length, a.rondeReview, a.overhead, cocok(k)]));
}

function detailJenis(data, kunci) {
  const j = data.jenis.jenis[kunci];
  const L = [`${kunci}: ${j.label} - ${j.deskripsi}`, `tujuan: ${j.tujuan}`, `alur cocok: ${j.alurCocok.join(", ")} (bawaan ${j.alurBawaan})`, ""];
  for (const at of ATRIBUT) {
    const b = j.bukti[at];
    L.push(`${at.padEnd(22)} [${b.tingkat}] ${formatNilai(at, j.nilai[at]).replace(/\n/g, " ")}`);
    L.push(`${"".padEnd(22)} ${b.rujukan}`);
  }
  return L.join("\n");
}
function tabelAudiens(data) {
  return tabel(["profil", "label", "ukuran teks", "cps", "kontras teks", "elemen baru", "tempo"],
    Object.entries(data.audiens.profil).map(([k, p]) => [k, p.label, `x${idAngka(p.nilai.pengaliUkuranTeks)}`, p.nilai.cps, `${idAngka(p.nilai.kontrasTeksMin)}:1`, p.nilai.maksElemenBaru, `x${idAngka(p.nilai.pengaliTempoAdegan)}`]));
}
function detailAudiens(data, kunci) {
  const p = data.audiens.profil[kunci];
  const L = [`${kunci}: ${p.label} - ${p.deskripsi}`, ""];
  for (const [at, v] of Object.entries(p.nilai)) {
    L.push(`${at.padEnd(24)} [${p.bukti[at].tingkat}] ${v}`);
    L.push(`${"".padEnd(24)} ${p.bukti[at].rujukan}`);
  }
  L.push("", data.audiens.aturanKomposisi);
  return L.join("\n");
}
function detailAlur(data, kunci) {
  const a = data.alur.alur[kunci];
  const L = [`${kunci}: ${a.label} - ${a.deskripsi}`, `kapan dipakai: ${a.kapanDipakai}`, `ronde review ${a.rondeReview}; overhead ${a.overhead}${a.urutanKetat ? "; gate berurutan" : ""}`,
    `bukti struktur [${a.bukti.struktur.tingkat}]: ${a.bukti.struktur.rujukan}`, `bukti gate dan ronde [${a.bukti.gateDanRonde.tingkat}]: ${a.bukti.gateDanRonde.rujukan}`, ""];
  for (const t of a.tahap) {
    L.push(`${t.id} ${t.fase.padEnd(10)} ${t.nama}${t.gate ? `  -> ${t.gate.id} ${t.gate.nama} (penyetuju ${t.gate.penyetuju})` : ""}`);
  }
  return L.join("\n");
}

async function utama() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        jenis: { type: "string" }, alur: { type: "string" }, audiens: { type: "string" }, out: { type: "string" }, judul: { type: "string" },
        gate: { type: "string" }, oleh: { type: "string" }, tanggal: { type: "string" }, berkas: { type: "string" },
        catatan: { type: "string" }, video: { type: "string" }, keluar: { type: "string" },
        timpa: { type: "boolean", default: false }, periksa: { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    keluarSalah(`${e.message}\n${PETUNJUK}`);
  }
  const { values: o, positionals: pos } = args;
  const [perintah, ...sisa] = pos;
  if (o.help || perintah === undefined) {
    console.log(PETUNJUK);
    process.exit(o.help ? 0 : 2);
  }
  const data = muatData();
  const bacaBerkas = () => {
    if (sisa.length !== 1) keluarSalah(`${perintah}: harus tepat satu berkas konsep.json`);
    if (!existsSync(sisa[0])) keluarSalah(`berkas tidak ditemukan: ${sisa[0]}`);
    return sisa[0];
  };
  const tulis = (berkas, isiTeks) => {
    mkdirSync(dirname(berkas) || ".", { recursive: true });
    writeFileSync(berkas, isiTeks);
  };

  switch (perintah) {
    case "baru": {
      if (!o.jenis || !o.alur) {
        console.error("Pilih --jenis dan --alur.\n");
        console.error("Jenis video:\n" + tabelJenis(data) + "\n\nAlur produksi:\n" + tabelAlur(data));
        console.error("\nContoh: bun run konsep -- baru --jenis panduan --alur instruksional --out konsep.json --judul \"Judul\"");
        process.exit(2);
      }
      if (!data.jenis.jenis[o.jenis]) keluarSalah(`jenis tidak dikenal: ${o.jenis} (pilihan: ${Object.keys(data.jenis.jenis).join(", ")})`);
      if (!data.alur.alur[o.alur]) keluarSalah(`alur tidak dikenal: ${o.alur} (pilihan: ${Object.keys(data.alur.alur).join(", ")})`);
      if (!o.out) keluarSalah("--out wajib (berkas konsep.json tujuan)");
      if (existsSync(o.out) && !o.timpa) keluarSalah(`${o.out} sudah ada; pakai --timpa untuk menimpa (persetujuan yang tercatat akan hilang)`);
      const j = data.jenis.jenis[o.jenis];
      if (!j.alurCocok.includes(o.alur)) console.error(`catatan: alur ${o.alur} bukan rekomendasi untuk jenis ${o.jenis} (rekomendasi: ${j.alurCocok.join(", ")})`);
      const profil = o.audiens === undefined ? [] : o.audiens.split(",").map((x) => x.trim()).filter(Boolean);
      for (const x of profil) if (!data.audiens.profil[x]) keluarSalah(`profil audiens tidak dikenal: ${x} (pilihan: ${Object.keys(data.audiens.profil).join(", ")})`);
      tulis(o.out, tulisJson(buatKonsep(data, { jenis: o.jenis, alur: o.alur, judul: o.judul ?? "", audiens: profil })));
      console.log(`konsep ditulis: ${o.out} (jenis ${o.jenis}, alur ${o.alur})`);
      return 0;
    }
    case "daftar": {
      const [bagian, kunci] = sisa;
      if (bagian !== undefined && !["jenis", "alur", "audiens"].includes(bagian)) keluarSalah(`daftar: pilih jenis, alur, atau audiens, bukan "${bagian}"`);
      if (bagian === "audiens") {
        if (kunci !== undefined && !data.audiens.profil[kunci]) keluarSalah(`audiens tidak dikenal: ${kunci} (pilihan: ${Object.keys(data.audiens.profil).join(", ")})`);
        console.log(kunci === undefined ? "Profil audiens (data/audiens.json):\n" + tabelAudiens(data) : detailAudiens(data, kunci));
        return 0;
      }
      if (kunci !== undefined) {
        const sumber = bagian === "jenis" ? data.jenis.jenis : data.alur.alur;
        if (!sumber[kunci]) keluarSalah(`${bagian} tidak dikenal: ${kunci} (pilihan: ${Object.keys(sumber).join(", ")})`);
        console.log(bagian === "jenis" ? detailJenis(data, kunci) : detailAlur(data, kunci));
        return 0;
      }
      if (bagian !== "alur") console.log("Jenis video (durasi = target/maks):\n" + tabelJenis(data));
      if (!bagian) console.log("");
      if (bagian !== "jenis") console.log("Alur produksi:\n" + tabelAlur(data));
      console.log("\nRincian: bun run konsep -- daftar jenis <kunci> | daftar alur <kunci> | daftar audiens [kunci]");
      return 0;
    }
    case "periksa": {
      const berkas = bacaBerkas();
      const r = bacaKonsepBerkas(berkas, data);
      const galat = [...r.galat];
      if (o.video !== undefined && r.konsep && galat.length === 0) {
        if (!existsSync(o.video)) keluarSalah(`--video: berkas tidak ditemukan: ${o.video}`);
        const a = data.alur.alur[r.konsep.alur];
        const gh = daftarGate(a).filter((g) => g.butuhHash).pop();
        const e = gh && r.konsep.persetujuan.find((x) => x.gate === gh.id);
        if (!gh) galat.push("--video: alur ini tidak punya gate berhash");
        else if (e?.status !== "disetujui") galat.push(`--video: gate ${gh.id} belum disetujui`);
        else if (e.hash !== hashBerkas(o.video)) galat.push(`--video: hash ${basename(o.video)} tidak sama dengan hash yang disetujui di gate ${gh.id}`);
      }
      const k = r.konsep;
      console.log(`Konsep: ${berkas}${k ? ` (jenis ${k.jenis}, alur ${k.alur}, tahap ${k.tahap})` : ""}`);
      for (const g of galat) console.log(`  GAGAL       ${g}`);
      for (const p of r.peringatan) console.log(`  PERINGATAN  ${p}`);
      console.log(`Hasil: ${galat.length ? "GAGAL" : "LOLOS"} (${galat.length} galat, ${r.peringatan.length} peringatan)`);
      return galat.length ? 2 : 0;
    }
    case "brief": {
      const berkas = bacaBerkas();
      const r = bacaKonsepBerkas(berkas, data);
      if (r.galat.length) keluarSalah(`konsep tidak valid: ${r.galat.join("; ")}`);
      const teks = buatBrief(data, r.konsep);
      if (o.out) { tulis(o.out, teks); console.log(`brief ditulis: ${o.out}`); } else process.stdout.write(teks);
      return 0;
    }
    case "setuju": {
      const berkas = bacaBerkas();
      const r = bacaKonsepBerkas(berkas, data);
      if (r.galat.length) keluarSalah(`konsep tidak valid: ${r.galat[0]}`);
      if (!o.gate) keluarSalah("--gate wajib");
      let hash = null;
      if (o.berkas !== undefined) {
        if (!existsSync(o.berkas) || !statSync(o.berkas).isFile()) keluarSalah(`--berkas: berkas tidak ditemukan: ${o.berkas}`);
        hash = hashBerkas(o.berkas);
      }
      const h = terapkanSetuju(data, r.konsep, { gate: o.gate, oleh: o.oleh, tanggal: o.tanggal, hash, berkas: o.berkas, catatan: o.catatan ?? "" });
      if (h.galat) keluarSalah(h.galat);
      for (const c of h.catatan) console.error(c);
      tulis(berkas, tulisJson(h.konsep));
      console.log(`gate ${o.gate} disetujui oleh ${o.oleh} (${o.tanggal})${hash ? `, sha256 ${hash}` : ""}; tahap sekarang ${h.konsep.tahap}`);
      return 0;
    }
    case "preset": {
      const berkas = bacaBerkas();
      const r = bacaKonsepBerkas(berkas, data);
      if (r.galat.length) keluarSalah(`konsep tidak valid: ${r.galat.join("; ")}`);
      const efAud = audiensEfektif(data, r.konsep.audiens?.profil, r.efektif);
      process.stdout.write(tulisJson({
        jenis: r.konsep.jenis,
        preset: r.efektif,
        ...(efAud ? { audiens: { profil: r.konsep.audiens.profil, efektif: efAud, konteksUkuranTeks: konteksUkuranTeks(data, r.konsep.audiens.konteksTonton) } } : {}),
      }));
      return 0;
    }
    case "sinkron-preset": {
      const tujuan = o.keluar ?? BERKAS.presetJs;
      const baru = bangunPresetJs(data);
      if (o.periksa) {
        const lama = existsSync(tujuan) ? readFileSync(tujuan, "utf8") : null;
        if (lama === baru) { console.log(`${tujuan} sinkron dengan data/jenis-video.json`); return 0; }
        console.error(`${tujuan} basi atau tidak ada; jalankan: bun run konsep -- sinkron-preset`);
        return 1;
      }
      tulis(tujuan, baru);
      console.log(`ditulis: ${tujuan}`);
      return 0;
    }
    default:
      keluarSalah(`subperintah tidak dikenal: ${perintah}\n${PETUNJUK}`);
  }
}

if (import.meta.main) {
  process.exit(await utama());
}
