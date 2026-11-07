/**
 * awvd / normalisasi-id.mjs — normalisasi teks Indonesia sebelum masuk mesin TTS.
 *
 * Mesin TTS saraf membaca angka, tanggal, URL, surel, dan singkatan dengan kacau (riset awvd,
 * uji putar-balik ASR 2026-11-07: tanggal "12/03/2026" dan "Pasal 5 ayat (2)" tidak terucap
 * benar; angka yang dieja aman). Modul ini mengubahnya menjadi kata, murni dan deterministik
 * (tanpa jaringan, tanpa kamus eksternal): `normalisasiTeks(teks, bahasa, { kamus })`.
 *
 * Yang ditangani (urutan penerapan): kamus pengguna, surel, URL, tanggal (DD/MM/YYYY dan
 * ISO), jam (08.30 WIB), rupiah dan dolar, persen, nomor di dalam kurung ("ayat (2)"),
 * ordinal "ke-3", nomor telepon dan angka panjang (dieja per digit), rentang "5-10",
 * angka negatif, angka berformat Indonesia (1.500.000 dan 3,5) lengkap dengan satuan
 * umum (kg, km, GB, ms), singkatan hukum dan gelar (UU, No., Jl., dr.), serta akronim
 * yang dieja per huruf (SOP, PDF, KTP). Sisa angka apa pun dibaca sebagai bilangan.
 *
 * Batas: bukan kamus lengkap. Singkatan di luar daftar tidak ditebak; nama diri dan akronim
 * khas proyek dimasukkan lewat `kamus` ({ kata: bacaan }, cocok persis, huruf besar-kecil
 * dibedakan). Teks hasil dicatat di keluaran narasi supaya bisa diaudit.
 * Karya asli repo ini (tanpa menyalin pustaka normalisasi pihak lain).
 */

const SATUAN = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan", "sepuluh", "sebelas"];
const SKALA = ["", "ribu", "juta", "miliar", "triliun"];
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const HURUF = { a: "a", b: "be", c: "se", d: "de", e: "e", f: "ef", g: "ge", h: "ha", i: "i", j: "je", k: "ka", l: "el", m: "em", n: "en", o: "o", p: "pe", q: "ki", r: "er", s: "es", t: "te", u: "u", v: "ve", w: "we", x: "eks", y: "ye", z: "zet" };
const ZONA = { WIB: "Waktu Indonesia Barat", WITA: "Waktu Indonesia Tengah", WIT: "Waktu Indonesia Timur" };
const SATUAN_UKUR = {
  kg: "kilogram", km: "kilometer", cm: "sentimeter", mm: "milimeter", m: "meter", GB: "gigabyte", MB: "megabyte", KB: "kilobyte",
  TB: "terabyte", Hz: "hertz", kHz: "kilohertz", MHz: "megahertz", GHz: "gigahertz", ms: "milidetik", jt: "juta", rb: "ribu",
};
const SINGKATAN = [
  [/\bNo\.\s*/g, "Nomor "], [/\bJl\.\s*/g, "Jalan "], [/\bGg\.\s*/g, "Gang "], [/\bdr\.\s*/g, "dokter "], [/\bDr\.\s*/g, "Doktor "],
  [/\bProf\.\s*/g, "Profesor "], [/\bIr\.\s*/g, "Insinyur "], [/\bdll\./g, "dan lain-lain"], [/\bdsb\./g, "dan sebagainya"],
  [/\bdst\./g, "dan seterusnya"], [/\bdkk\./g, "dan kawan-kawan"], [/\b[Tt]gl\.\s*/g, "tanggal "], [/\bhlm\.\s*/g, "halaman "],
  [/\b[Yy]th\.\s*/g, "yang terhormat "],
  [/\bUUD\b/g, "Undang-Undang Dasar"], [/\bUU\b/g, "Undang-Undang"], [/\bPerpres\b/g, "Peraturan Presiden"],
  [/\bPermen\b/g, "Peraturan Menteri"], [/\bPerda\b/g, "Peraturan Daerah"], [/\bPP\b/g, "Peraturan Pemerintah"],
  [/\bWITA\b/g, ZONA.WITA], [/\bWIB\b/g, ZONA.WIB], [/\bWIT\b/g, ZONA.WIT],
];
/** Akronim yang lazim dieja per huruf di Indonesia; yang lain dibiarkan (dibaca mesin sebagai kata). */
const AKRONIM_EJA = ["SOP", "PDF", "URL", "API", "KTP", "NIK", "NPWP", "ATM", "CPU", "GPU", "TV", "SD", "SMP", "SMA", "RT", "RW", "PNS", "ASN", "BPJS", "HP"];

// ------------------------------------------------------------------ bilangan
const digitPerDigit = (s) => [...s].map((d) => SATUAN[Number(d)]).join(" ");

function tiga(n) {
  if (n < 12) return [SATUAN[n]];
  if (n < 20) return [`${SATUAN[n - 10]} belas`];
  if (n < 100) return [SATUAN[Math.floor(n / 10)], "puluh", ...(n % 10 ? [SATUAN[n % 10]] : [])];
  const r = Math.floor(n / 100), sisa = n % 100;
  return [r === 1 ? "seratus" : `${SATUAN[r]} ratus`, ...(sisa ? tiga(sisa) : [])];
}

