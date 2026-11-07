#!/usr/bin/env bun
/**
 * awvd / pelajari.mjs — mempelajari GAYA sebuah video lokal tanpa menyalin isinya:
 * durasi, ritme potongan (deteksi adegan), palet warna dominan, kenyaringan, dan pola
 * struktur, sebagai angka agregat untuk bahan belajar penulis dan desainer.
 *
 *   bun scripts/pelajari.mjs <video-lokal> --sumber-sah <cara> [--out profil.json]
 *        [--out profil.md] [--json] [--tanggal YYYY-MM-DD] [--ambang-cut 10]
 *
 * Yang dihasilkan HANYA angka agregat: tanpa frame, tanpa audio, tanpa teks hasil OCR atau
 * transkripsi, tanpa nama berkas sumber (hanya sha256, ukuran, durasi). Tidak ada berkas
 * sementara: ffmpeg dialirkan ke memori proses. Tanggal datang dari --tanggal (tidak
 * memakai jam sistem), angka dibulatkan, jadi hasil deterministik pada berkas yang sama.
 *
 * Batas (docs/pelajari-reaction.md): hanya berkas lokal yang sah dimiliki pengguna;
 * --sumber-sah wajib dan mencatat PERNYATAAN pengguna (awvd tidak dapat memverifikasi cara
 * perolehan). Nilai unduh-platform, rekam-layar-platform, rip-stream, URL, atau nilai lain
 * di luar daftar ditolak (kode keluar 2). awvd tidak menyediakan pengunduh. Menyalin
 * naskah, karakter, musik, gaya grafis khas, atau merek tetap dilarang. Bukan nasihat hukum.
 *
 * Kode keluar: 0 berhasil, 2 argumen/penolakan, 1 galat ffmpeg. Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { sha256Berkas } from "./klip.mjs";

export const VERSI_PROFIL = 1;
export const SUMBER_SAH = [
  "milik-sendiri", "izin-tertulis", "rilis-pemegang-hak", "lisensi-terbuka", "stok-berbayar", "arsip-publik",
];
export const SUMBER_TOLAK = ["unduh-platform", "rekam-layar-platform", "rip-stream"];
const RASIO_DIKENAL = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["4:5", 4 / 5], ["21:9", 21 / 9]];

const bulat = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const f1 = (x) => String(bulat(x, 1)).replace(".", ",");
const f2 = (x) => String(bulat(x, 2)).replace(".", ",");

// --------------------------------------------------------------- statistik murni
function persentil(urut, p) {
  if (urut.length === 0) return 0;
  const i = Math.min(urut.length - 1, Math.max(0, Math.ceil((p / 100) * urut.length) - 1));
  return urut[i];
}

/**
 * Statistik adegan dari waktu potong (detik, relatif awal video) dan durasi total.
 * Murni dan deterministik; diuji tanpa media.
 */
export function statistikAdegan(potong, durasi) {
  const titik = [0, ...potong.filter((t) => t > 0 && t < durasi), durasi];
  const panjang = [];
  for (let i = 1; i < titik.length; i++) panjang.push(titik[i] - titik[i - 1]);
  const urut = [...panjang].sort((a, b) => a - b);
  const jumlah = panjang.length;
  const rata = jumlah ? panjang.reduce((a, b) => a + b, 0) / jumlah : 0;
  const median = jumlah ? (jumlah % 2 ? urut[(jumlah - 1) / 2] : (urut[jumlah / 2 - 1] + urut[jumlah / 2]) / 2) : 0;
  const potongValid = titik.slice(1, -1);
  const kurva = Array(10).fill(0);
  for (const t of potongValid) kurva[Math.min(9, Math.floor((t / durasi) * 10))]++;
  const separuh = durasi / 2;
  const rataSeparuh = (dari, sampai) => {
    const a = panjang.map((p, i) => ({ mulai: titik[i], p })).filter((x) => x.mulai >= dari && x.mulai < sampai);
    return a.length ? a.reduce((t, x) => t + x.p, 0) / a.length : null;
  };
  return {
    jumlahAdegan: jumlah,
    durasiAdeganDetik: panjang.map((x) => bulat(x, 2)),
    rataRata: bulat(rata, 2), median: bulat(median, 2), p90: bulat(persentil(urut, 90), 2),
    terpendek: bulat(urut[0] ?? 0, 2), terpanjang: bulat(urut[jumlah - 1] ?? 0, 2),
    potongPerMenit: bulat(durasi > 0 ? (potongValid.length / durasi) * 60 : 0, 2),
    kurvaRitme: kurva,
    rataParuhPertama: bulat(rataSeparuh(0, separuh) ?? 0, 2),
    rataParuhKedua: bulat(rataSeparuh(separuh, durasi + 1) ?? 0, 2),
    potongValid,
  };
}

