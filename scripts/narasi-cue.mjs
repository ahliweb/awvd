/**
 * awvd / narasi-cue.mjs — dari kata berstempel menjadi cue caption (WebVTT dan SRT) dan lint.
 *
 * Murni dan deterministik. Dipakai scripts/narasi.mjs. Pemecahan baris memakai
 * `pecahBaris` dari scripts/runtime.js (satu sumber kebenaran, dimuat apa adanya).
 *
 * Aturan pengelompokan: cue tidak melintasi pergantian adegan atau penutur; kalimat
 * mengakhiri cue; klausa (koma) mengakhiri cue bila cue sudah cukup panjang; cue tidak
 * melebihi baris x karakter maksimum maupun durasi maksimum; sisa kalimat 1-2 kata tidak
 * dibiarkan yatim. Waktu tampil: mulai saat kata pertama diucapkan, berakhir sedikit
 * sesudah kata terakhir (`tahan`), diperpanjang ke dalam jeda berikutnya (paling jauh
 * `tahanMaks`, tidak menimpa cue berikut) bila kecepatan baca melebihi `cps`, dan
 * diperpanjang sampai durasi minimum bila ada ruang. Cue tidak pernah dipercepat atau
 * diperlambat menyimpang dari ucapan: bila batas cps tetap terlampaui, lint melaporkan
 * `gagal` (perbaikannya di naskah atau kecepatan narasi), bukan menyembunyikannya.
 *
 * Karya asli repo ini. Batas dan dasar: docs/narasi-caption.md.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function muatRuntime() {
  const sebelum = globalThis.window;
  globalThis.window = { location: { search: "" } };
  try {
    return createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), "runtime.js"));
  } finally {
    if (sebelum === undefined) delete globalThis.window;
    else globalThis.window = sebelum;
  }
}
const { pecahBaris } = muatRuntime();

export const OPSI_CUE = {
  fps: 30,
  maksKarakter: 42,
  maksBaris: 2,
  cps: 17,
  minDurasi: 5 / 6, // detik; Netflix Timed Text Style Guide
  maksDurasi: 7,
  tahan: 0.2, // detik tampil sesudah kata terakhir
  tahanMaks: 0.5, // paling jauh caption bertahan sesudah ucapan demi kecepatan baca
  celahFrame: 2, // celah minimum antar-cue (nilai usulan awvd, bukan angka Netflix)
  klausaMin: null, // karakter minimum agar koma mengakhiri cue; null = 2/3 maksKarakter
  totalFrame: Infinity,
  akhirAdegan: {}, // { idAdegan: frame akhir adegan } batas atas perpanjangan cue
  penutur: {}, // { id: { nama, italik, label } }
};

const panjang = (s) => Array.from(s).length;
const KATA_SAMBUNG = ["dan", "atau", "tetapi", "yang", "untuk", "dengan", "di", "ke", "dari", "karena", "agar", "sehingga"];

/**
 * Mengelompokkan kata menjadi cue. `kata`: [{ tampil, tp, mulai, akhir, adegan, kalimat,
 * penutur }] dalam detik absolut dan urut. Mengembalikan cue:
 * { n, mulai, akhir, mulaiFrame, akhirFrame, adegan, penutur, teks, baris, karakter, cps,
 *   melebihi, indeks: [indeksKata...], jumlahKata, awalKalimat, akhirKalimat, kalimatKunci }.
 */
