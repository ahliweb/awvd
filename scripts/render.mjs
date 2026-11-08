#!/usr/bin/env bun
/**
 * video-terprogram / render.mjs — render komposisi web menjadi MP4 (atau satu PNG).
 *
 *   bun render.mjs <komposisi.html|URL> --out hasil.mp4
 *        [--props '{"judul":"..."}' | --props-file p.json]
 *        [--dari N] [--sampai M] [--skala 1] [--crf 18]
 *        [--audio musik.mp3] [--kenyaringan web|siaran|mati]
 *        [--subtitle teks.vtt|.srt] [--bahasa ind]
 *        [--paralel N] [--tangkap png|jpeg] [--md5-tangkapan F]
 *        [--still N] [--browser /path/chrome] [--izinkan-jaringan]
 *
 * Alur video: rentang frame dibagi menjadi segmen berukuran tetap CH = 4 x round(fps/2) frame
 * (kelipatan GOP, tidak bergantung jumlah pekerja). Setiap segmen dirender oleh pekerja
 * (render-segmen.mjs) di proses Chromium sendiri: pemanasan 2 frame (dibuang) -> screenshot PNG per
 * frame -> pipa ke ffmpeg x264 video-saja (-threads 2) -> MPEG-TS. Segmen digabung dengan concat
 * demuxer `-c copy` ke MP4 (+faststart); jumlah frame dan PTS diverifikasi. Audio, subtitle, dan
 * kenyaringan (loudnorm dua-pass) dipasang di tahap akhir tunggal dengan `-c:v copy`, tanpa encode
 * video ulang. Keluaran MP4 sama persis untuk --paralel berapa pun (serial = satu pekerja).
 * Tidak ada file sementara per frame; berkas sementara per render ada di folder unik dan dibersihkan.
 *
 * Jaringan: semua permintaan selain file:, data:, about:, dan blob: (HTTP, HTTPS,
 * WebSocket, sendBeacon, ...) diblokir dan dicatat; render gagal dengan kode keluar 3
 * beserta daftar URL-nya, supaya hasil tidak bergantung pada sumber luar. Komposisi
 * yang dibuka lewat http(s) hanya boleh meminta asalnya sendiri. --izinkan-jaringan
 * mematikan pemblokiran (hanya untuk pratinjau, bukan rilis).
 * Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { availableParallelism } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cariBrowser } from "./browser.js";
import { bukaSesi, buatJaring, filterPerkecil, hostAsal, klasifikasiGalat, urlKomposisi } from "./render-sesi.mjs";

const PEKERJA_MJS = join(dirname(fileURLToPath(import.meta.url)), "render-segmen.mjs");

function gagal(pesan, kode = 1) {
  console.error(`render.mjs: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun render.mjs <komposisi.html|URL> --out hasil.mp4 [opsi]
Opsi: --props JSON | --props-file F, --dari N, --sampai M, --skala X, --crf N,
      --audio F, --kenyaringan web|siaran|mati, --subtitle F(.vtt|.srt),
      --bahasa KODE, --paralel N, --tangkap png|jpeg, --md5-tangkapan F,
      --still N, --browser PATH, --izinkan-jaringan
--paralel N mengatur jumlah pekerja (bawaan min(4, inti/2)); keluaran MP4 sama untuk N berapa pun.
--tangkap jpeg: draf pratinjau (lossy, lebih cepat), bukan untuk rilis.
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
      paralel: { type: "string" },
      tangkap: { type: "string", default: "png" },
      "md5-tangkapan": { type: "string" },
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
const paralelOpt = angka("paralel", o.paralel, { min: 1, bulat: true });
if (o.tangkap !== "png" && o.tangkap !== "jpeg") gagal(`--tangkap tidak valid: "${o.tangkap}" (pilih png atau jpeg)`, 2);
if (o.tangkap === "jpeg" && stillOpt !== undefined) gagal("--tangkap jpeg tidak berlaku untuk --still (still selalu PNG lossless)", 2);
if (paralelOpt !== undefined && stillOpt !== undefined) console.error("peringatan: --paralel diabaikan bersama --still");
if (o.tangkap === "jpeg") console.error("peringatan: --tangkap jpeg adalah mode draf (lossy, sekitar 42 dB PSNR terhadap PNG); hanya untuk pratinjau, jangan untuk rilis");

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

let url;
try {
  url = urlKomposisi(positionals[0]);
} catch (e) {
  gagal(e.message, e.kode ?? 2);
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

async function jalankanFfmpeg(argumen, namaTahap) {
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...argumen], { stdout: "ignore", stderr: "pipe" });
  const [err, kode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`ffmpeg ${namaTahap} gagal (exit ${kode}):\n${err.trim()}`);
  return err.trim();
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

// Tahap akhir tunggal: pasang audio (AAC, kenyaringan) dan subtitle ke video hasil gabungan segmen.
// Video disalin apa adanya (-c:v copy); tidak ada encode video ulang.
function bangunFfmpegAkhir({ fps, dari, masuk, keluar, filterKenyaringan }) {
  const a = ["-i", masuk];
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
  a.push("-c:v", "copy");
  if (idxAudio >= 0) {
    // Normalisasi dulu, lalu apad: audio pendek diberi senyap setelah dinormalisasi,
    // dan -shortest memotong audio panjang; durasi = video.
    const rantai = [];
    if (filterKenyaringan) rantai.push(filterKenyaringan, "aresample=48000");
    rantai.push("apad");
    a.push("-c:a", "aac", "-b:a", "384k", "-ar", "48000", "-ac", "2", "-af", rantai.join(","), "-shortest");
  }
  if (idxSub >= 0) a.push("-c:s", "mov_text", "-metadata:s:s:0", `language=${o.bahasa}`);
  a.push("-movflags", "+faststart", "-f", "mp4", keluar);
  return a;
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

// ------------------------------------------------------------------ segmen
/** Ukuran segmen tetap, kelipatan GOP; tidak bergantung jumlah pekerja (kunci keluaran identik). */
function ukuranSegmen(fps) {
  return 4 * Math.max(1, Math.round(fps / 2));
}

