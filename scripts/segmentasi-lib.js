/**
 * awvd / segmentasi-lib.js — segmentasi orang lokal: bingkai RGB -> mask alfa 8 bit.
 *
 * Modul murni untuk tahap pembuatan aset beku (render tidak pernah memanggil modul ini). Isi:
 *   - registri model (`data/model-segmentasi.json`, skema 1) dan pemvalidasinya; sha256 bobot WAJIB
 *     dan fail-closed untuk model registri, hanya peringatan untuk model kustom tanpa sha256;
 *   - pemuatan onnxruntime-node OPSIONAL dari jalur `AWVD_ORT` (bukan dependensi awvd): tanpa itu
 *     GalatSegmentasi berpesan jelas dan tidak ada keluaran;
 *   - pra-proses RGB -> tensor NCHW, pasca-proses keluaran model -> mask 8 bit, ambang halus
 *     (smoothstep), dan pelicinan temporal EMA yang berurutan dan deterministik.
 *
 * Determinisme: seluruh perubahan ukuran, kuantisasi, ambang, dan EMA memakai aritmetika bilangan
 * bulat (bobot titik tetap 16 bit) atau operasi dasar IEEE (+ - * /), tanpa Math.exp dan kawan-kawan,
 * sehingga tidak bergantung pada kernel atau jumlah thread. Satu-satunya langkah yang bergantung
 * mesin adalah inferensi onnxruntime (versi, CPU, thread); itu sebabnya mask dibekukan ke cache dan
 * kunci cache memuat versi ORT dan sha256 bobot (`info` dari segmenter).
 *
 * Keamanan: bobot adalah data tak tepercaya. Berkas dibaca SEKALI ke memori, di-hash, lalu byte yang
 * sama diberikan ke ORT (tanpa jeda antara pemeriksaan dan pemakaian). `AWVD_ORT` menunjuk kode yang
 * akan dijalankan, jadi tunjuk hanya paket yang Anda pasang sendiri.
 *
 * Karya asli repo ini (dasar: dokumentasi publik onnxruntime dan kartu model MediaPipe/MODNet).
 * Rincian di docs/segmentasi-latar.md. Tidak ada akses jaringan di modul ini.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Naik bila cara pra/pasca-proses atau pelicinan berubah (masuk kunci cache pemanggil). */
export const VERSI_SEGMENTASI = 1;
export const VERSI_REGISTRI = 1;
/** Ukuran bobot maksimum (byte) yang dibaca ke memori. */
export const BATAS_BOBOT_BYTE = 512 * 1024 * 1024;
const BATAS_SISI = 8192;
const BATAS_PIKSEL = 16 * 1024 * 1024;
/** Lisensi bobot dan kode yang diterima registri bawaan (permisif). */
export const LISENSI_PERMISIF = ["Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC"];

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
export const JALUR_REGISTRI_BAWAAN = join(akar, "data", "model-segmentasi.json");

/**
 * Galat segmentasi. `kode` stabil untuk uji; `keluar` = kode keluar CLI yang disarankan:
 * 1 = lingkungan (ORT atau bobot tidak ada, inferensi gagal), 2 = validasi (skema, sha256, opsi).
 */
export class GalatSegmentasi extends Error {
  constructor(pesan, kode) {
    super(pesan);
    this.name = "GalatSegmentasi";
    this.kode = kode;
    this.keluar = KELUAR[kode] ?? 1;
  }
}
const KELUAR = {
  "ort-tidak-diset": 1, "ort-tidak-ditemukan": 1, "ort-tidak-valid": 1, "bobot-tidak-ada": 1, "ort-gagal": 1,
  "registri-tidak-valid": 2, "model-tidak-dikenal": 2, "sha256-salah": 2, "ukuran-salah": 2, "opsi-tidak-valid": 2,
  "model-tidak-cocok": 2, "keluaran-tidak-valid": 2,
};

const adalahObjek = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const adalahInt = (x) => Number.isInteger(x);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ------------------------------------------------------------------ registri
const POLA_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const POLA_BERKAS = /^[A-Za-z0-9][A-Za-z0-9._-]*\.onnx$/;
const POLA_SHA = /^[0-9a-f]{64}$/;
const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
const POLA_HTTPS = /^https:\/\/[^\s/]+\/\S*$/;
const KUNCI_MODEL = new Set(["nama", "berkas", "sha256", "ukuranByte", "tanggalSha256", "lisensiKode", "lisensiBobot", "sumberAsli", "dasarLisensi", "unduh", "masukan", "keluaran", "catatan"]);
const KUNCI_UNDUH = new Set(["url", "jenis", "revisi", "labelLisensiMirror"]);
const KUNCI_MASUKAN = new Set(["nama", "tetap", "dinamis", "bagi", "kurang"]);
const KUNCI_DINAMIS = new Set(["kelipatan", "min", "maks", "sisiPanjangBawaan"]);