export function susunCue(kata, opsi = {}) {
  const op = { ...OPSI_CUE, ...opsi };
  const klausaMin = op.klausaMin ?? Math.round((op.maksKarakter * 2) / 3);
  const fps = op.fps;
  const grup = [];
  let cur = null;
  let penutuTerakhir = null;

  const awalanUntuk = (p) => {
    const info = op.penutur[p];
    return info && info.label && p !== penutuTerakhir ? `[${info.nama}] ` : "";
  };
  const teksGrup = (g, tambah) => g.awalan + [...g.indeks, ...(tambah === undefined ? [] : [tambah])].map((i) => kata[i].tampil).join(" ");
  const muat = (g, tambah) => !pecahBaris(teksGrup(g, tambah), { maks: op.maksKarakter, baris: op.maksBaris }).melebihi;
  const tutup = () => {
    if (cur && cur.indeks.length) { grup.push(cur); penutuTerakhir = kata[cur.indeks[0]].penutur; }
    cur = null;
  };
  const baru = (k, awal) => ({ indeks: [], awalan: awalanUntuk(k.penutur), awal });

  for (let i = 0; i < kata.length; i++) {
    const k = kata[i];
    if (cur && (k.adegan !== kata[cur.indeks[0]].adegan || k.penutur !== kata[cur.indeks[0]].penutur)) tutup();
    if (cur && !muat(cur, i)) {
      // hindari cue yatim: sisa kalimat 1-2 kata ikut dibawa ke cue berikutnya
      let sisa = 0;
      for (let x = i; x < kata.length && kata[x].adegan === k.adegan && kata[x].kalimat === k.kalimat; x++) {
        sisa++;
        if (kata[x].tp === "titik") break;
      }
      // potong sebelum kata sambung terdekat di separuh akhir cue; bila tak ada, bawa kata
      // supaya sisa kalimat minimal tiga kata
      let geser = 0;
      if (cur.indeks.length >= 4) {
        for (let c = cur.indeks.length - 1; c >= Math.ceil(cur.indeks.length / 2); c--) {
          if (KATA_SAMBUNG.includes(kata[cur.indeks[c]].teks.toLowerCase())) { geser = cur.indeks.length - c; break; }
        }
        if (!geser && sisa <= 2) geser = 3 - sisa;
      }
      const bawa = geser ? cur.indeks.splice(cur.indeks.length - geser, geser) : [];
      tutup();
      if (bawa.length) { cur = baru(kata[bawa[0]]); cur.indeks = bawa; }
    }
    if (cur && k.akhir - kata[cur.indeks[0]].mulai > op.maksDurasi - op.tahan) {
      let c = -1; // potong di klausa terakhir bila ada
      for (let x = cur.indeks.length - 1; x > 0; x--) if (kata[cur.indeks[x]].tp) { c = x; break; }
      if (c >= 0) {
        const sisa = cur.indeks.splice(c + 1);
        tutup();
        cur = baru(kata[sisa[0]]); cur.indeks = sisa;
      } else tutup();
    }
    if (!cur) cur = baru(k);
    cur.indeks.push(i);
    const lanjut = k.tp === "titik" || (k.tp === "koma" && panjang(teksGrup(cur)) >= klausaMin);
    if (lanjut) tutup();
  }
  tutup();

  // ---- waktu tampil dalam frame
  const celah = op.celahFrame;
  const mulaiF = grup.map((g) => Math.round(kata[g.indeks[0]].mulai * fps));
  for (let i = 1; i < mulaiF.length; i++) mulaiF[i] = Math.max(mulaiF[i], mulaiF[i - 1] + celah + 1);

  const cues = grup.map((g, n) => {
    const pertama = kata[g.indeks[0]], terakhir = kata[g.indeks[g.indeks.length - 1]];
    const teks = teksGrup(g);
    const karakter = panjang(teks);
    const batasBerikut = n + 1 < grup.length ? mulaiF[n + 1] - celah : op.totalFrame;
    const batasAdegan = op.akhirAdegan[pertama.adegan] ?? Infinity;
    const batas = Math.min(batasBerikut, batasAdegan);
    const mulaiDtk = mulaiF[n] / fps;
    const akhirUcap = terakhir.akhir + op.tahan;
    const untukMin = Math.max(akhirUcap, mulaiDtk + op.minDurasi);
    const untukCps = Math.min(mulaiDtk + karakter / op.cps, terakhir.akhir + op.tahanMaks);
    const akhirF = Math.max(mulaiF[n] + 1, Math.min(Math.round(Math.max(untukMin, untukCps) * fps), batas));
    const dur = (akhirF - mulaiF[n]) / fps;
    const baris = pecahBaris(teks, { maks: op.maksKarakter, baris: op.maksBaris });
    const sebelum = n > 0 ? kata[grup[n - 1].indeks[grup[n - 1].indeks.length - 1]] : null;
    return {
      n: n + 1,
      mulai: mulaiF[n] / fps,
      akhir: akhirF / fps,
      mulaiFrame: mulaiF[n],
      akhirFrame: akhirF,
      adegan: pertama.adegan,
      penutur: pertama.penutur,
      teks,
      baris: Array.from(baris),
      karakter,
      cps: karakter / dur,
      melebihi: baris.melebihi,
      indeks: g.indeks.slice(),
      jumlahKata: g.indeks.length,
      awalKalimat: !sebelum || sebelum.adegan !== pertama.adegan || sebelum.kalimat !== pertama.kalimat,
      akhirKalimat: terakhir.tp === "titik",
      kalimatKunci: `${terakhir.adegan}:${terakhir.kalimat}`,
    };
  });
  return cues;
}

