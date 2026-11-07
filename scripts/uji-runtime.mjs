#!/usr/bin/env bun
/**
 * uji-runtime.mjs — uji unit helper runtime.js (tanpa browser, tanpa dependensi).
 * Memuat runtime.js di Bun dengan window/document tiruan minimal, lalu menegaskan
 * nilai helper. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-runtime.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- tiruan minimal: cukup agar runtime.js tereksekusi dan defineVideo berjalan.
const elemenTiruan = () => ({ setAttribute() {}, appendChild() {}, style: {} });
globalThis.window = { location: { search: "" } };
globalThis.document = {
  readyState: "complete",
  createElement: elemenTiruan,
  head: elemenTiruan(),
  documentElement: elemenTiruan(),
};
await import(join(dirname(fileURLToPath(import.meta.url)), "runtime.js"));
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
    "pilihTeksKontras", "durasiBaca", "pecahBaris", "captionAktif", "parseVtt", "parseSrt"]) {
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