export function labelTempo(median) {
  if (median <= 0) return "tidak-terukur";
  if (median < 2) return "cepat";
  if (median <= 5) return "sedang";
  return "lambat";
}

/** Palet dominan dari bingkai RGB 24-bit berurutan (kuantisasi 4 level per kanal = 64 bin). */
export function paletDominan(data, jumlah = 5) {
  const bin = new Uint32Array(64);
  let total = 0;
  for (let i = 0; i + 2 < data.length; i += 3) {
    const q = (v) => Math.round(v / 85);
    bin[q(data[i]) * 16 + q(data[i + 1]) * 4 + q(data[i + 2])]++;
    total++;
  }
  if (total === 0) return [];
  const hex = (n) => (n * 85).toString(16).padStart(2, "0");
  return [...bin.keys()].filter((k) => bin[k] > 0)
    .map((k) => ({ hex: `#${hex(k >> 4)}${hex((k >> 2) & 3)}${hex(k & 3)}`, persen: bulat((bin[k] / total) * 100, 1) }))
    .sort((a, b) => b.persen - a.persen || (a.hex < b.hex ? -1 : 1))
    .slice(0, jumlah);
}

function rasioDari(lebar, tinggi) {
  const r = lebar / tinggi;
  for (const [nama, nilai] of RASIO_DIKENAL) if (Math.abs(r / nilai - 1) < 0.02) return nama;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(lebar, tinggi);
  return `${lebar / g}:${tinggi / g}`;
}

// --------------------------------------------------------------------- ffmpeg
async function jalankan(cmd, { teksStdout = true } = {}) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([
    teksStdout ? new Response(p.stdout).text() : new Response(p.stdout).arrayBuffer(),
    new Response(p.stderr).text(), p.exited,
  ]);
  return { out, err, kode };
}

async function probe(berkas) {
  const r = await jalankan(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", berkas]);
  if (r.kode !== 0) throw new Error(`ffprobe gagal membaca berkas (bukan video yang dapat dibaca?): ${r.err.trim().split("\n")[0]}`);
  const j = JSON.parse(r.out);
  const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error("tidak ada trek video");
  const [a, b] = String(v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate).split("/").map(Number);
  const fps = b ? a / b : a;
  const durasi = Number(j.format?.duration ?? v.duration);
  if (!Number.isFinite(durasi) || durasi <= 0) throw new Error("durasi video tidak terbaca");
  return {
    durasi, lebar: Number(v.width), tinggi: Number(v.height), fps: bulat(fps, 2),
    adaAudio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/** Skor perubahan adegan per bingkai dari filter scdet; potong = skor >= ambang. */
async function deteksiAdegan(berkas, ambang) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-i", berkas, "-an", "-sn",
    "-vf", "scdet=threshold=100,metadata=print:file=-", "-f", "null", "-"]);
  if (r.kode !== 0) throw new Error(`ffmpeg gagal mendeteksi adegan:\n${r.err.trim()}`);
  const potong = [];
  let waktu = null, t0 = null, terakhir = -Infinity;
  for (const baris of r.out.split("\n")) {
    const m = /pts_time:(-?[\d.]+)/.exec(baris);
    if (m) { waktu = Number(m[1]); if (t0 === null) t0 = waktu; continue; }
    const s = /lavfi\.scd\.score=([\d.]+)/.exec(baris);
    if (s && waktu !== null && Number(s[1]) >= ambang) {
      const t = waktu - t0;
      if (t - terakhir >= 0.2) { potong.push(bulat(t, 3)); terakhir = t; }
    }
  }
  return potong;
}

