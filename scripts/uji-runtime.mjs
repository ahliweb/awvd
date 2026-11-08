#!/usr/bin/env bun
/**
 * uji-runtime.mjs — uji unit helper runtime.js (tanpa browser, tanpa dependensi).
 * Memuat runtime.js di Bun dengan window/document tiruan minimal, lalu menegaskan
 * nilai helper. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-runtime.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kreditAset as kreditAsetLib } from "./aset-lib.js";

// ---- tiruan minimal: cukup agar runtime.js tereksekusi dan defineVideo berjalan.
const elemenTiruan = () => ({ setAttribute() {}, appendChild() {}, style: {} });
const dirSkrip = dirname(fileURLToPath(import.meta.url));
globalThis.window = { location: { search: "" } };
globalThis.document = {
  readyState: "complete",
  createElement: elemenTiruan,
  head: elemenTiruan(),
  documentElement: elemenTiruan(),
};
await import(join(dirSkrip, "runtime.js"));
const api = globalThis.window.VideoTerprogram;

const { easing, durasi, ms, berjenjang, areaAman, luminansRelatif, kontras, pilihTeksKontras,
  durasiBaca, pecahBaris, captionAktif, parseVtt, parseSrt, acak, interpolasi } = api;

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function samaDengan(nyata, harapan, nama) {
  const a = JSON.stringify(nyata), b = JSON.stringify(harapan);
  tegas(a === b, `${nama}: dapat ${a}, harapan ${b}`);
}
function dekat(nyata, harapan, eps, nama) {
  tegas(Math.abs(nyata - harapan) <= eps, `${nama}: dapat ${nyata}, harapan ${harapan} (+-${eps})`);
}
function melempar(fn, nama) {
  let lempar = false;
  try { fn(); } catch { lempar = true; }
  tegas(lempar, `${nama}: seharusnya melempar galat`);
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

daftar("ekspor: semua helper ada di window.VideoTerprogram dan sebagai global", () => {
  for (const k of ["ms", "durasi", "berjenjang", "areaAman", "luminansRelatif", "kontras",
    "pilihTeksKontras", "durasiBaca", "pecahBaris", "captionAktif", "parseVtt", "parseSrt",
    "areaAmanVertikal", "areaCaption", "rencanaCaption", "keadaanCaption", "captionHtml"]) {
    tegas(api[k] != null, `${k} tidak diekspor`);
    tegas(globalThis.window[k] === api[k], `${k} bukan global`);
  }
});

daftar("regresi: defineVideo, easing lama, acak tetap sama", async () => {
  const v = globalThis.window.defineVideo({
    width: 100, height: 50, fps: 30, durationInFrames: 10, render() {},
  });
  tegas((await v.renderFrame(3)) === 3, "renderFrame(3) != 3");
  tegas(globalThis.window.video === v, "window.video tidak terpasang");
  dekat(easing.linear(0.3), 0.3, 0, "linear");
  dekat(easing.masukQuad(0.5), 0.25, 1e-12, "masukQuad");
  dekat(easing.bezier(0.25, 0.1, 0.25, 1)(0.5), 0.8024, 1e-3, "bezier ease");
  dekat(interpolasi(15, [0, 30], [0, 1]), 0.5, 1e-12, "interpolasi");
  const r1 = acak(42), r2 = acak(42);
  const u1 = [r1(), r1(), r1()], u2 = [r2(), r2(), r2()];
  samaDengan(u1, u2, "acak(42) dua kali");
  tegas(u1.every((x) => x >= 0 && x < 1), "acak di luar [0,1)");
});

daftar("areaAman(1920,1080): grafis 96/54/1728/972, aksi 67/38/1786/1004", () => {
  samaDengan(areaAman(1920, 1080), {
    aksi: { x: 67, y: 38, w: 1786, h: 1004 },
    grafis: { x: 96, y: 54, w: 1728, h: 972 },
  }, "areaAman(1920,1080)");
});

daftar("areaAman: simetris, setengah dibulatkan naik, 1280x720 dan 100x100, input salah melempar", () => {
  const a = areaAman(1280, 720); // 44,8->45; 25,2->25; 64; 36
  samaDengan(a, {
    aksi: { x: 45, y: 25, w: 1190, h: 670 },
    grafis: { x: 64, y: 36, w: 1152, h: 648 },
  }, "areaAman(1280,720)");
  samaDengan(areaAman(100, 100).aksi, { x: 4, y: 4, w: 92, h: 92 }, "3,5 dibulatkan naik ke 4");
  for (const [l, t] of [[1920, 1080], [1080, 1920], [777, 555]]) {
    const { aksi, grafis } = areaAman(l, t);
    for (const k of [aksi, grafis]) {
      tegas(k.x + k.w + k.x === l && k.y + k.h + k.y === t, `tidak simetris ${l}x${t}`);
    }
  }
  melempar(() => areaAman(0, 100), "areaAman(0,100)");
});

daftar("ms: ms(300,30)=9, bulatkan, minimal 1, nol, fps salah melempar", () => {
  tegas(ms(300, 30) === 9, "ms(300,30)");
  tegas(ms(1000, 24) === 24, "ms(1000,24)");
  tegas(ms(150, 30) === 5, "ms(150,30)"); // 4,5 -> 5 (setengah naik)
  tegas(ms(1, 30) === 1, "ms(1,30) harus 1 (minimal)");
  tegas(ms(0, 30) === 0 && !Object.is(ms(0, 30), -0), "ms(0,30)");
  melempar(() => ms(100, 0), "ms fps 0");
});

daftar("durasi: preset M3 + masuk/keluar, dipakai bersama ms()", () => {
  samaDengan(durasi, { pendek: 150, sedang: 300, panjang: 500, sangatPanjang: 800, masuk: 300, keluar: 200 }, "durasi");
  tegas(durasi.masuk > durasi.keluar, "masuk harus lebih lama dari keluar");
  tegas(ms(durasi.keluar, 30) === 6 && ms(durasi.sangatPanjang, 30) === 24, "ms(durasi.*, 30)");
});

daftar("easing preset M3: titik ujung, monoton, di dalam [0,1], tengah-tengah masuk akal", () => {
  const nama = ["standar", "percepat", "perlambat", "ditekankanMasuk", "ditekankanKeluar"];
  for (const k of nama) {
    const f = easing[k];
    tegas(typeof f === "function", `easing.${k} bukan fungsi`);
    tegas(f(0) === 0 && f(1) === 1, `easing.${k} ujung: ${f(0)}, ${f(1)}`);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const y = f(i / 100);
      tegas(y >= prev - 1e-5, `easing.${k} tidak monoton di ${i / 100}: ${y} < ${prev}`);
      tegas(y >= -1e-9 && y <= 1 + 1e-9, `easing.${k} di luar [0,1] di ${i / 100}: ${y}`);
      prev = y;
    }
  }
  tegas(easing.standar(0.5) > 0.5 && easing.perlambat(0.5) > 0.5, "standar/perlambat harus cepat di awal");
  tegas(easing.percepat(0.5) < 0.5 && easing.ditekankanKeluar(0.5) < 0.5, "percepat/keluar harus lambat di awal");
  samaDengan(easing.standar(0.3), easing.bezier(0.2, 0, 0, 1)(0.3), "standar = bezier(0.2,0,0,1)");
});

daftar("kontras: hitam/putih 21, #777/putih ~4,48 (gagal 4,5), sama = 1, bentuk warna", () => {
  dekat(kontras("#000", "#fff"), 21, 1e-9, "kontras(#000,#fff)");
  dekat(kontras("#fff", "#000"), 21, 1e-9, "simetris");
  dekat(kontras("#777", "#fff"), 4.48, 0.005, "kontras(#777,#fff)");
  tegas(kontras("#777", "#fff") < 4.5, "#777 di atas putih harus gagal AA 4,5");
  dekat(kontras("#767676", "#ffffff"), 4.54, 0.005, "#767676 (batas AA) lolos");
  dekat(kontras("#123456", "#123456"), 1, 1e-12, "warna sama");
  dekat(kontras([0, 0, 0], [255, 255, 255]), 21, 1e-9, "bentuk array");
  dekat(luminansRelatif("#fff"), 1, 1e-12, "L putih");
  dekat(luminansRelatif("#000"), 0, 1e-12, "L hitam");
  dekat(luminansRelatif("#ff0000"), 0.2126, 1e-9, "L merah");
  dekat(luminansRelatif("#00ff00"), 0.7152, 1e-9, "L hijau");
  dekat(luminansRelatif("#0000ff"), 0.0722, 1e-9, "L biru");
  dekat(luminansRelatif("#abc"), luminansRelatif("#aabbcc"), 0, "#rgb = #rrggbb");
  melempar(() => luminansRelatif("merah"), "warna nama");
  melempar(() => luminansRelatif([0, 0, 300]), "komponen > 255");
});

daftar("pilihTeksKontras: latar gelap -> putih, terang -> hitam", () => {
  tegas(pilihTeksKontras("#0b1220") === "#ffffff", "#0b1220");
  tegas(pilihTeksKontras("#ffffff") === "#000000", "#ffffff");
  tegas(pilihTeksKontras("#ffeb3b") === "#000000", "kuning");
  tegas(pilihTeksKontras("#777") === "#000000", "#777 (hitam 4,69 > putih 4,48)");
  tegas(pilihTeksKontras([20, 30, 60]) === "#ffffff", "array gelap");
});

daftar("durasiBaca: 34 karakter @17 cps = 2 s, clamp min/maks, frame, spasi dirapikan", () => {
  const t34 = "a".repeat(34);
  samaDengan(durasiBaca(t34), { detik: 2 }, "34 karakter");
  samaDengan(durasiBaca(t34, { fps: 30 }), { detik: 2, frame: 60 }, "34 karakter + fps");
  dekat(durasiBaca("Hai").detik, 5 / 6, 1e-12, "clamp min 5/6");
  samaDengan(durasiBaca("Hai", { fps: 30 }), { detik: 5 / 6, frame: 25 }, "min dalam frame");
  tegas(durasiBaca("x".repeat(500)).detik === 7, "clamp maks 7");
  samaDengan(durasiBaca("x".repeat(100), { cps: 10, maks: 20 }), { detik: 10 }, "opsi cps/maks");
  samaDengan(durasiBaca("a b", { min: 0 }), { detik: 3 / 17 }, "spasi dihitung");
  tegas(durasiBaca("a   b\n c").detik === durasiBaca("a b c").detik, "spasi berurutan dirapikan");
  tegas(durasiBaca("", { fps: 30 }).frame === 25, "teks kosong -> min");
  melempar(() => durasiBaca("x", { cps: 0 }), "cps 0");
  melempar(() => durasiBaca("x", { min: 5, maks: 2 }), "min > maks");
});

daftar("pecahBaris: muat satu baris -> satu elemen, melebihi=false", () => {
  const h = pecahBaris("Selamat datang di awvd");
  samaDengan(h, ["Selamat datang di awvd"], "satu baris");
  tegas(h.melebihi === false, "melebihi harus false");
  samaDengan(pecahBaris("  banyak   spasi  "), ["banyak spasi"], "spasi dirapikan");
  samaDengan(pecahBaris(""), [], "kosong");
  tegas("x".repeat(42) === pecahBaris("x".repeat(42))[0], "tepat maks muat");
});

daftar("pecahBaris: dua baris, potong sebelum kata sambung 'dan' (mengalahkan piramida)", () => {
  const h = pecahBaris("Laporan bulanan disusun otomatis dan dikirim ke seluruh pegawai");
  samaDengan(h, ["Laporan bulanan disusun otomatis", "dan dikirim ke seluruh pegawai"], "potong sebelum dan");
  tegas(h.melebihi === false, "melebihi harus false");
});

daftar("pecahBaris: potong setelah tanda baca; piramida terbalik bila tanpa titik baik; tanpa baris atas 1-2 kata", () => {
  samaDengan(pecahBaris("Selamat pagi hadirin sekalian, mari kita mulai pelatihan hari ini"),
    ["Selamat pagi hadirin sekalian,", "mari kita mulai pelatihan hari ini"], "setelah koma");
  // Tanpa tanda baca/kata sambung: satu-satunya potongan yang muat; bawah >= atas.
  const p = pecahBaris("Pemerintah daerah menyelenggarakan pelatihan literasi digital bagi aparatur");
  samaDengan(p, ["Pemerintah daerah menyelenggarakan", "pelatihan literasi digital bagi aparatur"], "piramida");
  tegas(p[1].length >= p[0].length, "baris bawah harus >= atas");
  // "Ya," (1 kata) ditolak sebagai baris atas walau setelah tanda baca.
  const y = pecahBaris("Ya, kami akan menyiapkan seluruh dokumen yang diperlukan hari ini");
  tegas(y[0].split(" ").length >= 3, `baris atas terlalu pendek: ${y[0]}`);
  tegas(y.join(" ") === "Ya, kami akan menyiapkan seluruh dokumen yang diperlukan hari ini", "teks utuh");
  tegas(y.every((b) => b.length <= 42), "baris > 42");
});

daftar("pecahBaris: terlalu panjang -> melebihi=true, teks tidak hilang; opsi maks/baris; deterministik", () => {
  const panjang = "Pemerintah daerah menyelenggarakan pelatihan literasi digital bagi seluruh aparatur sipil negara di lingkungan dinas";
  const h = pecahBaris(panjang);
  tegas(h.melebihi === true, "melebihi harus true");
  tegas(h.join(" ") === panjang, "teks hilang/berubah");
  tegas(h.length > 2, "harus > 2 baris");
  const tiga = pecahBaris(panjang, { baris: 3 });
  tegas(tiga.melebihi === false && tiga.length === 3 && tiga.every((b) => b.length <= 42), "3 baris muat");
  samaDengan(pecahBaris("a b c d e f", { maks: 5 }), ["a b c", "d e f"], "maks 5 -> dua baris");
  tegas(pecahBaris("a b c d e f", { maks: 3 }).melebihi === true, "maks 3 butuh 3 baris > 2");
  tegas(pecahBaris("x".repeat(50) + " y").melebihi === true, "kata tunggal > maks");
  samaDengan(pecahBaris(panjang, { baris: 3 }), tiga, "deterministik");
  melempar(() => pecahBaris("a", { baris: 0 }), "baris 0");
});

const vtt = [
  "﻿WEBVTT - judul",
  "Kind: captions",
  "",
  "NOTE ini komentar",
  "00:00:09.000 --> 00:00:10.000",
  "",
  "STYLE",
  "::cue { color: red }",
  "",
  "intro",
  "00:00:01.000 --> 00:00:02.500 align:start position:10%",
  "Halo <b>awvd</b>",
  "baris <v Budi>kedua</v> &amp; &lt;ketiga&gt;",
  "",
  "00:03.000 --> 00:04.200",
  "Pendek mm:ss",
  "",
  "01:00:00.500 --> 01:00:01.500",
  "Jam",
  "",
].join("\r\n");

daftar("parseVtt: header/NOTE/STYLE diabaikan, pengaturan cue, tag, entitas, mm:ss, jam", () => {
  const c = parseVtt(vtt);
  samaDengan(c, [
    { mulai: 1, akhir: 2.5, teks: "Halo awvd\nbaris kedua & <ketiga>" },
    { mulai: 3, akhir: 4.2, teks: "Pendek mm:ss" },
    { mulai: 3600.5, akhir: 3601.5, teks: "Jam" },
  ], "parseVtt");
});

const srt = "1\n00:00:00,500 --> 00:00:02,000\n<i>Halo</i> awvd\n\n2\n00:00:02,000 --> 00:00:03,250\nBaris kedua\ndua baris\n\n\n3\n00:00:05,100 --> 00:00:06,000\nTiga\n";

daftar("parseSrt: koma, nomor cue, banyak baris kosong, tag", () => {
  samaDengan(parseSrt(srt), [
    { mulai: 0.5, akhir: 2, teks: "Halo awvd" },
    { mulai: 2, akhir: 3.25, teks: "Baris kedua\ndua baris" },
    { mulai: 5.1, akhir: 6, teks: "Tiga" },
  ], "parseSrt");
  samaDengan(parseSrt(""), [], "kosong");
  samaDengan(parseSrt("tanpa cue sama sekali"), [], "tanpa cue");
  samaDengan(parseSrt("1\n00:00:05,000 --> 00:00:04,000\nterbalik\n"), [], "akhir <= mulai dibuang");
});

daftar("captionAktif: batas mulai <= t < akhir, celah -> null, tumpang tindih -> yang pertama", () => {
  const cues = parseSrt(srt); // 0,5-2 ; 2-3,25 ; 5,1-6
  const fps = 30;
  tegas(captionAktif(cues, 14, fps) === null, "frame 14 (0,4667 s) sebelum cue 1");
  tegas(captionAktif(cues, 15, fps)?.teks === "Halo awvd", "frame 15 (0,5 s) = mulai, aktif");
  tegas(captionAktif(cues, 59, fps)?.teks === "Halo awvd", "frame 59 masih cue 1");
  tegas(captionAktif(cues, 60, fps)?.teks.startsWith("Baris kedua"), "frame 60 (2 s): akhir cue 1 eksklusif, cue 2 mulai");
  tegas(captionAktif(cues, 97, fps)?.teks.startsWith("Baris kedua"), "frame 97 (3,2333 s) masih cue 2");
  tegas(captionAktif(cues, 98, fps) === null, "frame 98 (3,2667 s) celah");
  tegas(captionAktif(cues, 152, fps) === null, "frame 152 (5,0667 s) sebelum cue 3");
  tegas(captionAktif(cues, 153, fps)?.teks === "Tiga", "frame 153 (5,1 s) = mulai cue 3");
  tegas(captionAktif(cues, 180, fps) === null, "frame 180 (6 s) akhir eksklusif");
  tegas(captionAktif([], 0, fps) === null, "tanpa cue");
  const tumpang = [{ mulai: 0, akhir: 2, teks: "A" }, { mulai: 1, akhir: 3, teks: "B" }];
  tegas(captionAktif(tumpang, 45, 30).teks === "A", "tumpang tindih: pertama");
  tegas(captionAktif(tumpang, 60, 30).teks === "B", "A selesai di t=2");
  // timestamp desimal yang rawan galat float: 1,1 s = frame 33 pada 30 fps.
  const f = parseVtt("WEBVTT\n\n00:00:01.100 --> 00:00:02.200\nX\n");
  tegas(captionAktif(f, 33, 30)?.teks === "X" && captionAktif(f, 32, 30) === null, "batas 1,1 s");
  tegas(captionAktif(f, 66, 30) === null && captionAktif(f, 65, 30)?.teks === "X", "batas 2,2 s");
});

daftar("berjenjang: frame lokal elemen ke-indeks", () => {
  tegas(berjenjang(30, 0) === 30, "indeks 0");
  tegas(berjenjang(30, 2) === 18, "30 - 2*6");
  tegas(berjenjang(30, 2, { mulai: 10, jeda: 4 }) === 12, "30 - 10 - 2*4");
  tegas(berjenjang(5, 1) === -1, "belum mulai -> negatif");
  tegas(berjenjang(7, 1, { jeda: 0 }) === 7, "jeda 0");
});


// ============================================================ helper aset
// Props asli dari templat aset-contoh (salinan keluaran `bun run aset periksa`) dan turunannya.
const propsContoh = JSON.parse(/window\.asetPropsBawaan = (\{.*\});/s.exec(
  readFileSync(join(dirSkrip, "..", "templates", "aset-contoh", "aset-props.js"), "utf8"))[1]);
const salin = (o) => JSON.parse(JSON.stringify(o));
function propsUji(ubah) {
  const p = salin(propsContoh);
  const logoDasar = p.aset["logo-contoh"];
  // logo putih (varian untuk latar gelap) dan logo kecil/transparansi dilarang
  p.aset["logo-putih"] = { ...salin(logoDasar), jalur: "aset/logo-putih.svg", teksAlternatif: "Logo Contoh Karya (putih)",
    merek: { ...logoDasar.merek, aturan: { ...logoDasar.merek.aturan, warnaDiizinkan: ["#ffffff"] } } };
  p.aset["logo-tanpa-alt"] = { ...salin(logoDasar), teksAlternatif: undefined };
  delete p.aset["logo-tanpa-alt"].teksAlternatif;
  p.aset["logo-dekoratif"] = { ...salin(p.aset["logo-tanpa-alt"]), peran: "dekoratif" };
  p.aset["logo-tanpa-transparansi"] = { ...salin(logoDasar), merek: { ...logoDasar.merek, aturan: { ...logoDasar.merek.aturan, larangan: ["transparansi"] } } };
  p.aset["logo-lebar"] = { ...salin(logoDasar), merek: { ...logoDasar.merek, aturan: { clearSpace: { nilai: 0.5, satuan: "lebar" } } } };
  p.aset["foto-uji"] = { jenis: "gambar", jalur: "aset/foto.webp", sha256: "0".repeat(64), bytes: 1, format: "webp", lebar: 1200, tinggi: 800, rasio: 1.5,
    teksAlternatif: "Latar biru polos", peran: "informatif", fokus: { x: 0.5, y: 0.4 }, tampil: { lebar: 640, tinggi: 360, fit: "cover" },
    atribusi: { judul: "Foto uji", pencipta: "Penulis Uji", sumberUrl: "https://example.org/uji", lisensi: "STOK:pexels", urlLisensi: null,
      perubahan: "dipotong 16:9", tanggalAkses: "2026-11-07", tanpaJudul: false, penciptaAnonim: false, tampil: "akhir" }, ai: { status: "tidak" } };
  p.aset["foto-tanpa-alt"] = { ...salin(p.aset["foto-uji"]) };
  delete p.aset["foto-tanpa-alt"].teksAlternatif;
  p.aset["ikon-informatif"] = { ...salin(p.aset["ikon-centang"]), teksAlternatif: "Centang" };
  p.aset["font-uji"] = { jenis: "font", jalur: "aset/judul.ttf", sha256: "0".repeat(64), bytes: 1, format: "ttf",
    font: { famili: "Uji Awvd", bobot: 700, gaya: "normal", format: "ttf" },
    atribusi: { judul: "Font uji", pencipta: "Penulis Uji", sumberUrl: "https://example.org/f", lisensi: "OFL-1.1", urlLisensi: null, perubahan: "tidak ada", tanggalAkses: "2026-11-07", tanpaJudul: false, penciptaAnonim: false, tampil: "tidak" }, ai: { status: "tidak" } };
  if (ubah) ubah(p);
  return p;
}
async function menolak(fn, pola, nama) {
  let pesan = null;
  try { await fn(); } catch (e) { pesan = String(e.message); }
  tegas(pesan !== null, `${nama}: seharusnya galat`);
  tegas(pola.test(pesan), `${nama}: pesan galat tidak sesuai: ${pesan}`);
}
// elemen <img> tiruan yang mencatat pemasangan
function imgTiruan({ gagal = false } = {}) {
  const attr = {};
  return {
    tagName: "IMG", style: {}, attr,
    getAttribute: (k) => (k === "src" ? attr.src ?? null : attr[k] ?? null),
    setAttribute(k, v) { attr[k] = String(v); },
    removeAttribute(k) { delete attr[k]; },
    set src(v) { attr.src = v; }, get src() { return attr.src; },
    decode: () => (gagal ? Promise.reject(new Error("decode")) : Promise.resolve()),
  };
}

daftar("ekspor aset: asetGambar, pasangGambar, logo, ikon, kreditAset, pasangFont ada sebagai API dan global; runtime tanpa jalur SVG inline", () => {
  for (const k of ["asetGambar", "pasangGambar", "logo", "ikon", "kreditAset", "pasangFont"]) {
    tegas(typeof api[k] === "function" && globalThis.window[k] === api[k], `${k} tidak diekspor`);
  }
  // logo dan SVG hanya lewat <img>: runtime tidak punya cara menyisipkan markup
  const sumber = readFileSync(join(dirSkrip, "runtime.js"), "utf8");
  tegas(!/innerHTML|insertAdjacentHTML|outerHTML|DOMParser|createElementNS|createContextualFragment/.test(sumber), "runtime.js tidak boleh menyisipkan markup/SVG inline");
});

daftar("asetGambar: info dari aset-props (url, ukuran, rasio, fokus, alt); id tak ada, jenis salah, jalur berbahaya, props hilang = galat", async () => {
  const p = propsUji();
  const d = await api.asetGambar("logo-contoh", { props: p });
  samaDengan({ url: d.url, lebar: d.lebar, tinggi: d.tinggi, rasio: d.rasio, alt: d.alt, dekoratif: d.dekoratif, fit: d.fit },
    { url: "aset/logo-contoh.svg", lebar: 240, tinggi: 80, rasio: 3, alt: "Logo Contoh Karya (fiktif)", dekoratif: false, fit: "contain" }, "logo-contoh");
  const f = await api.asetGambar("foto-uji", { props: p, akar: "../proyek/" });
  samaDengan({ url: f.url, fokus: f.fokus, op: f.objectPosition, fit: f.fit }, { url: "../proyek/aset/foto.webp", fokus: { x: 0.5, y: 0.4 }, op: "50% 40%", fit: "cover" }, "foto-uji");
  // ctx = jalan pintas props
  tegas((await api.asetGambar("foto-uji", { ctx: { props: p } })).url === "aset/foto.webp", "ctx.props");
  await menolak(() => api.asetGambar("tidak-ada", { props: p }), /"tidak-ada" tidak ada di aset-props.*logo-contoh/, "id tak ada");
  await menolak(() => api.asetGambar("constructor", { props: p }), /tidak ada di aset-props/, "id prototipe");
  await menolak(() => api.asetGambar("font-uji", { props: p }), /berjenis font/, "jenis font");
  await menolak(() => api.asetGambar("logo-contoh", {}), /opsi\.props wajib/, "tanpa props");
  await menolak(() => api.asetGambar("logo-contoh", { props: { aset: [] } }), /tidak ada di aset-props/, "aset array");
  for (const jahat of ["http://x.example/a.png", "//x.example/a.png", "/etc/passwd", "../luar.png", "aset/../../luar.png", "file:///etc/passwd", "data:image/png;base64,AA", "aset\\x.png", ""]) {
    const q = propsUji((pp) => { pp.aset["foto-uji"].jalur = jahat; });
    await menolak(() => api.asetGambar("foto-uji", { props: q }), /berkas lokal relatif/, `jalur ${jahat}`);
  }
});

daftar("AC teksAlternatif: aset non-dekoratif tanpa teksAlternatif memicu galat (asetGambar, logo, ikon); dekoratif lolos dengan alt kosong", async () => {
  const p = propsUji();
  await menolak(() => api.asetGambar("foto-tanpa-alt", { props: p }), /informatif tetapi tanpa teksAlternatif/, "foto tanpa alt");
  await menolak(() => api.asetGambar("logo-tanpa-alt", { props: p }), /informatif tetapi tanpa teksAlternatif/, "logo tanpa alt (asetGambar)");
  await menolak(async () => api.logo("logo-tanpa-alt", "kiri-atas", { props: p, lebar: 1280, tinggi: 720 }), /informatif tetapi tanpa teksAlternatif/, "logo tanpa alt (logo)");
  // teks kosong atau spasi tidak dihitung; opsi tidak dapat mengosongkan teks manifest
  await menolak(() => api.asetGambar("foto-uji", { props: p, teksAlternatif: "  " }), /tanpa teksAlternatif/, "alt spasi");
  tegas((await api.asetGambar("foto-tanpa-alt", { props: p, teksAlternatif: "Latar biru" })).alt === "Latar biru", "alt dari opsi memenuhi syarat");
  // dekoratif eksplisit di manifest: alt kosong; peran tidak bisa diubah per pemakaian
  const dek = await api.asetGambar("logo-dekoratif", { props: p });
  tegas(dek.dekoratif === true && dek.alt === "", "dekoratif harus alt kosong");
  await menolak(() => api.asetGambar("foto-uji", { props: propsUji((pp) => { delete pp.aset["foto-uji"].teksAlternatif; pp.aset["foto-uji"].peran = "informatif"; }), peran: "dekoratif" }), /tanpa teksAlternatif/, "peran opsi tidak menimpa manifest");
  // ikon tanpa peran = dekoratif (kecuali ada teksAlternatif)
  const ik = api.ikon("ikon-centang", { props: p });
  tegas(ik.dekoratif === true && ik.alt === "", "ikon tanpa peran dekoratif");
  const ik2 = api.ikon("ikon-informatif", { props: p });
  tegas(ik2.dekoratif === false && ik2.alt === "Centang", "ikon dengan teksAlternatif informatif");
  const ik3 = propsUji((pp) => { pp.aset["ikon-centang"].peran = "informatif"; });
  await menolak(async () => api.ikon("ikon-centang", { props: ik3 }), /informatif tetapi tanpa teksAlternatif/, "ikon informatif tanpa alt");
});

daftar("pasangGambar: hanya <img> (AC logo selalu <img>, bukan inline); mengisi src, alt, aria-hidden, geometri, fokus, filter; tunggu decode; gagal = galat", async () => {
  const p = propsUji();
  for (const salah of [{ tagName: "svg", style: {}, setAttribute() {} }, { tagName: "DIV", style: {}, setAttribute() {} }, { tagName: "CANVAS" }, null, undefined]) {
    await menolak(() => api.pasangGambar(salah, api.logo("logo-contoh", "kiri-atas", { props: p, lebar: 1280, tinggi: 720, ukuran: 28 })), /harus elemen <img>/, `target ${salah && salah.tagName}`);
  }
  const k = api.logo("logo-contoh", "kiri-atas", { props: p, lebar: 1280, tinggi: 720, ukuran: 28 });
  const im = imgTiruan();
  tegas((await api.pasangGambar(im, k)) === true, "pasangGambar mengembalikan true");
  samaDengan([im.attr.src, im.attr.alt, im.attr["aria-hidden"] ?? null, im.style.position, im.style.left, im.style.top, im.style.width, im.style.height, im.style.objectFit],
    ["aset/logo-contoh.svg", "Logo Contoh Karya (fiktif)", null, "absolute", `${k.x}px`, `${k.y}px`, `${k.w}px`, `${k.h}px`, "contain"], "atribut logo");
  // ikon dekoratif: alt kosong + aria-hidden, filter, tanpa posisi absolut
  const ii = imgTiruan();
  await api.pasangGambar(ii, api.ikon("ikon-centang", { props: p, ukuran: 48, warna: "putih" }));
  samaDengan([ii.attr.alt, ii.attr["aria-hidden"], ii.style.filter, ii.style.width, ii.style.height, ii.style.position ?? null],
    ["", "true", "brightness(0) invert(1)", "48px", "48px", null], "atribut ikon");
  // foto: fokus -> object-position lewat asetGambar({ target })
  const ft = imgTiruan();
  const d = await api.asetGambar("foto-uji", { props: p, target: ft });
  samaDengan([ft.attr.src, ft.style.objectPosition, ft.style.objectFit, ft.attr.alt, d.id], ["aset/foto.webp", "50% 40%", "cover", "Latar biru polos", "foto-uji"], "asetGambar target");
  // src yang sama tidak ditulis ulang (tidak memicu muat ulang per frame)
  let tulis = 0;
  const diam = imgTiruan(); diam.attr.src = k.url;
  Object.defineProperty(diam, "src", { set() { tulis++; }, get() { return k.url; } });
  await api.pasangGambar(diam, k);
  tegas(tulis === 0, "src sama tidak boleh ditulis ulang");
  // decode gagal -> galat berisi URL
  await menolak(() => api.pasangGambar(imgTiruan({ gagal: true }), k), /gambar gagal dimuat: aset\/logo-contoh\.svg/, "decode gagal");
  await menolak(() => api.pasangGambar(imgTiruan(), { url: "x" }), /deskriptor tidak valid/, "deskriptor tanpa alt");
});

daftar("logo: area aman grafis, ukuran, clear space, posisi; rasio terkunci; ukuran minimum, tidak muat, transparansi, rotasi = galat", () => {
  const p = propsUji();
  const o = { props: p, lebar: 1920, tinggi: 1080, ukuran: 10 };
  const A = areaAman(1920, 1080).grafis; // 96,54,1728,972
  // logo-contoh: rasio 3, ukuranMinPx 96, clearSpace 0,25 tinggi. 10% x 1920 = 192; h = 64; cs = ceil(0,25 x 64) = 16
  const k = api.logo("logo-contoh", "kiri-atas", o);
  samaDengan({ w: k.w, h: k.h, cs: k.clearSpace, x: k.x, y: k.y }, { w: 192, h: 64, cs: 16, x: A.x + 16, y: A.y + 16 }, "kiri-atas");
  samaDengan([k.url, k.alt, k.fit, k.opacity, k.posisi, k.ukuranMinPx], ["aset/logo-contoh.svg", "Logo Contoh Karya (fiktif)", "contain", 1, "kiri-atas", 96], "bidang lain");
  const ka = api.logo("logo-contoh", "kanan-atas", o), kb = api.logo("logo-contoh", "kiri-bawah", o), kk = api.logo("logo-contoh", "kanan-bawah", o), kt = api.logo("logo-contoh", "tengah", o);
  samaDengan([ka.x, ka.y], [A.x + A.w - 16 - 192, A.y + 16], "kanan-atas");
  samaDengan([kb.x, kb.y], [A.x + 16, A.y + A.h - 16 - 64], "kiri-bawah");
  samaDengan([kk.x, kk.y], [A.x + A.w - 16 - 192, A.y + A.h - 16 - 64], "kanan-bawah");
  samaDengan([kt.x, kt.y], [A.x + Math.round((A.w - 192) / 2), A.y + Math.round((A.h - 64) / 2)], "tengah");
  // semua posisi (termasuk clear space) berada di dalam area aman grafis
  for (const pos of ["kiri-atas", "kanan-atas", "kiri-bawah", "kanan-bawah", "tengah"]) {
    const q = api.logo("logo-contoh", pos, o);
    tegas(q.x - q.clearSpace >= A.x && q.y - q.clearSpace >= A.y && q.x + q.w + q.clearSpace <= A.x + A.w && q.y + q.h + q.clearSpace <= A.y + A.h, `${pos} keluar area aman`);
  }
  // rasio terkunci: kotak mengikuti rasio aset-props pada ukuran apa pun (selisih pembulatan <= 1 px)
  for (const u of [8, 12, 20, 33]) { const q = api.logo("logo-contoh", "tengah", { ...o, ukuran: u }); tegas(Math.abs(q.w / q.rasio - q.h) <= 0.5 + 1e-9, `rasio ${u}%`); }
  // ctx menggantikan props, lebar, tinggi; nilai eksplisit menang
  samaDengan(api.logo("logo-contoh", "kiri-atas", { ctx: { props: p, width: 1920, height: 1080 }, ukuran: 10 }), k, "ctx");
  // clearSpace satuan lebar
  const kl = api.logo("logo-lebar", "kiri-atas", { ...o, ukuran: 10 });
  tegas(kl.clearSpace === 96 && kl.x === A.x + 96, `clearSpace satuan lebar: ${kl.clearSpace}`);
  // opacity (bug logo semi-transparan) lolos bila tidak dilarang
  tegas(api.logo("logo-contoh", "kiri-atas", { ...o, opacity: 0.8 }).opacity === 0.8, "opacity 0,8");
  // pelanggaran = galat
  const lempar = (fn, pola, nama) => { let m = null; try { fn(); } catch (e) { m = String(e.message); } tegas(m !== null && pola.test(m), `${nama}: ${m}`); };
  lempar(() => api.logo("logo-contoh", "kiri-atas", { ...o, ukuran: 4 }), /77 px, di bawah ukuran minimum pedoman merek \(96 px\)/, "di bawah ukuranMinPx");
  lempar(() => api.logo("logo-contoh", "kiri-atas", { ...o, ukuran: 95 }), /tidak muat di area aman grafis 1728x972/, "tidak muat");
  lempar(() => api.logo("logo-tanpa-transparansi", "kiri-atas", { ...o, opacity: 0.5 }), /melarang transparansi/, "transparansi dilarang");
  tegas(api.logo("logo-tanpa-transparansi", "kiri-atas", o).opacity === 1, "opacity 1 lolos walau transparansi dilarang");
  lempar(() => api.logo("logo-contoh", "kiri-atas", { ...o, rotasi: 10 }), /tidak boleh diputar, diregangkan/, "rotasi");
  lempar(() => api.logo("logo-contoh", "kiri-atas", { ...o, regang: 1.2 }), /tidak boleh diputar, diregangkan/, "regang");
  lempar(() => api.logo("logo-contoh", "tengah-atas", o), /posisi harus salah satu/, "posisi salah");
  lempar(() => api.logo("logo-contoh", "tengah", { props: p }), /ukuran frame wajib/, "tanpa ukuran frame");
  lempar(() => api.logo("logo-contoh", "tengah", { ...o, ukuran: 0 }), /persen lebar frame/, "ukuran 0");
  lempar(() => api.logo("logo-contoh", "tengah", { ...o, opacity: 0 }), /opacity/, "opacity 0");
  lempar(() => api.logo("ikon-centang", "tengah", o), /berjenis ikon, bukan logo/, "bukan logo");
  lempar(() => api.logo("tidak-ada", "tengah", o), /tidak ada di aset-props/, "id tak ada");
  // bawaan ukuran = 10% lebar frame
  tegas(api.logo("logo-contoh", "tengah", { props: p, lebar: 1920, tinggi: 1080 }).w === 192, "ukuran bawaan 10%");
  // rasio tak diketahui = galat
  lempar(() => api.logo("logo-contoh", "tengah", { ...o, props: propsUji((pp) => { delete pp.aset["logo-contoh"].rasio; delete pp.aset["logo-contoh"].lebar; }) }), /tanpa lebar\/tinggi/, "tanpa rasio");
  // deterministik: dua panggilan identik
  samaDengan(api.logo("logo-contoh", "kanan-bawah", o), kk, "deterministik");
});

daftar("logo: latar memeriksa kontras >= 3:1 terhadap warna yang diizinkan dan memilih varian terang/gelap", () => {
  const p = propsUji();
  const o = { props: p, lebar: 1920, tinggi: 1080, ukuran: 10 };
  const varian = { diLatarTerang: "logo-contoh", diLatarGelap: "logo-putih" };
  tegas(api.logo("logo-contoh", "kiri-atas", { ...o, latar: "#ffffff", varian }).id === "logo-contoh", "latar putih -> varian untuk latar terang");
  tegas(api.logo("logo-contoh", "kiri-atas", { ...o, latar: "#0f172a", varian }).id === "logo-putih", "latar gelap -> varian putih");
  tegas(api.logo("logo-contoh", "kiri-atas", { ...o, latar: [15, 23, 42], varian }).id === "logo-putih", "latar [r,g,b]");
  tegas(api.logo("logo-contoh", "kiri-atas", { ...o, latar: "#0f172a", varian: { diLatarTerang: "logo-contoh" } }).id === "logo-contoh", "tanpa varian untuk latar itu -> id awal");
  // tanpa varian: latar hanya memeriksa kontras
  tegas(api.logo("logo-contoh", "kiri-atas", { ...o, latar: "#ffffff" }).id === "logo-contoh", "latar putih, warna biru berkontras");
  let pesan = null;
  try { api.logo("logo-putih", "kiri-atas", { ...o, latar: "#ffffff" }); } catch (e) { pesan = e.message; }
  tegas(pesan && /berkontras 1\.00:1 terhadap latar, di bawah 3:1/.test(pesan), `logo putih di latar putih: ${pesan}`);
  pesan = null;
  try { api.logo("logo-contoh", "kiri-atas", { ...o, latar: "bukan-warna" }); } catch (e) { pesan = e.message; }
  tegas(pesan !== null, "latar tak sah melempar");
  // tanpa warnaDiizinkan di manifest: tidak ada pemeriksaan kontras
  const q = propsUji((pp) => { delete pp.aset["logo-contoh"].merek.aturan.warnaDiizinkan; });
  tegas(api.logo("logo-contoh", "kiri-atas", { ...o, props: q, latar: "#0b5fa5" }).id === "logo-contoh", "tanpa warnaDiizinkan");
});

daftar("ikon: ukuran sisi terpanjang mengikuti rasio, warna putih/hitam via filter, warna lain ditolak, hanya jenis ikon", () => {
  const p = propsUji();
  const i = api.ikon("ikon-centang", { props: p, ukuran: 48 });
  samaDengan([i.w, i.h, i.url, i.filter, i.fit, i.jenis], [48, 48, "aset/ikon-centang.svg", null, "contain", "ikon"], "ikon dasar");
  tegas(api.ikon("ikon-centang", { props: p }).w === 24, "ukuran bawaan 24");
  const lebar = propsUji((pp) => { Object.assign(pp.aset["ikon-centang"], { lebar: 40, tinggi: 20, rasio: 2 }); });
  samaDengan([api.ikon("ikon-centang", { props: lebar, ukuran: 48 }).w, api.ikon("ikon-centang", { props: lebar, ukuran: 48 }).h], [48, 24], "rasio 2");
  const tinggi = propsUji((pp) => { Object.assign(pp.aset["ikon-centang"], { lebar: 20, tinggi: 40, rasio: 0.5 }); });
  samaDengan([api.ikon("ikon-centang", { props: tinggi, ukuran: 48 }).w, api.ikon("ikon-centang", { props: tinggi, ukuran: 48 }).h], [24, 48], "rasio 0,5");
  tegas(api.ikon("ikon-centang", { props: p, warna: "hitam" }).filter === "brightness(0)", "hitam");
  for (const [fn, pola] of [
    [() => api.ikon("ikon-centang", { props: p, warna: "#ff0000" }), /warna harus "putih" atau "hitam"/],
    [() => api.ikon("ikon-centang", { props: p, ukuran: 0 }), /ukuran harus angka positif/],
    [() => api.ikon("logo-contoh", { props: p }), /berjenis logo, bukan ikon/],
  ]) { let m = null; try { fn(); } catch (e) { m = e.message; } tegas(m && pola.test(m), `ikon: ${m}`); }
});

daftar("AC kreditAset: ringkas:false = atribusi.kredit manifest apa adanya; cadangan identik dengan aset-lib; ringkas untuk layar; semua/urutan/id ganda/id tak ada", () => {
  const p = propsUji();
  // sesuai manifest: persis atribusi.kredit dari aset-props.json
  tegas(api.kreditAset("logo-contoh", { props: p, ringkas: false }) === propsContoh.aset["logo-contoh"].atribusi.kredit, "kredit logo = manifest");
  tegas(api.kreditAset("ikon-centang", { props: p, ringkas: false }) === propsContoh.aset["ikon-centang"].atribusi.kredit, "kredit ikon = manifest");
  // cadangan (tanpa atribusi.kredit) identik dengan pembangun aset-lib untuk beberapa lisensi
  const kasus = [
    { judul: "Foto A", pencipta: "Dewi", sumberUrl: "https://example.org/a", lisensi: "CC-BY-4.0", urlLisensi: "https://creativecommons.org/licenses/by/4.0/", perubahan: "dipotong 16:9. " },
    { judul: "Foto B", pencipta: "Budi", sumberUrl: "https://example.org/b", lisensi: "CC-BY-SA-3.0", urlLisensi: "https://creativecommons.org/licenses/by-sa/3.0/", perubahan: "tidak ada" },
    { judul: "Gambar C", pencipta: "Cici", sumberUrl: "https://example.org/c", lisensi: "STOK:pexels", urlLisensi: null, perubahan: "Tidak ada" },
    { judul: "Logo D", pencipta: "Proyek", sumberUrl: null, lisensi: "MILIK-SENDIRI", urlLisensi: null, perubahan: "" },
    { judul: "Gambar E", pencipta: "Eko", sumberUrl: "https://example.org/e", lisensi: "IZIN-TERTULIS:Pemda X", urlLisensi: null, perubahan: "diwarnai ulang" },
    { judul: "Ikon F", pencipta: "Fani", sumberUrl: "https://example.org/f", lisensi: "MIT", urlLisensi: null, perubahan: "tidak ada" },
    { judul: "Peta G", pencipta: "Gita", sumberUrl: "https://example.org/g", lisensi: "CC0-1.0", urlLisensi: "https://creativecommons.org/publicdomain/zero/1.0/", perubahan: "tidak ada" },
    { judul: "Tanpa judul", tanpaJudul: true, pencipta: "Hadi", sumberUrl: "https://example.org/h", lisensi: "CC-BY-4.0", urlLisensi: "https://creativecommons.org/licenses/by/4.0/", perubahan: "tidak ada" },
    { judul: "Anonim", pencipta: "Siapa", penciptaAnonim: true, sumberUrl: "https://example.org/i", lisensi: "PDM-1.0", urlLisensi: "https://creativecommons.org/publicdomain/mark/1.0/", perubahan: "tidak ada" },
  ];
  const q = propsUji((pp) => { kasus.forEach((a, n) => { pp.aset[`k${n}`] = { jenis: "gambar", jalur: "aset/x.png", teksAlternatif: "x", atribusi: { ...a, tampil: "akhir" } }; }); });
  kasus.forEach((a, n) => samaDengan(api.kreditAset(`k${n}`, { props: q, ringkas: false }), kreditAsetLib({ ...a }), `cadangan kasus ${n}`));
  // ringkas (layar): "Judul" oleh Pencipta · lisensi · diubah
  samaDengan(api.kreditAset(["k0", "k1", "k2", "k3", "k4", "k5", "k7", "k8"], { props: q }).split("\n"), [
    '"Foto A" oleh Dewi · CC BY 4.0 · diubah',
    '"Foto B" oleh Budi · CC BY-SA 3.0',
    '"Gambar C" oleh Cici · Lisensi stok pexels',
    '"Logo D" oleh Proyek · Milik sendiri',
    '"Gambar E" oleh Eko · Izin tertulis Pemda X · diubah',
    '"Ikon F" oleh Fani · MIT',
    "Hadi · CC BY 4.0",
    '"Anonim" · Public Domain Mark 1.0',
  ], "ringkas");
  tegas(api.kreditAset("logo-contoh", { props: p }) === '"Logo Contoh Karya" oleh Proyek awvd · Milik sendiri', "ringkas bawaan = true");
  // "semua": hanya aset yang atribusi.tampil layar/akhir, urutan manifest; tampil menyaring
  samaDengan(api.kreditAset("semua", { props: { aset: propsContoh.aset } }), "", "semua tanpa aset berkredit");
  const r = propsUji((pp) => { delete pp.aset["foto-tanpa-alt"]; pp.aset["ikon-centang"].atribusi.tampil = "layar"; pp.aset["foto-uji"].atribusi.kredit = "KREDIT FOTO."; });
  samaDengan(api.kreditAset("semua", { props: r, ringkas: false }).split("\n"), [propsContoh.aset["ikon-centang"].atribusi.kredit, "KREDIT FOTO."], "semua urutan manifest");
  samaDengan(api.kreditAset("semua", { props: r, tampil: "akhir", ringkas: false }), "KREDIT FOTO.", "saring akhir");
  // array: urutan dipertahankan (urut kemunculan), id ganda dibuang, id tak ada = galat, kosong = ""
  samaDengan(api.kreditAset(["foto-uji", "logo-contoh", "foto-uji"], { props: r, ringkas: false }).split("\n"), ["KREDIT FOTO.", propsContoh.aset["logo-contoh"].atribusi.kredit], "urutan array");
  samaDengan(api.kreditAset([], { props: p }), "", "array kosong");
  tegas(api.kreditAset("foto-uji", { ctx: { props: r }, ringkas: false }) === "KREDIT FOTO.", "ctx");
  for (const [fn, pola] of [
    [() => api.kreditAset(["tidak-ada"], { props: p }), /"tidak-ada" tidak ada di aset-props/],
    [() => api.kreditAset(7, { props: p }), /ids harus "semua"/],
    [() => api.kreditAset("logo-contoh", {}), /opsi\.props wajib/],
    [() => api.kreditAset("x", { props: propsUji((pp) => { pp.aset.x = { jenis: "gambar", jalur: "a.png" }; }) }), /tanpa atribusi/],
  ]) { let m = null; try { fn(); } catch (e) { m = e.message; } tegas(m && pola.test(m), `kreditAset: ${m}`); }
});

daftar("pasangFont: FontFace dari entri font, idempoten, galat bila gagal atau bukan font; tanpa browser = galat jelas", async () => {
  const p = propsUji();
  await menolak(() => api.pasangFont("font-uji", { props: p }), /FontFace\/document\.fonts tidak tersedia/, "tanpa browser");
  const dibuat = [], ditambah = [], dihapus = [];
  const asliFontFace = globalThis.window.FontFace, asliFonts = globalThis.document.fonts;
  globalThis.window.FontFace = class { constructor(famili, sumber, desk) { this.famili = famili; this.sumber = sumber; this.desk = desk; dibuat.push(this); } load() { return this.famili === "Gagal" ? Promise.reject(new Error("x")) : Promise.resolve(this); } };
  globalThis.document.fonts = { add: (f) => ditambah.push(f), delete: (f) => dihapus.push(f) };
  try {
    samaDengan(await api.pasangFont("font-uji", { props: p, akar: "proyek" }), ["Uji Awvd"], "hasil");
    samaDengan([dibuat[0].famili, dibuat[0].sumber, dibuat[0].desk], ["Uji Awvd", 'url("proyek/aset/judul.ttf") format("truetype")', { weight: "700", style: "normal", display: "block" }], "FontFace");
    tegas(ditambah.length === 1 && ditambah[0] === dibuat[0], "document.fonts.add");
    // idempoten: panggilan kedua (mis. tiap render) tidak membuat FontFace baru
    await api.pasangFont(["font-uji", "font-uji"], { props: p, akar: "proyek" });
    await api.pasangFont("semua", { props: p, akar: "proyek" });
    tegas(dibuat.length === 1, `FontFace dibuat ulang: ${dibuat.length}`);
    // gagal dimuat: galat jelas, face dibuang, dapat dicoba lagi
    const gagal = propsUji((pp) => { pp.aset["font-uji"].font.famili = "Gagal"; });
    await menolak(() => api.pasangFont("font-uji", { props: gagal }), /font gagal dimuat: "Gagal" \(aset\/judul\.ttf\)/, "font gagal");
    tegas(dihapus.length === 1 && dihapus[0].famili === "Gagal", "face gagal dibuang");
    await menolak(() => api.pasangFont("font-uji", { props: gagal }), /font gagal dimuat/, "coba lagi");
    tegas(dibuat.length === 3, "percobaan ulang membuat FontFace baru");
    await menolak(() => api.pasangFont("logo-contoh", { props: p }), /berjenis logo, bukan font/, "bukan font");
    await menolak(() => api.pasangFont("tidak-ada", { props: p }), /tidak ada di aset-props/, "id tak ada");
    await menolak(() => api.pasangFont(7, { props: p }), /ids harus/, "ids salah");
    await menolak(() => api.pasangFont("font-uji", { props: propsUji((pp) => { pp.aset["font-uji"].font.format = "eot"; }) }), /font\.famili dan font\.format/, "format salah");
    await menolak(() => api.pasangFont("font-uji", { props: propsUji((pp) => { pp.aset["font-uji"].jalur = "http://x.example/f.ttf"; }) }), /berkas lokal relatif/, "jalur jaringan");
  } finally {
    globalThis.window.FontFace = asliFontFace; globalThis.document.fonts = asliFonts;
  }
});

// ---- pemetaan waktu klip (#33): trim, speed, ramp, reverse, freeze
daftar("waktu klip: ekspor petaWaktuKlip, frameSumber, kecepatanPermil", () => {
  for (const k of ["petaWaktuKlip", "frameSumber", "kecepatanPermil"]) {
    tegas(typeof api[k] === "function", `${k} tidak diekspor`);
    tegas(globalThis.window[k] === api[k], `${k} bukan global`);
  }
  samaDengan([1.5, 0.29, 3.333, 1, 0.001].map(api.kecepatanPermil), [1500, 290, 3333, 1000, 1], "kecepatanPermil");
  for (const buruk of [0, -1, 1.0001, NaN, Infinity, "2", 1001, null]) {
    melempar(() => api.kecepatanPermil(buruk), `kecepatanPermil(${String(buruk)})`);
  }
});

daftar("waktu klip: speed konstan (2x memetakan frame genap, 0,5x menduplikasi, batas lantai)", () => {
  const { petaWaktuKlip: peta, frameSumber } = api;
  samaDengan(peta({ kecepatan: 2 }, 5), [0, 2, 4, 6, 8], "2x durasi 5");
  samaDengan(peta({ kecepatan: 2 }, 50).every((v, f) => v === 2 * f && v % 2 === 0), true, "2x selalu genap");
  samaDengan(peta({ kecepatan: 0.5 }, 5), [0, 0, 1, 1, 2], "0,5x");
  samaDengan(peta({ kecepatan: 1 }, 5), [0, 1, 2, 3, 4], "1x identitas");
  samaDengan(peta({}, 5), [0, 1, 2, 3, 4], "tanpa waktu = 1x");
  samaDengan(peta(undefined, 3), [0, 1, 2], "waktu undefined = 1x");
  samaDengan(peta({ kecepatan: 1.5 }, 5), [0, 1, 3, 4, 6], "1,5x");
  // Math.floor(100 * 0.29) === 28 (galat float); permil harus 29
  tegas(Math.floor(100 * 0.29) === 28, "demonstrasi galat float tidak berlaku lagi");
  tegas(peta({ kecepatan: 0.29 }, 101)[100] === 29, "0,29x di frame 100 harus 29");
  tegas(frameSumber({ kecepatan: 0.29 }, 100) === 29, "frameSumber 0,29x di frame 100 harus 29");
  tegas(frameSumber({ kecepatan: 0.57 }, 100) === 57, "0,57x di frame 100 harus 57");
  // trim: dari menggeser titik masuk
  tegas(frameSumber({ kecepatan: 2 }, 3, { dari: 10 }) === 16, "trim dari=10, 2x, frame 3");
  tegas(frameSumber({}, 0, { dari: 25 }) === 25, "frame 0 = dari");
  // identik dengan indeksFrameKlip untuk kecepatan konstan
  for (const kec of [0.25, 0.5, 1, 1.5, 2, 3.333]) {
    for (let f = 0; f < 40; f++) {
      tegas(frameSumber({ kecepatan: kec }, f) === api.indeksFrameKlip({ jumlah: 100000 }, f, { kecepatan: kec }), `sama dengan indeksFrameKlip (kec=${kec}, f=${f})`);
    }
  }
});

daftar("waktu klip: reverse dan freeze di batas", () => {
  const { petaWaktuKlip: peta, frameSumber } = api;
  samaDengan(peta({ kecepatan: 2, balik: true }, 5), [8, 6, 4, 2, 0], "reverse 2x");
  samaDengan(peta({ balik: true }, 4), [3, 2, 1, 0], "reverse 1x");
  samaDengan(peta({ balik: true }, 1), [0], "reverse durasi 1");
  tegas(frameSumber({ balik: true }, 0, { durasi: 4, dari: 10 }) === 13, "reverse: frame pertama = dari + terakhir maju");
  tegas(frameSumber({ balik: true }, 3, { durasi: 4, dari: 10 }) === 10, "reverse: frame terakhir = dari");
  melempar(() => frameSumber({ balik: true }, 0), "reverse tanpa durasi");
  melempar(() => frameSumber({ balik: true }, 4, { durasi: 4 }), "frameLokal = durasi");
  samaDengan(peta({ bekukan: true }, 4), [0, 0, 0, 0], "freeze");
  samaDengan(peta({ bekukan: true }, 1), [0], "freeze durasi 1");
  tegas(frameSumber({ bekukan: true }, 99, { dari: 7 }) === 7, "freeze menahan dari");
  samaDengan(peta({ bekukan: true, kecepatan: 3 }, 3), [0, 0, 0], "freeze mengabaikan kecepatan");
  melempar(() => peta({ bekukan: true, balik: true }, 3), "freeze + reverse");
  // reverse = maju dibalik, untuk banyak kecepatan dan durasi; batas pertama/terakhir
  for (const kec of [0.1, 0.25, 0.5, 1, 1.5, 1.75, 2, 3.333, 10]) {
    for (const d of [1, 2, 7, 30]) {
      const m = peta({ kecepatan: kec }, d), b = peta({ kecepatan: kec, balik: true }, d);
      samaDengan(m.slice().reverse(), b, `reverse = maju dibalik (kec=${kec}, d=${d})`);
      tegas(b[d - 1] === 0 && b[0] === m[d - 1], `batas reverse (kec=${kec}, d=${d})`);
      for (let f = 0; f < d; f++) tegas(frameSumber({ kecepatan: kec, balik: true }, f, { durasi: d }) === b[f], `frameSumber reverse (kec=${kec}, d=${d}, f=${f})`);
    }
  }
});

daftar("waktu klip: ramp monoton, deterministik, easing", () => {
  const { petaWaktuKlip: peta, frameSumber } = api;
  const naik = [{ pada: 0, nilai: 1 }, { pada: 30, nilai: 3 }];
  const r1 = peta({ kecepatan: naik }, 31), r2 = peta({ kecepatan: naik }, 31);
  samaDengan(r1, r2, "ramp deterministik");
  for (let i = 1; i < r1.length; i++) tegas(r1[i] >= r1[i - 1], `ramp monoton di ${i}`);
  tegas(r1[0] === 0 && r1[30] === 59, `ramp 1x -> 3x selama 31 frame berakhir di 59 (dapat ${r1[30]})`);
  // ramp turun
  const turun = peta({ kecepatan: [{ pada: 0, nilai: 3 }, { pada: 39, nilai: 0.5 }] }, 40);
  for (let i = 1; i < turun.length; i++) tegas(turun[i] >= turun[i - 1], "ramp turun monoton");
  // ramp datar = konstan
  samaDengan(peta({ kecepatan: [{ pada: 0, nilai: 2 }, { pada: 9, nilai: 2 }] }, 12), peta({ kecepatan: 2 }, 12), "ramp datar = konstan");
  // ramp hanya mulai di tengah: tahan nilai pertama sebelum, nilai terakhir sesudah
  const tengah = peta({ kecepatan: [{ pada: 5, nilai: 1 }, { pada: 10, nilai: 2 }] }, 20);
  samaDengan(tengah.slice(0, 6), [0, 1, 2, 3, 4, 5], "ramp: sebelum keyframe pertama menahan nilainya");
  tegas(tengah[19] - tengah[18] === 2, "ramp: sesudah keyframe terakhir menahan nilainya");
  // easing: nama, bezier [x1,y1,x2,y2], dan fungsi tetap monoton
  const adaEasing = [
    "masukQuad", "keluarQuad", "masukKeluarCubic", "standar", "perlambat", [0.25, 0.1, 0.25, 1], (t) => t * t,
  ];
  for (const e of adaEasing) {
    const kf = [{ pada: 0, nilai: 1, easing: e }, { pada: 30, nilai: 4 }];
    const r = peta({ kecepatan: kf }, 31);
    for (let i = 1; i < r.length; i++) tegas(r[i] >= r[i - 1], `ramp easing ${String(e)} monoton di ${i}`);
    samaDengan(r, peta({ kecepatan: kf }, 31), "ramp easing deterministik");
    for (let f = 0; f < 31; f += 7) tegas(frameSumber({ kecepatan: kf }, f) === r[f], `frameSumber = tabel (easing ${String(e)}, f=${f})`);
  }
  // easing "linear" sama dengan tanpa easing
  samaDengan(peta({ kecepatan: [{ pada: 0, nilai: 1, easing: "linear" }, { pada: 30, nilai: 3 }] }, 31), r1, "easing linear");
  // ramp + reverse: deret maju dibalik
  const rb = peta({ kecepatan: naik, balik: true }, 31);
  samaDengan(rb, r1.slice().reverse(), "ramp + reverse");
  tegas(frameSumber({ kecepatan: naik, balik: true }, 0, { durasi: 31 }) === 59 && frameSumber({ kecepatan: naik, balik: true }, 30, { durasi: 31 }) === 0, "ramp + reverse di batas");
  // kunci tegas: hasil tidak bergantung pada pemanggilan sebelumnya (tanpa keadaan)
  tegas(frameSumber({ kecepatan: naik }, 30) === 59, "frameSumber ramp frame 30");
  tegas(frameSumber({ kecepatan: naik }, 10) === r1[10], "frameSumber ramp frame 10 (urutan panggilan bebas)");
  tegas(frameSumber({ kecepatan: naik }, 30) === 59, "frameSumber ramp frame 30 lagi");
});

daftar("waktu klip: validasi masukan (gagal keras)", () => {
  const { petaWaktuKlip: peta, frameSumber } = api;
  melempar(() => peta({ kecepatan: 0 }, 5), "kecepatan 0");
  melempar(() => peta({ kecepatan: -2 }, 5), "kecepatan negatif");
  melempar(() => peta({ kecepatan: 1.2345 }, 5), "lebih dari 3 desimal");
  melempar(() => peta({ kecepatan: "2" }, 5), "kecepatan string");
  melempar(() => peta({ speed: 2 }, 5), "bidang tak dikenal");
  melempar(() => peta({ balik: 1 }, 5), "balik bukan boolean");
  melempar(() => peta({ habis: "lompat" }, 5), "habis tak valid");
  melempar(() => peta("2x", 5), "waktu bukan objek");
  melempar(() => peta([], 5), "waktu larik");
  for (const d of [0, -1, 1.5, NaN, "5", undefined]) melempar(() => peta({}, d), `durasi ${String(d)}`);
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 1 }] }, 5), "ramp 1 keyframe");
  melempar(() => peta({ kecepatan: [{ pada: 3, nilai: 1 }, { pada: 3, nilai: 2 }] }, 5), "pada tidak naik tegas");
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 1 }, { pada: 1.5, nilai: 2 }] }, 5), "pada pecahan");
  melempar(() => peta({ kecepatan: [{ pada: -1, nilai: 1 }, { pada: 3, nilai: 2 }] }, 5), "pada negatif");
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 0 }, { pada: 3, nilai: 2 }] }, 5), "nilai ramp 0");
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 1 }, { pada: 3, nilai: 1, easing: "linear" }] }, 5), "easing di keyframe terakhir");
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 1, easing: "tidakAda" }, { pada: 3, nilai: 2 }] }, 5), "easing tak dikenal");
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 1, easing: "bezier" }, { pada: 3, nilai: 2 }] }, 5), "easing 'bezier' tanpa parameter");
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 1, easing: [0, 0, 1] }, { pada: 3, nilai: 2 }] }, 5), "bezier 3 angka");
  melempar(() => peta({ kecepatan: [{ pada: 0, nilai: 1, easing: (t) => -5 * t }, { pada: 3, nilai: 2 }] }, 5), "easing yang membuat kecepatan <= 0");
  for (const f of [-1, 0.5, NaN, "1", undefined]) melempar(() => frameSumber({}, f), `frameLokal ${String(f)}`);
  melempar(() => frameSumber({}, 0, { dari: -1 }), "dari negatif");
  melempar(() => frameSumber({}, 0, { dari: 1.5 }), "dari pecahan");
  melempar(() => frameSumber({}, 0, { durasi: 0 }), "durasi 0");
});

daftar("waktu klip: integrasi indeksFrameKlip dan jalurFrameKlip (perilaku lama tetap)", () => {
  const { indeksFrameKlip: idx, jalurFrameKlip: jalur } = api;
  const klip = { jumlah: 10, folder: "klip/a", ekstensi: "jpg", digit: 4 };
  // perilaku lama tidak berubah (tanpa opsi.waktu)
  samaDengan([idx(klip, -1), idx(klip, 0), idx(klip, 9), idx(klip, 15), idx(klip, 15, { ulang: true }), idx(klip, 3, { kecepatan: 2 }), idx(klip, 2.5, { kecepatan: 2 })], [-1, 0, 9, 9, 5, 6, 5], "indeksFrameKlip lama");
  // jalur baru
  samaDengan([idx(klip, 0, { waktu: { kecepatan: 2 } }), idx(klip, 4, { waktu: { kecepatan: 2 } })], [0, 8], "waktu: 2x");
  tegas(idx(klip, -1, { waktu: { kecepatan: 2 } }) === -1, "waktu: negatif = belum mulai");
  tegas(idx(klip, 2, { waktu: { kecepatan: 2 }, dari: 3 }) === 7, "waktu: trim dari=3");
  tegas(idx(klip, 0, { waktu: { balik: true }, durasi: 6, dari: 2 }) === 7, "waktu: reverse frame pertama");
  tegas(idx(klip, 5, { waktu: { balik: true }, durasi: 6, dari: 2 }) === 2, "waktu: reverse frame terakhir");
  tegas(idx(klip, 8, { waktu: { bekukan: true }, dari: 4 }) === 4, "waktu: freeze");
  tegas(idx(klip, 3, { waktu: { kecepatan: [{ pada: 0, nilai: 1 }, { pada: 4, nilai: 3 }] } }) === 4, "waktu: ramp frame 3 (posisi 4500 permil)");
  // habis: tolak (bawaan), tahan, ulang
  const w = (habis) => ({ kecepatan: 2, habis });
  melempar(() => idx(klip, 5, { waktu: { kecepatan: 2 } }), "habis bawaan = tolak");
  melempar(() => idx(klip, 5, { waktu: w("tolak") }), "habis tolak");
  tegas(idx(klip, 4, { waktu: { kecepatan: 2 } }) === 8, "tepat sebelum batas tidak ditolak");
  tegas(idx(klip, 5, { waktu: w("tahan") }) === 9, "habis tahan");
  tegas(idx(klip, 6, { waktu: w("ulang") }) === 2, "habis ulang (12 mod 10)");
  // konflik opsi dan masukan buruk
  melempar(() => idx(klip, 0, { waktu: {}, kecepatan: 2 }), "waktu + opsi.kecepatan");
  melempar(() => idx(klip, 0, { waktu: {}, ulang: true }), "waktu + opsi.ulang");
  melempar(() => idx(klip, 0.5, { waktu: {} }), "frameLokal pecahan dengan waktu");
  melempar(() => idx(klip, 0, { waktu: { balik: true } }), "reverse tanpa durasi");
  melempar(() => idx(klip, 0, { waktu: { kecepatan: 0 } }), "kecepatan 0 lewat indeksFrameKlip");
  // jalurFrameKlip dan klipGambar ikut karena opsi diteruskan
  tegas(jalur(klip, 4, { waktu: { kecepatan: 2 } }) === "klip/a/0008.jpg", "jalurFrameKlip dengan waktu");
  tegas(jalur(klip, -1, { waktu: { kecepatan: 2 } }) === null, "jalurFrameKlip belum mulai");
});

// Acuan bebas (BigInt) untuk uji properti: tidak berbagi kode dengan runtime.
function acuanMaju(durasi, v) { // v(j) permil; posisi kumulatif; offset = lantai(posisi / 1000)
  const o = []; let pos = 0n;
  for (let f = 0; f < durasi; f++) { o.push(Number(pos / 1000n)); pos += BigInt(v(f)); }
  return o;
}
function acuanLinier(m0, m1, p0, p1) { // v(j) linear eksak, pembulatan setengah ke atas
  return (j) => {
    if (j <= p0) return m0;
    if (j >= p1) return m1;
    const n = BigInt(p1 - p0), k = BigInt(j - p0);
    return Number((2n * (BigInt(m0) * (n - k) + BigInt(m1) * k) + n) / (2n * n));
  };
}

daftar("waktu klip: properti ber-seed (acak) untuk monotonitas dan rentang, kecepatan konstan", () => {
  const { petaWaktuKlip: peta, frameSumber } = api;
  const r = acak("peta-waktu-konstan");
  const lantai = (a, b) => Math.floor(r() * (b - a + 1)) + a;
  for (let i = 0; i < 400; i++) {
    const m = lantai(1, 10000), kec = m / 1000, d = lantai(1, 150), dari = lantai(0, 50);
    const maju = peta({ kecepatan: kec }, d);
    tegas(maju.length === d && maju[0] === 0, `kasus ${i}: panjang dan awal`);
    const rujuk = acuanMaju(d, () => m);
    samaDengan(maju, rujuk, `kasus ${i}: sama dengan acuan BigInt (kec=${kec}, d=${d})`);
    for (let f = 1; f < d; f++) {
      tegas(maju[f] >= maju[f - 1], `kasus ${i}: monoton di ${f}`);
      tegas(maju[f] - maju[f - 1] <= Math.ceil(m / 1000), `kasus ${i}: loncatan <= ceil(kecepatan) di ${f}`);
    }
    tegas(maju[d - 1] <= Math.floor(((d - 1) * m) / 1000) && maju[d - 1] >= 0, `kasus ${i}: rentang`);
    const balik = peta({ kecepatan: kec, balik: true }, d);
    samaDengan(balik, maju.slice().reverse(), `kasus ${i}: reverse = maju dibalik`);
    for (let f = 1; f < d; f++) tegas(balik[f] <= balik[f - 1], `kasus ${i}: reverse tak naik di ${f}`);
    const f = lantai(0, d - 1);
    tegas(frameSumber({ kecepatan: kec }, f, { dari, durasi: d }) === dari + maju[f], `kasus ${i}: frameSumber maju`);
    tegas(frameSumber({ kecepatan: kec, balik: true }, f, { dari, durasi: d }) === dari + balik[f], `kasus ${i}: frameSumber reverse`);
    tegas(frameSumber({ bekukan: true }, f, { dari, durasi: d }) === dari, `kasus ${i}: freeze`);
  }
});

daftar("waktu klip: properti ber-seed (acak) untuk ramp linear: monoton, rentang, sama dengan acuan eksak", () => {
  const { petaWaktuKlip: peta, frameSumber } = api;
  const r = acak("peta-waktu-ramp");
  const bulat = (a, b) => Math.floor(r() * (b - a + 1)) + a;
  for (let i = 0; i < 300; i++) {
    const d = bulat(2, 120), jumlahKf = bulat(2, 5);
    let pada = bulat(0, 5);
    const kf = [];
    for (let k = 0; k < jumlahKf; k++) { kf.push({ pada, nilai: bulat(100, 10000) / 1000 }); pada += bulat(1, 40); }
    const peta1 = peta({ kecepatan: kf }, d);
    // acuan: gabungan segmen linear eksak
    const v = (j) => {
      if (j <= kf[0].pada) return Math.round(kf[0].nilai * 1000);
      const akhir = kf[kf.length - 1];
      if (j >= akhir.pada) return Math.round(akhir.nilai * 1000);
      let s = 0;
      while (kf[s + 1].pada <= j) s++;
      return acuanLinier(Math.round(kf[s].nilai * 1000), Math.round(kf[s + 1].nilai * 1000), kf[s].pada, kf[s + 1].pada)(j);
    };
    samaDengan(peta1, acuanMaju(d, v), `ramp ${i}: sama dengan acuan BigInt ${JSON.stringify(kf)}`);
    const nilaiMin = Math.min(...kf.map((k) => Math.round(k.nilai * 1000))), nilaiMaks = Math.max(...kf.map((k) => Math.round(k.nilai * 1000)));
    tegas(peta1[0] === 0, `ramp ${i}: awal 0`);
    for (let f = 1; f < d; f++) {
      tegas(peta1[f] >= peta1[f - 1], `ramp ${i}: monoton di ${f}`);
      tegas(peta1[f] <= Math.floor((f * nilaiMaks) / 1000), `ramp ${i}: batas atas di ${f}`);
      tegas(peta1[f] >= Math.floor((f * nilaiMin) / 1000), `ramp ${i}: batas bawah di ${f}`);
    }
    const balik = peta({ kecepatan: kf, balik: true }, d);
    samaDengan(balik, peta1.slice().reverse(), `ramp ${i}: reverse`);
    const f = bulat(0, d - 1);
    tegas(frameSumber({ kecepatan: kf }, f) === peta1[f], `ramp ${i}: frameSumber maju di ${f}`);
    tegas(frameSumber({ kecepatan: kf, balik: true }, f, { durasi: d }) === balik[f], `ramp ${i}: frameSumber reverse di ${f}`);
  }
});

daftar("waktu klip: properti ber-seed untuk ramp bereasing: monoton dan rentang", () => {
  const { petaWaktuKlip: peta } = api;
  const r = acak("peta-waktu-easing");
  const bulat = (a, b) => Math.floor(r() * (b - a + 1)) + a;
  const nama = ["masukQuad", "keluarQuad", "masukKeluarQuad", "masukCubic", "keluarCubic", "masukKeluarCubic", "standar", "percepat", "perlambat", [0.4, 0, 0.2, 1]];
  for (let i = 0; i < 150; i++) {
    const d = bulat(2, 100), a = bulat(100, 8000), b = bulat(100, 8000), akhir = bulat(1, 60);
    const kf = [{ pada: 0, nilai: a / 1000, easing: nama[bulat(0, nama.length - 1)] }, { pada: akhir, nilai: b / 1000 }];
    const t = peta({ kecepatan: kf }, d);
    samaDengan(t, peta({ kecepatan: kf }, d), `easing ${i}: deterministik`);
    tegas(t[0] === 0, `easing ${i}: awal`);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let f = 1; f < d; f++) {
      tegas(t[f] >= t[f - 1], `easing ${i}: monoton di ${f}`);
      tegas(t[f] <= Math.floor((f * hi) / 1000) && t[f] >= Math.floor((f * lo) / 1000), `easing ${i}: rentang di ${f}`);
    }
  }
});

daftar("keyframe: nilai tepat di titik, easing per segmen, larik, clamp, galat", () => {
  const { keyframe } = api;
  tegas(globalThis.window.keyframe === keyframe, "keyframe bukan global");
  const kf = [
    { pada: 0, nilai: 10, easing: "masukQuad" },
    { pada: 10, nilai: 20 , easing: [0.2, 0, 0, 1] },
    { pada: 30, nilai: 0, easing: "linear" },
    { pada: 40, nilai: 100 },
  ];
  // tepat di setiap keyframe (termasuk easing yang tak persis 1 di ujung)
  for (const k of kf) samaDengan(keyframe(k.pada, kf), k.nilai, `titik ${k.pada}`);
  // di antara: easing segmen sendiri
  dekat(keyframe(5, kf), 10 + 10 * easing.masukQuad(0.5), 1e-12, "seg0 masukQuad");
  dekat(keyframe(20, kf), 20 + (0 - 20) * easing.bezier(0.2, 0, 0, 1)(0.5), 1e-12, "seg1 bezier");
  dekat(keyframe(35, kf), 50, 1e-12, "seg2 linear");
  // sama dengan interpolasi untuk satu segmen
  dekat(keyframe(5, kf), interpolasi(5, [0, 10], [10, 20], { easing: easing.masukQuad }), 1e-12, "= interpolasi");
  // easing bawaan opsi dipakai bila titik tak punya easing; easing titik menang
  dekat(keyframe(5, [{ pada: 0, nilai: 0 }, { pada: 10, nilai: 1 }], { easing: "masukQuad" }), 0.25, 1e-12, "opsi.easing");
  dekat(keyframe(5, [{ pada: 0, nilai: 0, easing: "linear" }, { pada: 10, nilai: 1 }], { easing: "masukQuad" }), 0.5, 1e-12, "easing titik > opsi");
  dekat(keyframe(5, [{ pada: 0, nilai: 0, easing: (t) => t * t }, { pada: 10, nilai: 1 }]), 0.25, 1e-12, "easing fungsi");
  // clamp
  samaDengan(keyframe(-5, kf), 10, "clamp awal");
  samaDengan(keyframe(99, kf), 100, "clamp akhir");
  dekat(keyframe(50, kf, { clamp: false }), 200, 1e-12, "ekstrapolasi akhir linear");
  dekat(keyframe(-10, [{ pada: 0, nilai: 0, easing: "masukQuad" }, { pada: 10, nilai: 10 }], { clamp: false }), -10, 1e-12, "ekstrapolasi awal linear");
  // larik (vektor) dan pada pecahan; hasil salinan baru
  const v = [{ pada: 0, nilai: [0, 100, 255] }, { pada: 4, nilai: [100, 0, 255] }];
  samaDengan(keyframe(1, v), [25, 75, 255], "larik");
  const awal = keyframe(0, v);
  awal[0] = 999;
  samaDengan(keyframe(0, v), [0, 100, 255], "salinan, bukan rujukan");
  dekat(keyframe(0.5, [{ pada: 0.25, nilai: 0 }, { pada: 0.75, nilai: 4 }]), 2, 1e-12, "pada pecahan");
  // deterministik dan murni
  samaDengan(keyframe(17, kf), keyframe(17, kf), "deterministik");
  // galat
  melempar(() => keyframe(0, [{ pada: 0, nilai: 1 }]), "kurang dari 2 titik");
  melempar(() => keyframe(0, "x"), "bukan larik");
  melempar(() => keyframe(NaN, kf), "frame NaN");
  melempar(() => keyframe(0, [{ pada: 5, nilai: 1 }, { pada: 5, nilai: 2 }]), "pada tak naik tegas");
  melempar(() => keyframe(0, [{ pada: 0, nilai: 1 }, { pada: 1, nilai: [2] }]), "campur angka dan larik");
  melempar(() => keyframe(0, [{ pada: 0, nilai: [1, 2] }, { pada: 1, nilai: [2] }]), "panjang larik beda");
  melempar(() => keyframe(0, [{ pada: 0, nilai: "a" }, { pada: 1, nilai: 2 }]), "nilai bukan angka");
  melempar(() => keyframe(0, [{ pada: 0, nilai: 1 }, { pada: 1, nilai: 2, easing: "linear" }]), "easing di titik terakhir");
  melempar(() => keyframe(1, [{ pada: 0, nilai: 1, easing: "tidakAda" }, { pada: 4, nilai: 2 }]), "easing tak dikenal");
  melempar(() => keyframe(1, [{ pada: 0, nilai: 1 }, { pada: 4, nilai: 2 }], { easing: "bezier" }), "opsi.easing tak sah");
});

const t0 = Date.now();
let gagal = 0;
for (const [nama, fn] of uji) {
  const t = Date.now();
  try {
    await fn();
    console.log(`LOLOS  ${nama} (${((Date.now() - t) / 1000).toFixed(2)} s)`);
  } catch (e) {
    gagal++;
    console.log(`GAGAL  ${nama}: ${e.message}`);
  }
}
console.log(`\n${uji.length - gagal}/${uji.length} lolos, total ${((Date.now() - t0) / 1000).toFixed(2)} s`);
process.exit(gagal ? 1 : 0);