/**
 * Bilangan bulat (teks digit) menjadi kata Indonesia: 0 nol, 11 sebelas, 1000 seribu,
 * 2026 dua ribu dua puluh enam. Sampai 10^15 - 1; yang lebih besar dieja per digit.
 */
export function terbilang(digit) {
  const s = String(digit).replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(s)) throw new Error(`terbilang: bukan bilangan bulat: ${digit}`);
  let n = BigInt(s);
  if (n === 0n) return "nol";
  const grup = [];
  while (n > 0n) { grup.push(Number(n % 1000n)); n /= 1000n; }
  if (grup.length > SKALA.length) return digitPerDigit(s);
  const bagian = [];
  for (let i = grup.length - 1; i >= 0; i--) {
    const g = grup[i];
    if (!g) continue;
    if (i === 1 && g === 1) bagian.push("seribu");
    else bagian.push(...tiga(g), ...(SKALA[i] ? [SKALA[i]] : []));
  }
  return bagian.join(" ");
}

/** Angka format Indonesia ("1.500.000" atau "3,5" atau "3.5") menjadi kata. */
function bilangan(bulat, desimal) {
  const polos = bulat.replace(/\./g, "");
  const kepala = terbilang(polos);
  return desimal ? `${kepala} koma ${digitPerDigit(desimal)}` : kepala;
}

// ------------------------------------------------------------------ langkah per jenis
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lafalDomain(s) {
  return s.replace(/\./g, " titik ").replace(/-/g, " strip ").replace(/_/g, " garis bawah ");
}
function lafalPath(s) {
  return s.replace(/\//g, " garis miring ").replace(/\./g, " titik ").replace(/-/g, " strip ").replace(/_/g, " garis bawah ")
    .replace(/\?/g, " tanda tanya ").replace(/=/g, " sama dengan ").replace(/&/g, " dan ").replace(/#/g, " pagar ");
}
const potongPenutup = (s) => { const m = s.match(/^(.*?)([.,;:!?)]*)$/s); return [m[1], m[2]]; };

const POLA_SUREL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const POLA_URL = /\b(?:https?:\/\/|www\.)[^\s<>"]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|id|io|dev|app|info)(?:\/[^\s<>"]*)?(?![\w@])/gi;