async function ukurAudio(berkas, durasi) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-i", berkas, "-vn", "-sn",
    "-af", "ebur128=peak=true,silencedetect=n=-50dB:d=0.5", "-f", "null", "-"]);
  if (r.kode !== 0) throw new Error(`ffmpeg gagal mengukur audio:\n${r.err.trim()}`);
  const ringkas = r.err.slice(r.err.lastIndexOf("Summary:"));
  const angka = (re) => { const m = re.exec(ringkas); return m && m[1] !== "-inf" ? Number(m[1]) : null; };
  let I = angka(/\n\s*I:\s+(-?[\d.]+|-inf) LUFS/);
  const LRA = angka(/LRA:\s+(-?[\d.]+|-inf) LU/);
  const truePeak = angka(/Peak:\s+(-?[\d.]+|-inf) dBFS/);
  if (I !== null && I <= -69.9) I = null;
  let senyap = 0, mulai = null;
  for (const baris of r.err.split("\n")) {
    const a = /silence_start: (-?[\d.]+)/.exec(baris);
    if (a) mulai = Math.max(0, Number(a[1]));
    const b = /silence_end: (-?[\d.]+) \| silence_duration: ([\d.]+)/.exec(baris);
    if (b) { senyap += Number(b[2]); mulai = null; }
  }
  if (mulai !== null) senyap += Math.max(0, durasi - mulai);
  return {
    I: bulat(I, 1), LRA: bulat(LRA, 1), truePeak: bulat(truePeak, 1),
    proporsiSenyap: bulat(Math.min(1, senyap / durasi), 2), musik: "manual",
  };
}

async function hitungPalet(berkas) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error", "-i", berkas, "-an", "-sn",
    "-vf", "fps=2,scale=64:36:flags=area,format=rgb24", "-f", "rawvideo", "-"], { teksStdout: false });
  if (r.kode !== 0) throw new Error(`ffmpeg gagal membaca bingkai untuk palet:\n${r.err.trim()}`);
  return paletDominan(new Uint8Array(r.out));
}

// ---------------------------------------------------------------- profil + laporan
/**
 * Analisis satu berkas video lokal menjadi profil statistik (skema versi 1).
 * `opsi`: { caraPerolehan, tanggal|null, ambangCut }.
 */
