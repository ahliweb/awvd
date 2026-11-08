#!/usr/bin/env bun
/**
 * uji-render-paralel.mjs — uji jalur segmen renderer (render.mjs + render-segmen.mjs):
 *   (a) MP4 byte-identik untuk --paralel 1 dan 3 (komposisi mungil, banyak segmen) dan md5
 *       tangkapan per frame sama;
 *   (b) MP4 byte-identik untuk --paralel 1 dan 2 pada templat contoh-dasar;
 *   (c) tangkapan per frame jalur segmen = tangkapan berurutan satu proses (transisi-galeri
 *       sekitar frame 245, tempat efek awal-dingin teramati);
 *   (d) --tangkap jpeg menghasilkan MP4 valid dan ditandai draf; nilai tidak valid exit 2;
 *   (e) kegagalan satu pekerja = render gagal (exit non-nol), tanpa keluaran, tanpa berkas
 *       sementara, tanpa sisa proses Chromium;
 *   (f) audio dan subtitle di tahap akhir tunggal: video identik dengan render tanpa keduanya;
 *   (g) durasi MP4 = rentang frame yang dirender: subtitle yang berakhir lebih awal tidak memotong
 *       video/audio; audio panjang dipotong di akhir video, audio pendek di-pad; kenyaringan benar.
 * Tanpa dependensi tambahan. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-render-paralel.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cariBrowser } from "./browser.js";
import { bukaSesi, buatJaring, urlKomposisi } from "./render-sesi.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderCli = join(akar, "scripts", "render.mjs");
const runtimeJs = join(akar, "scripts", "runtime.js");
const contoh = join(akar, "templates", "contoh-dasar", "index.html");
const galeri = join(akar, "templates", "transisi-galeri", "index.html");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-paralel-"));
const j = (...p) => join(tmp, ...p);

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
async function jalankan(cmd, env) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env ? { ...process.env, ...env } : process.env });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const renderKe = (args, env) => jalankan(["bun", renderCli, ...args], env);
const md5Berkas = async (f) => new Bun.CryptoHasher("md5").update(await Bun.file(f).bytes()).digest("hex");
async function probe(file) {
  const r = await jalankan(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file]);
  tegas(r.kode === 0, `ffprobe gagal: ${r.err}`);
  return JSON.parse(r.out);
}
const video = (jj) => jj.streams.find((s) => s.codec_type === "video");
// md5 isi setiap frame video (framemd5) tanpa PTS/ukuran: bukti keluaran video sama
async function framemd5(file) {
  const r = await jalankan(["ffmpeg", "-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  tegas(r.kode === 0, `framemd5 gagal: ${r.err}`);
  return r.out.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").slice(-1)[0].trim()).join("\n");
}

// Komposisi mungil: fps 10 => GOP 5, segmen tetap 20 frame, jadi puluhan frame sudah menjadi beberapa
// segmen. Gerak hanya dari nomor frame. `gagalDi` membuat render() melempar galat pada frame itu.
function tulisKomposisi(nama, { frame = 70, gagalDi = -1 } = {}) {
  const f = j(nama);
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#123"><div id="k" style="position:absolute;width:40px;height:40px;background:#f80"></div><p id="t" style="position:absolute;left:10px;top:50px;margin:0;font:20px sans-serif;color:#fff"></p>` +
    `<script src="${runtimeJs}"></script><script>defineVideo({ width: 160, height: 90, fps: 10, durationInFrames: ${frame}, render(f) {` +
    `if (f === ${gagalDi}) throw new Error("uji: pekerja sengaja gagal di frame " + f);` +
    `const k = document.getElementById("k"); k.style.left = (f * 2) + "px"; k.style.top = (f % 20) + "px"; document.getElementById("t").textContent = "frame " + f; } });</script>`);
  return f;
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

daftar("(a) komposisi mungil, 3 segmen: MP4 dan md5 tangkapan identik untuk --paralel 1 dan 3; rentang --dari/--sampai", async () => {
  const k = tulisKomposisi("mungil.html", { frame: 50 });
  const md5 = {};
  const mp4 = {};
  for (const n of ["1", "3"]) {
    mp4[n] = j(`mungil-${n}.mp4`);
    md5[n] = j(`mungil-${n}.md5`);
    const r = await renderKe([k, "--out", mp4[n], "--paralel", n, "--md5-tangkapan", md5[n]]);
    tegas(r.kode === 0, `--paralel ${n}: exit ${r.kode}: ${r.err}`);
    tegas(new RegExp(`3 segmen, ${n} pekerja`).test(r.err), `--paralel ${n}: ringkasan segmen/pekerja tidak sesuai: ${r.err}`);
  }
  const v = video(await probe(mp4["1"]));
  tegas(v.nb_read_frames === "50", `frame ${v.nb_read_frames}, seharusnya 50`);
  tegas(v.profile === "High" && v.pix_fmt === "yuv420p", `profil ${v.profile}/${v.pix_fmt}`);
  tegas((await md5Berkas(mp4["1"])) === (await md5Berkas(mp4["3"])), "md5 MP4 berbeda antara 1 dan 3 pekerja");
  const m = ["1", "3"].map((n) => readFileSync(md5[n], "utf8"));
  tegas(m[0].trim().split("\n").length === 50, "manifest md5 tangkapan tidak 50 baris");
  tegas(m[0] === m[1], "md5 tangkapan per frame berbeda antara 1 dan 3 pekerja");
  // rentang --dari/--sampai: segmen dihitung dari --dari (30 frame = 2 segmen), keluaran sama untuk N berbeda
  const [r1, r2] = [j("rentang-1.mp4"), j("rentang-2.mp4")];
  for (const [f, n] of [[r1, "1"], [r2, "2"]]) {
    const r = await renderKe([k, "--out", f, "--paralel", n, "--dari", "13", "--sampai", "42"]);
    tegas(r.kode === 0, `rentang --paralel ${n}: ${r.err}`);
  }
  tegas(video(await probe(r1)).nb_read_frames === "30", "rentang 13..42 bukan 30 frame");
  tegas((await md5Berkas(r1)) === (await md5Berkas(r2)), "rentang: md5 MP4 berbeda antara 1 dan 2 pekerja");
});

daftar("(b) contoh-dasar 65 frame (2 segmen): MP4 identik untuk --paralel 1 dan 2", async () => {
  const [a, b] = [j("contoh-1.mp4"), j("contoh-2.mp4")];
  for (const [f, n] of [[a, "1"], [b, "2"]]) {
    const r = await renderKe([contoh, "--out", f, "--paralel", n, "--dari", "0", "--sampai", "64"]);
    tegas(r.kode === 0, `--paralel ${n}: exit ${r.kode}: ${r.err}`);
  }
  tegas(video(await probe(a)).nb_read_frames === "65", "bukan 65 frame");
  tegas((await md5Berkas(a)) === (await md5Berkas(b)), "md5 MP4 contoh-dasar berbeda antara 1 dan 2 pekerja");
});

daftar("(c) tangkapan jalur segmen = tangkapan berurutan satu proses (transisi-galeri frame 245..250, efek awal-dingin)", async () => {
  const props = JSON.parse(readFileSync(join(akar, "templates", "transisi-galeri", "props.json"), "utf8"));
  // referensi: satu proses menangkap berurutan dari frame 200 (frame 245 dan seterusnya sudah hangat)
  const jaring = buatJaring({});
  const sesi = await bukaSesi({ url: urlKomposisi(galeri), props, exe: cariBrowser(), jaring, skalaRaster: 1 });
  const ref = new Map();
  try {
    for (let n = 200; n <= 250; n++) {
      const buf = await sesi.ambil(n);
      ref.set(n, new Bun.CryptoHasher("md5").update(buf).digest("hex"));
    }
  } finally {
    await sesi.tutup();
  }
  // jalur segmen: segmen mulai di frame 245 (pemanasan 243 dan 244, dibuang)
  const manifest = j("galeri.md5");
  const r = await renderKe([galeri, "--out", j("galeri.mp4"), "--props-file", join(akar, "templates", "transisi-galeri", "props.json"),
    "--dari", "245", "--sampai", "250", "--paralel", "2", "--md5-tangkapan", manifest]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const baris = readFileSync(manifest, "utf8").trim().split("\n");
  tegas(baris.length === 6, `manifest ${baris.length} baris, seharusnya 6`);
  const beda = [];
  for (const l of baris) {
    const [n, h] = l.split(" ");
    if (ref.get(Number(n)) !== h) beda.push(n);
  }
  tegas(beda.length === 0, `tangkapan berbeda dari tangkapan berurutan pada frame: ${beda.join(", ")}`);
});

daftar("(d) --tangkap jpeg: MP4 valid dan ditandai draf; nilai tidak valid atau bersama --still -> exit 2", async () => {
  const f = j("jpeg.mp4");
  const r = await renderKe([contoh, "--out", f, "--tangkap", "jpeg", "--dari", "0", "--sampai", "29"]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  tegas(/draf/.test(r.err) && /lossy/.test(r.err), `peringatan draf/lossy tidak tercetak: ${r.err}`);
  const v = video(await probe(f));
  tegas(v.codec_name === "h264" && v.nb_read_frames === "30" && v.width === 1280, `jpeg: ${v.codec_name} ${v.nb_read_frames} frame ${v.width}x${v.height}`);
  const salah = await renderKe([contoh, "--out", j("x.mp4"), "--tangkap", "bmp"]);
  tegas(salah.kode === 2, `--tangkap bmp harus exit 2, dapat ${salah.kode}`);
  const still = await renderKe([contoh, "--out", j("x.png"), "--tangkap", "jpeg", "--still", "3"]);
  tegas(still.kode === 2, `--tangkap jpeg bersama --still harus exit 2, dapat ${still.kode}`);
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    const p = await renderKe([contoh, "--out", j("x.mp4"), "--paralel", bad]);
    tegas(p.kode === 2, `--paralel ${bad} harus exit 2, dapat ${p.kode}`);
  }
});

daftar("(e) satu pekerja gagal: exit non-nol, tanpa keluaran, tanpa berkas sementara, tanpa sisa Chromium", async () => {
  const k = tulisKomposisi("gagal.html", { frame: 70, gagalDi: 45 }); // segmen ke-3 (40..59)
  const tmpPrivat = j("tmp-privat");
  mkdirSync(tmpPrivat);
  const keluar = j("keluar", "gagal.mp4");
  const mulai = Date.now();
  const r = await renderKe([k, "--out", keluar, "--paralel", "2"], { TMPDIR: tmpPrivat });
  tegas(r.kode === 1, `harus exit 1, dapat ${r.kode}: ${r.err}`);
  tegas(/pekerja sengaja gagal di frame 45/.test(r.err), `pesan galat pekerja tidak sampai ke pengguna: ${r.err}`);
  tegas(!existsSync(keluar) && !existsSync(`${keluar}.sementara`), "keluaran atau berkas .sementara tersisa");
  const sisa = readdirSync(tmpPrivat);
  tegas(sisa.length === 0, `berkas sementara tersisa: ${sisa.join(", ")}`);
  const pg = await jalankan(["pgrep", "-f", tmpPrivat]);
  tegas(pg.kode === 1 && pg.out.trim() === "", `proses tersisa yang memakai folder sementara render (Chromium/ffmpeg): ${pg.out}`);
  tegas(Date.now() - mulai < 60000, "render gagal terlalu lama (pekerja lain tidak dihentikan?)");
  // kegagalan di segmen pertama pun gagal-tertutup
  const k0 = tulisKomposisi("gagal0.html", { frame: 70, gagalDi: 3 });
  const r0 = await renderKe([k0, "--out", j("gagal0.mp4"), "--paralel", "1"], { TMPDIR: tmpPrivat });
  tegas(r0.kode === 1 && !existsSync(j("gagal0.mp4")), `segmen pertama gagal: exit ${r0.kode}`);
  tegas(readdirSync(tmpPrivat).length === 0, "berkas sementara tersisa setelah kegagalan segmen pertama");
});

daftar("(f) audio dan subtitle di tahap akhir tunggal: video identik dengan render tanpa keduanya", async () => {
  const k = tulisKomposisi("av.html", { frame: 50 }); // 5 detik, 3 segmen
  const wav = j("nada.wav");
  const g = await jalankan(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", wav]);
  tegas(g.kode === 0, `ffmpeg sine gagal: ${g.err}`);
  const vtt = j("teks.vtt");
  writeFileSync(vtt, "WEBVTT\n\n00:00:00.500 --> 00:00:02.500\nHalo awvd\n\n00:00:03.000 --> 00:00:04.900\nBaris kedua\n");
  const [polos, av3, sub] = [j("polos.mp4"), j("av-3.mp4"), j("sub.mp4")];
  let r = await renderKe([k, "--out", polos, "--paralel", "1"]);
  tegas(r.kode === 0, `polos: ${r.err}`);
  r = await renderKe([k, "--out", av3, "--paralel", "3", "--audio", wav]);
  tegas(r.kode === 0, `audio: ${r.err}`);
  r = await renderKe([k, "--out", sub, "--paralel", "2", "--subtitle", vtt]);
  tegas(r.kode === 0, `subtitle: ${r.err}`);
  const info = await probe(av3);
  tegas(info.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"), "tidak ada aac");
  const dur = Number(info.format.duration);
  tegas(Math.abs(dur - 5) < 0.15, `durasi ${dur}`);
  tegas((await probe(sub)).streams.some((s) => s.codec_type === "subtitle" && s.codec_name === "mov_text"), "tidak ada mov_text");
  const fpolos = await framemd5(polos);
  tegas(fpolos === (await framemd5(av3)), "isi frame video berubah setelah audio dipasang (seharusnya -c:v copy)");
  tegas(fpolos === (await framemd5(sub)), "isi frame video berubah setelah subtitle dipasang (seharusnya -c:v copy)");
});

daftar("(g) durasi = rentang frame: subtitle pendek tidak memotong; audio panjang dipotong, audio pendek di-pad", async () => {
  const k = tulisKomposisi("durasi.html", { frame: 30 }); // 3 detik, 2 segmen
  const vtt = j("durasi.vtt");
  writeFileSync(vtt, "WEBVTT\n\n00:00:00.200 --> 00:00:01.000\nSatu\n\n00:00:01.500 --> 00:00:02.500\nDua\n"); // berakhir di 2,5 s
  const panjang = j("durasi-panjang.wav");
  const pendek = j("durasi-pendek.wav");
  for (const [f, dtk] of [[panjang, 6], [pendek, 1]]) {
    const g = await jalankan(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${dtk}`, f]);
    tegas(g.kode === 0, `ffmpeg sine gagal: ${g.err}`);
  }
  const polos = j("durasi-polos.mp4");
  const rp = await renderKe([k, "--out", polos, "--paralel", "1"]);
  tegas(rp.kode === 0, `polos: ${rp.err}`);
  const fpolos = await framemd5(polos);
  const kasus = [
    ["subtitle saja", ["--subtitle", vtt], false],
    ["audio panjang + subtitle", ["--audio", panjang, "--subtitle", vtt], true],
    ["audio pendek + subtitle", ["--audio", pendek, "--subtitle", vtt], true],
    ["audio panjang tanpa subtitle", ["--audio", panjang], true],
  ];
  for (const [nama, args, adaAudio] of kasus) {
    const f = j(`durasi-${nama.replaceAll(" ", "-").replaceAll("+", "p")}.mp4`);
    const r = await renderKe([k, "--out", f, "--paralel", "1", ...args]);
    tegas(r.kode === 0, `${nama}: exit ${r.kode}: ${r.err}`);
    const info = await probe(f);
    const v = video(info);
    tegas(v.nb_read_frames === "30", `${nama}: ${v.nb_read_frames} frame, seharusnya 30`);
    tegas(Math.abs(Number(v.duration) - 3) < 0.05, `${nama}: durasi video ${v.duration} s, seharusnya 3`);
    tegas(Math.abs(Number(info.format.duration) - 3) < 0.1, `${nama}: durasi MP4 ${info.format.duration} s, seharusnya 3`);
    tegas((await framemd5(f)) === fpolos, `${nama}: isi frame video berubah (seharusnya -c:v copy)`);
    if (adaAudio) {
      const a = info.streams.find((s) => s.codec_type === "audio");
      tegas(a && Math.abs(Number(a.duration) - 3) < 0.1, `${nama}: durasi audio ${a?.duration} s, seharusnya 3 (dipotong atau di-pad)`);
      const m = /kenyaringan: I=(-?[\d.]+) LUFS, TP=(-?[\d.]+) dBTP/.exec(r.err);
      tegas(m, `${nama}: laporan kenyaringan tidak ada: ${r.err}`);
      if (nama !== "audio pendek + subtitle") tegas(Math.abs(Number(m[1]) + 16) < 1.5 && Number(m[2]) <= -1.4, `${nama}: kenyaringan I=${m[1]} TP=${m[2]} menyimpang dari -16 LUFS / -1,5 dBTP`);
    }
    if (args.includes("--subtitle")) tegas(info.streams.some((s) => s.codec_type === "subtitle" && s.codec_name === "mov_text"), `${nama}: trek subtitle hilang`);
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
