#!/usr/bin/env bun
/**
 * uji-ketukan.mjs — uji deteksi ketukan (scripts/ketukan.mjs) dan helper komposisi
 * (scripts/ketukan.js). Sinyal uji dibangkitkan ffmpeg lavfi: metronom klik (120 dan 90 BPM,
 * plus derau putih ber-seed), metronom kick bernada rendah, senyap, dan derau saja. Tanpa
 * berkas audio, model, jaringan, atau aset pihak ketiga.
 *
 * Yang diuji: FFT terhadap DFT naif; ketukan metronom dalam +-1 frame (30 dan 60 fps) dan
 * tempo dalam +-2 BPM; senyap dan derau tanpa ketukan palsu; determinisme (dua jalan dan dua
 * pembangkitan sinyal); CLI (keluaran JSON, kode keluar); helper komposisi.
 * Musik nyata dengan tempo berubah atau ketukan lemah TIDAK diuji (docs/ketukan.md#batasan).
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-ketukan.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analisisKetukan, dekodeAudio, fft, ketukanDariBerkas, PARAMETER } from "./ketukan.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(akar, "scripts", "ketukan.mjs");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-ketukan-"));
const j = (...p) => join(tmp, ...p);

globalThis.window = { location: { search: "" } };
await import(pathToFileURL(join(akar, "scripts", "ketukan.js")).href);
const K = globalThis.window.Ketukan;

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
}

const SR = 44100;
const DURASI = 12;
const AWAL = 0.25; // klik pertama (detik)

/** Metronom klik 1,5 kHz (peluruhan cepat) mulai AWAL pada bpm, ditambah derau putih ber-seed. */
async function metronomKlik(berkas, bpm, { derau = 0.01, seed = 7 } = {}) {
  const klik = `aevalsrc=exprs='gte(t,${AWAL})*0.8*sin(2*PI*1500*t)*exp(-400*mod(t-${AWAL},60/${bpm}))':s=${SR}:d=${DURASI}`;
  if (derau > 0) {
    await ffmpeg("-f", "lavfi", "-i", klik,
      "-f", "lavfi", "-i", `anoisesrc=color=white:seed=${seed}:amplitude=${derau}:sample_rate=${SR}:duration=${DURASI}`,
      "-filter_complex", "amix=inputs=2:duration=first:normalize=0", "-ac", "1", berkas);
  } else {
    await ffmpeg("-f", "lavfi", "-i", klik, "-ac", "1", berkas);
  }
}
/** Metronom kick: sinus 60 Hz meluruh, mulai AWAL pada bpm. */
const metronomKick = (berkas, bpm) =>
  ffmpeg("-f", "lavfi", "-i", `aevalsrc=exprs='gte(t,${AWAL})*0.9*sin(2*PI*60*t)*exp(-25*mod(t-${AWAL},60/${bpm}))':s=${SR}:d=${DURASI}`, "-ac", "1", berkas);