export async function analisis(berkas, opsi) {
  const [sha, info] = [await sha256Berkas(berkas), await probe(berkas)];
  const potong = await deteksiAdegan(berkas, opsi.ambangCut);
  const st = statistikAdegan(potong, info.durasi);
  const { potongValid, ...statistik } = st;
  const audio = info.adaAudio ? await ukurAudio(berkas, info.durasi) : null;
  const palet = await hitungPalet(berkas);
  const awal = potongValid.filter((t) => t <= 3).length;
  const akhir = potongValid.filter((t) => t >= info.durasi * 0.9).length;
  const tempo = labelTempo(statistik.median);
  const percepatan = statistik.rataParuhPertama > 0 && statistik.rataParuhKedua > 0
    ? bulat(statistik.rataParuhPertama / statistik.rataParuhKedua, 2) : null;
  const pola = [];
  pola.push(`Ritme ${tempo}: median adegan ${f2(statistik.median)} s, ${f1(statistik.potongPerMenit)} potong per menit.`);
  if (percepatan !== null && Math.abs(percepatan - 1) >= 0.25) {
    pola.push(percepatan > 1 ? `Ritme mempercepat: adegan paruh kedua lebih pendek (rata-rata ${f2(statistik.rataParuhKedua)} s) daripada paruh pertama (${f2(statistik.rataParuhPertama)} s).`
      : `Ritme melambat: adegan paruh kedua lebih panjang (rata-rata ${f2(statistik.rataParuhKedua)} s) daripada paruh pertama (${f2(statistik.rataParuhPertama)} s).`);
  }
  pola.push(awal >= 2 ? `Pembuka padat: ${awal} potong dalam 3 detik pertama (indikator hook cepat).` : awal === 1 ? "Satu potong dalam 3 detik pertama." : "Tidak ada potong dalam 3 detik pertama (pembuka satu adegan).");
  if (akhir >= 1) pola.push(`${akhir} potong pada 10% akhir (indikator penutup atau ajakan bertindak yang berganti adegan).`);
  if (audio?.proporsiSenyap >= 0.3) pola.push(`Audio banyak senyap (${Math.round(audio.proporsiSenyap * 100)}% durasi).`);
  if (!audio) pola.push("Tanpa trek audio.");
  const peringatan = [
    `Pernyataan perolehan "${opsi.caraPerolehan}" dicatat apa adanya; awvd tidak dapat memverifikasinya. Tanggung jawab tetap pada pengguna.`,
    `Ambang deteksi adegan ${opsi.ambangCut} belum dikalibrasi untuk konten nyata (kilat, transisi cepat, kamera goyang dapat menambah atau melewatkan potong).`,
  ];
  if (statistik.jumlahAdegan < 3) peringatan.push("Hanya sedikit adegan terdeteksi; statistik ritme kurang bermakna.");
  return {
    versi: VERSI_PROFIL,
    sumber: { sha256: sha, ukuranByte: statSync(berkas).size, caraPerolehan: opsi.caraPerolehan, tanggalAnalisis: opsi.tanggal ?? null },
    teknis: {
      durasiDetik: bulat(info.durasi, 2), lebar: info.lebar, tinggi: info.tinggi, rasio: rasioDari(info.lebar, info.tinggi),
      fps: info.fps, adaAudio: info.adaAudio,
    },
    potong: { metode: "scdet", ambang: opsi.ambangCut, ...statistik },
    visual: { paletDominan: palet, catatan: "Statistik 64 bin warna (4 level per kanal); bukan gaya grafis yang boleh ditiru." },
    audio,
    struktur: { potongDiTigaDetikPertama: awal, potongDiSepuluhPersenAkhir: akhir, tempo, percepatan, indikatif: true },
    pola,
    peringatan,
    catatan: [
      "Profil statistik; bukan salinan ekspresi.",
      "Tidak menyimpan frame, audio, teks, atau nama berkas sumber.",
      "Ide, metode, dan struktur umum tidak dilindungi hak cipta (UU 28/2014 Pasal 41 huruf b); ekspresi konkret tetap dilindungi.",
    ],
  };
}

const DILARANG = [
  "naskah dan kalimat khas",
  "karakter dan maskot",
  "musik dan efek suara",
  "urutan visual yang meniru adegan tertentu",
  "gaya grafis khas yang dilindungi (ilustrasi, tipografi berlisensi, trade dress)",
  "logo dan merek",
  "komposisi yang menjadi bagian paling penting dan khas karya",
];
const CEK_ORISINALITAS = [
  "Apakah urutan adegan per adegan identik dengan sumber?",
  "Apakah ada kalimat yang sama dengan naskah sumber?",
  "Apakah warna atau tipografi menyerupai merek tertentu?",
  "Elemen pembeda apa yang kamu tambahkan (sudut pandang, data, contoh sendiri)?",
];