function periksaKunci(obj, boleh, jalur, galat) {
  for (const k of Object.keys(obj)) if (!boleh.has(k)) galat.push(`${jalur}: kunci tidak dikenal "${k}"`);
}

/**
 * Memvalidasi satu objek registri (skema 1). `kustom` = registri buatan pemakai: sha256, ukuranByte,
 * tanggalSha256, sumberAsli, dan lisensi permisif tidak diwajibkan; lisensi non-permisif dan
 * sha256 yang absen menjadi peringatan. Mengembalikan { galat: string[], peringatan: string[] }.
 */
export function validasiRegistri(reg, { kustom = false } = {}) {
  const galat = [], peringatan = [];
  if (!adalahObjek(reg)) return { galat: ["registri harus berupa objek JSON"], peringatan };
  periksaKunci(reg, new Set(["versi", "catatan", "model"]), "registri", galat);
  if (reg.versi !== VERSI_REGISTRI) galat.push(`versi harus ${VERSI_REGISTRI}`);
  if (!adalahObjek(reg.model) || Object.keys(reg.model).length === 0) {
    galat.push('"model" harus objek berisi minimal satu model');
    return { galat, peringatan };
  }
  for (const [id, m] of Object.entries(reg.model)) {
    const j = `model.${id}`;
    if (!POLA_ID.test(id)) galat.push(`${j}: id harus cocok ${POLA_ID}`);
    if (!adalahObjek(m)) { galat.push(`${j}: harus objek`); continue; }
    periksaKunci(m, KUNCI_MODEL, j, galat);
    if (typeof m.nama !== "string" || !m.nama.trim()) galat.push(`${j}.nama wajib (teks tidak kosong)`);
    if (typeof m.berkas !== "string" || !POLA_BERKAS.test(m.berkas)) galat.push(`${j}.berkas wajib: nama berkas .onnx tanpa pemisah jalur`);
    // integritas
    if (m.sha256 === undefined || m.sha256 === null) {
      if (kustom) peringatan.push(`${j}: tanpa sha256, bobot tidak diverifikasi (tanggung jawab pemakai)`);
      else galat.push(`${j}.sha256 wajib untuk model registri (64 heksadesimal huruf kecil)`);
    } else if (typeof m.sha256 !== "string" || !POLA_SHA.test(m.sha256)) {
      galat.push(`${j}.sha256 harus 64 heksadesimal huruf kecil`);
    }
    if (m.ukuranByte === undefined || m.ukuranByte === null) {
      if (!kustom) galat.push(`${j}.ukuranByte wajib untuk model registri`);
    } else if (!adalahInt(m.ukuranByte) || m.ukuranByte < 1 || m.ukuranByte > BATAS_BOBOT_BYTE) {
      galat.push(`${j}.ukuranByte harus bilangan bulat 1..${BATAS_BOBOT_BYTE}`);
    }
    if (m.tanggalSha256 === undefined || m.tanggalSha256 === null) {
      if (!kustom) galat.push(`${j}.tanggalSha256 wajib untuk model registri (YYYY-MM-DD)`);
    } else if (typeof m.tanggalSha256 !== "string" || !POLA_TANGGAL.test(m.tanggalSha256)) {
      galat.push(`${j}.tanggalSha256 harus YYYY-MM-DD`);
    }
    // lisensi
    for (const k of ["lisensiKode", "lisensiBobot"]) {
      const v = m[k];
      if (typeof v !== "string" || !v.trim()) { galat.push(`${j}.${k} wajib (dari sumber asli penulis)`); continue; }
      if (!LISENSI_PERMISIF.includes(v)) {
        if (kustom) peringatan.push(`${j}.${k} "${v}" bukan lisensi permisif yang dikenal (${LISENSI_PERMISIF.join(", ")}); tinjau syaratnya`);
        else galat.push(`${j}.${k} "${v}" bukan lisensi permisif yang diterima registri bawaan (${LISENSI_PERMISIF.join(", ")})`);
      }
    }
    if (m.sumberAsli === undefined || m.sumberAsli === null) {
      if (!kustom) galat.push(`${j}.sumberAsli wajib untuk model registri (URL https sumber asli penulis)`);
    } else if (typeof m.sumberAsli !== "string" || !POLA_HTTPS.test(m.sumberAsli)) galat.push(`${j}.sumberAsli harus URL https`);
    if (m.dasarLisensi !== undefined && (typeof m.dasarLisensi !== "string" || !POLA_HTTPS.test(m.dasarLisensi))) galat.push(`${j}.dasarLisensi harus URL https`);
    if (m.catatan !== undefined && typeof m.catatan !== "string") galat.push(`${j}.catatan harus teks`);
    // unduh
    if (m.unduh !== undefined) {
      if (!adalahObjek(m.unduh)) galat.push(`${j}.unduh harus objek`);
      else {
        periksaKunci(m.unduh, KUNCI_UNDUH, `${j}.unduh`, galat);
        if (typeof m.unduh.url !== "string" || !POLA_HTTPS.test(m.unduh.url)) galat.push(`${j}.unduh.url harus URL https`);
        if (!["resmi", "konversi-komunitas"].includes(m.unduh.jenis)) galat.push(`${j}.unduh.jenis harus "resmi" atau "konversi-komunitas"`);
        for (const k of ["revisi", "labelLisensiMirror"]) if (m.unduh[k] !== undefined && typeof m.unduh[k] !== "string") galat.push(`${j}.unduh.${k} harus teks`);
      }
    } else if (!kustom) galat.push(`${j}.unduh wajib untuk model registri (tautan unduh yang dapat diperiksa pemakai)`);
    // masukan dan keluaran
    const mk = m.masukan;
    if (!adalahObjek(mk)) galat.push(`${j}.masukan wajib (objek)`);
    else {
      periksaKunci(mk, KUNCI_MASUKAN, `${j}.masukan`, galat);
      if (mk.nama !== undefined && (typeof mk.nama !== "string" || !mk.nama)) galat.push(`${j}.masukan.nama harus teks`);
      const ada = (mk.tetap !== undefined) + (mk.dinamis !== undefined);
      if (ada !== 1) galat.push(`${j}.masukan harus memuat tepat satu dari "tetap" dan "dinamis"`);
      if (mk.tetap !== undefined) {
        if (!Array.isArray(mk.tetap) || mk.tetap.length !== 2 || !mk.tetap.every((x) => adalahInt(x) && x >= 16 && x <= 4096)) galat.push(`${j}.masukan.tetap harus [lebar, tinggi] bulat 16..4096`);
      }
      if (mk.dinamis !== undefined) {
        const d = mk.dinamis;
        if (!adalahObjek(d)) galat.push(`${j}.masukan.dinamis harus objek`);
        else {
          periksaKunci(d, KUNCI_DINAMIS, `${j}.masukan.dinamis`, galat);
          const ok = adalahInt(d.kelipatan) && d.kelipatan >= 1 && d.kelipatan <= 256
            && adalahInt(d.min) && adalahInt(d.maks) && d.min >= 16 && d.maks <= 4096 && d.min <= d.maks
            && adalahInt(d.sisiPanjangBawaan) && d.sisiPanjangBawaan >= d.min && d.sisiPanjangBawaan <= d.maks;
          if (!ok) galat.push(`${j}.masukan.dinamis: kelipatan (1..256), min (>=16), maks (<=4096), sisiPanjangBawaan (di antara min dan maks) wajib bilangan bulat`);
        }
      }
      for (const [k, wajibPositif] of [["bagi", true], ["kurang", false]]) {
        if (mk[k] === undefined) continue;
        if (typeof mk[k] !== "number" || !Number.isFinite(mk[k]) || (wajibPositif && mk[k] <= 0)) galat.push(`${j}.masukan.${k} harus bilangan hingga${wajibPositif ? " > 0" : ""}`);
      }
    }
    if (m.keluaran !== undefined) {
      if (!adalahObjek(m.keluaran) || Object.keys(m.keluaran).some((k) => k !== "nama") || (m.keluaran.nama !== undefined && typeof m.keluaran.nama !== "string")) galat.push(`${j}.keluaran harus objek { nama?: teks }`);
    }
  }
  return { galat, peringatan };
}

