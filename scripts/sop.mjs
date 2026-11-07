#!/usr/bin/env bun
/**
 * awvd / sop.mjs — SOP sebagai sumber dokumen dan video.
 *
 *   bun scripts/sop.mjs <sop.json> --out DIR [--pdf] [--fps 30] [--cps 17] [--browser PATH]
 *
 * Dari satu berkas data `sop.json` (format SOP Administrasi Pemerintahan menurut
 * PermenPAN-RB No. 35 Tahun 2012) dihasilkan di DIR:
 *   sop.html         dokumen cetak A4 landscape (identitas, matriks swimlane, pengesahan)
 *   sop.pdf          hanya dengan --pdf (dicetak lewat Chromium yang sama dengan render.mjs)
 *   video-props.json props untuk template video (templates/sop): adegan, waktu, caption
 *   caption.vtt      caption dari narasi, siap untuk --subtitle render.mjs
 *
 * Validasi fail-closed: data yang cacat menghentikan proses dengan kode keluar 2 dan
 * daftar galat. Kode keluar 1 untuk galat saat membuat PDF. Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- muat helper
// runtime.js dan sop-alir.js adalah skrip browser (UMD); dimuat dengan window
// sementara agar global tidak bocor ke proses ini. Satu sumber kebenaran helper.
function muatSkrip(nama) {
  const sebelum = globalThis.window;
  globalThis.window = { location: { search: "" } };
  try {
    return createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), nama));
  } finally {
    if (sebelum === undefined) delete globalThis.window;
    else globalThis.window = sebelum;
  }
}
const runtime = muatSkrip("runtime.js");
const SopAlir = muatSkrip("sop-alir.js");
const { durasiBaca, pecahBaris } = runtime;

// ------------------------------------------------------------------ konstanta
export const JENIS_LANGKAH = ["mulai", "proses", "keputusan", "selesai"];
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus",
  "September", "Oktober", "November", "Desember"];
const POLA_KONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const MIN_CUE_DETIK = 5 / 6;
const MAKS_CUE_DETIK = 7;
const MAKS_KARAKTER_BARIS = 42;
const MAKS_BARIS = 2;
const JEDA_DETIK = 0.5;
const MIN_LANGKAH_DETIK = 2;
const MIN_ADEGAN_DETIK = 3;
const MIN_PENUTUP_DETIK = 4;
const MAKS_DASAR_HUKUM_VIDEO = 3;
const MAKS_PERINGATAN_VIDEO = 2;
const LANGKAH_PER_HALAMAN = 10; // keputusan desain, bukan aturan PermenPAN-RB 35/2012
const WPM_BAWAAN = 140;         // laju narasi bawaan (rentang acuan 130-150), dapat diubah
const JEDA_SEGMEN_BAWAAN = 2;   // detik antar subtugas (acuan van der Meij 2013: 2-5 detik)
const MAKS_LANGKAH_SEGMEN = 5;  // subtugas 3-5 aksi per segmen
const MAKS_LOGO_BYTE = 256 * 1024;

// ------------------------------------------------------------------- validasi
const KUNCI = {
  akar: ["identitas", "dasarHukum", "kualifikasiPelaksana", "keterkaitan", "peralatan",
    "peringatan", "pencatatan", "pelaksana", "prosedur", "pengesahan", "fiktif"],
  identitas: ["judul", "nomor", "unit", "logo", "tanggalPembuatan", "tanggalRevisi", "tanggalEfektif", "disahkanOleh"],
  disahkanOleh: ["jabatan", "nama", "nip", "fiktif"],
  pelaksana: ["id", "nama"],
  prosedur: ["kode", "judul", "tujuan", "langkah"],
  langkah: ["no", "aktivitas", "pelaksana", "jenis", "kelengkapan", "waktu", "output",
    "keterangan", "ya", "tidak", "narasi"],
  pengesahan: ["ditetapkanDi", "tanggal", "penandatangan"],
  penandatangan: ["peran", "jabatan", "nama", "nip", "fiktif"],
};
const DAFTAR_TEKS = ["dasarHukum", "kualifikasiPelaksana", "keterkaitan", "peralatan", "peringatan", "pencatatan"];

// Pola data pribadi (UU 27/2022; AGENTS aturan 4). Heuristik: bisa menimbulkan positif palsu.
const POLA_DATA_PRIBADI = [
  ["NIP", /(?<!\d)\d{8}\s?\d{6}\s?\d\s?\d{3}(?!\d)/],
  ["NIK", /(?<!\d)\d{16}(?!\d)/],
  ["nomor telepon", /(?<![\w/])(?:\+62|62|0)\s?8\d{1,3}[\s-]?\d{3,4}[\s-]?\d{2,5}(?![\w])|(?<![\w/])0\d{2,3}[\s-]\d{5,8}(?!\w)/],
  ["surel", /[^\s@]+@[^\s@]+\.[^\s@]+/],
];
const adalahObjek = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const tanggalValid = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

/** Mengembalikan daftar galat (string); kosong berarti valid. */
export function validasi(sop) {
  const galat = [];
  const tambah = (jalur, pesan) => galat.push(`${jalur}: ${pesan}`);

  if (!adalahObjek(sop)) return ["(akar): sop.json harus berupa objek JSON"];

  // karakter kontrol dan pola data pribadi di semua string. Pola data pribadi hanya
  // diizinkan bila objek pemuatnya (atau induknya) bertanda "fiktif": true.
  (function pindai(v, jalur, fiktif) {
    if (typeof v === "string") {
      const m = POLA_KONTROL.exec(v);
      if (m) tambah(jalur, `mengandung karakter kontrol (U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")})`);
      if (!fiktif) {
        for (const [jenis, pola] of POLA_DATA_PRIBADI) {
          if (pola.test(v)) tambah(jalur, `terindikasi data pribadi (${jenis}); pakai data fiktif atau beri tanda "fiktif": true pada objeknya`);
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => pindai(x, `${jalur}[${i}]`, fiktif));
    } else if (adalahObjek(v)) {
      const f = fiktif || v.fiktif === true;
      for (const [k, x] of Object.entries(v)) {
        if (POLA_KONTROL.test(k)) tambah(jalur, `kunci "${k.replace(POLA_KONTROL, "?")}" mengandung karakter kontrol`);
        pindai(x, jalur ? `${jalur}.${k}` : k, f);
      }
    }
  })(sop, "", false);

  function kunciDikenal(obj, jenis, jalur) {
    for (const k of Object.keys(obj)) {
      if (!KUNCI[jenis].includes(k)) tambah(jalur, `kunci tidak dikenal "${k}" (kunci yang berlaku: ${KUNCI[jenis].join(", ")})`);
    }
  }
  function teks(obj, k, jalur, { opsional = false } = {}) {
    const v = obj[k];
    const j = `${jalur}.${k}`;
    if (v === undefined) {
      if (!opsional) tambah(j, "wajib diisi");
      return false;
    }
    if (typeof v !== "string") { tambah(j, "harus berupa teks"); return false; }
    if (v.trim() === "") { tambah(j, opsional ? "tidak boleh kosong bila ditulis" : "tidak boleh kosong"); return false; }
    return true;
  }
  function tanggal(obj, k, jalur, { opsional = false } = {}) {
    if (!teks(obj, k, jalur, { opsional })) return;
    if (!tanggalValid(obj[k])) tambah(`${jalur}.${k}`, `bukan tanggal yang valid (format YYYY-MM-DD): "${obj[k]}"`);
  }
  function objek(obj, k, jalur) {
    const v = obj[k];
    if (v === undefined) { tambah(`${jalur}.${k}`, "wajib diisi"); return null; }
    if (!adalahObjek(v)) { tambah(`${jalur}.${k}`, "harus berupa objek"); return null; }
    return v;
  }
  function larik(obj, k, jalur, { min = 1 } = {}) {
    const v = obj[k];
    const j = jalur ? `${jalur}.${k}` : k;
    if (v === undefined) { tambah(j, "wajib diisi"); return null; }
    if (!Array.isArray(v)) { tambah(j, "harus berupa larik"); return null; }
    if (v.length < min) { tambah(j, `minimal ${min} butir`); return null; }
    return v;
  }

  kunciDikenal(sop, "akar", "(akar)");

  function boolOpsional(obj, k, jalur) {
    if (obj[k] !== undefined && typeof obj[k] !== "boolean") tambah(`${jalur}.${k}`, "harus true atau false");
  }
  boolOpsional(sop, "fiktif", "(akar)");

  const idn = objek(sop, "identitas", "");
  if (idn) {
    kunciDikenal(idn, "identitas", "identitas");
    for (const k of ["judul", "nomor", "unit"]) teks(idn, k, "identitas");
    teks(idn, "logo", "identitas", { opsional: true });
    tanggal(idn, "tanggalPembuatan", "identitas");
    tanggal(idn, "tanggalRevisi", "identitas", { opsional: true });
    tanggal(idn, "tanggalEfektif", "identitas");
    const ds = objek(idn, "disahkanOleh", "identitas");
    if (ds) {
      kunciDikenal(ds, "disahkanOleh", "identitas.disahkanOleh");
      teks(ds, "jabatan", "identitas.disahkanOleh");
      teks(ds, "nama", "identitas.disahkanOleh", { opsional: true });
      teks(ds, "nip", "identitas.disahkanOleh", { opsional: true });
      boolOpsional(ds, "fiktif", "identitas.disahkanOleh");
    }
  }

  for (const k of DAFTAR_TEKS) {
    const l = larik(sop, k, "");
    if (l) l.forEach((x, i) => {
      if (typeof x !== "string") tambah(`${k}[${i}]`, "harus berupa teks");
      else if (x.trim() === "") tambah(`${k}[${i}]`, "tidak boleh kosong");
    });
  }

  // pelaksana
  const idPelaksana = new Set();
  const pel = larik(sop, "pelaksana", "");
  if (pel) pel.forEach((p, i) => {
    const j = `pelaksana[${i}]`;
    if (!adalahObjek(p)) { tambah(j, "harus berupa objek"); return; }
    kunciDikenal(p, "pelaksana", j);
    const idOk = teks(p, "id", j);
    teks(p, "nama", j);
    if (idOk) {
      if (idPelaksana.has(p.id)) tambah(`${j}.id`, `duplikat: "${p.id}"`);
      idPelaksana.add(p.id);
    }
  });

  // prosedur
  const kodeAda = new Set();
  const pros = larik(sop, "prosedur", "");
  if (pros) pros.forEach((p, pi) => {
    const jp = `prosedur[${pi}]`;
    if (!adalahObjek(p)) { tambah(jp, "harus berupa objek"); return; }
    kunciDikenal(p, "prosedur", jp);
    if (teks(p, "kode", jp)) {
      if (kodeAda.has(p.kode)) tambah(`${jp}.kode`, `duplikat: "${p.kode}"`);
      kodeAda.add(p.kode);
    }
    teks(p, "judul", jp);
    teks(p, "tujuan", jp);
    const ls = larik(p, "langkah", jp, { min: 2 });
    if (!ls) return;
    const sebelum = galat.length;
    const nomorAda = new Set();
    ls.forEach((l, li) => {
      const j = `${jp}.langkah[${li}]`;
      if (!adalahObjek(l)) { tambah(j, "harus berupa objek"); return; }
      kunciDikenal(l, "langkah", j);
      // nomor langkah: bilangan bulat, unik, berurutan 1..n
      if (l.no === undefined) tambah(`${j}.no`, "wajib diisi");
      else if (!Number.isInteger(l.no)) tambah(`${j}.no`, "harus bilangan bulat");
      else if (nomorAda.has(l.no)) tambah(`${j}.no`, `nomor langkah ${l.no} duplikat (nomor harus unik)`);
      else if (l.no !== li + 1) tambah(`${j}.no`, `nomor langkah harus berurutan mulai 1: diharapkan ${li + 1}, ditemukan ${l.no}`);
      if (Number.isInteger(l.no)) nomorAda.add(l.no);
      teks(l, "aktivitas", j);
      teks(l, "kelengkapan", j);
      teks(l, "waktu", j);
      teks(l, "output", j);
      teks(l, "keterangan", j, { opsional: true });
      teks(l, "narasi", j, { opsional: true });
      if (teks(l, "pelaksana", j) && !idPelaksana.has(l.pelaksana)) {
        tambah(`${j}.pelaksana`, `"${l.pelaksana}" tidak terdaftar di pelaksana`);
      }
      if (l.jenis === undefined) tambah(`${j}.jenis`, "wajib diisi");
      else if (!JENIS_LANGKAH.includes(l.jenis)) tambah(`${j}.jenis`, `harus salah satu dari ${JENIS_LANGKAH.join(", ")}: "${l.jenis}"`);
      else {
        const awal = li === 0, akhir = li === ls.length - 1;
        if (awal && l.jenis !== "mulai") tambah(`${j}.jenis`, `langkah pertama harus "mulai", ditemukan "${l.jenis}"`);
        if (akhir && l.jenis !== "selesai") tambah(`${j}.jenis`, `langkah terakhir harus "selesai", ditemukan "${l.jenis}"`);
        if (!awal && l.jenis === "mulai") tambah(`${j}.jenis`, `"mulai" hanya boleh pada langkah pertama`);
        const cabang = (k) => {
          const v = l[k];
          if (!Number.isInteger(v)) { tambah(`${j}.${k}`, "harus nomor langkah (bilangan bulat)"); return; }
          if (v < 1 || v > ls.length) tambah(`${j}.${k}`, `menuju langkah ${v} yang tidak ada (langkah 1..${ls.length})`);
          else if (v === li + 1) tambah(`${j}.${k}`, "tidak boleh menuju langkah itu sendiri");
        };
        if (l.jenis === "keputusan") {
          for (const k of ["ya", "tidak"]) {
            if (l[k] === undefined) tambah(`${j}.${k}`, "wajib diisi untuk langkah keputusan");
            else cabang(k);
          }
          if (Number.isInteger(l.ya) && l.ya === l.tidak) tambah(`${j}.tidak`, "ya dan tidak tidak boleh menuju langkah yang sama");
        } else {
          for (const k of ["ya", "tidak"]) {
            if (l[k] !== undefined) tambah(`${j}.${k}`, `hanya boleh ada pada langkah keputusan (jenis "${l.jenis}")`);
          }
        }
      }
    });
    // keterjangkauan: semua langkah harus bisa dicapai dari langkah 1
    if (galat.length === sebelum) {
      const terjangkau = new Set([0]);
      const antre = [0];
      while (antre.length) {
        const i = antre.pop();
        const l = ls[i];
        const tujuan = l.jenis === "selesai" ? [] : l.jenis === "keputusan" ? [l.ya - 1, l.tidak - 1] : [i + 1];
        for (const t of tujuan) if (!terjangkau.has(t)) { terjangkau.add(t); antre.push(t); }
      }
      ls.forEach((l, i) => {
        if (!terjangkau.has(i)) tambah(`${jp}.langkah[${i}]`, `langkah ${l.no} tidak terjangkau dari langkah 1 (tidak ada alur yang menuju ke sana)`);
      });
    }
  });

  // pengesahan
  const pg = objek(sop, "pengesahan", "");
  if (pg) {
    kunciDikenal(pg, "pengesahan", "pengesahan");
    teks(pg, "ditetapkanDi", "pengesahan");
    tanggal(pg, "tanggal", "pengesahan");
    const ps = larik(pg, "penandatangan", "pengesahan");
    if (ps) ps.forEach((p, i) => {
      const j = `pengesahan.penandatangan[${i}]`;
      if (!adalahObjek(p)) { tambah(j, "harus berupa objek"); return; }
      kunciDikenal(p, "penandatangan", j);
      teks(p, "peran", j);
      teks(p, "jabatan", j);
      teks(p, "nama", j, { opsional: true });
      teks(p, "nip", j, { opsional: true });
      boolOpsional(p, "fiktif", j);
    });
  }
  return galat;
}

// ----------------------------------------------------------- peringatan lunak
/**
 * Urutan pelaksana menurut kemunculan pertama dalam sekuen kegiatan (PermenPAN-RB
 * 35/2012, Lampiran II.B.2.c: urutan kolom mengikuti sekuen kegiatan, bukan hierarki).
 * Urutan larik `pelaksana` pada sop.json tidak dipakai untuk tata letak.
 */
export function urutanPelaksana(langkah, registrasi) {
  const nama = Object.fromEntries(registrasi.map((p) => [p.id, p.nama]));
  const urut = [];
  for (const l of langkah) if (!urut.includes(l.pelaksana)) urut.push(l.pelaksana);
  return urut.map((id) => ({ id, nama: String(nama[id]).replace(/\s+/g, " ").trim() }));
}

/** Peringatan yang tidak menghentikan proses (data valid, tetapi tidak sesuai anjuran). */
export function peringatanSop(sop) {
  const hasil = [];
  const namaSemua = sop.pelaksana.map((p) => p.nama.replace(/\s+/g, " ").trim().toLowerCase());
  const dipakai = new Set();
  sop.prosedur.forEach((p, pi) => p.langkah.forEach((l, li) => {
    dipakai.add(l.pelaksana);
    if (l.jenis === "keputusan") return;
    const a = l.aktivitas.replace(/\s+/g, " ").trim().toLowerCase();
    const subjek = namaSemua.find((n) => a === n || a.startsWith(`${n} `));
    if (subjek) {
      hasil.push(`prosedur[${pi}].langkah[${li}].aktivitas: kegiatan sebaiknya ditulis kata kerja aktif tanpa subjek; ` +
        `pelaksana ("${subjek}") cukup di kolom pelaksana (PermenPAN-RB 35/2012, Lampiran II.B.2.c)`);
    }
  }));
  sop.pelaksana.forEach((p, i) => {
    if (!dipakai.has(p.id)) hasil.push(`pelaksana[${i}]: "${p.id}" tidak dipakai oleh langkah mana pun; tidak dibuatkan kolom`);
  });
  return hasil;
}

// -------------------------------------------------------------------- teks id
const rapikan = (s) => String(s).replace(/\s+/g, " ").trim();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const tanpaAkhir = (s) => rapikan(s).replace(/[\s.,;:!?]+$/u, "");
/** Huruf kecil di awal kalimat kecuali singkatan (huruf kedua juga kapital). */
function huruf1Kecil(s) {
  if (/^[A-Z]($|[^A-Z])/.test(s)) return s[0].toLowerCase() + s.slice(1);
  return s;
}
export function tanggalIndonesia(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${BULAN[m - 1]} ${y}`;
}
function daftarKata(arr) {
  if (arr.length <= 1) return arr.join("");
  if (arr.length === 2) return `${arr[0]} dan ${arr[1]}`;
  return `${arr.slice(0, -1).join(", ")}, dan ${arr[arr.length - 1]}`;
}
const ringkasDasarHukum = (s) => {
  const potong = tanpaAkhir(s.split(/\s+tentang\s+/i)[0]);
  return potong.length >= 8 ? potong : tanpaAkhir(s);
};

/** Narasi satu langkah: teks `narasi` bila ada, selain itu disusun otomatis. */
export function narasiLangkah(l, namaPelaksana) {
  if (l.narasi && rapikan(l.narasi)) return rapikan(l.narasi);
  const nama = namaPelaksana[l.pelaksana];
  if (l.jenis === "keputusan") {
    const a = rapikan(l.aktivitas);
    const tanya = /[.?!]$/.test(a) ? a : `${a}?`;
    const arah = (n) => (n > l.no ? `lanjut ke langkah ${n}` : `kembali ke langkah ${n}`);
    return `${nama} memeriksa: ${tanya} Jika ya, ${arah(l.ya)}; jika tidak, ${arah(l.tidak)}.`;
  }
  return `${nama} ${huruf1Kecil(tanpaAkhir(l.aktivitas))}. Hasilnya: ${huruf1Kecil(tanpaAkhir(l.output))}.`;
}

// -------------------------------------------------------------------- caption
const panjang = (s) => Array.from(s).length;

const jumlahKata = (s) => (rapikan(s) === "" ? 0 : rapikan(s).split(" ").length);

/**
 * Memecah narasi menjadi teks cue: tiap cue muat dalam dua baris <= 42 karakter dan
 * tidak melebihi 7 detik, baik pada kecepatan baca `cps` maupun laju narasi `wpm`
 * (kata per menit). Kalimat digabung selama masih muat; kalimat yang terlalu panjang
 * dipotong di kata, lebih disukai sesudah , ; :.
 */
export function pecahCue(narasi, cps, wpm = WPM_BAWAAN) {
  const maksKar = Math.min(MAKS_KARAKTER_BARIS * MAKS_BARIS, Math.floor(MAKS_CUE_DETIK * cps));
  const maksKata = Math.max(1, Math.floor((MAKS_CUE_DETIK * wpm) / 60));
  const muat = (t) => panjang(t) <= maksKar && jumlahKata(t) <= maksKata &&
    !pecahBaris(t, { maks: MAKS_KARAKTER_BARIS, baris: MAKS_BARIS }).melebihi;
  const kalimat = rapikan(narasi).split(/(?<=[.!?])\s+(?=[A-Z"(])/u);

  function pecahKalimat(s) {
    const bagian = [];
    let cur = [];
    for (const w of s.split(" ")) {
      if (cur.length === 0 || muat([...cur, w].join(" "))) { cur.push(w); continue; }
      let potong = cur.length;
      for (let k = cur.length - 1; k >= Math.floor(cur.length / 2); k--) {
        if (/[,;:]$/.test(cur[k])) { potong = k + 1; break; }
      }
      bagian.push(cur.slice(0, potong).join(" "));
      cur = [...cur.slice(potong), w];
    }
    if (cur.length) bagian.push(cur.join(" "));
    return bagian;
  }

  const hasil = [];
  let cur = "";
  for (const s of kalimat) {
    if (muat(s)) {
      if (cur && muat(`${cur} ${s}`)) cur += ` ${s}`;
      else { if (cur) hasil.push(cur); cur = s; }
    } else {
      if (cur) { hasil.push(cur); cur = ""; }
      const b = pecahKalimat(s);
      hasil.push(...b.slice(0, -1));
      cur = b[b.length - 1];
    }
  }
  if (cur) hasil.push(cur);
  return hasil;
}

// ---------------------------------------------------------------------- video
/** Membagi n langkah menjadi segmen (subtugas) berukuran 3-5 aksi, selisih ukuran paling kecil. */
export function ukuranSegmen(n) {
  const k = Math.max(1, Math.ceil(n / MAKS_LANGKAH_SEGMEN));
  const dasar = Math.floor(n / k), sisa = n % k;
  return Array.from({ length: k }, (_, i) => dasar + (i < sisa ? 1 : 0));
}

/**
 * Menyusun adegan, jadwal frame, dan cue caption secara deterministik.
 * Durasi cue = yang lebih lama antara waktu baca (durasiBaca pada `cps`) dan waktu
 * narasi (kata / `wpm`), dibulatkan ke atas ke frame (cps tidak pernah terlampaui) dan
 * dijepit 5/6..7 detik; durasi adegan = jumlah durasi cue (min 2 s per langkah, 3 s
 * adegan lain, 4 s penutup) ditambah jeda 0,5 s. Langkah dikelompokkan menjadi segmen
 * 3-5 aksi; langkah penutup segmen (selain segmen terakhir) diberi tambahan jeda
 * `jedaSegmen` detik (acuan: van der Meij 2013, jeda 2-5 detik antar subtugas).
 */
export function susunVideo(sop, { fps = 30, cps = 17, wpm = WPM_BAWAAN, jedaSegmen = JEDA_SEGMEN_BAWAAN } = {}) {
  const namaPelaksana = Object.fromEntries(sop.pelaksana.map((p) => [p.id, p.nama]));
  const semuaLangkah = sop.prosedur.flatMap((p) => p.langkah);
  const pelaksanaVideo = urutanPelaksana(semuaLangkah, sop.pelaksana);
  const lajurProsedur = sop.prosedur.map((p) => urutanPelaksana(p.langkah, sop.pelaksana));
  const totalLangkah = semuaLangkah.length;
  const id = sop.identitas;
  const tgl = tanggalIndonesia(id.tanggalEfektif);

  const mentah = [];
  mentah.push({
    min: MIN_ADEGAN_DETIK,
    narasi: `${tanpaAkhir(id.judul)}. Nomor dokumen ${rapikan(id.nomor)}, ${rapikan(id.unit)}. Berlaku efektif sejak ${tgl}.`,
    data: {
      jenis: "judul", judul: rapikan(id.judul), nomor: rapikan(id.nomor), unit: rapikan(id.unit),
      tanggalEfektif: tgl,
      disahkanOleh: { jabatan: rapikan(id.disahkanOleh.jabatan), ...(id.disahkanOleh.nama ? { nama: rapikan(id.disahkanOleh.nama) } : {}) },
    },
  });

  const butir = sop.dasarHukum.slice(0, MAKS_DASAR_HUKUM_VIDEO).map(rapikan);
  const lainnya = sop.dasarHukum.length - butir.length;
  mentah.push({
    min: MIN_ADEGAN_DETIK,
    narasi: `Dasar hukum prosedur ini: ${butir.map(ringkasDasarHukum).join("; ")}.` +
      (lainnya > 0 ? ` Ada ${lainnya} dasar hukum lain di dokumen SOP.` : "") +
      ` Pelaksananya: ${daftarKata(pelaksanaVideo.map((p) => p.nama))}.`,
    data: { jenis: "dasarHukum", butir, lainnya },
  });

  sop.prosedur.forEach((p, pi) => {
    mentah.push({
      min: MIN_ADEGAN_DETIK,
      narasi: `Prosedur ${pi + 1}${sop.prosedur.length > 1 ? ` dari ${sop.prosedur.length}` : ""}: ${tanpaAkhir(p.judul)}. ` +
        `Tujuannya: ${huruf1Kecil(tanpaAkhir(p.tujuan))}.`,
      data: { jenis: "prosedur", p: pi, kode: rapikan(p.kode), judul: rapikan(p.judul), tujuan: rapikan(p.tujuan), jumlahLangkah: p.langkah.length },
    });
    const ukuran = ukuranSegmen(p.langkah.length);
    const segmenDari = [];
    ukuran.forEach((u, si) => { for (let q = 0; q < u; q++) segmenDari.push(si); });
    p.langkah.forEach((l, li) => {
      const si = segmenDari[li];
      const akhirSegmen = si < ukuran.length - 1 && segmenDari[li + 1] !== si;
      mentah.push({
        min: MIN_LANGKAH_DETIK,
        tahan: akhirSegmen ? Math.round(jedaSegmen * fps) : 0,
        narasi: narasiLangkah(l, namaPelaksana),
        data: {
          jenis: "langkah", p: pi, l: li, no: l.no, jenisLangkah: l.jenis,
          segmen: si + 1, jumlahSegmen: ukuran.length,
          aktivitas: rapikan(l.aktivitas), pelaksana: l.pelaksana,
          kelengkapan: rapikan(l.kelengkapan), waktu: rapikan(l.waktu), output: rapikan(l.output),
          ...(l.keterangan ? { keterangan: rapikan(l.keterangan) } : {}),
          ...(l.jenis === "keputusan" ? { ya: l.ya, tidak: l.tidak } : {}),
        },
      });
    });
  });

  const peringatan = sop.peringatan.slice(0, MAKS_PERINGATAN_VIDEO).map(rapikan);
  const ringkasan = sop.prosedur.length > 1
    ? `${sop.prosedur.length} prosedur dengan total ${totalLangkah} langkah`
    : `${totalLangkah} langkah`;
  mentah.push({
    min: MIN_PENUTUP_DETIK,
    narasi: `Demikian ${tanpaAkhir(id.judul)}. Prosedur ini mencakup ${ringkasan} dengan ${pelaksanaVideo.length} pelaksana.` +
      (peringatan.length ? ` Perhatikan: ${tanpaAkhir(peringatan[0])}.` : "") +
      " Dokumen lengkap tersedia dalam berkas SOP.",
    data: {
      jenis: "penutup", judul: rapikan(id.judul), jumlahLangkah: totalLangkah, jumlahPelaksana: pelaksanaVideo.length,
      prosedur: sop.prosedur.map((p) => ({ kode: rapikan(p.kode), judul: rapikan(p.judul), jumlahLangkah: p.langkah.length })),
      peringatan,
    },
  });

  const bingkaiMin = Math.ceil(MIN_CUE_DETIK * fps - 1e-9);
  const jeda = Math.max(1, Math.round(JEDA_DETIK * fps));
  const adegan = [];
  const caption = [];
  let kursor = 0;
  for (const m of mentah) {
    let t = kursor;
    for (const teksCue of pecahCue(m.narasi, cps, wpm)) {
      const baris = pecahBaris(teksCue, { maks: MAKS_KARAKTER_BARIS, baris: MAKS_BARIS });
      const detikBaca = durasiBaca(teksCue, { cps, min: MIN_CUE_DETIK, maks: MAKS_CUE_DETIK }).detik;
      const detik = Math.min(MAKS_CUE_DETIK, Math.max(detikBaca, (jumlahKata(teksCue) * 60) / wpm));
      const n = Math.max(bingkaiMin, Math.ceil(detik * fps - 1e-9));
      caption.push({ mulai: t / fps, akhir: (t + n) / fps, teks: baris.join("\n") });
      t += n;
    }
    const baca = t - kursor;
    const durasi = Math.max(baca, Math.ceil(m.min * fps - 1e-9)) + jeda + (m.tahan || 0);
    adegan.push({ ...m.data, mulai: kursor, durasi, narasi: m.narasi });
    kursor += durasi;
  }

  const props = {
    versi: 2,
    fps,
    cps,
    wpm,
    jedaSegmen,
    durationInFrames: kursor,
    identitas: {
      judul: rapikan(id.judul), nomor: rapikan(id.nomor), unit: rapikan(id.unit), tanggalEfektif: tgl,
    },
    pelaksana: pelaksanaVideo,
    prosedur: sop.prosedur.map((p, pi) => ({
      kode: rapikan(p.kode), judul: rapikan(p.judul),
      pelaksana: lajurProsedur[pi],
      langkah: p.langkah.map((l) => ({
        no: l.no, jenis: l.jenis, lajur: lajurProsedur[pi].findIndex((x) => x.id === l.pelaksana),
        ...(l.jenis === "keputusan" ? { ya: l.ya, tidak: l.tidak } : {}),
      })),
    })),
    adegan,
    caption,
  };
  return props;
}

function waktuVtt(detik, fps) {
  const bingkai = Math.round(detik * fps);
  const msTotal = Math.round((bingkai * 1000) / fps);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const jam = Math.floor(msTotal / 3600000);
  const mnt = Math.floor((msTotal % 3600000) / 60000);
  const dtk = Math.floor((msTotal % 60000) / 1000);
  return `${p(jam)}:${p(mnt)}:${p(dtk)}.${p(msTotal % 1000, 3)}`;
}

export function buatVtt(caption, fps) {
  const blok = caption.map((c, i) => `${i + 1}\n${waktuVtt(c.mulai, fps)} --> ${waktuVtt(c.akhir, fps)}\n${c.teks}`);
  return `WEBVTT\n\n${blok.join("\n\n")}\n`;
}

// ------------------------------------------------------------------- dokumen
// Geometri matriks (mm). Lebar isi halaman A4 landscape dengan margin 10 mm = 277 mm.
const HAL_LEBAR = 277;
const FONT_MM = 7.5 * 0.3528;
const LH_MM = FONT_MM * 1.3;
const PAD_MM = 1.2;
const LEBAR_KARAKTER_MM = FONT_MM * 0.6; // pesimistis (font lebar seperti DejaVu Sans)
const SIM = { // setengah tinggi simbol (mm)
  mulai: 3.5, selesai: 3.5, proses: 4.5, keputusan: 6.5,
};
const BARIS_MIN = { mulai: 13, selesai: 13, proses: 13, keputusan: 17 };

function geometriKolom(nLajur) {
  const lajurW = Math.min(26, 164.6 / nLajur);
  const s = (HAL_LEBAR - 8 - nLajur * lajurW) / 174;
  return {
    no: 8, kegiatan: 62 * s, kelengkapan: 30 * s, waktu: 16 * s, output: 30 * s, keterangan: 36 * s,
    lajurW, simW: Math.max(6, Math.min(lajurW - 8, 18)),
  };
}

function jumlahBaris(teks, lebarMm) {
  const maks = Math.max(4, Math.floor((lebarMm - 2 * PAD_MM) / LEBAR_KARAKTER_MM));
  let baris = 1, cur = 0;
  for (const kata of rapikan(teks).split(" ")) {
    let n = Array.from(kata).length;
    if (cur > 0 && cur + 1 + n <= maks) { cur += 1 + n; continue; }
    if (cur > 0) { baris++; cur = 0; }
    while (n > maks) { baris++; n -= maks; } // kata lebih panjang dari satu baris dipatahkan
    cur = n;
  }
  return baris;
}

function teksCabang(l) {
  return l.jenis === "keputusan" ? `Ya: ke langkah ${l.ya}. Tidak: ke langkah ${l.tidak}.` : "";
}

function tinggiBaris(l, k) {
  const sel = [
    jumlahBaris(l.aktivitas, k.kegiatan),
    jumlahBaris(l.kelengkapan, k.kelengkapan),
    jumlahBaris(l.waktu, k.waktu),
    jumlahBaris(l.output, k.output),
    (l.keterangan ? jumlahBaris(l.keterangan, k.keterangan) : 0) +
      (l.jenis === "keputusan" ? jumlahBaris(teksCabang(l), k.keterangan) : 0),
  ];
  const teksMm = Math.max(...sel) * LH_MM + 2 * PAD_MM + 0.8;
  return Math.round(Math.max(BARIS_MIN[l.jenis], teksMm) * 100) / 100;
}

const f = (n) => String(Math.round(n * 1000) / 1000);

function simbolSvg(l, xc, cy, k) {
  if (l.jenis === "penghubung") {
    const w = LEBAR_HUBUNG, h = SIM_HUBUNG;
    const t = [[xc - w, cy - h], [xc + w, cy - h], [xc + w, cy + h * 0.3], [xc, cy + h], [xc - w, cy + h * 0.3]];
    return `<g><title>${esc(`Penghubung antar halaman ${l.huruf}`)}</title>` +
      `<polygon points="${t.map((q) => `${f(q[0])},${f(q[1])}`).join(" ")}" fill="#ffffff" stroke="#111827" stroke-width="0.3"/>` +
      `<text x="${f(xc)}" y="${f(cy - 0.6)}" dy=".35em" text-anchor="middle" font-size="3" font-weight="700" fill="#111827">${esc(l.huruf)}</text></g>`;
  }
  const hw = k.simW / 2;
  const hh = SIM[l.jenis];
  const terang = l.jenis === "mulai" || l.jenis === "selesai" ? "#e5e7eb" : l.jenis === "keputusan" ? "#fef3c7" : "#ffffff";
  const gaya = `fill="${terang}" stroke="#111827" stroke-width="0.3"`;
  let bentuk;
  if (l.jenis === "keputusan") {
    bentuk = `<polygon points="${f(xc - hw)},${f(cy)} ${f(xc)},${f(cy - hh)} ${f(xc + hw)},${f(cy)} ${f(xc)},${f(cy + hh)}" ${gaya}/>`;
  } else {
    bentuk = `<rect x="${f(xc - hw)}" y="${f(cy - hh)}" width="${f(k.simW)}" height="${f(2 * hh)}" rx="${l.jenis === "proses" ? 0.6 : f(hh)}" ${gaya}/>`;
  }
  const label = l.jenis === "mulai" ? "Mulai" : l.jenis === "selesai" ? "Selesai" : String(l.no);
  const ukuran = l.jenis === "mulai" || l.jenis === "selesai" ? 2.4 : 3;
  const nama = { mulai: "Mulai", selesai: "Selesai", proses: "Proses", keputusan: "Keputusan" }[l.jenis];
  return `<g><title>${esc(`Langkah ${l.no}: ${nama}`)}</title>${bentuk}` +
    `<text x="${f(xc)}" y="${f(cy)}" dy=".35em" text-anchor="middle" font-size="${ukuran}" font-weight="${label.length < 3 ? 700 : 400}" fill="#111827">${esc(label)}</text></g>`;
}

function kepalaSvg(kp) {
  const { x, y, arah } = kp;
  const a = 1.8, b = 0.9;
  const t = arah === "bawah" ? [[x, y], [x - b, y - a], [x + b, y - a]]
    : arah === "kanan" ? [[x, y], [x - a, y - b], [x - a, y + b]]
      : [[x, y], [x + a, y - b], [x + a, y + b]];
  return `<polygon points="${t.map((p) => `${f(p[0])},${f(p[1])}`).join(" ")}" fill="#111827"/>`;
}

/** Huruf penanda sambungan antar halaman: A..Z, AA, AB, ... */
function hurufSambungan(n) {
  let h = "";
  for (let k = n; k >= 0; k = Math.floor(k / 26) - 1) h = String.fromCharCode(65 + (k % 26)) + h;
  return h;
}

/** Membagi n langkah menjadi halaman berukuran seimbang, paling banyak `maks` langkah. */
export function bagiHalaman(n, maks) {
  const k = Math.max(1, Math.ceil(n / maks));
  const dasar = Math.floor(n / k), sisa = n % k;
  const hasil = [];
  let awal = 0;
  for (let i = 0; i < k; i++) {
    const u = dasar + (i < sisa ? 1 : 0);
    hasil.push([awal, awal + u]);
    awal += u;
  }
  return hasil;
}

const SIM_HUBUNG = 4.2; // setengah tinggi segilima penghubung (mm)
const LEBAR_HUBUNG = 5.5; // setengah lebar segilima penghubung (mm)

/**
 * Tabel matriks untuk satu halaman (langkah dari `awal` sampai sebelum `akhir`).
 * Garis alir yang keluar atau masuk dari halaman lain diwakili segilima penghubung
 * bernomor huruf (Lampiran II.B.2.b); penghubung ditaruh di baris tambahan di atas
 * (masuk) atau di bawah (keluar) halaman.
 */
function tabelProsedur(sop, p, [awal, akhir], huruf, urut) {
  const nL = urut.length;
  const k = geometriKolom(nL);
  const lajurDari = Object.fromEntries(urut.map((x, i) => [x.id, i]));
  const semua = p.langkah.map((l) => ({ ...l, lajur: lajurDari[l.pelaksana] }));
  const keluarDari = (l, i) => (l.jenis === "selesai" ? [] : l.jenis === "keputusan"
    ? [{ ke: l.ya - 1, label: "Ya" }, { ke: l.tidak - 1, label: "Tidak" }]
    : [{ ke: i + 1, label: null }]);

  // sambungan antar halaman: garis i -> j dengan i dan j di halaman berbeda
  const masuk = [], keluar = [];
  semua.forEach((l, i) => keluarDari(l, i).forEach((e) => {
    const diDalamI = i >= awal && i < akhir, diDalamJ = e.ke >= awal && e.ke < akhir;
    if (diDalamI && !diDalamJ) keluar.push({ i, j: e.ke, label: e.label, h: huruf[`${i}>${e.ke}`] });
    if (!diDalamI && diDalamJ) masuk.push({ i, j: e.ke, h: huruf[`${i}>${e.ke}`] });
  }));
  masuk.sort((x, y) => x.j - y.j || x.i - y.i);
  keluar.sort((x, y) => x.i - y.i || x.j - y.j);

  const baris = []; // setiap elemen: langkah asli atau penghubung
  const nAtas = masuk.length;
  masuk.forEach((m) => baris.push({
    jenis: "penghubung", huruf: m.h, lajur: semua[m.j].lajur, no: "",
    teks: `Sambungan dari langkah ${semua[m.i].no} (${m.h})`, tujuan: m.j,
  }));
  for (let i = awal; i < akhir; i++) baris.push({ ...semua[i], asli: i });
  keluar.forEach((x) => baris.push({
    jenis: "penghubung", huruf: x.h, lajur: semua[x.i].lajur, no: "",
    teks: `Lanjut ke langkah ${semua[x.j].no} (${x.h})`, sumber: x.i, labelCabang: x.label,
  }));
  const idxAsli = (g) => nAtas + (g - awal);
  const idxKeluar = (i, j) => nAtas + (akhir - awal) + keluar.findIndex((x) => x.i === i && x.j === j);
  const langkahRute = baris.map((l, bi) => {
    if (l.jenis === "penghubung") {
      return { jenis: "penghubung", lajur: l.lajur, keluar: l.tujuan !== undefined ? [{ ke: idxAsli(l.tujuan), label: null }] : [] };
    }
    return {
      jenis: l.jenis, lajur: l.lajur,
      keluar: keluarDari(l, l.asli).map((e) => ({
        ke: e.ke >= awal && e.ke < akhir ? idxAsli(e.ke) : idxKeluar(l.asli, e.ke), label: e.label,
      })),
    };
  });

  const half = (l) => (l.jenis === "penghubung" ? SIM_HUBUNG : SIM[l.jenis]);
  const tinggi = baris.map((l) => (l.jenis === "penghubung" ? 11 : tinggiBaris(l, k)));
  const tops = [];
  tinggi.reduce((a, h, i) => { tops[i] = a; return a + h; }, 0);
  const rute = SopAlir.rute({
    langkah: langkahRute, lajurLebar: k.lajurW, simLebar: k.simW, tops, tinggi,
    setengah: baris.map(half), setengahLebar: baris.map((l) => (l.jenis === "penghubung" ? LEBAR_HUBUNG : k.simW / 2)),
    satuan: 1,
  });
  const barisDari = (y) => { // indeks baris yang memuat y global
    for (let r = tops.length - 1; r >= 0; r--) if (y >= tops[r] - 1e-9) return r;
    return 0;
  };
  const potongan = rute.map((r) => SopAlir.potongBaris(r.titik, tops, tinggi, 0));
  const lebarLajur = nL * k.lajurW;

  const kol = [k.no, k.kegiatan, ...urut.map(() => k.lajurW), k.kelengkapan, k.waktu, k.output, k.keterangan];
  const cols = kol.map((w) => `<col style="width:${f(w)}mm">`).join("");
  const kepala =
    `<thead><tr><th rowspan="2" scope="col">No</th><th rowspan="2" scope="col">Kegiatan</th>` +
    `<th colspan="${nL}" scope="colgroup">Pelaksana</th><th colspan="3" scope="colgroup">Mutu Baku</th><th rowspan="2" scope="col">Keterangan</th></tr>` +
    `<tr>${urut.map((x) => `<th class="pel" scope="col">${esc(rapikan(x.nama))}</th>`).join("")}` +
    `<th scope="col">Kelengkapan</th><th scope="col">Waktu</th><th scope="col">Output</th></tr></thead>`;

  const isi = baris.map((l, i) => {
    const bagian = [];
    for (let q = 1; q < nL; q++) bagian.push(`<line x1="${f(q * k.lajurW)}" y1="0" x2="${f(q * k.lajurW)}" y2="${f(tinggi[i])}" stroke="#d1d5db" stroke-width="0.2" stroke-dasharray="1 1"/>`);
    rute.forEach((r, ri) => {
      for (const pl of potongan[ri][i] || []) {
        bagian.push(`<polyline points="${pl.map((t) => `${f(t[0])},${f(t[1])}`).join(" ")}" fill="none" stroke="#111827" stroke-width="0.35" stroke-linecap="square" stroke-linejoin="miter"/>`);
      }
      if (barisDari(r.kepala.y) === i) bagian.push(kepalaSvg({ ...r.kepala, y: r.kepala.y - tops[i] }));
      if (r.label && barisDari(r.labelPos.y) === i) {
        bagian.push(`<text x="${f(r.labelPos.x)}" y="${f(r.labelPos.y - tops[i])}" text-anchor="${r.labelPos.anchor}" font-size="2.1" font-weight="700" fill="#111827" stroke="#ffffff" stroke-width="0.5" paint-order="stroke">${r.label}</text>`);
      }
    });
    bagian.push(simbolSvg(l, (l.lajur + 0.5) * k.lajurW, tinggi[i] / 2, k));
    const label = l.jenis === "penghubung" ? `Penghubung antar halaman ${l.huruf}` : `Simbol alir langkah ${l.no}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(lebarLajur)} ${f(tinggi[i])}" width="${f(lebarLajur)}mm" height="${f(tinggi[i])}mm" role="img" aria-label="${esc(label)}">${bagian.join("")}</svg>`;
    if (l.jenis === "penghubung") {
      return `<tr class="baris hubung" data-h="${f(tinggi[i])}" style="height:${f(tinggi[i])}mm">` +
        `<td class="no"></td><td class="kegiatan"><em>${esc(l.teks)}</em></td>` +
        `<td class="lajur" colspan="${nL}">${svg}</td><td colspan="4"></td></tr>`;
    }
    const ket = (l.keterangan ? `<div>${esc(rapikan(l.keterangan))}</div>` : "") +
      (l.jenis === "keputusan" ? `<div class="cabang">${esc(teksCabang(l))}</div>` : "");
    return `<tr class="baris" data-h="${f(tinggi[i])}" style="height:${f(tinggi[i])}mm">` +
      `<th scope="row" class="no">${l.no}</th><td class="kegiatan">${esc(rapikan(l.aktivitas))}</td>` +
      `<td class="lajur" colspan="${nL}">${svg}</td>` +
      `<td>${esc(rapikan(l.kelengkapan))}</td><td>${esc(rapikan(l.waktu))}</td><td>${esc(rapikan(l.output))}</td>` +
      `<td class="ket">${ket}</td></tr>`;
  });
  return `<table class="matriks"><colgroup>${cols}</colgroup>${kepala}<tbody>${isi.join("")}</tbody></table>`;
}