/** Laporan Markdown deterministik dari profil. */
export function bangunMarkdown(p) {
  const t = p.teknis, c = p.potong, s = p.struktur;
  const b = [];
  b.push("# Profil gaya video (statistik)", "");
  b.push("Bahan belajar gaya: angka agregat dari satu video lokal yang sah dimiliki. Bukan salinan isi dan bukan nasihat hukum.", "");
  b.push("## Sumber", "",
    `- sha256: \`${p.sumber.sha256}\``,
    `- Ukuran: ${p.sumber.ukuranByte} byte`,
    `- Cara perolehan (pernyataan pengguna, tidak diverifikasi): ${p.sumber.caraPerolehan}`,
    `- Tanggal analisis: ${p.sumber.tanggalAnalisis ?? "tidak diisi"}`, "");
  b.push("## Teknis", "",
    `- Durasi: ${f2(t.durasiDetik)} s; ${t.lebar}x${t.tinggi} (${t.rasio}); ${t.fps} fps; audio: ${t.adaAudio ? "ada" : "tidak ada"}`, "");
  b.push("## Ritme potongan", "",
    `- Adegan: ${c.jumlahAdegan}; rata-rata ${f2(c.rataRata)} s; median ${f2(c.median)} s; persentil 90 ${f2(c.p90)} s; terpendek ${f2(c.terpendek)} s; terpanjang ${f2(c.terpanjang)} s`,
    `- Potong per menit: ${f1(c.potongPerMenit)} (metode ${c.metode}, ambang ${c.ambang})`,
    `- Kurva ritme (jumlah potong per sepersepuluh durasi): ${c.kurvaRitme.join(", ")}`,
    `- Durasi tiap adegan (detik): ${c.durasiAdeganDetik.map(f2).join(", ")}`, "");
  b.push("## Pola", "", ...p.pola.map((x) => `- ${x}`), "");
  b.push("## Struktur (indikatif)", "",
    `- Tempo: ${s.tempo}`,
    `- Potong di 3 detik pertama: ${s.potongDiTigaDetikPertama}; di 10% akhir: ${s.potongDiSepuluhPersenAkhir}`,
    `- Rasio rata-rata adegan paruh pertama terhadap kedua: ${s.percepatan === null ? "tidak terukur" : f2(s.percepatan)}`, "");
  b.push("## Palet dominan (statistik)", "", ...(p.visual.paletDominan.length ? p.visual.paletDominan.map((x) => `- \`${x.hex}\` ${f1(x.persen)}%`) : ["- tidak terukur"]), "",
    "Pakai merek dan palet milik sendiri; palet di atas hanya statistik.", "");
  b.push("## Audio", "");
  if (p.audio) {
    b.push(`- Kenyaringan terpadu: ${p.audio.I === null ? "senyap" : `${f1(p.audio.I)} LUFS`}; LRA ${p.audio.LRA === null ? "-" : `${f1(p.audio.LRA)} LU`}; true peak ${p.audio.truePeak === null ? "-" : `${f1(p.audio.truePeak)} dBFS`}`,
      `- Proporsi senyap: ${Math.round(p.audio.proporsiSenyap * 100)}%`,
      "- Ada musik atau tidak: isi manual (tidak dapat ditentukan andal tanpa klasifikasi)");
  } else b.push("- Tanpa trek audio");
  b.push("", "## Peringatan", "", ...p.peringatan.map((x) => `- ${x}`), "");
  b.push("## Dilarang disalin", "", ...DILARANG.map((x) => `- ${x}`), "");
  b.push("## Cek orisinalitas oleh manusia", "", ...CEK_ORISINALITAS.map((x) => `- [ ] ${x}`), "");
  return `${b.join("\n")}\n`;
}