function surel(teks) {
  return teks.replace(POLA_SUREL, (m) => {
    const [bersih, penutup] = potongPenutup(m);
    const [lokal, domain] = bersih.split("@");
    return ` ${lafalDomain(lokal)} at ${lafalDomain(domain)}${penutup} `;
  });
}
function url(teks) {
  return teks.replace(POLA_URL, (m) => {
    const [bersih, penutup] = potongPenutup(m);
    let s = bersih.replace(/^https?:\/\//i, "");
    s = s.replace(/^www\./i, "we we we titik ");
    const i = s.search(/[/?#]/);
    const host = i < 0 ? s : s.slice(0, i), path = i < 0 ? "" : s.slice(i);
    return ` ${lafalDomain(host)}${lafalPath(path)}${penutup} `;
  });
}

function tanggal(teks) {
  const pakai = (d, b, t) => {
    const dd = Number(d), bb = Number(b);
    if (dd < 1 || dd > 31 || bb < 1 || bb > 12) return null;
    return `${terbilang(String(dd))} ${BULAN[bb - 1]} ${terbilang(t)}`;
  };
  return teks
    .replace(/(?<![\d.,/-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g, (m, t, b, d) => pakai(d, b, t) ?? m)
    .replace(/(?<![\d.,/-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d])/g, (m, d, b, t) => pakai(d, b, t) ?? m);
}

function jam(teks) {
  return teks.replace(/(?<![\d.,])(?:([Pp]ukul|[Jj]am)\s+)?([01]?\d|2[0-3])([.:])([0-5]\d)(?![\d])(?:\s*(WIB|WITA|WIT)\b)?/g,
    (m, awalan, h, pemisah, mnt, zona) => {
      // "10.30" polos bisa angka desimal: dianggap jam hanya bila ada konteks (awalan, zona, titik dua, atau nol di depan)
      if (!awalan && !zona && pemisah !== ":" && !/^0\d$/.test(h)) return m;
      const kepala = `${awalan ? `${awalan} ` : ""}${terbilang(h)}`;
      const menit = Number(mnt) === 0 ? "" : ` lewat ${terbilang(mnt)} menit`;
      return `${kepala}${menit}${zona ? ` ${ZONA[zona]}` : ""}`;
    });
}

const POLA_ANGKA = String.raw`(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d+))?`;

function mataUang(teks) {
  const skalaOpsional = String.raw`(?:\s+(ribu|juta|miliar|triliun))?`;
  return teks
    .replace(new RegExp(String.raw`(?<![A-Za-z])Rp\.?\s?${POLA_ANGKA}${skalaOpsional}`, "g"), (m, b, d, skala) => ` ${bilangan(b, d)}${skala ? ` ${skala}` : ""} rupiah `)
    .replace(new RegExp(String.raw`(?<![A-Za-z])(?:US)?\$\s?${POLA_ANGKA}${skalaOpsional}`, "g"), (m, b, d, skala) => ` ${bilangan(b, d)}${skala ? ` ${skala}` : ""} dolar `);
}

function persen(teks) {
  return teks.replace(new RegExp(String.raw`(?<![\d.,])${POLA_ANGKA}\s?%`, "g"), (m, b, d) => ` ${bilangan(b, d)} persen `);
}

function kurung(teks) {
  return teks.replace(/\(\s*(\d+)\s*\)/g, " $1 ");
}

function ordinal(teks) {
  return teks.replace(/\bke[-–](\d+)\b/g, (m, n) => (Number(n) === 1 ? "pertama" : `ke${terbilang(n)}`));
}

function telepon(teks) {
  return teks.replace(/(?<![\d.,/-])(\+62|0)((?:[\s-]?\d){8,13})(?![\d])/g, (m, awal, sisa) => {
    const depan = awal === "+62" ? "plus enam dua" : "nol";
    return ` ${depan} ${digitPerDigit(sisa.replace(/[\s-]/g, ""))} `;
  });
}

function rentang(teks) {
  return teks
    .replace(/(?<=\d)\s?[-–]\s?(?=\d)/g, " sampai ")
    .replace(/(?<![\w)])-(?=\d)/g, "minus ");
}

function angkaUmum(teks) {
  const satuan = Object.keys(SATUAN_UKUR).sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const re = new RegExp(String.raw`(?<![\d.,])${POLA_ANGKA}(\s?(?:${satuan})(?![A-Za-z]))?`, "g");
  return teks.replace(re, (m, b, d, uk, offset, semua) => {
    const sebelum = semua[offset - 1] ?? "", setelah = semua[offset + m.length] ?? "";
    let isi;
    if (!b.includes(".") && !d && (b.length >= 11 || (b.length > 1 && b.startsWith("0")))) isi = digitPerDigit(b);
    else isi = bilangan(b, d);
    if (uk) isi += ` ${SATUAN_UKUR[uk.trim()]}`;
    return `${/\p{L}/u.test(sebelum) ? " " : ""}${isi}${/\p{L}/u.test(setelah) ? " " : ""}`;
  });
}

function sisaAngka(teks) {
  return teks.replace(/\d+/g, (m, offset, semua) => {
    const sebelum = semua[offset - 1] ?? "", setelah = semua[offset + m.length] ?? "";
    return `${/\p{L}/u.test(sebelum) ? " " : ""}${m.length > 1 && m.startsWith("0") ? digitPerDigit(m) : terbilang(m)}${/\p{L}/u.test(setelah) ? " " : ""}`;
  });
}

function singkatan(teks) {
  let s = teks;
  for (const [re, ganti] of SINGKATAN) s = s.replace(re, ganti);
  const eja = new RegExp(String.raw`\b(?:${AKRONIM_EJA.join("|")})\b`, "g");
  s = s.replace(eja, (m) => [...m].map((c) => HURUF[c.toLowerCase()]).join(" "));
  return s;
}

function kamusPengguna(teks, kamus) {
  let s = teks;
  for (const [kata, baca] of Object.entries(kamus ?? {})) {
    if (typeof baca !== "string" || !kata) continue;
    s = s.replace(new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRe(kata)}(?![\p{L}\p{N}])`, "gu"), baca);
  }
  return s;
}

function lainnya(teks) {
  return teks
    .replace(/\bdan\/atau\b/gi, "dan atau")
    .replace(/(?<=\p{L})\/(?=\p{L})/gu, " atau ")
    .replace(/&/g, " dan ");
}

const rapikan = (s) => s.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();

/** Normalisasi teks Indonesia (lihat kepala berkas). Hasil tidak memuat angka. */
export function normalisasiId(teks, { kamus = {} } = {}) {
  let s = String(teks);
  s = kamusPengguna(s, kamus);
  s = surel(s);
  s = url(s);
  s = tanggal(s);
  s = jam(s);
  s = mataUang(s);
  s = persen(s);
  s = kurung(s);
  s = ordinal(s);
  s = telepon(s);
  s = rentang(s);
  s = singkatan(s);
  s = angkaUmum(s);
  s = sisaAngka(s);
  s = lainnya(s);
  return rapikan(s);
}

/** Inggris: hanya merapikan; angka harus dieja penulis (naskah menolak angka tanpa `bacaan`). */
export function normalisasiEn(teks, { kamus = {} } = {}) {
  return rapikan(kamusPengguna(String(teks), kamus).replace(/&/g, " and "));
}

/** Memilih normalisasi menurut bahasa karakter suara (`id` atau `en`; lainnya hanya dirapikan). */
export function normalisasiTeks(teks, bahasa, opsi = {}) {
  if (bahasa === "id") return normalisasiId(teks, opsi);
  return normalisasiEn(teks, opsi);
}