const LEGENDA =
  `<svg class="legenda" viewBox="0 0 75 8" width="75mm" height="8mm" role="img" aria-label="Legenda simbol">` +
  `<rect x="1" y="2" width="9" height="4" rx="2" fill="#e5e7eb" stroke="#111827" stroke-width="0.3"/>` +
  `<text x="12" y="4" dy=".35em" font-size="2.4" fill="#111827">Mulai/Selesai</text>` +
  `<rect x="31" y="1.5" width="8" height="5" rx="0.6" fill="#fff" stroke="#111827" stroke-width="0.3"/>` +
  `<text x="41" y="4" dy=".35em" font-size="2.4" fill="#111827">Proses</text>` +
  `<polygon points="54,4 57.5,0.8 61,4 57.5,7.2" fill="#fef3c7" stroke="#111827" stroke-width="0.3"/>` +
  `<text x="63" y="4" dy=".35em" font-size="2.4" fill="#111827">Keputusan</text></svg>`;

const CSS = `
@page { size: A4 landscape; margin: 10mm 10mm 14mm 10mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Noto Sans", "Liberation Sans", Arial, "DejaVu Sans", sans-serif; font-size: 8.5pt; line-height: 1.35; color: #111827; background: #e5e7eb; }
.halaman { width: ${HAL_LEBAR}mm; margin: 6mm auto; padding: 0; background: #fff; }
@media screen { .halaman { padding: 10mm; width: ${HAL_LEBAR + 20}mm; box-shadow: 0 1px 6px rgba(0,0,0,.25); } }
@media print { body { background: #fff; } .halaman { margin: 0; break-after: page; } .halaman:last-child { break-after: auto; } }
h1 { font-size: 13pt; margin: 0 0 2mm; }
h2 { font-size: 11pt; margin: 0 0 1.5mm; }
h3 { font-size: 8.5pt; margin: 0 0 1mm; text-transform: uppercase; letter-spacing: .02em; }
table { border-collapse: separate; border-spacing: 0; width: 100%; }
.kop th, .kop td, .unsur td, .daftar th, .daftar td { border: 0.3mm solid #111827; padding: 1.6mm 2mm; vertical-align: top; text-align: left; }
.kop { margin-bottom: 4mm; }
.kop th { width: 38mm; background: #f3f4f6; font-weight: 600; }
.kop .kop-instansi { width: 95mm; text-align: center; vertical-align: middle; }
.kop .kecil { font-size: 8pt; letter-spacing: .08em; color: #374151; }
.kop .instansi { font-size: 13pt; font-weight: 700; margin-top: 2mm; }
.kop .logo { max-height: 22mm; max-width: 60mm; margin-bottom: 2mm; }
.kop .ttd { height: 12mm; color: #6b7280; font-size: 7pt; }
.unsur { margin-bottom: 4mm; table-layout: fixed; }
.unsur td { width: 50%; }
.unsur ol { margin: 0; padding-left: 5mm; }
.unsur li { margin-bottom: 0.8mm; }
.daftar th { background: #f3f4f6; }
.matriks { table-layout: fixed; margin-top: 2mm; }
.matriks th, .matriks td { border-right: 0.3mm solid #111827; border-bottom: 0.3mm solid #111827; padding: ${PAD_MM}mm; font-size: 7.5pt; line-height: 1.3; vertical-align: middle; text-align: left; overflow-wrap: anywhere; }
.matriks tr > :first-child { border-left: 0.3mm solid #111827; }
.matriks thead tr:first-child > * { border-top: 0.3mm solid #111827; }
.matriks th { background: #e5e7eb; text-align: center; font-weight: 700; }
.matriks th.pel { font-weight: 600; font-size: 7pt; }
.matriks thead { display: table-header-group; }
.matriks td.no, .matriks th.no { text-align: center; }
.matriks tbody th.no { background: transparent; font-weight: 400; }
.matriks tr.hubung td.kegiatan { font-size: 7pt; color: #374151; }
.matriks td.lajur { padding: 0; }
.matriks td.lajur svg { display: block; overflow: visible; }
.matriks tr.baris { break-inside: avoid; }
.matriks .cabang { margin-top: 0.8mm; font-weight: 600; }
.prosedur-judul { display: flex; justify-content: space-between; align-items: baseline; gap: 6mm; }
.tujuan { margin: 0 0 1mm; }
.sah-teks { margin: 0 0 6mm; }
.sah th, .sah td { border: 0.3mm solid #111827; padding: 2mm; vertical-align: top; text-align: center; }
.sah .ruang { height: 30mm; }
.sah th { text-align: center; }
.sah .peran { background: #f3f4f6; font-weight: 600; }
`;