function bagiSegmen(dari, sampai, ch) {
  const segmen = [];
  for (let s = dari, i = 0; s <= sampai; s += ch, i++) segmen.push({ idx: i, dari: s, sampai: Math.min(s + ch - 1, sampai) });
  return segmen;
}

function pekerjaBawaan() {
  let inti = 2;
  try { inti = availableParallelism(); } catch {}
  return Math.max(1, Math.min(4, Math.floor(inti / 2)));
}

// Verifikasi gabungan: jumlah frame sama dengan rentang dan PTS rapat (selisih tetap, tanpa lubang
// atau duplikat). Berjalan pada paket saja (tanpa dekode), jadi murah.
async function verifikasiGabungan(file, total) {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts", "-of", "csv=p=0", file],
    { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`ffprobe verifikasi gabungan gagal (exit ${kode}):\n${err.trim()}`);
  const pts = out.split("\n").filter(Boolean).map((l) => Number(l.split(",")[0])).sort((a, b) => a - b);
  if (pts.length !== total) throw new Error(`verifikasi gabungan: ${pts.length} frame, seharusnya ${total}`);
  if (pts.some((v) => !Number.isFinite(v))) throw new Error("verifikasi gabungan: ada paket tanpa PTS");
  if (total > 1) {
    const d = pts[1] - pts[0];
    if (!(d > 0) || pts.some((v, i) => i > 0 && v - pts[i - 1] !== d)) throw new Error("verifikasi gabungan: PTS frame tidak rapat (ada lubang atau duplikat)");
  }
}

function lapisGalat(daftar) {
  // pesan halaman identik dari banyak pekerja ditampilkan sekali
  const lihat = new Set();
  const baris = [];
  for (const teks of daftar) {
    for (const l of teks.split("\n")) {
      if (l.trim() && !lihat.has(l)) { lihat.add(l); baris.push(l); }
    }
  }
  return baris;
}

// ------------------------------------------------------------------------ main
const t0 = Date.now();
const izinkanJaringan = o["izinkan-jaringan"];
const jaring = buatJaring({ izinkan: izinkanJaringan, asalKomposisi: hostAsal(positionals[0]) });
let exe;
try {
  exe = cariBrowser(o.browser);
} catch (e) {
  gagal(e.message, e.kode);
}
if (izinkanJaringan) {
  console.error("peringatan: --izinkan-jaringan aktif; permintaan jaringan tidak diblokir, hasil bisa tidak deterministik dan jangan dipakai untuk rilis");
}

let sesi = null;
let tmp = null;
let keluarSementara = null;
let kodeKeluar = 0;
let batal = false;
const pekerja = new Set();

