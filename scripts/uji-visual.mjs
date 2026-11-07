#!/usr/bin/env bun
/**
 * uji-visual.mjs — uji helper visual runtime.js (simulasi buta warna, CIEDE2000, periksaPalet,
 * ukuranTeks), data/audiens.json, koreksi cps Netflix Indonesia, integrasi audiens di konsep.mjs,
 * dan ukuran teks templat contoh-dasar. Tanpa browser dan tanpa dependensi. Exit 0 bila semua
 * lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-visual.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { audiensEfektif, buatKonsep, konteksUkuranTeks, muatData, periksaAudiens, periksaKonsep } from "./konsep.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- tiruan minimal browser (seperti uji-runtime.mjs)
const elemenTiruan = () => ({ setAttribute() {}, appendChild() {}, style: {} });
globalThis.window = { location: { search: "" } };
globalThis.document = { readyState: "complete", createElement: elemenTiruan, head: elemenTiruan(), documentElement: elemenTiruan() };
await import(pathToFileURL(join(akar, "scripts", "runtime.js")).href);
const api = globalThis.window.VideoTerprogram;
const { simulasiButaWarna, keLab, bedaLab, bedaWarna, periksaPalet, ukuranTeks, paletOkabeIto, kontras } = api;

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function dekat(nyata, harapan, eps, nama) {
  tegas(Math.abs(nyata - harapan) <= eps, `${nama}: dapat ${nyata}, harapan ${harapan} (+-${eps})`);
}
function melempar(fn, nama, re) {
  let pesan = null;
  try { fn(); } catch (e) { pesan = e.message; }
  tegas(pesan !== null, `${nama}: seharusnya melempar galat`);
  if (re) tegas(re.test(pesan), `${nama}: pesan galat "${pesan}" tidak cocok ${re}`);
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

// Data uji CIEDE2000 dari Sharma, Wu & Dalal (2005), Color Research & Application 30(1):21-30:
// [Lab1, Lab2, delta E00]. Nilai ditulis ulang dari tabel data uji tambahan makalah itu.
const SHARMA = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, -1, 2], [50, 0, 0], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[50, 2.5, 0], [61, -5, 29], 22.8977],
  [[50, 2.5, 0], [56, -27, -3], 31.903],
  [[50, 2.5, 0], [58, 24, 15], 19.4535],
  [[50, 2.5, 0], [50, 3.1736, 0.5854], 1],
  [[50, 2.5, 0], [50, 3.2972, 0], 1],
  [[50, 2.5, 0], [50, 1.8634, 0.5757], 1],
  [[50, 2.5, 0], [50, 3.2592, 0.335], 1],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

daftar("ekspor: helper visual ada di window.VideoTerprogram dan sebagai global", () => {
  for (const k of ["simulasiButaWarna", "keLab", "bedaLab", "bedaWarna", "periksaPalet", "ukuranTeks", "paletOkabeIto"]) {
    tegas(api[k] != null, `${k} tidak diekspor`);
    tegas(globalThis.window[k] === api[k], `${k} bukan global`);
  }
});

daftar("bedaLab: data uji Sharma 2005 (23 pasangan, 1e-3), simetris", () => {
  for (const [a, b, harapan] of SHARMA) {
    dekat(bedaLab(a, b), harapan, 1e-3, `Sharma ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    dekat(bedaLab(b, a), harapan, 1e-3, "simetri");
  }
});

daftar("keLab dan bedaWarna: titik acuan sRGB D65, identik = 0, hitam-putih = 100", () => {
  const putih = keLab("#ffffff"), hitam = keLab("#000"), merah = keLab([255, 0, 0]);
  dekat(putih[0], 100, 0.01, "L putih");
  dekat(Math.hypot(putih[1], putih[2]), 0, 0.01, "kroma putih");
  dekat(hitam[0], 0, 1e-9, "L hitam");
  // merah sRGB murni di D65: Lab (53,24; 80,09; 67,20) (nilai rujukan umum)
  dekat(merah[0], 53.24, 0.05, "L merah");
  dekat(merah[1], 80.09, 0.05, "a merah");
  dekat(merah[2], 67.2, 0.05, "b merah");
  dekat(bedaWarna("#336699", [0x33, 0x66, 0x99]), 0, 1e-9, "identik");
  dekat(bedaWarna("#000", "#fff"), 100, 0.01, "hitam-putih");
  melempar(() => bedaWarna("merah", "#fff"), "warna tak sah", /warna harus/);
});

daftar("simulasiButaWarna: putih/hitam tetap, keparahan 0 = identitas, nilai acuan, galat", () => {
  for (const j of ["protanopia", "deuteranopia", "tritanopia"]) {
    const p = simulasiButaWarna("#ffffff", j), h = simulasiButaWarna("#000000", j);
    dekat(Math.max(...p.map((v) => Math.abs(v - 255))), 0, 0.6, `putih ${j}`);
    dekat(Math.max(...h), 0, 0.01, `hitam ${j}`);
    const asli = [200, 100, 50], nol = simulasiButaWarna(asli, j, 0);
    for (let i = 0; i < 3; i++) dekat(nol[i], asli[i], 1e-9, `keparahan 0 ${j}`);
    const setengah = simulasiButaWarna(asli, j, 0.5), penuh = simulasiButaWarna(asli, j);
    tegas(bedaWarna(asli, setengah) < bedaWarna(asli, penuh), `keparahan 0,5 harus lebih dekat ke asli daripada 1 (${j})`);
  }
  // merah #d62728 pada deuteranopia (nilai acuan hitungan matriks Machado 2009, keparahan 1)
  const d = simulasiButaWarna("#d62728", "deuteranopia");
  dekat(d[0], 139.36, 0.05, "R deuteranopia"); dekat(d[1], 124.41, 0.05, "G deuteranopia"); dekat(d[2], 30.7, 0.05, "B deuteranopia");
  // merah vs hijau jadi nyaris sama pada deuteranopia, tetapi jelas beda pada penglihatan normal
  dekat(bedaWarna("#d62728", "#2ca02c"), 71.8, 0.1, "merah-hijau normal");
  dekat(bedaWarna(simulasiButaWarna("#d62728", "deuteranopia"), simulasiButaWarna("#2ca02c", "deuteranopia")), 4.6, 0.1, "merah-hijau deuteranopia");
  melempar(() => simulasiButaWarna("#fff", "akromatopsia"), "jenis tak dikenal", /protanopia/);
  melempar(() => simulasiButaWarna("#fff", "protanopia", 1.5), "keparahan > 1", /0\.\.1/);
  melempar(() => simulasiButaWarna("#fff", "protanopia", -0.1), "keparahan < 0", /0\.\.1/);
  const a = simulasiButaWarna("#d62728", "tritanopia"), b = simulasiButaWarna("#d62728", "tritanopia");
  tegas(JSON.stringify(a) === JSON.stringify(b), "tidak deterministik");
});

daftar("periksaPalet: Okabe-Ito lolos, palet merah-hijau gagal pada deuteranopia, kontras latar, opsi, galat", () => {
  tegas(paletOkabeIto.length === 8 && paletOkabeIto[0] === "#000000", "paletOkabeIto: 8 warna, hitam pertama");
  const latar = "#101828";
  const tanpaHitam = periksaPalet(paletOkabeIto.slice(1), { latar });
  tegas(tanpaHitam.lolos && tanpaHitam.pasangan.length === 0, `Okabe-Ito tanpa hitam: ${JSON.stringify(tanpaHitam.pasangan)}`);
  for (const k of ["normal", "protanopia", "deuteranopia", "tritanopia"]) tegas(tanpaHitam.minPerKondisi[k] >= 10, `min ${k} ${tanpaHitam.minPerKondisi[k]}`);
  dekat(tanpaHitam.minPerKondisi.normal, 21.7, 0.1, "min normal Okabe-Ito");
  dekat(tanpaHitam.minPerKondisi.deuteranopia, 11.6, 0.1, "min deuteranopia Okabe-Ito");

  const semua = periksaPalet(paletOkabeIto, { latar });
  tegas(!semua.lolos && semua.pasangan.length === 0 && semua.lemahKontras.length === 1 && semua.lemahKontras[0].warna === "#000000", "hitam harus lemah kontras terhadap latar gelap");
  dekat(semua.lemahKontras[0].kontras, 1.18, 0.01, "kontras hitam vs latar");

  const lalu = periksaPalet(["#d62728", "#2ca02c", "#ffd700"]);
  tegas(!lalu.lolos && lalu.pasangan.length === 1 && lalu.pasangan[0].kondisi === "deuteranopia", `lampu lalu lintas: ${JSON.stringify(lalu.pasangan)}`);
  tegas(lalu.pasangan[0].a === 0 && lalu.pasangan[0].b === 1, "pasangan merah-hijau");
  dekat(lalu.pasangan[0].deltaE, 4.6, 0.05, "deltaE merah-hijau deuteranopia");

  const tableau = periksaPalet(["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"]);
  tegas(!tableau.lolos && tableau.pasangan.length >= 5, `Tableau10 klasik harus gagal pada protanopia/deuteranopia: ${tableau.pasangan.length}`);

  // opsi: ambang kecil meloloskan, ambang besar menggagalkan; kontrasMin
  tegas(periksaPalet(["#d62728", "#2ca02c"], { ambang: 4 }).lolos, "ambang 4 meloloskan merah-hijau (4,6)");
  tegas(!periksaPalet(paletOkabeIto.slice(1), { ambang: 15 }).lolos, "ambang 15 menggagalkan Okabe-Ito");
  const lemahLatar = periksaPalet(["#888888", "#ffffff"], { latar: "#999999" });
  tegas(!lemahLatar.lolos && lemahLatar.lemahKontras.length === 2 && lemahLatar.pasangan.length === 0, "dua warna terang vs latar abu-abu: keduanya < 3:1");
  const lemahSatu = periksaPalet(["#888888", "#ffffff"], { latar: "#999999", kontrasMin: 2 }).lemahKontras;
  tegas(lemahSatu.length === 1 && lemahSatu[0].warna === "#888888", "kontrasMin 2: hanya #888888 (1,24:1) yang lemah; putih 2,85:1 lolos");
  tegas(periksaPalet(["#e8590c", "#38bdf8", "#cbd5e1"], { latar }).lolos, "palet aksen contoh-dasar lolos");
  dekat(kontras("#e8590c", latar), 4.96, 0.01, "kontras aksen contoh-dasar");

  melempar(() => periksaPalet(["#fff"]), "palet satu warna", />= 2/);
  melempar(() => periksaPalet("#fff"), "palet bukan array", />= 2/);
  melempar(() => periksaPalet(["#fff", "#000"], { ambang: 0 }), "ambang 0", /positif/);
  melempar(() => periksaPalet(["#fff", "tidak-sah"]), "warna tak sah", /warna harus/);
});

daftar("ukuranTeks: nilai acuan, urutan peran/audiens/konteks, pengali angka, galat", () => {
  // acuan hitungan sudut (CPS 0,2 derajat, rasio tinggi-x 0,52, geometri asumsi)
  const acuan = [
    ["isi", "umum", "ponselLanskap", 1080, 49, 4.5], ["isi", "umum", "ponselPotret169", 1080, 79, 7.3],
    ["isi", "umum", "tv", 1080, 27, 2.5], ["isi", "umum", "laptop", 1080, 50, 4.6],
    ["isi", "umum", "ponselVertikalPenuh", 1080, 20, 1.9], ["isi", "lansia", "ponselLanskap", 1080, 73, 6.8],
    ["isi", "lowVision", "ponselLanskap", 1080, 98, 9.1], ["isi", "anak", "ponselLanskap", 1080, 59, 5.4],
    ["judul", "umum", "ponselLanskap", 1080, 86, 8], ["subjudul", "umum", "ponselLanskap", 1080, 59, 5.5],
    ["keterangan", "umum", "ponselLanskap", 1080, 39, 3.6], ["caption", "umum", "ponselLanskap", 720, 33, 4.5],
  ];
  for (const [peran, aud, kon, tinggi, px, persen] of acuan) {
    const r = ukuranTeks(tinggi, peran, aud, kon);
    tegas(r.px === px, `${peran}/${aud}/${kon}@${tinggi}: px ${r.px}, harapan ${px}`);
    dekat(r.persenTinggi, persen, 0.11, `${peran}/${aud}/${kon} persen`);
  }
  const bawaan = ukuranTeks(1080);
  tegas(JSON.stringify(bawaan) === JSON.stringify(ukuranTeks(1080, "isi", "umum", "ponselLanskap")), "bawaan = isi/umum/ponselLanskap");
  dekat(bawaan.tinggiXDerajat, 0.25, 1e-9, "tinggi-x derajat isi umum (0,2 x 1,25)");
  // pengali angka setara nama
  tegas(ukuranTeks(1080, "isi", 1.5, "laptop").px === ukuranTeks(1080, "isi", "lansia", "laptop").px, "pengali 1,5 = lansia");
  // linear terhadap tinggi frame
  dekat(ukuranTeks(2160, "isi").px, 2 * ukuranTeks(1080, "isi").px, 1, "linear terhadap tinggi frame");
  // urutan monoton
  const px = (p, a, k) => ukuranTeks(1080, p, a, k).px;
  tegas(px("judul") > px("subjudul") && px("subjudul") > px("isi") && px("isi") > px("keterangan"), "urutan peran");
  tegas(px("isi", "umum") < px("isi", "anak") && px("isi", "anak") < px("isi", "lansia") && px("isi", "lansia") < px("isi", "lowVision"), "urutan audiens");
  tegas(px("isi", "umum", "ponselPotret169") > px("isi", "umum", "laptop") && px("isi", "umum", "laptop") > px("isi", "umum", "tv") && px("isi", "umum", "tv") > px("isi", "umum", "ponselVertikalPenuh"), "urutan konteks");
  // properti pendamping dipakai uji dan konsep.mjs
  tegas(ukuranTeks.pengaliAudiens.lansia === 1.5 && ukuranTeks.konteks.tv.sudut > 18 && ukuranTeks.peran.isi === 1.25, "properti pendamping");
  melempar(() => ukuranTeks(0), "tinggi 0", /positif/);
  melempar(() => ukuranTeks(720, "paragraf"), "peran tak dikenal", /peran/);
  melempar(() => ukuranTeks(720, "isi", "kakek"), "audiens tak dikenal", /audiens/);
  melempar(() => ukuranTeks(720, "isi", -1), "pengali negatif", /audiens/);
  melempar(() => ukuranTeks(720, "isi", "umum", "bioskop"), "konteks tak dikenal", /konteks/);
});

// ----------------------------------------------------------------- data dan konsep
const data = muatData();

daftar("data/audiens.json: skema valid, pengali sama dengan runtime, peta konteks valid, sumber tiap nilai", () => {
  const g = periksaAudiens(data.audiens, api);
  tegas(g.length === 0, `periksaAudiens: ${g.slice(0, 3).join("; ")}`);
  tegas(JSON.stringify(Object.keys(data.audiens.profil)) === JSON.stringify(["umum", "remaja", "anak", "lansia", "lowVision"]), "daftar profil");
  const n = (p) => data.audiens.profil[p].nilai;
  tegas(n("umum").cps === 17 && n("anak").cps === 13, "cps umum 17 dan anak 13 (Netflix Indonesia)");
  tegas(data.audiens.profil.anak.bukti.cps.tingkat === "pedoman-industri" && /13 cps/.test(data.audiens.profil.anak.bukti.cps.rujukan), "bukti cps anak");
  tegas(n("lansia").kontrasTeksMin === 7 && n("lowVision").kontrasTeksMin === 7 && n("umum").kontrasTeksMin === 4.5, "kontras teks (WCAG 1.4.3 dan 1.4.6)");
  for (const [k, p] of Object.entries(data.audiens.profil)) {
    for (const [at, b] of Object.entries(p.bukti)) tegas(b.rujukan.length > 20, `${k}.${at}: rujukan terlalu singkat`);
  }
  // pemeriksa menolak data rusak
  const rusak = (ubah, re) => {
    const m = JSON.parse(JSON.stringify(data.audiens));
    ubah(m);
    const gg = periksaAudiens(m, api);
    tegas(gg.some((x) => re.test(x)), `data rusak tidak terdeteksi (${re}): ${gg.join("; ")}`);
  };
  rusak((m) => { m.profil.anak.nilai.pengaliUkuranTeks = 1.3; }, /tidak sama dengan runtime/);
  rusak((m) => { m.profil.umum.nilai.kontrasTeksMin = 3; }, /kontrasTeksMin/);
  rusak((m) => { delete m.profil.lansia.bukti.cps; }, /lansia\.bukti\.cps/);
  rusak((m) => { m.profil.lansia.bukti.cps.tingkat = "ilmiah"; }, /tingkat tidak valid/);
  rusak((m) => { m.petaKonteksTonton.tv = "bioskop"; }, /petaKonteksTonton\.tv/);
  rusak((m) => { m.profil.anak.nilai.cps = 25; }, /cps/);
  rusak((m) => { delete m.profil.remaja; }, /kunci harus sama/);
});

daftar("koreksi cps Netflix Indonesia di data/jenis-video.json dan salinan preset", () => {
  const teks = readFileSync(join(akar, "data", "jenis-video.json"), "utf8");
  tegas(!/belum diverifikasi, bawaan konservatif/.test(teks), "catatan kesenjangan cps masih ada");
  tegas(!/17 cps \(anak\) dan 20 cps \(dewasa\)/.test(teks), "angka lama (anak 17, dewasa 20) masih ada");
  tegas(!/README/.test(teks), "rujukan 'README' masih ada di data/jenis-video.json");
  for (const [k, j] of Object.entries(data.jenis.jenis)) {
    const rujukan = j.bukti.cps.rujukan;
    tegas(/13 cps/.test(rujukan) && /SDH/.test(rujukan), `${k}: rujukan cps harus menyebut anak 13 cps dan SDH`);
    tegas(j.nilai.cps === (k === "sosial" ? 20 : 17), `${k}: cps ${j.nilai.cps}`);
  }
  tegas(/docs\/konsep-jenis-alur\.md/.test(data.jenis.jenis.sosial.bukti.cps.rujukan), "sosial: rujukan harus menunjuk docs/konsep-jenis-alur.md");
  const runtime = readFileSync(join(akar, "scripts", "runtime.js"), "utf8");
  tegas(/subtitle[\s\S]{0,40}17 cps \(dewasa\) dan 13 cps \(anak\)/.test(runtime), "komentar durasiBaca belum dikoreksi");
});

daftar("konsep.mjs: profil audiens (cps efektif, validasi, peringatan, brief, konteks ukuran teks)", () => {
  tegas(JSON.stringify(audiensEfektif(data, ["umum"])) === JSON.stringify({
    pengaliUkuranTeks: 1, cps: 17, pengaliTempoAdegan: 1, kontrasTeksMin: 4.5, kontrasNonTeksMin: 3, maksElemenBaru: 4, pengaliKecepatanNarasi: 1,
  }), "audiensEfektif umum");
  const gabung = audiensEfektif(data, ["umum", "lansia", "anak"]);
  tegas(gabung.pengaliUkuranTeks === 1.5 && gabung.cps === 13 && gabung.kontrasTeksMin === 7 && gabung.maksElemenBaru === 3 && gabung.pengaliTempoAdegan === 1.4 && gabung.pengaliKecepatanNarasi === 0.85, `paling ketat: ${JSON.stringify(gabung)}`);
  tegas(audiensEfektif(data, []) === null && audiensEfektif(data, undefined) === null && audiensEfektif(data, ["tidakada"]) === null, "tanpa profil sah -> null");
  const dgPreset = audiensEfektif(data, ["umum"], { cps: 13, kontrasMin: 7 });
  tegas(dgPreset.cps === 13 && dgPreset.kontrasTeksMin === 7, "digabung dengan preset (paling ketat)");
  tegas(JSON.stringify(konteksUkuranTeks(data, ["laptop-kantor", "ponsel", "xyz", "laptop"])) === JSON.stringify(["laptop", "ponselLanskap"]), "konteksUkuranTeks");
  tegas(konteksUkuranTeks(data, undefined).length === 0 && konteksUkuranTeks(data, ["catatan"]).length === 0, "konteksUkuranTeks tak sah");

  const baru = buatKonsep(data, { jenis: "edukasi", alur: "instruksional", judul: "Uji audiens fiktif", audiens: ["anak"] });
  tegas(baru.caption.cps === 13 && JSON.stringify(baru.audiens.profil) === JSON.stringify(["anak"]), `baru --audiens anak: cps ${baru.caption.cps}`);
  const tanpa = buatKonsep(data, { jenis: "edukasi", alur: "instruksional", judul: "Uji" });
  tegas(!("profil" in tanpa.audiens) && tanpa.caption.cps === 17, "tanpa --audiens: tidak ada kunci profil, cps preset");

  const konsep = (profil, tambahan = {}) => {
    const k = buatKonsep(data, { jenis: "edukasi", alur: "instruksional", judul: "Uji audiens fiktif" });
    k.tujuan = "Tujuan fiktif."; k.tujuanBelajar = ["Tujuan belajar fiktif"]; k.audiens.deskripsi = "Audiens fiktif";
    k.pesanUtama = "Pesan fiktif."; k.cta.teks = "Ajakan fiktif";
    if (profil !== undefined) k.audiens.profil = profil;
    return Object.assign(k, tambahan);
  };
  tegas(periksaKonsep(data, konsep(["umum"])).galat.length === 0, "profil umum lolos");
  const salahJenis = periksaKonsep(data, konsep(["kakek"]));
  tegas(salahJenis.galat.some((x) => /audiens\.profil/.test(x)), "profil tak dikenal harus galat");
  tegas(periksaKonsep(data, konsep("anak")).galat.some((x) => /audiens\.profil/.test(x)), "profil bukan array harus galat");
  const lansia = periksaKonsep(data, konsep(["lansia"]));
  tegas(lansia.galat.length === 0, `profil lansia: ${lansia.galat}`);
  tegas(lansia.peringatan.some((x) => /caption\.cps 17 melebihi batas profil audiens \(14\)/.test(x)), `peringatan cps lansia: ${lansia.peringatan}`);
  tegas(lansia.peringatan.some((x) => /kontrasMin .* di bawah kebutuhan profil audiens \(7:1\)/.test(x)), `peringatan kontras lansia: ${lansia.peringatan}`);
  const ok = periksaKonsep(data, konsep(["lansia"], { override: { kontrasMin: 7 }, overrideAlasan: "Penonton lansia.", caption: { burnIn: false, cps: 14, mode: "pop-on", bahasa: "ind" } }));
  tegas(ok.galat.length === 0 && ok.peringatan.length === 0, `lansia dengan override: ${ok.galat} ${ok.peringatan}`);
});

// ----------------------------------------------------------------- templat contoh-dasar
daftar("templat contoh-dasar: ukuran teks memenuhi ukuranTeks() untuk audiens umum (laptop, ponsel lanskap, TV)", () => {
  const html = readFileSync(join(akar, "templates", "contoh-dasar", "index.html"), "utf8");
  const tinggi = Number(/#layar\s*\{[^}]*height:\s*(\d+)px/.exec(html)?.[1]);
  tegas(tinggi === 720, `tinggi #layar terbaca ${tinggi}`);
  const ukuran = (selektor) => {
    const m = new RegExp(`${selektor.replace(/[.#]/g, "\\$&")}\\s*\\{[^}]*font-size:\\s*(\\d+)px`).exec(html);
    tegas(m, `font-size ${selektor} tidak ditemukan`);
    return Number(m[1]);
  };
  const peran = { "#judul": "judul", "#subjudul": "subjudul", "#lower .t1": "isi", "#lower .t2": "keterangan" };
  for (const kon of ["laptop", "ponselLanskap", "tv"]) {
    for (const [sel, p] of Object.entries(peran)) {
      const min = ukuranTeks(tinggi, p, "umum", kon).px;
      tegas(ukuran(sel) >= min, `${sel} ${ukuran(sel)}px < minimum ${min}px (${p}, umum, ${kon}, tinggi ${tinggi})`);
    }
  }
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