/** Dokumen cetak lengkap sebagai string HTML. */
export function buatHtml(sop, { langkahPerHalaman = LANGKAH_PER_HALAMAN, logo = null } = {}) {
  const id = sop.identitas;
  const daftarOl = (arr) => `<ol>${arr.map((x) => `<li>${esc(rapikan(x))}</li>`).join("")}</ol>`;
  const unsur = (judul, arr) => `<td><h3>${esc(judul)}</h3>${daftarOl(arr)}</td>`;
  const sahBy = id.disahkanOleh;

  const identitas = `<section class="halaman" id="identitas">
<table class="kop"><tbody>
<tr><td class="kop-instansi" rowspan="6">${logo ? `<img class="logo" src="${logo}" alt="Logo ${esc(rapikan(id.unit))}"><br>` : ""}<div class="kecil">STANDAR OPERASIONAL PROSEDUR</div><div class="instansi">${esc(rapikan(id.unit))}</div></td><th scope="row">Nomor SOP</th><td>${esc(rapikan(id.nomor))}</td></tr>
<tr><th scope="row">Tanggal Pembuatan</th><td>${esc(tanggalIndonesia(id.tanggalPembuatan))}</td></tr>
<tr><th scope="row">Tanggal Revisi</th><td>${id.tanggalRevisi ? esc(tanggalIndonesia(id.tanggalRevisi)) : "-"}</td></tr>
<tr><th scope="row">Tanggal Efektif</th><td>${esc(tanggalIndonesia(id.tanggalEfektif))}</td></tr>
<tr><th scope="row">Disahkan oleh</th><td>${esc(rapikan(sahBy.jabatan))}<div class="ttd">(tanda tangan dan stempel)</div>${sahBy.nama ? `<strong>${esc(rapikan(sahBy.nama))}</strong>` : "(nama)"}<br>NIP. ${sahBy.nip ? esc(rapikan(sahBy.nip)) : "-"}</td></tr>
<tr><th scope="row">Nama SOP</th><td><strong>${esc(rapikan(id.judul))}</strong></td></tr>
</tbody></table>
<table class="unsur"><tbody>
<tr>${unsur("Dasar Hukum", sop.dasarHukum)}${unsur("Kualifikasi Pelaksana", sop.kualifikasiPelaksana)}</tr>
<tr>${unsur("Keterkaitan", sop.keterkaitan)}${unsur("Peralatan/Perlengkapan", sop.peralatan)}</tr>
<tr>${unsur("Peringatan", sop.peringatan)}${unsur("Pencatatan dan Pendataan", sop.pencatatan)}</tr>
</tbody></table>
<table class="daftar"><thead><tr><th style="width:30mm" scope="col">Kode</th><th scope="col">Prosedur dalam dokumen ini</th><th style="width:25mm" scope="col">Jumlah langkah</th></tr></thead><tbody>
${sop.prosedur.map((p) => `<tr><td>${esc(rapikan(p.kode))}</td><td>${esc(rapikan(p.judul))}</td><td>${p.langkah.length}</td></tr>`).join("\n")}
</tbody></table>
</section>`;

  const prosedur = sop.prosedur.map((p, pi) => {
    const urut = urutanPelaksana(p.langkah, sop.pelaksana);
    const halaman = bagiHalaman(p.langkah.length, langkahPerHalaman);
    const halamanDari = (i) => halaman.findIndex(([a, b]) => i >= a && i < b);
    // huruf penanda untuk tiap garis yang melintasi batas halaman
    const huruf = {};
    let n = 0;
    p.langkah.forEach((l, i) => {
      const tujuan = l.jenis === "selesai" ? [] : l.jenis === "keputusan" ? [l.ya - 1, l.tidak - 1] : [i + 1];
      for (const j of tujuan) if (halamanDari(i) !== halamanDari(j)) huruf[`${i}>${j}`] = hurufSambungan(n++);
    });
    return halaman.map((rentang, hi) => `<section class="halaman" id="prosedur-${pi + 1}${hi ? `-${hi + 1}` : ""}">
<div class="prosedur-judul"><h2>${esc(rapikan(p.kode))}: ${esc(rapikan(p.judul))}${halaman.length > 1 ? ` (halaman ${hi + 1} dari ${halaman.length})` : ""}</h2>${LEGENDA}</div>
${hi === 0 ? `<p class="tujuan"><strong>Tujuan:</strong> ${esc(rapikan(p.tujuan))}</p>` : ""}
${tabelProsedur(sop, p, rentang, huruf, urut)}
</section>`).join("\n");
  }).join("\n");

  const pg = sop.pengesahan;
  const pengesahan = `<section class="halaman" id="pengesahan">
<h2>Lembar Penetapan dan Pengesahan</h2>
<p class="sah-teks">Ditetapkan di ${esc(rapikan(pg.ditetapkanDi))}<br>pada tanggal ${esc(tanggalIndonesia(pg.tanggal))}</p>
<table class="sah"><tbody>
<tr>${pg.penandatangan.map((x) => `<th class="peran" scope="col">${esc(rapikan(x.peran))}</th>`).join("")}</tr>
<tr>${pg.penandatangan.map(() => `<td class="ruang">(tanda tangan dan cap)</td>`).join("")}</tr>
<tr>${pg.penandatangan.map((x) => `<td><strong>${esc(rapikan(x.jabatan))}</strong><br>${x.nama ? esc(rapikan(x.nama)) : "(nama)"}<br>NIP. ${x.nip ? esc(rapikan(x.nip)) : "-"}</td>`).join("")}</tr>
</tbody></table>
</section>`;

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(rapikan(id.judul))} - ${esc(rapikan(id.nomor))}</title>
<style>${CSS}</style>
</head>
<body>
${identitas}
${prosedur}
${pengesahan}
</body>
</html>
`;
}

// ------------------------------------------------------------------------ PDF
// Utang teknis: pencarian browser ini menduplikasi cariBrowser() di render.mjs agar
// perilaku render.mjs tidak berubah. Bila render.mjs kelak mengekstrak fungsinya ke
// modul bersama, ganti salinan ini.
function cariBrowser(pilihan) {
  if (pilihan) {
    if (!existsSync(pilihan)) throw Object.assign(new Error(`--browser tidak ada: ${pilihan}`), { kode: 2 });
    return pilihan;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  const kandidat = [
    ["chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell"],
    ["chromium-", "chrome-linux64/chrome"],
  ];
  if (existsSync(root)) {
    for (const [awalan, rel] of kandidat) {
      const dirs = readdirSync(root)
        .filter((d) => d.startsWith(awalan) && /^\d+$/.test(d.slice(awalan.length)))
        .sort((a, b) => Number(b.slice(awalan.length)) - Number(a.slice(awalan.length)));
      for (const d of dirs) {
        const exe = join(root, d, rel);
        if (existsSync(exe)) return exe;
      }
    }
  }
  for (const exe of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(exe)) return exe;
  }
  throw Object.assign(new Error("tidak menemukan browser Chromium; pakai --browser /path/chrome"), { kode: 2 });
}

/** Mencetak sop.html ke PDF A4 landscape. Mengembalikan daftar peringatan tata letak. */
export async function cetakPdf(htmlPath, pdfPath, sop, pilihanBrowser) {
  const { chromium } = await import("playwright-core");
  const exe = cariBrowser(pilihanBrowser);
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  const peringatan = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.emulateMedia({ media: "print" });
    await page.goto(pathToFileURL(resolve(htmlPath)).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    // tinggi baris matriks harus sama dengan yang dipakai untuk menggambar garis alir
    const melar = await page.evaluate(() => {
      const mmPx = 96 / 25.4;
      return [...document.querySelectorAll("tr.baris")].map((tr, i) => ({
        i, harapan: Number(tr.dataset.h) * mmPx, nyata: tr.getBoundingClientRect().height,
        no: tr.querySelector(".no")?.textContent,
      })).filter((r) => Math.abs(r.nyata - r.harapan) > 1.5);
    });
    for (const r of melar) {
      peringatan.push(`peringatan: tata letak baris langkah ${r.no} berbeda dari rencana (${(r.nyata / (96 / 25.4)).toFixed(1)} mm, rencana ${(r.harapan / (96 / 25.4)).toFixed(1)} mm); garis alir bisa meleset`);
    }
    const id = sop.identitas;
    const eh = (s) => esc(rapikan(s));
    await page.pdf({
      path: pdfPath, format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true,
      tagged: true, outline: true, // PDF bertag dengan outline; bukan klaim PDF/UA (belum divalidasi)
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: `<div style="font-size:7px;width:100%;padding:0 10mm;display:flex;justify-content:space-between;color:#374151;font-family:sans-serif"><span>${eh(id.nomor)} | ${eh(id.judul)}</span><span>Halaman <span class="pageNumber"></span> dari <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await browser.close().catch(() => {});
  }
  return peringatan;
}