// ------------------------------------------------------------------------ CLI
function gagal(pesan, kode = 1) {
  console.error(`pelajari.mjs: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun scripts/pelajari.mjs <video-lokal> --sumber-sah <cara> [--out profil.json] [--out profil.md]
       [--json] [--tanggal YYYY-MM-DD] [--ambang-cut 10]
--sumber-sah (wajib): ${SUMBER_SAH.join(" | ")}
  (pernyataan pengguna bahwa berkas sah dimiliki; tidak diverifikasi). Nilai ${SUMBER_TOLAK.join(", ")},
  URL, atau nilai lain ditolak: awvd tidak mengunduh dan tidak menerima hasil unduhan platform.
--out F        tulis profil: .json untuk JSON, .md untuk laporan Markdown (boleh diulang)
--json         tanpa --out: cetak JSON ke stdout (bawaan: cetak Markdown)
--tanggal D    tanggal analisis YYYY-MM-DD (tanpa jam sistem agar deterministik)
--ambang-cut N ambang skor scdet 1..100 (bawaan 10)
Kode keluar 0 berhasil, 2 argumen tidak valid atau ditolak, 1 galat ffmpeg.`;

async function utama() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        "sumber-sah": { type: "string" },
        out: { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        tanggal: { type: "string" },
        "ambang-cut": { type: "string", default: "10" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const { values: o, positionals } = args;
  if (o.help) { console.log(PETUNJUK); return; }
  if (positionals.length !== 1) gagal(`harus tepat satu berkas video lokal.\n${PETUNJUK}`, 2);
  const masukan = positionals[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(masukan)) {
    gagal(`"${masukan}" adalah URL. awvd hanya membaca berkas lokal yang sah dimiliki dan tidak menyediakan pengunduh dari platform mana pun (YouTube, TikTok, Facebook, Instagram, X, dll.).`, 2);
  }
  if (o["sumber-sah"] === undefined) gagal(`--sumber-sah wajib (${SUMBER_SAH.join(" | ")}).\n${PETUNJUK}`, 2);
  if (SUMBER_TOLAK.includes(o["sumber-sah"])) {
    gagal(`--sumber-sah ${o["sumber-sah"]} ditolak: hasil unduhan, rekam layar, atau rip stream platform melanggar ketentuan layanan platform dan tidak diterima. Pakai berkas milik sendiri, izin tertulis, atau lisensi terbuka.`, 2);
  }
  if (!SUMBER_SAH.includes(o["sumber-sah"])) gagal(`--sumber-sah "${o["sumber-sah"]}" tidak dikenal; pilihan: ${SUMBER_SAH.join(", ")}.`, 2);
  if (o.tanggal !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(o.tanggal) && !Number.isNaN(Date.parse(`${o.tanggal}T00:00:00Z`)))) gagal("--tanggal harus YYYY-MM-DD yang sah.", 2);
  const ambangCut = Number(o["ambang-cut"]);
  if (!Number.isFinite(ambangCut) || ambangCut < 1 || ambangCut > 100) gagal("--ambang-cut harus angka 1..100.", 2);
  const berkas = resolve(masukan);
  if (!existsSync(berkas) || !statSync(berkas).isFile()) gagal(`berkas tidak ditemukan: ${masukan}`, 2);
  const keluar = o.out ?? [];
  for (const k of keluar) {
    const e = extname(k).toLowerCase();
    if (e !== ".json" && e !== ".md") gagal(`--out ${k}: ekstensi harus .json atau .md`, 2);
  }

  let profil;
  try {
    profil = await analisis(berkas, { caraPerolehan: o["sumber-sah"], tanggal: o.tanggal ?? null, ambangCut });
  } catch (e) {
    gagal(e.message);
  }
  const json = `${JSON.stringify(profil, null, 2)}\n`;
  const md = bangunMarkdown(profil);
  for (const k of keluar) {
    const jalur = resolve(k);
    mkdirSync(dirname(jalur), { recursive: true });
    writeFileSync(jalur, extname(k).toLowerCase() === ".json" ? json : md);
    console.error(`ditulis: ${k}`);
  }
  if (keluar.length === 0) process.stdout.write(o.json ? json : md);
}

if (import.meta.main) await utama();