function bacaJson(jalur, apa) {
  let teks;
  try { teks = readFileSync(jalur, "utf8"); } catch (e) { throw new GalatSegmentasi(`${apa} tidak terbaca (${jalur}): ${e.code ?? e.message}`, "registri-tidak-valid"); }
  try { return JSON.parse(teks); } catch (e) { throw new GalatSegmentasi(`${apa} bukan JSON valid (${jalur}): ${e.message}`, "registri-tidak-valid"); }
}

/**
 * Memuat registri: bawaan (`data/model-segmentasi.json`, divalidasi ketat) digabung dengan registri
 * kustom pemakai (opsional, `kustom` = jalur atau `AWVD_REGISTRI_SEGMENTASI`). Id kustom tidak boleh
 * menimpa id bawaan (mencegah penurunan paksa dari sha256 wajib ke tanpa sha256). Mengembalikan
 * { model: { id: spesifikasi + {kustom: bool} }, peringatan: string[] }.
 */
export function muatRegistri({ kustom = null, env = process.env, jalurBawaan = JALUR_REGISTRI_BAWAAN } = {}) {
  const peringatan = [];
  const bawaan = bacaJson(jalurBawaan, "registri bawaan");
  const v = validasiRegistri(bawaan);
  if (v.galat.length) throw new GalatSegmentasi(`registri bawaan tidak valid:\n${v.galat.map((x) => `  - ${x}`).join("\n")}`, "registri-tidak-valid");
  const model = {};
  for (const [id, m] of Object.entries(bawaan.model)) model[id] = { ...m, kustom: false };
  const jalurKustom = kustom || env.AWVD_REGISTRI_SEGMENTASI || null;
  if (jalurKustom) {
    const p = resolve(jalurKustom);
    const isi = bacaJson(p, "registri kustom");
    const vk = validasiRegistri(isi, { kustom: true });
    if (vk.galat.length) throw new GalatSegmentasi(`registri kustom tidak valid (${p}):\n${vk.galat.map((x) => `  - ${x}`).join("\n")}`, "registri-tidak-valid");
    peringatan.push(...vk.peringatan);
    for (const [id, m] of Object.entries(isi.model)) {
      if (id in model) throw new GalatSegmentasi(`registri kustom tidak boleh memakai id bawaan "${id}" (${p}); pakai id lain`, "registri-tidak-valid");
      model[id] = { ...m, kustom: true };
    }
  }
  return { model, peringatan };
}

