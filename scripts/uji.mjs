#!/usr/bin/env bun
/**
 * uji.mjs — uji otomatis renderer awvd (tanpa dependensi tambahan).
 * Menjalankan render.mjs ke direktori sementara dan menegaskan hasilnya
 * dengan ffprobe/ffmpeg. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji.mjs [--simpan DIR]   # salin PNG still ke DIR (artefak CI)
 */
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const render = join(akar, "scripts", "render.mjs");
const contoh = join(akar, "templates", "contoh-dasar", "index.html");
const simpanIdx = process.argv.indexOf("--simpan");
const simpanDir = simpanIdx > 0 ? process.argv[simpanIdx + 1] : null;
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-"));

const hasil = [];
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}

async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
async function renderKe(args) {
  return jalankan(["bun", render, ...args]);
}
async function probe(file) {
  const r = await jalankan(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file]);
  tegas(r.kode === 0, `ffprobe gagal: ${r.err}`);
  return JSON.parse(r.out);
}
const video = (j) => j.streams.find((s) => s.codec_type === "video");
async function framemd5(file) {
  const r = await jalankan(["ffmpeg", "-v", "error", "-i", file, "-f", "framemd5", "-"]);
  tegas(r.kode === 0, `framemd5 gagal: ${r.err}`);
  return r.out.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").slice(-1)[0].trim()).join("\n");
}