/**
 * Memeriksa cue terhadap batas. Mengembalikan [{ n, tingkat: "gagal"|"peringatan", kode, pesan }].
 * gagal: cps melebihi batas, baris/karakter melebihi, cue tumpang tindih atau celah < celahFrame,
 * waktu terbalik. peringatan: durasi di luar [minDurasi, maksDurasi], cue yatim satu kata.
 */
export function periksaCue(cues, opsi = {}) {
  const op = { ...OPSI_CUE, ...opsi };
  const hasil = [];
  const tambah = (c, tingkat, kode, pesan) => hasil.push({ n: c.n, tingkat, kode, pesan });
  const EPS = 1e-9;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const dur = (c.akhirFrame - c.mulaiFrame) / op.fps;
    if (!(c.akhirFrame > c.mulaiFrame)) tambah(c, "gagal", "waktu", "akhir tidak sesudah mulai");
    const cps = c.karakter / dur;
    if (cps > op.cps + EPS) {
      tambah(c, "gagal", "cps", `${cps.toFixed(2)} cps melebihi batas ${op.cps} (${c.karakter} karakter dalam ${dur.toFixed(2)} s); ringkas teks atau perlambat narasi`);
    }
    if (c.melebihi || c.baris.length > op.maksBaris || c.baris.some((b) => panjang(b) > op.maksKarakter)) {
      tambah(c, "gagal", "baris", `melebihi ${op.maksBaris} baris x ${op.maksKarakter} karakter`);
    }
    if (dur > op.maksDurasi + EPS) tambah(c, "peringatan", "durasi-panjang", `durasi ${dur.toFixed(2)} s melebihi ${op.maksDurasi} s`);
    if (dur < op.minDurasi - 1e-6) tambah(c, "peringatan", "durasi-pendek", `durasi ${dur.toFixed(2)} s kurang dari ${op.minDurasi.toFixed(2)} s (tidak ada ruang untuk diperpanjang)`);
    if (c.jumlahKata === 1 && c.akhirKalimat && !c.awalKalimat) tambah(c, "peringatan", "yatim", "satu kata sisa kalimat berdiri sendiri");
    if (i + 1 < cues.length) {
      const b = cues[i + 1];
      if (b.mulaiFrame < c.akhirFrame) tambah(c, "gagal", "tumpang-tindih", `tumpang tindih dengan cue ${b.n}`);
      else if (b.mulaiFrame - c.akhirFrame < op.celahFrame) tambah(c, "gagal", "celah", `celah ke cue ${b.n} kurang dari ${op.celahFrame} frame`);
    }
  }
  return hasil;
}

// ------------------------------------------------------------------ keluaran
function waktu(frame, fps, pemisah) {
  const ms = Math.round((frame * 1000) / fps);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const dua = (n) => String(n).padStart(2, "0");
  return `${dua(h)}:${dua(m)}:${dua(s)}${pemisah}${String(ms % 1000).padStart(3, "0")}`;
}

function isiCue(c, penutur, escape) {
  const lari = (b) => (escape ? b.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : b);
  const teks = c.baris.map(lari).join("\n");
  return penutur[c.penutur]?.italik ? `<i>${teks}</i>` : teks;
}

/** WebVTT. `penutur`: { id: { italik } } (italik membungkus teks dengan <i>). */
export function keVtt(cues, fps, penutur = {}) {
  return "WEBVTT\n\n" + cues.map((c) =>
    `${c.n}\n${waktu(c.mulaiFrame, fps, ".")} --> ${waktu(c.akhirFrame, fps, ".")}\n${isiCue(c, penutur, true)}\n`).join("\n");
}

/** SubRip. */
export function keSrt(cues, fps, penutur = {}) {
  return cues.map((c) =>
    `${c.n}\n${waktu(c.mulaiFrame, fps, ",")} --> ${waktu(c.akhirFrame, fps, ",")}\n${isiCue(c, penutur, false)}\n`).join("\n");
}