// ------------------------------------------------------------------ bobot
/**
 * Mencari berkas bobot: `jalur` eksplisit, lalu `AWVD_MODEL_DIR/<berkas registri>`. Melempar
 * GalatSegmentasi("bobot-tidak-ada") dengan petunjuk unduh bila tidak ada.
 */
export function cariBobot(id, spec, { jalur = null, env = process.env } = {}) {
  let p = null;
  if (jalur) p = resolve(jalur);
  else if (env.AWVD_MODEL_DIR) p = resolve(env.AWVD_MODEL_DIR, spec.berkas);
  if (!p) {
    throw new GalatSegmentasi(
      `berkas bobot model "${id}" belum ditentukan: set AWVD_MODEL_DIR (folder berisi ${spec.berkas}) atau berikan jalur eksplisit.${petunjukUnduh(spec)}`,
      "bobot-tidak-ada");
  }
  if (!existsSync(p) || !statSync(p).isFile()) {
    throw new GalatSegmentasi(`berkas bobot model "${id}" tidak ditemukan: ${p}.${petunjukUnduh(spec)}`, "bobot-tidak-ada");
  }
  return p;
}
function petunjukUnduh(spec) {
  const u = spec.unduh?.url;
  return u ? ` Unduh manual dari ${u} (${spec.unduh.jenis}), simpan sebagai ${spec.berkas}; awvd tidak mengunduh dan tidak membundel bobot.` : "";
}

/**
 * Membaca bobot sekali, memeriksa ukuran dan sha256, dan mengembalikan { data, sha256, ukuranByte }.
 * Model registri: ukuran dan sha256 tidak cocok -> GalatSegmentasi (fail-closed). Model kustom:
 * tanpa sha256 hanya `peringatan`; sha256 yang dideklarasikan tetap wajib cocok (deklarasi yang
 * tidak cocok berarti berkas bukan yang dimaksud, jadi ditolak).
 */
export function verifikasiBobot(id, spec, jalur, { peringatan = [] } = {}) {
  let st;
  try { st = statSync(jalur); } catch (e) { throw new GalatSegmentasi(`berkas bobot tidak terbaca (${jalur}): ${e.code ?? e.message}`, "bobot-tidak-ada"); }
  if (!st.isFile()) throw new GalatSegmentasi(`bobot bukan berkas biasa: ${jalur}`, "bobot-tidak-ada");
  if (st.size > BATAS_BOBOT_BYTE) throw new GalatSegmentasi(`bobot model "${id}" terlalu besar (${st.size} byte, batas ${BATAS_BOBOT_BYTE})`, "ukuran-salah");
  if (spec.ukuranByte !== undefined && spec.ukuranByte !== null && st.size !== spec.ukuranByte) {
    throw new GalatSegmentasi(`ukuran bobot model "${id}" tidak cocok: ${st.size} byte, registri ${spec.ukuranByte} byte (${jalur}); bobot ditolak`, "ukuran-salah");
  }
  const data = readFileSync(jalur);
  if (data.length > BATAS_BOBOT_BYTE) throw new GalatSegmentasi(`bobot model "${id}" terlalu besar`, "ukuran-salah");
  const hash = sha256(data);
  if (spec.sha256) {
    if (hash !== spec.sha256) {
      throw new GalatSegmentasi(`sha256 bobot model "${id}" tidak cocok (${jalur}):\n  terhitung: ${hash}\n  registri:  ${spec.sha256}\nBobot ditolak sebelum dimuat ke onnxruntime. Unduh ulang dari sumber yang benar.`, "sha256-salah");
    }
  } else {
    peringatan.push(`model kustom "${id}" tidak punya sha256: bobot ${jalur} TIDAK diverifikasi (sha256 terhitung ${hash}); cantumkan di registri kustom agar terkunci`);
  }
  return { data, sha256: hash, ukuranByte: data.length };
}