// kenyaringan hasil (EBU R 128, true peak) lewat ffmpeg ebur128
async function ukurKenyaringan(file) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  tegas(r.kode === 0, `ebur128 gagal: ${r.err}`);
  const ringkas = r.err.slice(r.err.lastIndexOf("Summary:"));
  const m = ringkas.match(/I:\s+(-?[\d.]+)\s+LUFS/);
  tegas(m, `ringkasan ebur128 tidak terbaca: ${ringkas}`);
  return Number(m[1]);
}
// sinyal uji 3 s (lebih pendek dari video 6 s: sekaligus menguji apad)
async function buatNada() {
  const wav = join(tmp, "nada.wav");
  const g = await jalankan(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", wav]);
  tegas(g.kode === 0, `ffmpeg sine gagal: ${g.err}`);
  return wav;
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

const utama = join(tmp, "utama.mp4");

daftar("(a) properti video: h264 High 1280x720 30fps 180 frame yuv420p bt709 tv 6 s", async () => {
  const r = await renderKe([contoh, "--out", utama]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const v = video(await probe(utama));
  tegas(v.codec_name === "h264", `codec ${v.codec_name}`);
  tegas(v.width === 1280 && v.height === 720, `dimensi ${v.width}x${v.height}`);
  tegas(v.r_frame_rate === "30/1", `fps ${v.r_frame_rate}`);
  tegas(v.nb_read_frames === "180", `frame ${v.nb_read_frames}`);
  tegas(v.pix_fmt === "yuv420p", `pix_fmt ${v.pix_fmt}`);
  tegas(v.profile === "High", `profil ${v.profile}`);
  tegas(
    v.color_space === "bt709" && v.color_primaries === "bt709" && v.color_transfer === "bt709",
    `warna ${v.color_space}/${v.color_primaries}/${v.color_transfer}`,
  );
  tegas(v.color_range === "tv", `rentang warna ${v.color_range}`);
  const dur = Number((await probe(utama)).format.duration);
  tegas(Math.abs(dur - 6) < 0.05, `durasi ${dur}`);
});

daftar("(b) determinisme: dua render -> framemd5 identik", async () => {
  const dua = join(tmp, "kedua.mp4");
  const r = await renderKe([contoh, "--out", dua]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const [a, b] = [await framemd5(utama), await framemd5(dua)];
  tegas(a.split("\n").length === 180, "framemd5 tidak 180 baris");
  tegas(a === b, "framemd5 dua render berbeda");
});

daftar("(c) --still -> PNG 1280x720", async () => {
  const png = join(tmp, "still.png");
  const r = await renderKe([contoh, "--out", png, "--still", "60"]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const v = video(await probe(png));
  tegas(v.codec_name === "png" && v.width === 1280 && v.height === 720, `still ${v.codec_name} ${v.width}x${v.height}`);
  if (simpanDir) {
    mkdirSync(simpanDir, { recursive: true });
    copyFileSync(png, join(simpanDir, "still-60.png"));
  }
});

daftar("(d) --dari 30 --sampai 59 -> 30 frame", async () => {
  const f = join(tmp, "rentang.mp4");
  const r = await renderKe([contoh, "--out", f, "--dari", "30", "--sampai", "59"]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  tegas(video(await probe(f)).nb_read_frames === "30", "bukan 30 frame");
});

daftar("(e) --audio -> aac 48 kHz, durasi ~6 s, kenyaringan -16 LUFS +-1", async () => {
  const wav = await buatNada();
  const f = join(tmp, "audio.mp4");
  const r = await renderKe([contoh, "--out", f, "--audio", wav]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const j = await probe(f);
  const a = j.streams.find((s) => s.codec_type === "audio");
  tegas(a && a.codec_name === "aac", "tidak ada aac");
  const dur = Number(j.format.duration);
  tegas(Math.abs(dur - 6) < 0.15, `durasi ${dur}`);
  tegas(a.sample_rate === "48000", `sample rate ${a.sample_rate}`);
  tegas(a.channels === 2, `kanal ${a.channels}`);
  const lufs = await ukurKenyaringan(f);
  tegas(Math.abs(lufs - -16) <= 1, `kenyaringan ${lufs} LUFS, target -16 +-1`);
});

daftar("(f) --subtitle .vtt -> mov_text", async () => {
  const vtt = join(tmp, "teks.vtt");
  writeFileSync(vtt, "WEBVTT\n\n00:00:00.500 --> 00:00:02.500\nHalo awvd\n\n00:00:03.000 --> 00:00:05.000\nBaris kedua\n");
  const f = join(tmp, "sub.mp4");
  const r = await renderKe([contoh, "--out", f, "--subtitle", vtt, "--bahasa", "ind"]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const s = (await probe(f)).streams.find((x) => x.codec_type === "subtitle");
  tegas(s && s.codec_name === "mov_text", "tidak ada mov_text");
  tegas(s.tags?.language === "ind", `bahasa ${s.tags?.language}`);
});

daftar("(g) --skala 0.5 -> 640x360, folder keluaran dibuat otomatis", async () => {
  const f = join(tmp, "belum", "ada", "skala.mp4");
  const r = await renderKe([contoh, "--out", f, "--skala", "0.5", "--dari", "0", "--sampai", "29"]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const v = video(await probe(f));
  tegas(v.width === 640 && v.height === 360, `dimensi ${v.width}x${v.height}`);
});

daftar("(j) determinisme pada --skala 0.5 dan 0.75: dua render -> framemd5 identik (regresi #26)", async () => {
  // Penangkapan dengan clip.scale < 1 menghasilkan raster yang berbeda +-1 pada batas tile secara
  // acak; 60 frame per render membuat selisih hampir pasti terdeteksi bila perbaikan hilang.
  for (const s of ["0.5", "0.75"]) {
    const [a, b] = [join(tmp, `skala-${s}-a.mp4`), join(tmp, `skala-${s}-b.mp4`)];
    for (const f of [a, b]) {
      const r = await renderKe([contoh, "--out", f, "--skala", s, "--dari", "0", "--sampai", "59"]);
      tegas(r.kode === 0, `render --skala ${s} exit ${r.kode}: ${r.err}`);
    }
    const lebar = Math.round(1280 * Number(s));
    const tinggi = Math.round(720 * Number(s)) & ~1;
    const v = video(await probe(a));
    tegas(v.width === (lebar & ~1) && v.height === tinggi, `--skala ${s}: dimensi ${v.width}x${v.height}`);
    const [ma, mb] = [await framemd5(a), await framemd5(b)];
    tegas(ma.split("\n").length === 60, `--skala ${s}: framemd5 tidak 60 baris`);
    tegas(ma === mb, `--skala ${s}: framemd5 dua render berbeda`);
  }
  // --still ikut jalur yang sama
  const [p1, p2] = [join(tmp, "skala-a.png"), join(tmp, "skala-b.png")];
  for (const f of [p1, p2]) {
    const r = await renderKe([contoh, "--out", f, "--skala", "0.5", "--still", "7"]);
    tegas(r.kode === 0, `still --skala 0.5 exit ${r.kode}: ${r.err}`);
  }
  const vs = video(await probe(p1));
  tegas(vs.width === 640 && vs.height === 360, `still --skala 0.5: dimensi ${vs.width}x${vs.height}`);
  tegas((await framemd5(p1)) === (await framemd5(p2)), "still --skala 0.5 berbeda antar render");
});

daftar("(h) halaman tanpa window.video -> exit != 0", async () => {
  const html = join(tmp, "kosong.html");
  writeFileSync(html, "<!doctype html><title>kosong</title><p>tanpa defineVideo</p>");
  const r = await renderKe([html, "--out", join(tmp, "kosong.mp4")]);
  tegas(r.kode !== 0, "seharusnya gagal");
  tegas(/window\.video/.test(r.err), `pesan galat tidak menyebut window.video: ${r.err}`);
});

daftar("(i) --kenyaringan siaran -> -23 LUFS +-1; nilai tidak valid -> exit 2", async () => {
  const wav = await buatNada();
  const f = join(tmp, "siaran.mp4");
  const r = await renderKe([contoh, "--out", f, "--audio", wav, "--kenyaringan", "siaran", "--sampai", "89"]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const lufs = await ukurKenyaringan(f);
  tegas(Math.abs(lufs - -23) <= 1, `kenyaringan ${lufs} LUFS, target -23 +-1`);
  const x = await renderKe([contoh, "--out", join(tmp, "salah.mp4"), "--audio", wav, "--kenyaringan", "keras"]);
  tegas(x.kode === 2, `nilai tidak valid harus exit 2, dapat ${x.kode}`);
});

const t0 = Date.now();
let gagal = 0;
try {
  for (const [nama, fn] of uji) {
    const t = Date.now();
    try {
      await fn();
      hasil.push(`LOLOS  ${nama} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    } catch (e) {
      gagal++;
      hasil.push(`GAGAL  ${nama}: ${e.message}`);
    }
    console.log(hasil[hasil.length - 1]);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${uji.length - gagal}/${uji.length} lolos, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(gagal ? 1 : 0);