async function hentikanPekerja() {
  const hidup = [...pekerja].filter((p) => p.exitCode === null);
  for (const p of hidup) { try { p.kill("SIGTERM"); } catch {} }
  await Promise.race([Promise.all(hidup.map((p) => p.exited.catch(() => {}))), Bun.sleep(3000)]);
  for (const p of hidup) { if (p.exitCode === null) { try { p.kill("SIGKILL"); } catch {} } }
  await Promise.all(hidup.map((p) => p.exited.catch(() => {})));
}

function bersihkanBerkas() {
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} tmp = null; }
  if (keluarSementara) { try { rmSync(keluarSementara, { force: true }); } catch {} keluarSementara = null; }
}

for (const sinyal of ["SIGINT", "SIGTERM"]) {
  process.on(sinyal, () => {
    batal = true;
    hentikanPekerja().finally(() => {
      bersihkanBerkas();
      process.exit(sinyal === "SIGINT" ? 130 : 143);
    });
  });
}

try {
  if (stillOpt !== undefined) {
    // ---------------------------------------------------------- mode --still
    sesi = await bukaSesi({ url, props, exe, jaring, skalaRaster, tangkap: "png" });
    const { cfg } = sesi;
    if (stillOpt >= cfg.durationInFrames) throw new Error(`--still ${stillOpt} di luar 0..${cfg.durationInFrames - 1}`);
    await sesi.hangatkan(stillOpt); // pemanasan yang sama dengan segmen video: tangkapan identik
    let buf = await sesi.ambil(stillOpt);
    if (skala < 1) buf = await perkecilPng(buf, Math.round(cfg.width * skala), Math.round(cfg.height * skala));
    await Bun.write(o.out, buf);
    console.error(`still frame ${stillOpt} -> ${o.out} (${(statSync(o.out).size / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } else {
    // -------------------------------------------------------- mode video
    // Probe: baca konfigurasi komposisi (dan gagal cepat bila halaman bermasalah), lalu tutup.
    // Frame dirender oleh pekerja segmen di proses Chromium masing-masing.
    sesi = await bukaSesi({ url, props, exe, jaring, skalaRaster, tangkap: o.tangkap });
    const cfg = sesi.cfg;
    await sesi.tutup();
    sesi = null;

    const dur = cfg.durationInFrames;
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

    tmp = mkdtempSync(join(tmpdir(), "awvd-render-"));
    const berkasProps = join(tmp, "props.json");
    writeFileSync(berkasProps, JSON.stringify(props));
    const segmen = bagiSegmen(dari, sampai, ukuranSegmen(cfg.fps)).map((s) => ({
      ...s,
      ts: join(tmp, `seg-${String(s.idx).padStart(5, "0")}.ts`),
      md5: join(tmp, `seg-${String(s.idx).padStart(5, "0")}.md5`),
    }));
    const jumlahPekerja = Math.min(paralelOpt ?? pekerjaBawaan(), segmen.length);

    const tty = process.stderr.isTTY;
    const selesai = new Array(segmen.length).fill(0);
    let terakhirLapor = 0;
    const tRender = Date.now();
    const lapor = () => {
      const k = selesai.reduce((a, b) => a + b, 0);
      const now = Date.now();
      if (now - terakhirLapor > (tty ? 500 : 5000) || k === total) {
        terakhirLapor = now;
        const fpsRender = k / ((now - tRender) / 1000 || 1);
        process.stderr.write(`${tty ? "\r" : ""}frame ${k}/${total}  ${fpsRender.toFixed(1)} fps render${tty ? "" : "\n"}`);
      }
    };

    const jalankanPekerja = async (seg) => {
      const a = [process.execPath, PEKERJA_MJS, positionals[0],
        "--props-file", berkasProps, "--dari", String(seg.dari), "--sampai", String(seg.sampai),
        "--skala", String(skala), "--crf", String(crf), "--tangkap", o.tangkap,
        "--cfg", JSON.stringify(cfg), "--out", seg.ts];
      if (o.browser) a.push("--browser", o.browser);
      if (izinkanJaringan) a.push("--izinkan-jaringan");
      if (o["md5-tangkapan"]) a.push("--md5", seg.md5);
      // TMPDIR per pekerja di dalam folder sementara render: artefak Playwright dan profil Chromium
      // dari pekerja yang dihentikan paksa ikut terhapus saat folder render dibersihkan.
      const tmpPekerja = join(tmp, `pekerja-${String(seg.idx).padStart(5, "0")}`);
      mkdirSync(tmpPekerja);
      const p = Bun.spawn(a, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: tmpPekerja } });
      pekerja.add(p);
      const baca = (async () => {
        const dek = new TextDecoder();
        let sisa = "";
        for await (const bagian of p.stdout) {
          sisa += dek.decode(bagian, { stream: true });
          let i;
          while ((i = sisa.indexOf("\n")) >= 0) {
            const baris = sisa.slice(0, i);
            sisa = sisa.slice(i + 1);
            const m = /^P (\d+)$/.exec(baris);
            if (m) { selesai[seg.idx] = Number(m[1]); lapor(); }
          }
        }
      })();
      const [galat, kode] = await Promise.all([new Response(p.stderr).text(), p.exited, baca]);
      return { seg, kode, galat };
    };

    // antrean pekerja: tiap pekerja mengambil segmen berikutnya; satu kegagalan menghentikan semuanya
    const hasil = new Array(segmen.length);
    let berikut = 0;
    let gagalPertama = null;
    const pelari = async () => {
      while (!batal && !gagalPertama && berikut < segmen.length) {
        const seg = segmen[berikut++];
        const r = await jalankanPekerja(seg);
        hasil[seg.idx] = r;
        if (r.kode !== 0 && !gagalPertama && !batal) {
          gagalPertama = r;
          await hentikanPekerja();
        }
      }
    };
    await Promise.all(Array.from({ length: jumlahPekerja }, pelari));
    if (tty) process.stderr.write("\n");
    if (gagalPertama) {
      // kode 3 (jaringan) didahulukan: hampir selalu penyebab utama
      const g3 = hasil.find((r) => r && r.kode === 3);
      const r = g3 ?? gagalPertama;
      console.error(r.galat.trim() || `render.mjs: pekerja segmen ${r.seg.dari}..${r.seg.sampai} gagal (exit ${r.kode})`);
      kodeKeluar = r.kode === 3 ? 3 : 1;
    } else if (!batal) {
      for (const l of lapisGalat(hasil.map((r) => r.galat))) console.error(l);

      // gabung: concat demuxer -c copy (tanpa encode ulang)
      const daftarBerkas = join(tmp, "daftar.txt");
      writeFileSync(daftarBerkas, segmen.map((s) => `file '${s.ts.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
      const adaTambahan = Boolean(o.audio || o.subtitle);
      keluarSementara = `${resolve(o.out)}.sementara`;
      const gabungan = adaTambahan ? join(tmp, "gabungan.mp4") : keluarSementara;
      await jalankanFfmpeg(["-f", "concat", "-safe", "0", "-i", daftarBerkas, "-c", "copy",
        ...(adaTambahan ? [] : ["-movflags", "+faststart"]), "-f", "mp4", gabungan], "gabung segmen");
      await verifikasiGabungan(gabungan, total);
      if (adaTambahan) {
        const pesan = await jalankanFfmpeg(bangunFfmpegAkhir({ fps: cfg.fps, dari, masuk: gabungan, keluar: keluarSementara, filterKenyaringan }), "tahap akhir (audio/subtitle)");
        if (pesan) console.error(pesan);
      }
      if (o["md5-tangkapan"]) {
        const baris = segmen.map((s) => readFileSync(s.md5, "utf8").trimEnd()).join("\n");
        writeFileSync(o["md5-tangkapan"], `${baris}\n`);
      }
      renameSync(keluarSementara, o.out);
      keluarSementara = null;

      const ukuran = statSync(o.out).size;
      console.error(
        `selesai: ${o.out}\n  ${total} frame @ ${cfg.fps} fps = ${(total / cfg.fps).toFixed(2)} s, ${lebar}x${tinggi}, ` +
        `${(ukuran / 1024 / 1024).toFixed(2)} MB, waktu render ${((Date.now() - t0) / 1000).toFixed(1)} s ` +
        `(${segmen.length} segmen, ${jumlahPekerja} pekerja)`,
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
  }
} catch (e) {
  const { kode, pesan } = klasifikasiGalat(jaring, e);
  console.error(pesan);
  kodeKeluar = kode;
} finally {
  await hentikanPekerja();
  if (sesi) await sesi.tutup();
  bersihkanBerkas();
}
process.exit(kodeKeluar);