// ------------------------------------------------------------------ onnxruntime opsional
const PETUNJUK_ORT = "awvd tidak membundel onnxruntime. Pasang onnxruntime-node (MIT) di luar repo ini (mis. `bun add onnxruntime-node` di folder terpisah) lalu tunjuk lewat AWVD_ORT (jalur folder paket atau berkas masuknya). Langkahnya ada di docs/segmentasi-latar.md. Hanya Linux x64 yang diuji.";

/**
 * Memuat modul onnxruntime-node dari `AWVD_ORT`. Mengembalikan { ort, jalur, versi }. Melempar
 * GalatSegmentasi bila env tidak diset, jalur tidak ada, atau modul tidak memiliki
 * InferenceSession dan Tensor.
 */
export function pastikanOrt(env = process.env) {
  const mentah = env.AWVD_ORT;
  if (!mentah) throw new GalatSegmentasi(`onnxruntime belum ditunjuk (AWVD_ORT kosong).\n${PETUNJUK_ORT}`, "ort-tidak-diset");
  const jalur = resolve(mentah);
  if (!existsSync(jalur)) throw new GalatSegmentasi(`AWVD_ORT menunjuk jalur yang tidak ada: ${jalur}\n${PETUNJUK_ORT}`, "ort-tidak-ditemukan");
  let modul;
  try { modul = createRequire(import.meta.url)(jalur); } catch (e) {
    throw new GalatSegmentasi(`modul onnxruntime tidak dapat dimuat dari ${jalur}: ${String(e?.message ?? e).split("\n")[0]}\n${PETUNJUK_ORT}`, "ort-tidak-valid");
  }
  const ort = typeof modul?.InferenceSession?.create === "function" ? modul : modul?.default;
  if (typeof ort?.InferenceSession?.create !== "function" || typeof ort?.Tensor !== "function") {
    throw new GalatSegmentasi(`${jalur} bukan modul onnxruntime (InferenceSession.create atau Tensor tidak ada).\n${PETUNJUK_ORT}`, "ort-tidak-valid");
  }
  const versi = String(ort.env?.versions?.node ?? ort.env?.versions?.common ?? "tidak-diketahui");
  return { ort, jalur, versi };
}

// ------------------------------------------------------------------ ubah ukuran (bilangan bulat)
function petaTitik(sumber, tujuan) {
  const a = new Int32Array(tujuan), b = new Int32Array(tujuan), f = new Int32Array(tujuan);
  const maks = sumber - 1;
  for (let x = 0; x < tujuan; x++) {
    let pos = Math.floor(((2 * x + 1) * sumber * 32768) / tujuan) - 32768; // titik tengah piksel, 16.16
    if (pos < 0) pos = 0;
    let i = pos >> 16, w = pos & 0xffff;
    if (i >= maks) { i = maks; w = 0; }
    a[x] = i; b[x] = i < maks ? i + 1 : i; f[x] = w;
  }
  return { a, b, f };
}

/**
 * Interpolasi bilinear titik tengah piksel dengan bobot titik tetap 16 bit (hanya bilangan bulat,
 * identik di semua mesin). `src` = Uint8Array berselang-seling `kanal` kanal.
 */
export function ubahUkuran(src, sl, st, kanal, dl, dt) {
  if (src.length !== sl * st * kanal) throw new GalatSegmentasi(`ubahUkuran: panjang data ${src.length} != ${sl}x${st}x${kanal}`, "opsi-tidak-valid");
  if (sl === dl && st === dt) return Uint8Array.from(src);
  const hx = petaTitik(sl, dl), vy = petaTitik(st, dt);
  const tmp = new Int32Array(st * dl * kanal); // nilai x 65536
  for (let y = 0; y < st; y++) {
    const baris = y * sl * kanal;
    const keluar = y * dl * kanal;
    for (let x = 0; x < dl; x++) {
      const p = baris + hx.a[x] * kanal, q = baris + hx.b[x] * kanal, w = hx.f[x], iw = 65536 - w;
      for (let c = 0; c < kanal; c++) tmp[keluar + x * kanal + c] = src[p + c] * iw + src[q + c] * w;
    }
  }
  const out = new Uint8Array(dl * dt * kanal);
  const lebarBaris = dl * kanal;
  for (let y = 0; y < dt; y++) {
    const r0 = vy.a[y] * lebarBaris, r1 = vy.b[y] * lebarBaris, w = vy.f[y], iw = 65536 - w;
    const keluar = y * lebarBaris;
    for (let i = 0; i < lebarBaris; i++) {
      // jumlah <= 255 * 2^32 < 2^53: tepat dalam double; bagi 2^32 tepat; dibulatkan ke terdekat
      out[keluar + i] = Math.floor((tmp[r0 + i] * iw + tmp[r1 + i] * w + 2147483648) / 4294967296);
    }
  }
  return out;
}