// ------------------------------------------------------------------------ CLI
const PETUNJUK = `Pemakaian:
  bun scripts/sop.mjs <sop.json> --out DIR [--pdf] [--fps 30] [--cps 17] [--wpm 140]
      [--jeda-segmen 2] [--langkah-per-halaman 10] [--browser PATH]
Menghasilkan DIR/sop.html, DIR/video-props.json, DIR/caption.vtt (+ DIR/sop.pdf dengan --pdf).`;

function gagal(pesan, kode) {
  console.error(`sop.mjs: ${pesan}`);
  process.exit(kode);
}

export async function utama(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string" }, pdf: { type: "boolean" }, fps: { type: "string", default: "30" },
        cps: { type: "string", default: "17" }, wpm: { type: "string", default: String(WPM_BAWAAN) },
        "jeda-segmen": { type: "string", default: String(JEDA_SEGMEN_BAWAAN) },
        "langkah-per-halaman": { type: "string", default: String(LANGKAH_PER_HALAMAN) }, browser: { type: "string" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const { values: o, positionals } = args;
  if (o.help) { console.log(PETUNJUK); return 0; }
  if (positionals.length !== 1) gagal(`harus tepat satu berkas sop.json.\n${PETUNJUK}`, 2);
  if (!o.out) gagal(`--out wajib.\n${PETUNJUK}`, 2);
  const fps = Number(o.fps), cps = Number(o.cps), wpm = Number(o.wpm);
  const jedaSegmen = Number(o["jeda-segmen"]), perHalaman = Number(o["langkah-per-halaman"]);
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) gagal(`--fps tidak valid: "${o.fps}" (bilangan bulat 1..120)`, 2);
  if (!Number.isFinite(cps) || cps < 5 || cps > 40) gagal(`--cps tidak valid: "${o.cps}" (5..40)`, 2);

  if (!Number.isFinite(wpm) || wpm < 60 || wpm > 300) gagal(`--wpm tidak valid: "${o.wpm}" (60..300 kata per menit)`, 2);
  if (!Number.isFinite(jedaSegmen) || jedaSegmen < 2 || jedaSegmen > 5) gagal(`--jeda-segmen tidak valid: "${o["jeda-segmen"]}" (2..5 detik)`, 2);
  if (!Number.isInteger(perHalaman) || perHalaman < 3 || perHalaman > 40) gagal(`--langkah-per-halaman tidak valid: "${o["langkah-per-halaman"]}" (bilangan bulat 3..40)`, 2);

  const berkas = positionals[0];
  if (!existsSync(berkas)) gagal(`berkas tidak ditemukan: ${berkas}`, 2);
  let sop;
  try {
    sop = JSON.parse(readFileSync(berkas, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    gagal(`${berkas} bukan JSON valid: ${e.message}`, 2);
  }
  const galat = validasi(sop);
  if (galat.length) {
    console.error(`sop.mjs: ${berkas} tidak valid (${galat.length} galat):\n${galat.map((g) => `  - ${g}`).join("\n")}`);
    return 2;
  }

  // logo (opsional): berkas gambar relatif terhadap sop.json, disematkan sebagai data URI
  let logo = null;
  if (sop.identitas.logo) {
    const f = resolve(dirname(resolve(berkas)), sop.identitas.logo);
    const tipe = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp" }[extname(f).toLowerCase()];
    if (!tipe) gagal(`${berkas} tidak valid: identitas.logo: ekstensi harus png, jpg, svg, atau webp: ${sop.identitas.logo}`, 2);
    if (!existsSync(f)) gagal(`${berkas} tidak valid: identitas.logo: berkas tidak ditemukan: ${sop.identitas.logo}`, 2);
    const data = readFileSync(f);
    if (data.length > MAKS_LOGO_BYTE) gagal(`${berkas} tidak valid: identitas.logo: ${data.length} byte melebihi batas ${MAKS_LOGO_BYTE}`, 2);
    logo = `data:${tipe};base64,${data.toString("base64")}`;
  }
  for (const w of peringatanSop(sop)) console.error(`peringatan: ${w}`);

  const dir = resolve(o.out);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    gagal(`tidak bisa membuat folder keluaran ${o.out}: ${e.message}`, 2);
  }
  const props = susunVideo(sop, { fps, cps, wpm, jedaSegmen });
  writeFileSync(join(dir, "sop.html"), buatHtml(sop, { langkahPerHalaman: perHalaman, logo }));
  writeFileSync(join(dir, "video-props.json"), `${JSON.stringify(props, null, 2)}\n`);
  writeFileSync(join(dir, "caption.vtt"), buatVtt(props.caption, fps));
  const langkahTotal = sop.prosedur.reduce((n, p) => n + p.langkah.length, 0);
  console.log(`sop.html, video-props.json, caption.vtt -> ${dir}`);
  console.log(`  ${sop.prosedur.length} prosedur, ${langkahTotal} langkah, ${props.adegan.length} adegan, ` +
    `${props.durationInFrames} frame @ ${fps} fps = ${(props.durationInFrames / fps).toFixed(1)} s, ${props.caption.length} cue caption`);

  if (o.pdf) {
    try {
      const peringatan = await cetakPdf(join(dir, "sop.html"), join(dir, "sop.pdf"), sop, o.browser);
      for (const p of peringatan) console.error(p);
      console.log(`sop.pdf -> ${join(dir, "sop.pdf")}`);
    } catch (e) {
      console.error(`sop.mjs: gagal membuat PDF: ${e.message}`);
      return e.kode === 2 ? 2 : 1;
    }
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await utama(process.argv.slice(2)));
}
