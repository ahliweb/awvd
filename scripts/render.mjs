#!/usr/bin/env bun
/**
 * video-terprogram / render.mjs — render komposisi web menjadi MP4 (atau satu PNG).
 *
 *   bun render.mjs <komposisi.html|URL> --out hasil.mp4
 *        [--props '{"judul":"..."}' | --props-file p.json]
 *        [--dari N] [--sampai M] [--skala 1] [--crf 18]
 *        [--audio musik.mp3] [--kenyaringan web|siaran|mati]
 *        [--subtitle teks.vtt|.srt] [--bahasa ind]
 *        [--still N] [--browser /path/chrome] [--izinkan-jaringan]
 *
 * Alur: Chromium headless (playwright-core, tanpa unduh browser) -> per frame
 * window.video.renderFrame(n) -> screenshot PNG -> pipe ke stdin ffmpeg.
 * Tidak ada file sementara per frame.
 *
 * Jaringan: semua permintaan selain file:, data:, about:, dan blob: (HTTP, HTTPS,
 * WebSocket, sendBeacon, ...) diblokir dan dicatat; render gagal dengan kode keluar 3
 * beserta daftar URL-nya, supaya hasil tidak bergantung pada sumber luar. Komposisi
 * yang dibuka lewat http(s) hanya boleh meminta asalnya sendiri. --izinkan-jaringan
 * mematikan pemblokiran (hanya untuk pratinjau, bukan rilis).
 * Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { cariBrowser } from "./browser.js";

const BATAS_WAKTU_VIDEO_MS = 15000;

function gagal(pesan, kode = 1) {
  console.error(`render.mjs: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun render.mjs <komposisi.html|URL> --out hasil.mp4 [opsi]
Opsi: --props JSON | --props-file F, --dari N, --sampai M, --skala X, --crf N,
      --audio F, --kenyaringan web|siaran|mati, --subtitle F(.vtt|.srt),
      --bahasa KODE, --still N, --browser PATH, --izinkan-jaringan
Jaringan diblokir secara bawaan (kode keluar 3 bila ada permintaan non-lokal).`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      props: { type: "string" },
      "props-file": { type: "string" },
      dari: { type: "string" },
      sampai: { type: "string" },
      skala: { type: "string", default: "1" },
      crf: { type: "string", default: "18" },
      audio: { type: "string" },
      kenyaringan: { type: "string" },
      subtitle: { type: "string" },
      bahasa: { type: "string", default: "ind" },
      still: { type: "string" },
      browser: { type: "string" },
      "izinkan-jaringan": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  gagal(`${e.message}\n${PETUNJUK}`, 2);
}
const { values: o, positionals } = args;
if (o.help) {
  console.log(PETUNJUK);
  process.exit(0);
}
if (positionals.length !== 1) gagal(`harus tepat satu komposisi.\n${PETUNJUK}`, 2);
if (!o.out) gagal(`--out wajib.\n${PETUNJUK}`, 2);
// folder keluaran dibuat bila belum ada (ffmpeg tidak membuatnya sendiri)
try {
  mkdirSync(dirname(resolve(o.out)), { recursive: true });
} catch (e) {
  gagal(`tidak bisa membuat folder keluaran untuk ${o.out}: ${e.message}`, 2);
}

function angka(nama, nilai, { min = -Infinity, bulat = false } = {}) {
  if (nilai === undefined) return undefined;
  const n = Number(nilai);
  if (!Number.isFinite(n) || n < min || (bulat && !Number.isInteger(n))) {
    gagal(`--${nama} tidak valid: "${nilai}"`, 2);
  }
  return n;
}
const skala = angka("skala", o.skala, { min: 0.1 });
// Skala < 1 TIDAK ditangkap Chromium pada ukuran kecil: clip.scale < 1 menghasilkan raster yang
// berbeda +-1 pada batas tile secara acak antar jalankan (#26). Tangkap pada skala 1 (deterministik)
// lalu perkecil dengan ffmpeg (lanczos). Skala >= 1 tetap lewat clip.scale (raster tajam).
const skalaRaster = Math.max(skala, 1);
const crf = angka("crf", o.crf, { min: 0, bulat: true });
if (crf > 51) gagal("--crf harus 0..51", 2);
const dariOpt = angka("dari", o.dari, { min: 0, bulat: true });
const sampaiOpt = angka("sampai", o.sampai, { min: 0, bulat: true });
const stillOpt = angka("still", o.still, { min: 0, bulat: true });

if (o.props && o["props-file"]) gagal("pakai salah satu: --props atau --props-file", 2);
let props = {};
try {
  if (o.props) props = JSON.parse(o.props);
  else if (o["props-file"]) props = JSON.parse(readFileSync(o["props-file"], "utf8"));
} catch (e) {
  gagal(`props bukan JSON valid: ${e.message}`, 2);
}
if (props === null || typeof props !== "object" || Array.isArray(props)) {
  gagal("props harus objek JSON", 2);
}
// target kenyaringan: web = AES TD1004/TD1008 (streaming), siaran = EBU R 128
const TARGET_KENYARINGAN = {
  web: { I: -16, TP: -1.5, LRA: 11, label: "web, -16 LUFS" },
  siaran: { I: -23, TP: -1, LRA: 11, label: "siaran, -23 LUFS" },
};
if (o.kenyaringan !== undefined && o.kenyaringan !== "mati" && !TARGET_KENYARINGAN[o.kenyaringan]) {
  gagal(`--kenyaringan tidak valid: "${o.kenyaringan}" (pilih web, siaran, atau mati)`, 2);
}
const targetKenyaringan = o.audio ? TARGET_KENYARINGAN[o.kenyaringan ?? "web"] : undefined;
if (o.kenyaringan && !o.audio) console.error("peringatan: --kenyaringan diabaikan tanpa --audio");
for (const [nama, f] of [["audio", o.audio], ["subtitle", o.subtitle]]) {
  if (f && !existsSync(f)) gagal(`--${nama}: file tidak ditemukan: ${f}`, 2);
}

// ---------------------------------------------------------------- URL & browser
function urlKomposisi(arg) {
  if (/^https?:\/\//i.test(arg) || /^file:\/\//i.test(arg)) return arg;
  const p = resolve(arg);
  if (!existsSync(p)) gagal(`komposisi tidak ditemukan: ${arg}`, 2);
  return pathToFileURL(p).href;
}

// ---------------------------------------------------------------------- ffmpeg
const dapatAngka = (v) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined);

function filterLoudnorm(t, ukur) {
  let f = `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}`;
  if (ukur) {
    f += `:measured_I=${ukur.input_i}:measured_TP=${ukur.input_tp}:measured_LRA=${ukur.input_lra}` +
      `:measured_thresh=${ukur.input_thresh}:offset=${ukur.target_offset}:linear=true`;
  }
  return f;
}

// Pass 1 loudnorm: ukur segmen audio yang sama dengan yang masuk ke video
// (offset --dari, dipotong sepanjang video). Mengembalikan objek ukuran atau null.
async function ukurPass1(t, { offsetDetik, durasiDetik }) {
  const p = Bun.spawn([
    "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info",
    "-ss", offsetDetik, "-t", durasiDetik.toFixed(6), "-i", o.audio, "-vn",
    "-af", `${filterLoudnorm(t)}:print_format=json`, "-f", "null", "-",
  ], { stdout: "ignore", stderr: "pipe" });
  const [err, kode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`ffmpeg pengukuran kenyaringan (pass 1) gagal (exit ${kode}):\n${err.trim()}`);
  const m = err.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) throw new Error("keluaran loudnorm pass 1 tidak memuat JSON pengukuran");
  const j = JSON.parse(m[0]);
  for (const k of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    if (dapatAngka(j[k]) === undefined) return null; // senyap total (-inf) atau tak terukur
  }
  return j;
}

// Ukur hasil akhir (EBU R 128, true peak). Hanya laporan.
async function ukurAkhir(file) {
  const p = Bun.spawn([
    "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info", "-i", file, "-vn",
    "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-",
  ], { stdout: "ignore", stderr: "pipe" });
  const [err, kode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`ffmpeg ebur128 gagal (exit ${kode})`);
  const ringkas = err.slice(err.lastIndexOf("Summary:"));
  const I = ringkas.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  const TP = ringkas.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  if (!I || !TP) throw new Error("ringkasan ebur128 tidak terbaca");
  const angka = (t) => (t === "-inf" ? -Infinity : Number(t));
  return { I: angka(I[1]), TP: angka(TP[1]) };
}

// Filter perkecil deterministik (swscale lanczos, pembulatan akurat) untuk skala < 1.
const filterPerkecil = (w, h) => `scale=${w}:${h}:flags=lanczos+accurate_rnd+full_chroma_int`;

function bangunFfmpeg({ fps, dari, w, h, filterKenyaringan }) {
  const a = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"];
  const offsetDetik = (dari / fps).toFixed(6);
  let idx = 1;
  let idxAudio = -1;
  let idxSub = -1;
  if (o.audio) {
    // audio disejajarkan dengan frame awal (--dari)
    a.push("-ss", offsetDetik, "-i", o.audio);
    idxAudio = idx++;
  }
  if (o.subtitle) {
    a.push("-ss", offsetDetik, "-i", o.subtitle);
    idxSub = idx++;
  }
  a.push("-map", "0:v");
  if (idxAudio >= 0) a.push("-map", `${idxAudio}:a:0`);
  if (idxSub >= 0) a.push("-map", `${idxSub}:s:0`);
  // Crop dulu: dimensi ganjil dipotong 1 px ke genap (yuv420p mewajibkan genap).
  // Lalu RGB penuh (PNG sRGB dari browser) -> YUV BT.709 rentang TV, eksplisit.
  // Skala < 1: perkecil dari tangkapan skala 1 ke w x h (RGB, sebelum konversi warna).
  const perkecil = skala < 1 ? `${filterPerkecil(w, h)},` : "";
  a.push("-vf", `${perkecil}crop=trunc(iw/2)*2:trunc(ih/2)*2,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709`);
  // Profil sesuai YouTube Help "Recommended upload encoding settings": H.264 High,
  // 4:2:0, progresif, B-frame 2, GOP tertutup = setengah fps, SDR BT.709.
  a.push(
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p", "-r", String(fps),
    "-profile:v", "high", "-bf", "2", "-g", String(Math.max(1, Math.round(fps / 2))), "-flags", "+cgop",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  );
  if (idxAudio >= 0) {
    // Normalisasi dulu, lalu apad: audio pendek diberi senyap setelah dinormalisasi,
    // dan -shortest memotong audio panjang; durasi = video.
    const rantai = [];
    if (filterKenyaringan) rantai.push(filterKenyaringan, "aresample=48000");
    rantai.push("apad");
    a.push("-c:a", "aac", "-b:a", "384k", "-ar", "48000", "-ac", "2", "-af", rantai.join(","), "-shortest");
  }
  if (idxSub >= 0) a.push("-c:s", "mov_text", "-metadata:s:s:0", `language=${o.bahasa}`);
  a.push("-movflags", "+faststart", o.out);
  return a;
}

// ---------------------------------------------------------------- jaringan
// Hanya skema lokal (file, data, about, blob) yang lolos tanpa dicegat. Selebihnya (http, https, ws, wss, ftp, ...)
// dicegat context.route / routeWebSocket, dibatalkan, dan dicatat. Uji lokal: route saja
// tidak menutup WebSocket, jadi keduanya dipasang.
const BATAS_DAFTAR_BLOKIR = 20;
const izinkanJaringan = o["izinkan-jaringan"];
const diblokir = new Map(); // "METODE url" -> { metode, url, jenis }

function hostAsal(arg) {
  if (!/^https?:\/\//i.test(arg)) return null;
  try { return new URL(arg).host; } catch { return null; }
}

function samaAsal(asalKomposisi, url) {
  if (!asalKomposisi) return false;
  try {
    const u = new URL(url);
    return /^(?:https?|wss?):$/.test(u.protocol) && u.host === asalKomposisi;
  } catch {
    return false;
  }
}

class JaringanDiblokir extends Error {
  constructor() {
    super(pesanJaringan());
    this.kode = 3;
  }
}

function pesanJaringan() {
  const daftar = [...diblokir.values()];
  const baris = daftar.slice(0, BATAS_DAFTAR_BLOKIR).map((d) => `  ${d.metode} ${d.url} (${d.jenis})`);
  if (daftar.length > BATAS_DAFTAR_BLOKIR) baris.push(`  ... dan ${daftar.length - BATAS_DAFTAR_BLOKIR} lainnya`);
  return `${daftar.length} permintaan jaringan diblokir (hanya file:, data:, about:, blob: yang diizinkan):\n${baris.join("\n")}\n` +
    "Pakai aset lokal yang tercatat (bun run aset); --izinkan-jaringan hanya untuk pratinjau, bukan rilis.";
}

function periksaJaringan() {
  if (!izinkanJaringan && diblokir.size) throw new JaringanDiblokir();
}

async function pasangPemblokiranJaringan(context, asalKomposisi) {
  const catat = (metode, url, jenis) => {
    const kunci = `${metode} ${url}`;
    if (!diblokir.has(kunci)) diblokir.set(kunci, { metode, url, jenis });
  };
  await context.route(/^(?!(?:file|data|about|blob):)/i, (route) => {
    const req = route.request();
    if (samaAsal(asalKomposisi, req.url())) return route.continue();
    catat(req.method(), req.url(), req.resourceType());
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (ws) => {
    if (samaAsal(asalKomposisi, ws.url())) {
      ws.connectToServer();
      return;
    }
    catat("WS", ws.url(), "websocket");
    ws.close({ code: 1008, reason: "diblokir awvd" });
  });
}

// Perkecil satu PNG lewat ffmpeg (jalur yang sama dengan mode video; deterministik).
async function perkecilPng(buf, w, h) {
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "png", "-i", "-",
    "-vf", filterPerkecil(w, h), "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(buf);
  await p.stdin.end();
  const [keluar, galat, kode] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`ffmpeg gagal memperkecil still (exit ${kode}):\n${galat.trim()}`);
  return Buffer.from(keluar);
}

// ------------------------------------------------------------------------ main
const t0 = Date.now();
const url = urlKomposisi(positionals[0]);
let exe;
try {
  exe = cariBrowser(o.browser);
} catch (e) {
  gagal(e.message, e.kode);
}
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    "--allow-file-access-from-files", // fetch()/font dari file:// bertetangga
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--hide-scrollbars",
  ],
}).catch((e) => gagal(`gagal meluncurkan browser (${exe}): ${e.message}`));

let ffmpeg = null;
let kodeKeluar = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  if (izinkanJaringan) {
    console.error("peringatan: --izinkan-jaringan aktif; permintaan jaringan tidak diblokir, hasil bisa tidak deterministik dan jangan dipakai untuk rilis");
  } else {
    await pasangPemblokiranJaringan(context, hostAsal(positionals[0]));
  }
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[halaman] galat: ${e.message}`));
  page.on("console", (m) => {
    // pemblokiran jaringan sudah dilaporkan lengkap di akhir; jangan dobel dengan galat sumber per permintaan
    if (m.type() === "error" && !(!izinkanJaringan && /ERR_BLOCKED_BY_CLIENT/.test(m.text()))) console.error(`[halaman] ${m.text()}`);
  });
  await page.addInitScript((p) => { window.videoProps = p; }, props);
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
  } catch (e) {
    throw new Error(`gagal membuka ${url}: ${e.message}`);
  }

  try {
    await page.waitForFunction(
      () => window.video && typeof window.video.renderFrame === "function",
      null,
      { timeout: BATAS_WAKTU_VIDEO_MS },
    );
  } catch {
    throw new Error(
      `window.video tidak terdefinisi dalam ${BATAS_WAKTU_VIDEO_MS / 1000} detik. ` +
      "Pastikan komposisi memuat runtime.js dan memanggil defineVideo(...).",
    );
  }
  const cfg = await page.evaluate(() => {
    const v = window.video;
    return { width: v.width, height: v.height, fps: v.fps, durationInFrames: v.durationInFrames };
  });
  for (const k of ["width", "height", "fps", "durationInFrames"]) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) throw new Error(`window.video.${k} tidak valid: ${cfg[k]}`);
  }
  await page.setViewportSize({ width: cfg.width, height: cfg.height });

  // Muat eksplisit setiap @font-face sebelum frame pertama. `document.fonts.ready` saja tidak
  // memuat face yang belum dipakai DOM awal, sehingga elemen berfont yang dibuat di render()
  // bisa tertangkap dengan font cadangan lalu bergeser (uji lokal: lebar 168,6 px -> 189,8 px).
  const fontGagal = await page.evaluate(async () => {
    const muka = [...document.fonts];
    const hasil = await Promise.allSettled(muka.map((f) => f.load()));
    await document.fonts.ready;
    const gagalMuat = muka
      .filter((f, i) => hasil[i].status === "rejected" || f.status === "error")
      .map((f) => `${f.family} (bobot ${f.weight}, gaya ${f.style})`);
    // tunggu gambar siap
    const imgs = [...document.images];
    for (const v of document.querySelectorAll("video[poster]")) {
      const im = new Image();
      im.src = v.poster;
      imgs.push(im);
    }
    await Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((ok) => {
      im.addEventListener("load", ok, { once: true });
      im.addEventListener("error", ok, { once: true });
    }))));
    await Promise.all(imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
    return gagalMuat;
  });
  periksaJaringan(); // pesan "diblokir" lebih jelas daripada "gambar/font gagal dimuat"
  if (fontGagal.length) throw new Error(`font gagal dimuat: ${fontGagal.join(", ")}. Periksa url() di @font-face (berkas lokal, format didukung Chromium).`);
  const rusak = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.currentSrc || i.src));
  if (rusak.length) throw new Error(`gambar gagal dimuat: ${rusak.join(", ")}`);

  const dur = cfg.durationInFrames;
  // Tangkap via CDP: PNG lossless, optimizeForSpeed mengurangi kompresi (lebih cepat, berkas lebih besar).
  const cdp = await context.newCDPSession(page);
  const ambil = async (n) => {
    await page.evaluate(async (f) => {
      await window.video.renderFrame(f);
      // jaring pengaman: face yang baru ditambahkan di dalam render() dimuat sebelum tangkapan
      const fs = document.fonts;
      if (fs.size) {
        const belum = [...fs].filter((x) => x.status === "unloaded" || x.status === "loading");
        if (belum.length) await Promise.allSettled(belum.map((x) => x.load()));
        if (fs.status === "loading") await fs.ready;
      }
    }, n);
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      optimizeForSpeed: true,
      // skala >= 1 lewat clip.scale: layout tetap w x h, raster dibuat ulang tajam pada ukuran akhir
      clip: { x: 0, y: 0, width: cfg.width, height: cfg.height, scale: skalaRaster },
    });
    periksaJaringan();
    return Buffer.from(data, "base64");
  };

  // ------------------------------------------------------------ mode --still
  if (stillOpt !== undefined) {
    if (stillOpt >= dur) throw new Error(`--still ${stillOpt} di luar 0..${dur - 1}`);
    let buf = await ambil(stillOpt);
    if (skala < 1) buf = await perkecilPng(buf, Math.round(cfg.width * skala), Math.round(cfg.height * skala));
    await Bun.write(o.out, buf);
    console.error(`still frame ${stillOpt} -> ${o.out} (${(statSync(o.out).size / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } else {
    // -------------------------------------------------------- mode video
    const dari = dariOpt ?? 0;
    const sampai = sampaiOpt ?? dur - 1;
    if (dari > sampai || sampai >= dur) throw new Error(`rentang frame tidak valid: ${dari}..${sampai} (komposisi 0..${dur - 1})`);
    const total = sampai - dari + 1;
    const lebar = Math.round(cfg.width * skala);
    const tinggi = Math.round(cfg.height * skala);
    if (lebar % 2 || tinggi % 2) console.error(`peringatan: dimensi ${lebar}x${tinggi} ganjil, dipotong ke genap`);

    // kenyaringan dua-pass: ukur (pass 1) sebelum encode; pass 2 memakai nilai ukur (linear)
    let filterKenyaringan = null;
    if (targetKenyaringan && o.kenyaringan !== "mati") {
      const ukur = await ukurPass1(targetKenyaringan, { offsetDetik: (dari / cfg.fps).toFixed(6), durasiDetik: total / cfg.fps });
      if (ukur) {
        filterKenyaringan = filterLoudnorm(targetKenyaringan, ukur);
        console.error(`kenyaringan awal: I=${Number(ukur.input_i).toFixed(1)} LUFS, TP=${Number(ukur.input_tp).toFixed(1)} dBTP`);
      } else {
        console.error("peringatan: audio senyap atau tak terukur, normalisasi kenyaringan dilewati");
      }
    }

    ffmpeg = Bun.spawn(["ffmpeg", ...bangunFfmpeg({ fps: cfg.fps, dari, w: lebar, h: tinggi, filterKenyaringan })], {
      stdin: "pipe", stdout: "ignore", stderr: "pipe",
    });
    const stderrFfmpeg = new Response(ffmpeg.stderr).text(); // kuras agar tidak buntu
    let ffmpegMati = false;
    ffmpeg.exited.then(() => { ffmpegMati = true; });

    const tty = process.stderr.isTTY;
    let terakhirLapor = 0;
    const tRender = Date.now();
    for (let n = dari; n <= sampai; n++) {
      if (ffmpegMati) break;
      const buf = await ambil(n);
      ffmpeg.stdin.write(buf);
      await ffmpeg.stdin.flush();
      const k = n - dari + 1;
      const now = Date.now();
      if (now - terakhirLapor > (tty ? 500 : 5000) || k === total) {
        terakhirLapor = now;
        const fpsRender = k / ((now - tRender) / 1000 || 1);
        process.stderr.write(`${tty ? "\r" : ""}frame ${k}/${total}  ${fpsRender.toFixed(1)} fps render${tty ? "" : "\n"}`);
      }
    }
    if (tty) process.stderr.write("\n");
    await page.evaluate(() => 0); // putaran ulang: pastikan catatan permintaan frame terakhir sudah masuk
    periksaJaringan();
    await ffmpeg.stdin.end();
    const kode = await ffmpeg.exited;
    const pesanFfmpeg = (await stderrFfmpeg).trim();
    if (kode !== 0) throw new Error(`ffmpeg gagal (exit ${kode}):\n${pesanFfmpeg}`);
    if (pesanFfmpeg) console.error(pesanFfmpeg);
    const ukuran = statSync(o.out).size;
    console.error(
      `selesai: ${o.out}\n  ${total} frame @ ${cfg.fps} fps = ${(total / cfg.fps).toFixed(2)} s, ${lebar}x${tinggi}, ` +
      `${(ukuran / 1024 / 1024).toFixed(2)} MB, waktu render ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    if (o.audio) {
      // laporan saja: kegagalan pengukuran tidak menggagalkan render
      const target = o.kenyaringan === "mati" ? "tanpa normalisasi" : `target ${targetKenyaringan.label}`;
      try {
        const k = await ukurAkhir(o.out);
        console.error(`kenyaringan: I=${k.I.toFixed(1)} LUFS, TP=${k.TP.toFixed(1)} dBTP (${target})`);
      } catch (e) {
        console.error(`peringatan: kenyaringan hasil tidak terukur: ${e.message}`);
      }
    }
  }
} catch (e) {
  if (!izinkanJaringan && diblokir.size) {
    // permintaan yang diblokir hampir selalu penyebab utama; galat lain hanya dampaknya
    console.error(`render.mjs: ${pesanJaringan()}`);
    if (!(e instanceof JaringanDiblokir)) console.error(`galat yang menyertai: ${e.message}`);
    kodeKeluar = 3;
  } else {
    console.error(`render.mjs: ${e.message}`);
    kodeKeluar = 1;
  }
} finally {
  if (ffmpeg && ffmpeg.exitCode === null) {
    // SIGKILL: ffmpeg menahan stdin terbuka dan tidak keluar karena SIGTERM; keluarannya memang dibuang
    try { ffmpeg.kill("SIGKILL"); } catch {}
    await ffmpeg.exited.catch(() => {});
  }
  // keluaran setengah jadi hasil render yang gagal karena jaringan tidak boleh tersisa sebagai video rusak
  if (kodeKeluar === 3 && ffmpeg) {
    try { unlinkSync(o.out); } catch {}
  }
  await browser.close().catch(() => {});
}
process.exit(kodeKeluar);