// ------------------------------------------------------------------ pra-proses
function periksaBingkai(rgb, lebar, tinggi) {
  if (!adalahInt(lebar) || !adalahInt(tinggi) || lebar < 1 || tinggi < 1 || lebar > BATAS_SISI || tinggi > BATAS_SISI || lebar * tinggi > BATAS_PIKSEL) {
    throw new GalatSegmentasi(`ukuran bingkai ${lebar}x${tinggi} tidak valid (1..${BATAS_SISI} per sisi, maks ${BATAS_PIKSEL} piksel)`, "opsi-tidak-valid");
  }
  if (!(rgb instanceof Uint8Array) || rgb.length !== lebar * tinggi * 3) {
    throw new GalatSegmentasi(`bingkai harus Uint8Array rgb24 sepanjang ${lebar * tinggi * 3} byte (dapat ${rgb?.length})`, "opsi-tidak-valid");
  }
}

/**
 * Ukuran masukan model [lebar, tinggi] untuk bingkai `lebar` x `tinggi`. Model "tetap": harus sama
 * dengan ukuran tetap. Model "dinamis": `ukuranInput` = [w, h] (kelipatan dan rentang dari registri)
 * atau satu bilangan (sisi panjang); bawaan = sisi panjang `sisiPanjangBawaan` dengan rasio bingkai,
 * dibulatkan ke kelipatan (mis. 1280x720 -> 512x288 untuk MODNet).
 */
export function ukuranMasukan(spec, lebar, tinggi, ukuranInput = null) {
  const mk = spec.masukan;
  if (mk.tetap) {
    if (ukuranInput !== null && ukuranInput !== undefined) {
      const u = Array.isArray(ukuranInput) ? ukuranInput : null;
      if (!u || u[0] !== mk.tetap[0] || u[1] !== mk.tetap[1]) throw new GalatSegmentasi(`model berukuran masukan tetap ${mk.tetap.join("x")}; ukuranInput ${JSON.stringify(ukuranInput)} ditolak`, "opsi-tidak-valid");
    }
    return [...mk.tetap];
  }
  const { kelipatan: k, min, maks, sisiPanjangBawaan } = mk.dinamis;
  if (Array.isArray(ukuranInput)) {
    const [w, h] = ukuranInput;
    if (![w, h].every((x) => adalahInt(x) && x >= min && x <= maks && x % k === 0)) {
      throw new GalatSegmentasi(`ukuranInput [${w}, ${h}] harus bilangan bulat kelipatan ${k} dalam ${min}..${maks}`, "opsi-tidak-valid");
    }
    return [w, h];
  }
  let sisi = sisiPanjangBawaan;
  if (ukuranInput !== null && ukuranInput !== undefined) {
    if (!adalahInt(ukuranInput) || ukuranInput < min || ukuranInput > maks) throw new GalatSegmentasi(`ukuranInput (sisi panjang) harus bilangan bulat ${min}..${maks}`, "opsi-tidak-valid");
    sisi = ukuranInput;
  }
  const panjang = Math.max(lebar, tinggi);
  const ke = (x) => Math.min(maks, Math.max(min, Math.max(k, Math.round((x * sisi) / (panjang * k)) * k)));
  return [ke(lebar), ke(tinggi)];
}

/**
 * Bingkai rgb24 -> tensor float32 NCHW [1, 3, mt, ml] dengan (nilai / bagi) - kurang
 * (selfie: /255; MODNet: /127,5 - 1). Perubahan ukuran memakai bilangan bulat murni.
 */
export function praProses(rgb, lebar, tinggi, spec, [ml, mt]) {
  periksaBingkai(rgb, lebar, tinggi);
  const kecil = ubahUkuran(rgb, lebar, tinggi, 3, ml, mt);
  const bagi = spec.masukan.bagi ?? 255, kurang = spec.masukan.kurang ?? 0;
  const n = ml * mt;
  const tensor = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const dasar = c * n;
    for (let i = 0; i < n; i++) tensor[dasar + i] = kecil[i * 3 + c] / bagi - kurang;
  }
  return { tensor, dims: [1, 3, mt, ml] };
}

// ------------------------------------------------------------------ pasca-proses
/**
 * Keluaran model (probabilitas alfa 0..1, bentuk [..., H, W]) -> mask Uint8Array `lebar` x `tinggi`
 * (0..255). Nilai di luar 0..1 dijepit; nilai bukan angka hingga menjadi 0 dan, bila semuanya
 * tidak hingga, GalatSegmentasi.
 */