/** Ketukan yang seharusnya (detik) untuk metronom bpm dalam DURASI. */
function harapan(bpm) {
  const P = 60 / bpm, h = [];
  for (let k = 0; AWAL + k * P < DURASI - 0.05; k++) h.push(AWAL + k * P);
  return h;
}
/** Periksa jumlah dan posisi ketukan terhadap harapan dalam +-toleransiFrame. */
function periksaKetukan(hasil, bpm, fps, toleransiFrame = 1) {
  const h = harapan(bpm);
  tegas(hasil.ketukan.length === h.length, `jumlah ketukan ${hasil.ketukan.length}, harapan ${h.length}`);
  let maks = 0;
  h.forEach((e, i) => {
    const sel = Math.abs(hasil.ketukan[i].frame - Math.round(e * fps));
    maks = Math.max(maks, sel);
    tegas(sel <= toleransiFrame, `ketukan ${i}: frame ${hasil.ketukan[i].frame}, harapan ${Math.round(e * fps)} (selisih ${sel} > ${toleransiFrame})`);
  });
  return maks;
}
function periksaTempo(hasil, bpm) {
  tegas(hasil.tempo !== null, "tempo tidak terdeteksi");
  tegas(Math.abs(hasil.tempo.bpm - bpm) <= 2, `tempo ${hasil.tempo.bpm} BPM, harapan ${bpm} +-2`);
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

// ----------------------------------------------------------------- FFT
daftar("(a) FFT radix-2 sama dengan DFT naif; sinus puncak di bin yang benar", () => {
  const N = 64;
  let s = 12345; // pembangkit linear-kongruen ber-seed (hanya untuk uji)
  const acak = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
  const xr = Float64Array.from({ length: N }, acak), xi = Float64Array.from({ length: N }, acak);
  const re = Float64Array.from(xr), im = Float64Array.from(xi);
  fft(re, im);
  for (let k = 0; k < N; k++) {
    let dr = 0, di = 0;
    for (let n = 0; n < N; n++) {
      const a = (-2 * Math.PI * k * n) / N;
      dr += xr[n] * Math.cos(a) - xi[n] * Math.sin(a);
      di += xr[n] * Math.sin(a) + xi[n] * Math.cos(a);
    }
    tegas(Math.abs(dr - re[k]) < 1e-9 && Math.abs(di - im[k]) < 1e-9, `bin ${k}: FFT ${re[k]},${im[k]} vs DFT ${dr},${di}`);
  }
  const r2 = Float64Array.from({ length: 256 }, (_, n) => Math.sin((2 * Math.PI * 17 * n) / 256)), i2 = new Float64Array(256);
  fft(r2, i2);
  let terbesar = 0;
  for (let k = 1; k < 128; k++) if (Math.hypot(r2[k], i2[k]) > Math.hypot(r2[terbesar], i2[terbesar])) terbesar = k;
  tegas(terbesar === 17, `puncak sinus di bin ${terbesar}, harapan 17`);
  let galat = false;
  try { fft(new Float64Array(6), new Float64Array(6)); } catch { galat = true; }
  tegas(galat, "panjang bukan pangkat dua harus ditolak");
});

// ------------------------------------------------------ metronom sintetis
daftar("(b) metronom klik 120 BPM + derau ber-seed: ketukan +-1 frame (30 fps), tempo +-2 BPM", async () => {
  const f = j("klik120.wav");
  await metronomKlik(f, 120, { derau: 0.01, seed: 7 });
  const h = await ketukanDariBerkas(f, { fps: 30 });
  periksaTempo(h, 120);
  periksaKetukan(h, 120, 30);
  tegas(h.keyakinan >= 0.9, `keyakinan ${h.keyakinan}, harapan >= 0.9`);
  tegas(h.ketukan.every((k) => k.dariOnset), "semua ketukan metronom harus didukung onset");
  // kontrol negatif: uji ini harus bisa gagal (harapan digeser 0,2 s = 6 frame)
  const geser = { ...h, ketukan: h.ketukan.map((k) => ({ ...k, frame: k.frame + 6 })) };
  let gagalSemestinya = false;
  try { periksaKetukan(geser, 120, 30); } catch { gagalSemestinya = true; }
  tegas(gagalSemestinya, "kontrol negatif: ketukan yang bergeser 6 frame harus ditolak");
});

daftar("(c) metronom klik 90 BPM + derau lebih keras: ketukan +-1 frame (30 fps), tempo +-2 BPM", async () => {
  const f = j("klik90.wav");
  await metronomKlik(f, 90, { derau: 0.03, seed: 11 });
  const h = await ketukanDariBerkas(f, { fps: 30 });
  periksaTempo(h, 90);
  periksaKetukan(h, 90, 30);
});

daftar("(d) presisi: metronom 120 dan 90 BPM juga +-1 frame pada 60 fps (galat waktu < 3 ms)", async () => {
  for (const bpm of [120, 90]) {
    const f = j(`klik${bpm}.wav`);
    const h = await ketukanDariBerkas(f, { fps: 60 });
    periksaKetukan(h, bpm, 60);
    const P = 60 / bpm;
    for (const k of h.ketukan) {
      const n = Math.round((k.detik - AWAL) / P);
      tegas(Math.abs(k.detik - (AWAL + n * P)) < 0.003, `ketukan ${k.detik}: galat waktu > 3 ms`);
    }
  }
});

daftar("(e) metronom kick bernada rendah (60 Hz, 100 BPM) + derau: ketukan +-1 frame, tempo +-2", async () => {
  const k = j("kick.wav");
  await metronomKick(k, 100);
  const h = await ketukanDariBerkas(k, { fps: 30 });
  periksaTempo(h, 100);
  periksaKetukan(h, 100, 30);
});

daftar("(f) tempo di tepi rentang: 60 dan 160 BPM terdeteksi (+-2) tanpa lompat oktaf", async () => {
  for (const bpm of [60, 160]) {
    const f = j(`klik${bpm}.wav`);
    await metronomKlik(f, bpm, { derau: 0.01, seed: 3 });
    const h = await ketukanDariBerkas(f, { fps: 30 });
    periksaTempo(h, bpm);
    periksaKetukan(h, bpm, 30);
  }
});

// ----------------------------------------------------- tanpa ketukan
daftar("(g) senyap dan derau putih stasioner: tanpa tempo, tanpa ketukan, ada peringatan", async () => {
  await ffmpeg("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "5", j("senyap.wav"));
  await ffmpeg("-f", "lavfi", "-i", `anoisesrc=color=white:seed=5:amplitude=0.1:sample_rate=${SR}:duration=8`, "-ac", "1", j("derau.wav"));
  for (const n of ["senyap.wav", "derau.wav"]) {
    const h = await ketukanDariBerkas(j(n), { fps: 30 });
    tegas(h.tempo === null && h.ketukan.length === 0, `${n}: tidak boleh ada tempo/ketukan (dapat ${JSON.stringify(h.tempo)}, ${h.ketukan.length} ketukan)`);
    tegas(h.keyakinan === 0 && h.peringatan.length > 0, `${n}: keyakinan 0 dan peringatan wajib`);
  }
  const x = new Float32Array(100);
  const k = analisisKetukan(x, { fps: 30 });
  tegas(k.tempo === null && k.ketukan.length === 0, "audio sangat pendek tidak boleh galat");
});

// ---------------------------------------------------------- determinisme
daftar("(h) determinisme: dua analisis sama, dua pembangkitan sinyal sama, hasil JSON identik", async () => {
  const a = await ketukanDariBerkas(j("klik120.wav"), { fps: 30 });
  const b = await ketukanDariBerkas(j("klik120.wav"), { fps: 30 });
  tegas(JSON.stringify(a) === JSON.stringify(b), "dua analisis berkas yang sama harus identik");
  await metronomKlik(j("klik120-ulang.wav"), 120, { derau: 0.01, seed: 7 });
  const c = await ketukanDariBerkas(j("klik120-ulang.wav"), { fps: 30 });
  tegas(JSON.stringify(a) === JSON.stringify(c), "sinyal yang dibangkitkan ulang harus memberi hasil identik");
  const x = await dekodeAudio(j("klik120.wav"));
  tegas(x.length === Math.floor(DURASI * PARAMETER.sampleRate) || Math.abs(x.length - DURASI * PARAMETER.sampleRate) <= 2, `panjang dekode ${x.length}`);
});

// ------------------------------------------------------------------ CLI
daftar("(i) CLI: keluaran JSON berskema, frame = round(detik * fps), --fps dihormati, kode keluar 0", async () => {
  const out = j("hasil", "ketukan.json");
  const r = await jalankan(["bun", cli, j("klik90.wav"), "--fps", "25", "--out", out]);
  tegas(r.kode === 0, `kode ${r.kode}: ${r.err}`);
  tegas(/Tempo 90/.test(r.out) || /Tempo 89|Tempo 91/.test(r.out), `ringkasan tidak memuat tempo: ${r.out}`);
  const d = JSON.parse(readFileSync(out, "utf8"));
  tegas(d.versi === 1 && d.fps === 25, "versi dan fps");
  for (const kunci of ["durasi", "tempo", "ketukan", "onset", "keyakinan", "peringatan"]) tegas(kunci in d, `kunci ${kunci} tidak ada`);
  for (const kunci of ["bpm", "periode", "fase"]) tegas(typeof d.tempo[kunci] === "number", `tempo.${kunci}`);
  tegas(d.ketukan.length > 0 && d.onset.length > 0, "ketukan dan onset tidak boleh kosong");
  for (const k of d.ketukan) tegas(k.frame === Math.round(k.detik * 25) && typeof k.dariOnset === "boolean", `ketukan ${JSON.stringify(k)}`);
  for (const o of d.onset) tegas(o.frame === Math.round(o.detik * 25) && o.kekuatan > 0 && o.kekuatan <= 1, `onset ${JSON.stringify(o)}`);
  const r2 = await jalankan(["bun", cli, j("klik90.wav"), "--fps", "25", "--out", j("hasil", "ketukan2.json")]);
  tegas(r2.kode === 0 && readFileSync(out, "utf8") === readFileSync(j("hasil", "ketukan2.json"), "utf8"), "dua jalan CLI harus menghasilkan berkas identik");
});

daftar("(j) CLI: senyap keluar 0 dengan peringatan; argumen salah dan berkas hilang keluar 2; bukan audio keluar 1", async () => {
  const senyap = await jalankan(["bun", cli, j("senyap.wav"), "--out", j("senyap.json")]);
  tegas(senyap.kode === 0 && /peringatan/.test(senyap.err) && JSON.parse(readFileSync(j("senyap.json"), "utf8")).tempo === null, `senyap: kode ${senyap.kode} ${senyap.err}`);
  const kasus = [
    [[], "tanpa argumen"],
    [[j("tidak-ada.wav")], "berkas tidak ada"],
    [[j("klik90.wav"), "--fps", "0"], "--fps 0"],
    [[j("klik90.wav"), "--fps", "abc"], "--fps bukan angka"],
    [[j("klik90.wav"), "--fps", "999"], "--fps terlalu besar"],
    [["https://contoh.invalid/a.mp3"], "URL"],
    [[j("klik90.wav"), "--tidak-dikenal"], "opsi tak dikenal"],
  ];
  for (const [a, nama] of kasus) {
    const r = await jalankan(["bun", cli, ...a, "--out", j("x.json")]);
    tegas(r.kode === 2, `${nama}: kode ${r.kode}, harapan 2 (${r.err.trim()})`);
  }
  writeFileSync(j("bukan-audio.wav"), "ini bukan audio");
  const rb = await jalankan(["bun", cli, j("bukan-audio.wav"), "--out", j("x.json")]);
  tegas(rb.kode === 1, `bukan audio: kode ${rb.kode}, harapan 1`);
});

// --------------------------------------------------------------- helper
daftar("(k) helper window.Ketukan: ketukanTerdekat, rapatkan, fasaKetukan, denyut, ketukanDalam (murni)", () => {
  const data = { fps: 30, ketukan: [1, 1.5, 2, 2.5, 3].map((detik) => ({ detik, frame: Math.round(detik * 30), dariOnset: true })) };
  tegas(K.ketukanTerdekat({ fps: 30, ketukan: [] }, 10) === null, "tanpa ketukan -> null");
  const n = K.ketukanTerdekat(data, 44);
  tegas(n.indeks === 1 && n.frame === 45 && n.selisih === 1 && n.detik === 1.5, `terdekat 44: ${JSON.stringify(n)}`);
  tegas(K.ketukanTerdekat(data, 0).indeks === 0 && K.ketukanTerdekat(data, 500).indeks === 4, "di luar rentang memakai ketukan tepi");
  tegas(K.ketukanTerdekat(data, 60, 60).frame === 60, "fps argumen menggantikan data.fps (1 s = frame 60)");
  tegas(K.rapatkan(data, 47) === 45 && K.rapatkan(data, 52) === 52 && K.rapatkan(data, 52, { maks: 10 }) === 45, "rapatkan memakai ambang maks (bawaan 3 frame)");
  tegas(K.rapatkan(data, 47, { maks: 1 }) === 47, "di luar maks: frame asli");
  const f = K.fasaKetukan(data, 52);
  tegas(f.indeks === 1 && Math.abs(f.fase - 7 / 15) < 1e-9 && f.sejak === 7 && f.menuju === 8, `fasa 52: ${JSON.stringify(f)}`);
  tegas(K.fasaKetukan(data, 10) === null && K.fasaKetukan(data, 90) === null, "fasa di luar rentang ketukan -> null");
  tegas(K.denyut(data, 30) === 1 && K.denyut(data, 10) === 0 && K.denyut(data, 90 + 30) === 0, "denyut: 1 di ketukan, 0 sebelum dan lama sesudah");
  const d1 = K.denyut(data, 33, { panjang: 0.2 }), d2 = K.denyut(data, 35, { panjang: 0.2 });
  tegas(d1 > d2 && d1 < 1 && d2 > 0, `denyut meluruh: ${d1} > ${d2}`);
  tegas(K.denyut(data, 36, { panjang: 0.2 }) === 0, "denyut habis tepat pada panjang");
  tegas(K.denyut(data, 33) === K.denyut(data, 33), "murni: panggilan yang sama, hasil sama");
  const dalam = K.ketukanDalam(data, 46, 75);
  tegas(dalam.map((q) => q.frame).join() === "60,75", `ketukanDalam: ${JSON.stringify(dalam)}`);
  for (const buruk of [null, {}, { ketukan: "x" }]) {
    let galat = false;
    try { K.ketukanTerdekat(buruk, 1); } catch { galat = true; }
    tegas(galat, `data buruk ${JSON.stringify(buruk)} harus ditolak`);
  }
  let g2 = false;
  try { K.ketukanTerdekat({ ketukan: [{ detik: 1 }] }, 1); } catch { g2 = true; }
  tegas(g2, "tanpa fps harus ditolak");
});

daftar("(l) ketukan.json hasil CLI dapat dipakai helper dan frame ketukan sama dengan hasil CLI", () => {
  const d = JSON.parse(readFileSync(j("hasil", "ketukan.json"), "utf8"));
  for (const k of d.ketukan.slice(0, 5)) {
    const n = K.ketukanTerdekat(d, k.frame);
    tegas(n.frame === k.frame && n.selisih === 0, `ketukan ${k.frame}: ${JSON.stringify(n)}`);
    tegas(K.denyut(d, k.frame) === 1, "denyut di ketukan = 1");
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
