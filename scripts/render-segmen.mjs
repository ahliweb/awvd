#!/usr/bin/env bun
/**
 * awvd / render-segmen.mjs — pekerja internal render.mjs. Bukan antarmuka publik: flag dan
 * keluarannya boleh berubah tanpa pemberitahuan; pakai `bun run render`.
 *
 * Merender satu segmen frame (dari..sampai, inklusif) di proses Chromium sendiri:
 *   pemanasan 2 frame (dibuang) -> tangkap PNG/JPEG -> ffmpeg x264 video-saja (-threads 2)
 *   -> MP4 sementara -> remux ke MPEG-TS (`--out`) untuk digabung `-c copy` oleh render.mjs.
 *
 * Dengan `--deps F` (cache segmen): semua berkas lokal yang diminta halaman selama proses ini hidup
 * dicatat, lalu manifest berkas + sha256 ditulis ke F (render-cache.mjs). Hanya mendengarkan peristiwa
 * jaringan; tidak memengaruhi piksel.
 *
 * Protokol ke render.mjs: stdout memuat baris `P <k>` (k = frame selesai di segmen ini); pesan galat
 * ada di stderr; kode keluar 0 berhasil, 1 galat render, 3 permintaan jaringan diblokir, 143 dihentikan.
 * Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { cariBrowser } from "./browser.js";
import { buatPelacak } from "./render-cache.mjs";
import { bukaSesi, buatJaring, filterPerkecil, hostAsal, klasifikasiGalat, urlKomposisi } from "./render-sesi.mjs";

// Parameter encode per segmen. Dipatok agar keluaran tidak bergantung jumlah inti mesin:
// -threads 2 membuat x264 memakai jumlah thread tetap (thread otomatis mengubah byte keluaran).
const THREAD_X264 = 2;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "props-file": { type: "string" },
    dari: { type: "string" },
    sampai: { type: "string" },
    skala: { type: "string" },
    crf: { type: "string" },
    tangkap: { type: "string", default: "png" },
    browser: { type: "string" },
    "izinkan-jaringan": { type: "boolean", default: false },
    cfg: { type: "string" },
    out: { type: "string" },
    md5: { type: "string" },
    deps: { type: "string" },
  },
});

const dari = Number(o.dari);
const sampai = Number(o.sampai);
const skala = Number(o.skala);
const crf = Number(o.crf);
const cfgDiharapkan = JSON.parse(o.cfg);
const jaring = buatJaring({ izinkan: o["izinkan-jaringan"], asalKomposisi: hostAsal(positionals[0]) });
const tmpMp4 = `${o.out}.mp4`;
const lacak = o.deps ? buatPelacak() : null;

function argumenFfmpeg({ fps, w, h }) {
  const a = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps),
    "-c:v", o.tangkap === "jpeg" ? "mjpeg" : "png", "-i", "-", "-map", "0:v"];
  // Crop dulu: dimensi ganjil dipotong 1 px ke genap (yuv420p mewajibkan genap).
  // Lalu RGB penuh (sRGB dari browser) -> YUV BT.709 rentang TV, eksplisit.
  // Skala < 1: perkecil dari tangkapan skala 1 ke w x h (RGB, sebelum konversi warna).
  const perkecil = skala < 1 ? `${filterPerkecil(w, h)},` : "";
  a.push("-vf", `${perkecil}crop=trunc(iw/2)*2:trunc(ih/2)*2,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709`);
  // Profil sesuai YouTube Help "Recommended upload encoding settings": H.264 High,
  // 4:2:0, progresif, B-frame 2, GOP tertutup = setengah fps, SDR BT.709.
  a.push(
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p", "-r", String(fps),
    "-profile:v", "high", "-bf", "2", "-g", String(Math.max(1, Math.round(fps / 2))), "-flags", "+cgop",
    "-threads", String(THREAD_X264),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-f", "mp4", tmpMp4,
  );
  return a;
}

let sesi = null;
let ffmpeg = null;
let kodeKeluar = 0;

async function bersihkan() {
  if (ffmpeg && ffmpeg.exitCode === null) {
    // SIGKILL: ffmpeg menahan stdin terbuka dan tidak keluar karena SIGTERM; keluarannya memang dibuang
    try { ffmpeg.kill("SIGKILL"); } catch {}
    await ffmpeg.exited.catch(() => {});
  }
  if (sesi) await sesi.tutup();
  try { unlinkSync(tmpMp4); } catch {}
}

// render.mjs menghentikan pekerja (SIGTERM) saat pekerja lain gagal atau pengguna menekan Ctrl+C
process.on("SIGTERM", () => { bersihkan().finally(() => process.exit(143)); });

try {
  const props = JSON.parse(readFileSync(o["props-file"], "utf8"));
  sesi = await bukaSesi({
    url: urlKomposisi(positionals[0]),
    props,
    exe: cariBrowser(o.browser),
    jaring,
    skalaRaster: Math.max(skala, 1),
    tangkap: o.tangkap,
    log: (s) => console.error(s),
    lacak,
  });
  const { cfg } = sesi;
  for (const k of Object.keys(cfgDiharapkan)) {
    if (cfg[k] !== cfgDiharapkan[k]) throw new Error(`window.video.${k} berubah antar proses (${cfgDiharapkan[k]} lalu ${cfg[k]}); komposisi harus deterministik`);
  }
  if (sampai >= cfg.durationInFrames) throw new Error(`segmen ${dari}..${sampai} di luar komposisi 0..${cfg.durationInFrames - 1}`);
  const lebar = Math.round(cfg.width * skala);
  const tinggi = Math.round(cfg.height * skala);

  await sesi.hangatkan(dari);

  ffmpeg = Bun.spawn(["ffmpeg", ...argumenFfmpeg({ fps: cfg.fps, w: lebar, h: tinggi })], {
    stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const stderrFfmpeg = new Response(ffmpeg.stderr).text(); // kuras agar tidak buntu
  let ffmpegMati = false;
  ffmpeg.exited.then(() => { ffmpegMati = true; });

  const md5 = o.md5 ? [] : null;
  for (let n = dari; n <= sampai; n++) {
    if (ffmpegMati) break;
    const buf = await sesi.ambil(n);
    if (md5) md5.push(`${n} ${new Bun.CryptoHasher("md5").update(buf).digest("hex")}`);
    ffmpeg.stdin.write(buf);
    await ffmpeg.stdin.flush();
    process.stdout.write(`P ${n - dari + 1}\n`);
  }
  await sesi.sinkron();
  jaring.periksa();
  if (lacak) {
    const alasanDom = await sesi.periksaDom();
    if (alasanDom) lacak.tidakBisa(alasanDom);
    await lacak.tulis(o.deps);
  }
  await ffmpeg.stdin.end();
  const kode = await ffmpeg.exited;
  const pesanFfmpeg = (await stderrFfmpeg).trim();
  if (kode !== 0) throw new Error(`ffmpeg gagal (exit ${kode}):\n${pesanFfmpeg}`);
  if (pesanFfmpeg) console.error(pesanFfmpeg);
  if (md5) writeFileSync(o.md5, `${md5.join("\n")}\n`);

  // MP4 -> MPEG-TS tanpa encode ulang: render.mjs menggabung segmen lewat concat demuxer `-c copy`
  const remux = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", tmpMp4,
    "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", o.out], { stdout: "ignore", stderr: "pipe" });
  const [galatRemux, kodeRemux] = await Promise.all([new Response(remux.stderr).text(), remux.exited]);
  if (kodeRemux !== 0) throw new Error(`ffmpeg remux segmen ${dari}..${sampai} gagal (exit ${kodeRemux}):\n${galatRemux.trim()}`);
} catch (e) {
  const { kode, pesan } = klasifikasiGalat(jaring, e);
  console.error(pesan);
  kodeKeluar = kode;
} finally {
  await bersihkan();
}
process.exit(kodeKeluar);