export function pascaProses(data, dims, lebar, tinggi) {
  if (!Array.isArray(dims) || dims.length < 2) throw new GalatSegmentasi(`bentuk keluaran model tidak valid: ${JSON.stringify(dims)}`, "keluaran-tidak-valid");
  const mt = Number(dims[dims.length - 2]), ml = Number(dims[dims.length - 1]);
  const lain = dims.slice(0, -2).every((d) => Number(d) === 1);
  if (!lain || !adalahInt(mt) || !adalahInt(ml) || mt < 1 || ml < 1 || data.length !== mt * ml) {
    throw new GalatSegmentasi(`keluaran model harus satu kanal [1,1,H,W]: dims ${JSON.stringify(dims)}, panjang ${data.length}`, "keluaran-tidak-valid");
  }
  const kecil = new Uint8Array(mt * ml);
  let hingga = 0;
  for (let i = 0; i < kecil.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue; // tetap 0
    hingga++;
    kecil[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.floor(v * 255 + 0.5);
  }
  if (hingga === 0) throw new GalatSegmentasi("keluaran model tidak memuat satu pun angka hingga (NaN atau tak hingga)", "keluaran-tidak-valid");
  return ubahUkuran(kecil, ml, mt, 1, lebar, tinggi);
}

/**
 * Tabel pencarian 256 entri untuk ambang halus: nilai di bawah `rendah` menjadi 0, di atas `tinggi`
 * menjadi 255, di antaranya smoothstep (t*t*(3-2t)). `null` = identitas. Hanya + - * /.
 */
export function buatLut(ambang = null) {
  const lut = new Uint8Array(256);
  if (ambang === null || ambang === undefined) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  if (!Array.isArray(ambang) || ambang.length !== 2 || !ambang.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1) || !(ambang[0] < ambang[1])) {
    throw new GalatSegmentasi(`ambang harus [rendah, tinggi] dengan 0 <= rendah < tinggi <= 1 (dapat ${JSON.stringify(ambang)})`, "opsi-tidak-valid");
  }
  const [lo, hi] = ambang;
  for (let i = 0; i < 256; i++) {
    let t = (i / 255 - lo) / (hi - lo);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    lut[i] = Math.floor(t * t * (3 - 2 * t) * 255 + 0.5);
  }
  return lut;
}

/**
 * Pelicinan temporal EMA berurutan: keadaan = keadaan + (bingkai - keadaan) * a, dengan
 * `ema` = bobot bingkai baru (0 < ema <= 1; 1 = tanpa pelicinan) dan keadaan 8 bit pecahan (x256)
 * dalam bilangan bulat, sehingga identik di semua mesin. Bingkai pertama (atau setelah `ulang()`)
 * menginisialisasi keadaan. Mask n bergantung pada mask 0..n-1 sehingga HARUS diberikan berurutan
 * dan dari satu proses; jangan diparalel antar bingkai.
 */
export function buatEma(ema = 1) {
  if (typeof ema !== "number" || !Number.isFinite(ema) || !(ema > 0) || ema > 1) throw new GalatSegmentasi(`ema harus 0 < ema <= 1 (dapat ${ema})`, "opsi-tidak-valid");
  const a = Math.min(256, Math.max(1, Math.round(ema * 256)));
  let keadaan = null;
  return {
    bobot: a / 256,
    langkah(mask) {
      if (!(mask instanceof Uint8Array)) throw new GalatSegmentasi("EMA menerima Uint8Array", "opsi-tidak-valid");
      if (keadaan === null || keadaan.length !== mask.length) {
        if (keadaan !== null) throw new GalatSegmentasi("ukuran mask berubah di tengah urutan EMA; panggil ulang() atau buat pelicin baru", "opsi-tidak-valid");
        keadaan = new Int32Array(mask.length);
        for (let i = 0; i < mask.length; i++) keadaan[i] = mask[i] << 8;
        return Uint8Array.from(mask);
      }
      const out = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) {
        const s = keadaan[i] + (((mask[i] << 8) - keadaan[i]) * a >> 8);
        keadaan[i] = s;
        out[i] = (s + 128) >> 8;
      }
      return out;
    },
    ulang() { keadaan = null; },
  };
}

// ------------------------------------------------------------------ segmenter
/**
 * Membuat segmenter: memuat registri, ORT (AWVD_ORT), memverifikasi bobot (fail-closed untuk model
 * registri), lalu membuat sesi dari byte yang sudah diverifikasi.
 *
 * `opsi`: { model (id registri, wajib), jalur (bobot eksplisit), env, registriKustom, thread (1..64;
 * bawaan = bawaan ORT), ukuranInput, ambang, ema (bobot bingkai baru, bawaan 1), peringatan (larik
 * penampung) }. Mengembalikan { info, segmentasi(rgb, lebar, tinggi), mentah(...), ulangEma(), tutup() }.
 * `segmentasi` berstatus (EMA): panggil berurutan per bingkai; `mentah` tanpa ambang dan EMA.
 */
