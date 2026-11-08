#!/usr/bin/env bun
/**
 * uji-reframe.mjs — uji reframe 16:9 ke 9:16: helper komposisi (scripts/reframe.js), CLI
 * (scripts/reframe.mjs: periksa dan saran), dan templat reframe-contoh di Chromium.
 *
 * Yang diuji: geometri crop (zoom, penjepit tepi), interpolasi keyframe (linear, easing, tahan,
 * di luar rentang), determinisme dan akses acak, validasi skema, teks sumber terpotong dan
 * teks keluaran di luar area aman 9:16, templat (salinan data tidak basi; di Chromium subjek tetap
 * di tengah dan teks di area aman), CLI (kode keluar), dan saran fokus pada video sintetis ffmpeg
 * (kotak putih bergerak dan diam; fail-closed tanpa ffmpeg). Tanpa model, jaringan, atau aset
 * pihak ketiga. Deteksi wajah dan pelacakan objek TIDAK diuji (tidak ada; docs/reframe.md).
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-reframe.mjs
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { haluskan, PARAMETER_SARAN, periksaBerkasReframe, sarankanReframe, sederhanakan } from "./reframe.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(akar, "scripts", "reframe.mjs");
const templat = join(akar, "templates", "reframe-contoh");
const muat = createRequire(import.meta.url);
const RF = muat("./reframe.js");
const RT = muat("./runtime.js");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-reframe-"));
const j = (...p) => join(tmp, ...p);

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function samaDengan(a, b, pesan) {
  tegas(JSON.stringify(a) === JSON.stringify(b), `${pesan}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
function dekat(a, b, eps, pesan) {
  tegas(Math.abs(a - b) <= eps, `${pesan}: ${a} !~ ${b} (eps ${eps})`);
}
function melempar(fn, pola, pesan) {
  try { fn(); } catch (e) { tegas(pola.test(e.message), `${pesan}: pesan "${e.message}"`); return; }
  throw new Error(`${pesan}: tidak melempar`);
}
async function jalankan(cmd, env) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", ...(env ? { env } : {}) });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const bun = (...a) => jalankan([process.execPath, cli, ...a]);
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
}

const uji = [];
const tes = (nama, fn) => uji.push([nama, fn]);

const SUMBER = { lebar: 1920, tinggi: 1080 };
const KELUAR = { lebar: 1080, tinggi: 1920 };
const dasar = (keyframe, tambahan = {}) => ({ sumber: SUMBER, keluar: KELUAR, keyframe, ...tambahan });
const templatData = JSON.parse(readFileSync(join(templat, "reframe.json"), "utf8"));

tes("(a) geometri crop: 16:9 ke 9:16 pada zoom 1 dan 2, penjepit tepi, skala", () => {
  const k = (fokus, zoom) => RF.kotakCrop(dasar([{ frame: 0, fokus, zoom }]), 0);
  const c = k([0.5, 0.5], 1);
  samaDengan([c.w, c.h, c.x, c.y], [607.5, 1080, 656.25, 0], "tengah zoom 1");
  dekat(c.skala, 1080 / 607.5, 0.001, "skala");
  dekat(c.w / c.h, 9 / 16, 1e-3, "rasio crop 9:16");
  samaDengan([k([0, 0.5], 1).x, k([1, 0.5], 1).x], [0, 1312.5], "tepi kiri dan kanan dijepit");
  const z = k([0.5, 0.5], 2);
  samaDengan([z.w, z.h, z.x, z.y], [303.75, 540, 808.125, 270], "zoom 2");
  samaDengan([k([0, 0], 2).x, k([0, 0], 2).y, k([1, 1], 2).y], [0, 0, 540], "zoom 2 dijepit di sudut");
  // sumber lebih sempit dari keluar (potret ke lanskap): jendela selebar sumber
  const p = RF.kotakCrop({ sumber: { lebar: 1080, tinggi: 1920 }, keluar: { lebar: 1920, tinggi: 1080 }, keyframe: [{ frame: 0, fokus: [0.5, 0.5] }] }, 0);
  samaDengan([p.w, p.h], [1080, 607.5], "sumber potret ke keluar lanskap");
});

tes("(b) interpolasi keyframe: linear, easing, tahan, di luar rentang, akses acak", () => {
  const o = dasar([
    { frame: 10, fokus: [0.3, 0.5] },
    { frame: 20, fokus: [0.7, 0.5], easing: "masukKeluarCubic" },
    { frame: 30, fokus: [0.7, 0.5], easing: "tahan" },
    { frame: 40, fokus: [0.2, 0.5] },
  ]);
  const fx = (f) => RF.kotakCrop(o, f).fokus[0];
  samaDengan([fx(0), fx(10)], [0.3, 0.3], "sebelum dan di keyframe pertama");
  dekat(fx(15), 0.5, 1e-9, "tengah segmen linear");
  dekat(fx(12.5), 0.4, 1e-9, "frame pecahan, linear");
  samaDengan([fx(30), fx(20), fx(40), fx(99)], [0.7, 0.7, 0.2, 0.2], "tepat di keyframe dan setelah yang terakhir");
  // segmen berjalan di 20..30 linear: 0.7 -> 0.7 tetap
  samaDengan(fx(25), 0.7, "segmen datar");
  // 'tahan' pada segmen 30..40: nilai awal ditahan sampai tepat di keyframe berikut
  samaDengan([fx(35), fx(39), fx(40)], [0.7, 0.7, 0.2], "tahan");
  const o2 = dasar([{ frame: 0, fokus: [0, 0.5], easing: "masukKeluarCubic" }, { frame: 10, fokus: [1, 0.5] }]);
  const e = (f) => RF.kotakCrop(o2, f).fokus[0];
  dekat(e(5), 0.5, 1e-9, "easing simetris di tengah");
  tegas(e(2) < 0.2 && e(8) > 0.8, "easing masukKeluar lambat di ujung");
  // determinisme dan akses acak: urutan pemanggilan tidak berpengaruh
  const frames = [37, 3, 20, 20, 0, 39, 12];
  const maju = [...frames].sort((a, b) => a - b).map((f) => JSON.stringify(RF.kotakCrop(o, f)));
  const acak = frames.map((f) => JSON.stringify(RF.kotakCrop(o, f)));
  samaDengan(frames.map((f) => acak[frames.indexOf(f)]), frames.map((f) => maju[[...frames].sort((a, b) => a - b).indexOf(f)]), "akses acak = berurutan");
  samaDengan(RF.kotakCrop(o, 17), RF.kotakCrop(o, 17), "panggilan berulang");
});

tes("(c) gayaCrop: transform memetakan tepi crop ke tepi bingkai keluaran", () => {
  const o = templatData;
  for (const f of [0, 45, 90, 149]) {
    const c = RF.kotakCrop(o, f), g = RF.gayaCrop(o, f);
    const m = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)$/.exec(g.transform);
    tegas(m, `format transform: ${g.transform}`);
    const [tx, ty, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
    dekat(c.x * s + tx, 0, 0.01, `f${f}: tepi kiri crop`);
    dekat((c.x + c.w) * s + tx, o.keluar.lebar, 0.01, `f${f}: tepi kanan crop`);
    dekat(c.y * s + ty, 0, 0.01, `f${f}: tepi atas crop`);
    dekat((c.y + c.h) * s + ty, o.keluar.tinggi, 0.01, `f${f}: tepi bawah crop`);
  }
  samaDengan([RF.gayaCrop(o, 0).width, RF.gayaCrop(o, 0).transformOrigin], ["1920px", "0 0"], "ukuran elemen sumber dan titik asal");
});

tes("(d) validasi skema: galat jelas, kotakCrop melempar", () => {
  const buruk = [
    [dasar([]), /keyframe harus larik/],
    [dasar([{ frame: 0, fokus: [0.5, 0.5] }, { frame: 0, fokus: [0.5, 0.5] }]), /naik tegas/],
    [dasar([{ frame: 5, fokus: [0.5, 0.5] }, { frame: 2, fokus: [0.5, 0.5] }]), /naik tegas/],
    [dasar([{ frame: 0.5, fokus: [0.5, 0.5] }]), /bilangan bulat/],
    [dasar([{ frame: 0, fokus: [1.2, 0.5] }]), /fokus harus/],
    [dasar([{ frame: 0, fokus: [0.5] }]), /fokus harus/],
    [dasar([{ frame: 0, fokus: [0.5, 0.5], zoom: 0.9 }]), /zoom harus/],
    [dasar([{ frame: 0, fokus: [0.5, 0.5], zoom: 9 }]), /zoom harus/],
    [dasar([{ frame: 0, fokus: [0.5, 0.5], easing: "meledak" }]), /easing tidak dikenal/],
    [{ sumber: { lebar: 0, tinggi: 1080 }, keluar: KELUAR, keyframe: [{ frame: 0, fokus: [0.5, 0.5] }] }, /sumber harus/],
    [{ sumber: SUMBER, keyframe: [{ frame: 0, fokus: [0.5, 0.5] }] }, /keluar harus/],
    [null, /objek/],
  ];
  for (const [o, pola] of buruk) {
    const h = RF.periksaReframe(o);
    tegas(!h.ok && h.galat.some((g) => pola.test(g)), `periksaReframe harus menolak ${pola}: ${JSON.stringify(h.galat)}`);
    melempar(() => RF.kotakCrop(o, 0), /^reframe: /, `kotakCrop ${pola}`);
  }
  melempar(() => RF.kotakCrop(dasar([{ frame: 0, fokus: [0.5, 0.5] }]), NaN), /frame harus angka/, "frame NaN");
});

tes("(e) teks sumber: terpotong crop dilaporkan di frame pertama yang memotong", () => {
  // teks di x 700..1220 butuh crop selebar 607,5 yang mencakupnya: fokus 0.5 cukup, fokus 0.78 tidak
  const teks = { x: 700, y: 200, w: 520, h: 90 };
  const aman = RF.periksaReframe(dasar([{ frame: 0, fokus: [0.5, 0.5] }], { teksSumber: [{ ...teks, dari: 0, sampai: 100 }] }));
  tegas(aman.ok, `harus lolos: ${JSON.stringify(aman.galat)}`);
  const geser = RF.periksaReframe(dasar([
    { frame: 0, fokus: [0.5, 0.5] }, { frame: 100, fokus: [0.9, 0.5] },
  ], { teksSumber: [{ ...teks, dari: 0, sampai: 100, catatan: "judul" }] }));
  tegas(!geser.ok && /judul.*terpotong crop pada frame \d+/.test(geser.galat[0]), `harus gagal: ${JSON.stringify(geser.galat)}`);
  const f = Number(/frame (\d+)/.exec(geser.galat[0])[1]);
  tegas(RF.kotakCrop(dasar([{ frame: 0, fokus: [0.5, 0.5] }, { frame: 100, fokus: [0.9, 0.5] }]), f).x > 700 + 0.01, "frame yang dilaporkan memang memotong (tepi kiri teks)");
  const sebelum = RF.kotakCrop(dasar([{ frame: 0, fokus: [0.5, 0.5] }, { frame: 100, fokus: [0.9, 0.5] }]), f - 1);
  tegas(sebelum.x <= 700 + 0.02, "frame sebelumnya belum memotong (galat melaporkan yang pertama)");
  // hanya rentang dari..sampai yang diperiksa
  tegas(RF.periksaReframe(dasar([{ frame: 0, fokus: [0.5, 0.5] }, { frame: 100, fokus: [0.9, 0.5] }], { teksSumber: [{ ...teks, dari: 0, sampai: 5 }] })).ok, "rentang pendek lolos");
  // kotak di luar bingkai sumber atau skema salah
  for (const t of [{ x: 1900, y: 0, w: 100, h: 10 }, { x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10, h: 10, dari: 9, sampai: 3 }]) {
    tegas(!RF.periksaReframe(dasar([{ frame: 0, fokus: [0.5, 0.5] }], { teksSumber: [t] })).ok, `kotak buruk ${JSON.stringify(t)}`);
  }
  // peringatan: rasio sama
  tegas(RF.periksaReframe({ sumber: SUMBER, keluar: { lebar: 1280, tinggi: 720 }, keyframe: [{ frame: 0, fokus: [0.5, 0.5] }] }).peringatan.some((p) => /berasio sama/.test(p)), "peringatan rasio sama");
  tegas(RF.periksaReframe(dasar([{ frame: 0, fokus: [0.5, 0.5] }, { frame: 50, fokus: [0.5, 0.5] }]), { durasi: 40 }).peringatan.some((p) => /di luar durasi/.test(p)), "peringatan di luar durasi");
});

tes("(f) area aman 9:16: teks keluaran di dalam lolos, di zona antarmuka bawah gagal", () => {
  const aman = RT.areaAmanVertikal(1080, 1920);
  samaDengan(aman, { x: 65, y: 250, w: 895, h: 1190 }, "area aman 1080x1920 (sama dengan runtime.js)");
  tegas(RF.periksaAreaAman(templatData.teksKeluar, aman).ok, "teksKeluar templat di area aman");
  const h = RF.periksaAreaAman([{ x: 100, y: 300, w: 800, h: 100 }, { x: 100, y: 1500, w: 800, h: 100 }, { x: 0, y: 400, w: 500, h: 100 }, { x: 600, y: 400, w: 400, h: 100 }], aman);
  samaDengan(h, { ok: false, luar: [1, 2, 3] }, "tiga kotak di luar (bawah, kiri, kanan)");
  tegas(RF.periksaAreaAman([{ x: 65, y: 250, w: 895, h: 1190 }], aman).ok, "tepat pada batas lolos");
  melempar(() => RF.periksaAreaAman([{ x: 0, y: 0, w: 1, h: 1 }]), /aman wajib/, "tanpa aman");
  melempar(() => RF.periksaAreaAman([{ x: 0, y: 0, w: 0, h: 1 }], aman), /kotak\[0\]/, "kotak tak valid");
  // periksaBerkasReframe memakai area aman runtime pada keluar berkas
  const salah = { ...templatData, teksKeluar: [{ x: 100, y: 1600, w: 400, h: 100 }] };
  const hb = periksaBerkasReframe(salah, { durasi: 150 });
  tegas(!hb.ok && /teksKeluar\[0\] di luar area aman 9:16/.test(hb.galat[0]), `galat area aman: ${JSON.stringify(hb.galat)}`);
  tegas(!periksaBerkasReframe({ ...templatData, versi: 2 }).ok, "versi tak didukung ditolak");
  tegas(!periksaBerkasReframe({ ...templatData, teksKeluar: "x" }).ok, "teksKeluar bukan larik ditolak");
});

tes("(g) templat: reframe.json valid, reframe-data.js sama dengan reframe.json", () => {
  const h = periksaBerkasReframe(templatData, { durasi: 150 });
  tegas(h.ok, `templat valid: ${JSON.stringify(h.galat)}`);
  const sumber = readFileSync(join(templat, "reframe-data.js"), "utf8");
  const g = { window: {} };
  new Function("window", sumber)(g.window);
  samaDengan(g.window.REFRAME_DATA, templatData, "reframe-data.js basi: jalankan ulang penyalinan dari reframe.json");
  for (const b of ["# Aset templat reframe-contoh", "## Metadata", "## Changelog"]) tegas(readFileSync(join(templat, "ASET.md"), "utf8").includes(b), `ASET.md memuat ${b}`);
});

tes("(h) CLI periksa: kode keluar dan keluaran", async () => {
  const ok = await bun("periksa", join(templat, "reframe.json"), "--durasi", "150");
  tegas(ok.kode === 0 && /reframe valid/.test(ok.out), `periksa templat: ${ok.kode} ${ok.out}${ok.err}`);
  const js = await bun("periksa", join(templat, "reframe.json"), "--json");
  tegas(js.kode === 0 && JSON.parse(js.out).ok === true, "keluaran --json");
  writeFileSync(j("buruk.json"), JSON.stringify({ ...templatData, keyframe: [{ frame: 0, fokus: [2, 0.5] }] }));
  const buruk = await bun("periksa", j("buruk.json"));
  tegas(buruk.kode === 2 && /fokus harus/.test(buruk.err) && /TIDAK valid/.test(buruk.out), `berkas buruk: ${buruk.kode} ${buruk.err}`);
  writeFileSync(j("bukan.json"), "{");
  tegas((await bun("periksa", j("bukan.json"))).kode === 2, "bukan JSON = 2");
  tegas((await bun("periksa", j("tidak-ada.json"))).kode === 2, "berkas tidak ada = 2");
  tegas((await bun("periksa", "https://contoh.invalid/r.json")).kode === 2, "URL ditolak");
  tegas((await bun("periksa", join(templat, "reframe.json"), "--durasi", "0")).kode === 2, "--durasi 0 = 2");
  tegas((await bun("sulap", join(templat, "reframe.json"))).kode === 2, "subperintah tak dikenal = 2");
  tegas((await bun("periksa")).kode === 2, "tanpa berkas = 2");
  tegas((await bun("saran", join(templat, "reframe.json"), "--keluar", "1080")).kode === 2, "--keluar salah = 2");
  tegas((await bun("saran", join(templat, "reframe.json"), "--fps", "0")).kode === 2, "--fps 0 = 2");
  const bantuan = await bun("--help");
  tegas(bantuan.kode === 0 && /Pemakaian/.test(bantuan.out), "--help");
});

tes("(i) saran: fungsi murni haluskan dan sederhanakan", () => {
  const P = PARAMETER_SARAN;
  const lonjakan = [[0.5, 0.5], [0.5, 0.5], [0.9, 0.5], [0.5, 0.5], [0.5, 0.5]];
  samaDengan(haluskan(lonjakan).map((p) => p[0]), [0.5, 0.5, 0.5, 0.5, 0.5], "median membuang lonjakan satu sampel");
  samaDengan(sederhanakan([], 30), [], "kosong");
  const diam = Array.from({ length: 20 }, () => [0.5, 0.5]);
  samaDengan(sederhanakan(diam, 30), [{ frame: 0, fokus: [0.5, 0.5], easing: "linear" }], "diam = satu keyframe");
  const geser = [...Array.from({ length: 10 }, () => [0.3, 0.5]), ...Array.from({ length: 10 }, () => [0.7, 0.5])];
  const kf = sederhanakan(geser, 30);
  const sampelKeFrame = (i) => Math.round((i / P.sampelPerDetik) * 30);
  samaDengan(kf.map((k) => [k.frame, k.fokus[0]]), [[0, 0.3], [sampelKeFrame(9), 0.3], [sampelKeFrame(10), 0.7]], "loncatan: sudut sebelum, lalu tujuan");
  for (let i = 1; i < kf.length; i++) tegas(kf[i].frame > kf[i - 1].frame, "frame naik tegas");
  tegas(RF.periksaReframe(dasar(kf)).ok, "keluaran sederhanakan lolos skema");
});

tes("(j) saran dari video sintetis: kotak bergerak, kotak diam, determinisme, fail-closed tanpa ffmpeg", async () => {
  const bergerak = j("gerak.mp4"), diam = j("diam.mp4");
  const buat = (berkas, x) => ffmpeg(
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=10:d=4", "-f", "lavfi", "-i", "color=c=white:s=60x60:r=10:d=4",
    "-filter_complex", `[0][1]overlay=x='${x}':y=150`, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "12", berkas,
  );
  await buat(bergerak, "t*120");
  await buat(diam, "300");
  const g = await sarankanReframe(bergerak, { fps: 30 });
  samaDengan(g.sumber, { lebar: 640, tinggi: 360 }, "ukuran sumber dari ffprobe");
  tegas(RF.periksaReframe(g).ok, `hasil lolos skema: ${JSON.stringify(RF.periksaReframe(g).galat)}`);
  const xs = g.keyframe.map((k) => k.fokus[0]);
  tegas(xs[0] < 0.3, `fokus awal di kiri: ${xs[0]}`);
  tegas(xs[xs.length - 1] > 0.6, `fokus akhir di kanan: ${xs[xs.length - 1]}`);
  tegas(g.keyframe.length >= 3, `kotak bergerak menghasilkan beberapa keyframe: ${g.keyframe.length}`);
  for (let i = 1; i < xs.length; i++) tegas(xs[i] >= xs[i - 1] - 0.05, "fokus menuju kanan (tanpa mundur berarti)");
  tegas(g.peringatan.some((p) => /wajib ditinjau manusia/.test(p)), "peringatan tinjau manusia");
  samaDengan(g.saran.jumlahSampel, 20, "20 sampel (4 detik x 5/detik)");
  samaDengan(await sarankanReframe(bergerak, { fps: 30 }), g, "determinisme dua jalan");
  const d = await sarankanReframe(diam, { fps: 30 });
  samaDengan(d.keyframe.length, 1, "kotak diam = satu keyframe");
  dekat(d.keyframe[0].fokus[0], 330 / 640, 0.08, "fokus di kotak diam");
  // CLI menulis berkas dan melapor
  const keluar = await bun("saran", bergerak, "--fps", "30", "--out", j("hasil", "r.json"));
  tegas(keluar.kode === 0 && existsSync(j("hasil", "r.json")) && /keyframe saran/.test(keluar.out) && /wajib ditinjau manusia/.test(keluar.err), `CLI saran: ${keluar.kode} ${keluar.out}${keluar.err}`);
  samaDengan(JSON.parse(readFileSync(j("hasil", "r.json"), "utf8")), g, "berkas CLI = fungsi");
  // fail-closed: PATH tanpa ffmpeg/ffprobe -> kode 1, pesan jelas, tidak ada berkas keluaran
  mkdirSync(j("kosong"), { recursive: true });
  const tanpa = await jalankan([process.execPath, cli, "saran", bergerak, "--out", j("hasil", "tanpa.json")], { PATH: j("kosong"), HOME: tmp });
  tegas(tanpa.kode === 1 && /ffprobe tidak dapat dijalankan|ffprobe gagal/.test(tanpa.err), `fail-closed: ${tanpa.kode} ${tanpa.err}`);
  tegas(!existsSync(j("hasil", "tanpa.json")), "tidak menulis keluaran saat alat tidak ada");
  // berkas bukan video
  writeFileSync(j("teks.txt"), "bukan video");
  const bukan = await bun("saran", j("teks.txt"), "--out", j("hasil", "x.json"));
  tegas(bukan.kode === 1 && !existsSync(j("hasil", "x.json")), `bukan video: ${bukan.kode} ${bukan.err}`);
});

tes("(k) templat di Chromium: subjek tetap di tengah bingkai 9:16, papan sumber utuh, teks di area aman", async () => {
  const { chromium } = await import("playwright-core");
  const { cariBrowser } = await import("./browser.js");
  const browser = await chromium.launch({ executablePath: cariBrowser(), headless: true, args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const galat = [];
    page.on("pageerror", (e) => galat.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") galat.push(m.text()); });
    await page.goto(pathToFileURL(join(templat, "index.html")).href);
    const info = await page.evaluate(() => ({ w: window.video.width, h: window.video.height, fps: window.video.fps, n: window.video.durationInFrames }));
    samaDengan(info, { w: 1080, h: 1920, fps: 30, n: 150 }, "properti video");
    const aman = RT.areaAmanVertikal(1080, 1920);
    const ukur = (frame) => page.evaluate(async (f) => {
      await window.video.renderFrame(f);
      const rect = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, o: getComputedStyle(document.getElementById(id)).opacity }; };
      return { subjek: rect("subjek"), papan: rect("papan"), judul: rect("judul"), ket: rect("ket") };
    }, frame);
    const dalam = (b, a, eps = 0.6) => b.x >= a.x - eps && b.y >= a.y - eps && b.x + b.w <= a.x + a.w + eps && b.y + b.h <= a.y + a.h + eps;
    for (const f of [0, 30, 60, 75, 90, 120, 149]) {
      const m = await ukur(f);
      // subjek (lingkaran 200 px dikali skala) berpusat di x ~ 540 pada bingkai keluaran
      dekat(m.subjek.x + m.subjek.w / 2, 540, 12, `frame ${f}: subjek di tengah horizontal`);
      tegas(dalam(m.subjek, { x: 0, y: 0, w: 1080, h: 1920 }), `frame ${f}: subjek terlihat penuh ${JSON.stringify(m.subjek)}`);
      tegas(dalam(m.judul, aman) && dalam(m.ket, aman), `frame ${f}: teks di area aman`);
      if (f <= 60) tegas(dalam(m.papan, { x: 0, y: 0, w: 1080, h: 1920 }), `frame ${f}: papan sumber utuh di bingkai ${JSON.stringify(m.papan)}`);
    }
    // determinisme: frame yang sama dirender dua kali (urutan acak) identik
    const a1 = await ukur(75);
    await ukur(10);
    const a2 = await ukur(75);
    samaDengan(a1, a2, "frame 75 identik setelah frame lain");
    samaDengan(galat, [], "galat halaman");
    await page.close();
  } finally {
    await browser.close();
  }
});

// ----------------------------------------------------------------- jalankan
const t0 = Date.now();
let gagal = 0;
try {
  for (const [nama, fn] of uji) {
    const t = Date.now();
    try {
      await fn();
      console.log(`LOLOS  ${nama} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    } catch (e) {
      gagal++;
      console.log(`GAGAL  ${nama}: ${e.message}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${uji.length - gagal}/${uji.length} lolos, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(gagal ? 1 : 0);