export async function buatSegmenter({ model, jalur = null, env = process.env, registriKustom = null, thread = null, ukuranInput = null, ambang = null, ema = 1, peringatan = [] } = {}) {
  if (typeof model !== "string" || !model) throw new GalatSegmentasi("opsi model (id registri) wajib", "opsi-tidak-valid");
  if (thread !== null && (!adalahInt(thread) || thread < 1 || thread > 64)) throw new GalatSegmentasi(`thread harus bilangan bulat 1..64 (dapat ${thread})`, "opsi-tidak-valid");
  const lut = buatLut(ambang);
  const pelicin = buatEma(ema);
  const reg = muatRegistri({ kustom: registriKustom, env });
  peringatan.push(...reg.peringatan);
  const spec = reg.model[model];
  if (!spec) throw new GalatSegmentasi(`model "${model}" tidak dikenal; yang tersedia: ${Object.keys(reg.model).join(", ")}`, "model-tidak-dikenal");
  // ukuran masukan diperiksa dini (opsi salah = galat validasi, bukan baru saat bingkai pertama)
  ukuranMasukan(spec, 1, 1, ukuranInput);

  const { ort, versi } = pastikanOrt(env);
  const berkas = cariBobot(model, spec, { jalur, env });
  const bobot = verifikasiBobot(model, spec, berkas, { peringatan });

  const opsiSesi = { executionProviders: ["cpu"], interOpNumThreads: 1, ...(thread ? { intraOpNumThreads: thread } : {}) };
  let sesi;
  try { sesi = await ort.InferenceSession.create(bobot.data, opsiSesi); } catch (e) {
    throw new GalatSegmentasi(`onnxruntime gagal memuat model "${model}": ${String(e?.message ?? e).split("\n")[0]}`, "ort-gagal");
  }
  const namaMasuk = spec.masukan.nama ?? sesi.inputNames[0];
  const namaKeluar = spec.keluaran?.nama ?? sesi.outputNames[0];
  if (!sesi.inputNames.includes(namaMasuk) || !sesi.outputNames.includes(namaKeluar)) {
    await sesi.release?.();
    throw new GalatSegmentasi(`model "${model}" tidak cocok dengan registri: masukan/keluaran diminta ${namaMasuk}/${namaKeluar}, model punya ${sesi.inputNames.join(",")}/${sesi.outputNames.join(",")}`, "model-tidak-cocok");
  }
  let ukuranBingkai = null;
  const info = {
    versiLib: VERSI_SEGMENTASI, model, nama: spec.nama, sha256: bobot.sha256, ukuranByte: bobot.ukuranByte, kustom: spec.kustom,
    lisensiKode: spec.lisensiKode, lisensiBobot: spec.lisensiBobot, versiOrt: versi, thread, ukuranInput, ambang, ema: pelicin.bobot, lokal: true,
  };

  async function mentah(rgb, lebar, tinggi) {
    periksaBingkai(rgb, lebar, tinggi);
    const [ml, mt] = ukuranMasukan(spec, lebar, tinggi, ukuranInput);
    const { tensor, dims } = praProses(rgb, lebar, tinggi, spec, [ml, mt]);
    let keluar;
    try { keluar = await sesi.run({ [namaMasuk]: new ort.Tensor("float32", tensor, dims) }); } catch (e) {
      throw new GalatSegmentasi(`inferensi onnxruntime gagal (model "${model}", masukan ${ml}x${mt}): ${String(e?.message ?? e).split("\n")[0]}`, "ort-gagal");
    }
    const t = keluar[namaKeluar];
    if (!t || !t.data) throw new GalatSegmentasi(`model "${model}" tidak mengeluarkan "${namaKeluar}"`, "keluaran-tidak-valid");
    return pascaProses(t.data, t.dims, lebar, tinggi);
  }
  return {
    info,
    mentah,
    async segmentasi(rgb, lebar, tinggi) {
      if (ukuranBingkai && (ukuranBingkai[0] !== lebar || ukuranBingkai[1] !== tinggi)) {
        throw new GalatSegmentasi(`ukuran bingkai berubah (${ukuranBingkai.join("x")} -> ${lebar}x${tinggi}); panggil ulangEma() atau buat segmenter baru`, "opsi-tidak-valid");
      }
      const m = await mentah(rgb, lebar, tinggi);
      ukuranBingkai = [lebar, tinggi];
      for (let i = 0; i < m.length; i++) m[i] = lut[m[i]];
      return pelicin.langkah(m);
    },
    ulangEma() { pelicin.ulang(); ukuranBingkai = null; },
    async tutup() { await sesi.release?.(); },
  };
}
