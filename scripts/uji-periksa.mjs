#!/usr/bin/env bun
/**
 * uji-periksa.mjs — uji alat QC scripts/periksa.mjs (tanpa dependensi tambahan).
 * Membuat berkas uji di direktori sementara (render.mjs dan ffmpeg lavfi), menjalankan
 * periksa.mjs, lalu menegaskan kode keluar dan hasilnya. Exit 0 bila semua lolos.
 *
 *   bun scripts/uji-periksa.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const render = join(akar, "scripts", "render.mjs");
const periksa = join(akar, "scripts", "periksa.mjs");
const contoh = join(akar, "templates", "contoh-dasar", "index.html");
const tmp = mkdtempSync(join(tmpdir(), "awvd-periksa-"));

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-v", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
}
// jalankan periksa dengan --json; kembalikan { kode, hasil, err, cari(id) }
async function periksaJson(file, ...opsi) {
  const r = await jalankan(["bun", periksa, file, "--json", ...opsi]);
  let hasil = null;
  try { hasil = JSON.parse(r.out); } catch { /* biarkan null */ }
  return { kode: r.kode, hasil, err: r.err, cari: (id) => hasil?.pemeriksaan.find((p) => p.id === id) };
}
const status = (r, id) => r.cari(id)?.status;

// Pengodean seperti render.mjs: BT.709, rentang TV, profil High, faststart.
const ENCODE_BAIK = ["-vf", "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-movflags", "+faststart"];
// Kedip hitam-putih: toggle luminans tiap `periode` frame pada 20 fps (periode 1 = 10 Hz).
const kedip = (periode) =>
  `color=c=black:s=320x180:r=20:d=2,format=yuv420p,geq=lum='255*mod(floor(N/${periode}),2)':cb=128:cr=128`;

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

let baik = null; // video 2 s hasil render.mjs dengan audio
async function videoBaik() {
  if (baik) return baik;
  const wav = join(tmp, "nada.wav");
  await ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=3", wav);
  const f = join(tmp, "baik.mp4");
  const r = await jalankan(["bun", render, contoh, "--out", f, "--audio", wav, "--sampai", "59"]);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  baik = f;
  return f;
}

daftar("(a) render contoh 2 s + audio -> periksa exit 0 (encoding, kenyaringan, kilatan)", async () => {
  const f = await videoBaik();
  const r = await periksaJson(f);
  tegas(r.kode === 0, `exit ${r.kode}: ${JSON.stringify(r.hasil?.pemeriksaan.map((p) => [p.id, p.status, p.rincian]))} ${r.err}`);
  for (const id of ["encoding", "kenyaringan", "kilatan", "kilatan-merah"]) {
    tegas(status(r, id) === "LOLOS", `${id}: ${status(r, id)}`);
  }
  const siaran = await periksaJson(f, "--kenyaringan", "siaran");
  tegas(status(siaran, "kenyaringan") === "GAGAL", "-16 LUFS seharusnya gagal target siaran (-23)");
  tegas(siaran.kode === 1, `siaran exit ${siaran.kode}`);
});

daftar("(b) kedip hitam-putih 10 Hz -> kilatan GAGAL, exit 1; kilatan merah lolos", async () => {
  const f = join(tmp, "kedip.mp4");
  await ffmpeg("-f", "lavfi", "-i", kedip(1), ...ENCODE_BAIK, f);
  const r = await periksaJson(f);
  tegas(r.kode === 1, `exit ${r.kode}`);
  tegas(status(r, "kilatan") === "GAGAL", `kilatan ${status(r, "kilatan")}`);
  tegas(r.cari("kilatan").data.maksTransisi >= 18, `transisi ${r.cari("kilatan").data.maksTransisi}`);
  tegas(status(r, "encoding") === "LOLOS", `encoding ${status(r, "encoding")}: ${r.cari("encoding").rincian}`);
  tegas(status(r, "kilatan-merah") === "LOLOS", `kilatan-merah ${status(r, "kilatan-merah")}`);
});

daftar("(b2) batas 3 flash/s: 3 Hz lolos, 3,75 Hz gagal (30 fps)", async () => {
  const buat = async (periode, nama) => {
    const f = join(tmp, nama);
    await ffmpeg("-f", "lavfi", "-i",
      `color=c=black:s=320x180:r=30:d=3,format=yuv420p,geq=lum='255*mod(floor(N/${periode}),2)':cb=128:cr=128`,
      ...ENCODE_BAIK, f);
    return periksaJson(f);
  };
  const tiga = await buat(5, "tiga.mp4");
  tegas(status(tiga, "kilatan") === "LOLOS", `3 Hz: ${status(tiga, "kilatan")}`);
  const empat = await buat(4, "empat.mp4");
  tegas(status(empat, "kilatan") === "GAGAL", `3,75 Hz: ${status(empat, "kilatan")}`);
});

daftar("(b3) kedip merah jenuh <-> hitam -> kilatan merah GAGAL", async () => {
  const f = join(tmp, "merah.mp4");
  // Y/Cb/Cr merah murni (BT.601 kasar) berganti dengan hitam tiap frame
  await ffmpeg("-f", "lavfi", "-i",
    "color=c=black:s=320x180:r=20:d=2,format=yuv420p,geq=lum='81*mod(N,2)+16*(1-mod(N,2))':cb='90*mod(N,2)+128*(1-mod(N,2))':cr='240*mod(N,2)+128*(1-mod(N,2))'",
    ...ENCODE_BAIK, f);
  const r = await periksaJson(f);
  tegas(status(r, "kilatan-merah") === "GAGAL", `kilatan-merah ${status(r, "kilatan-merah")}`);
});

daftar("(c) encode tanpa penandaan bt709 dan tanpa faststart -> encoding GAGAL", async () => {
  const f = join(tmp, "polos.mp4");
  await ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", f);
  const r = await periksaJson(f);
  tegas(r.kode === 1, `exit ${r.kode}`);
  const e = r.cari("encoding");
  tegas(e.status === "GAGAL", `encoding ${e.status}`);
  const teks = e.rincian.join("\n");
  tegas(/color_space/.test(teks), `rincian tidak menyebut color_space: ${teks}`);
  tegas(/faststart/.test(teks), `rincian tidak menyebut faststart: ${teks}`);
  tegas(status(r, "kenyaringan") === "LEWATI", `kenyaringan tanpa audio: ${status(r, "kenyaringan")}`);
  // tabel teks juga memuat GAGAL
  const t = await jalankan(["bun", periksa, f]);
  tegas(t.kode === 1 && /GAGAL\s+Encoding/.test(t.out), `tabel: ${t.out}`);
});

daftar("(d) subtitle: baris 50 karakter + cps tinggi -> GAGAL dengan nomor cue; subtitle baik lolos", async () => {
  const f = await videoBaik();
  const panjang = "abcdefghi ".repeat(6).trim().slice(0, 50);
  tegas(panjang.length === 50, "baris uji bukan 50 karakter");
  const buruk = join(tmp, "buruk.vtt");
  writeFileSync(buruk, [
    "WEBVTT", "",
    "00:00:00.000 --> 00:00:01.000", `${panjang}`, "",
    "00:00:01.200 --> 00:00:03.200", "Halo awvd", "",
    "00:00:03.000 --> 00:00:05.000", "Cue ketiga tumpang tindih", "",
    "00:00:05.500 --> 00:00:05.800", "Terlalu singkat", "",
  ].join("\n"));
  const r = await periksaJson(f, "--subtitle", buruk);
  tegas(r.kode === 1, `exit ${r.kode}`);
  const s = r.cari("subtitle");
  tegas(s.status === "GAGAL", `subtitle ${s.status}`);
  const jenis = (j, cue) => s.data.masalah.some((m) => m.jenis === j && m.cue === cue);
  tegas(jenis("baris-terlalu-panjang", 1), "cue 1 harus melebihi 42 karakter");
  tegas(jenis("cps-terlalu-tinggi", 1), "cue 1 harus melebihi cps");
  tegas(jenis("durasi-terlalu-pendek", 4), "cue 4 harus terlalu pendek");
  tegas(s.data.masalah.some((m) => m.jenis === "tumpang-tindih"), "cue 2 dan 3 harus tumpang tindih");
  tegas(s.rincian.some((x) => /cue 1:/.test(x)), `rincian tanpa nomor cue: ${s.rincian}`);
  // subtitle baik: SRT juga
  const baikVtt = join(tmp, "baik.vtt");
  writeFileSync(baikVtt, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHalo awvd\n\n00:00:01.200 --> 00:00:02.200\nSelamat datang\n");
  const ok = await periksaJson(f, "--subtitle", baikVtt);
  tegas(ok.kode === 0 && ok.cari("subtitle").status === "LOLOS", `subtitle baik: exit ${ok.kode} ${JSON.stringify(ok.cari("subtitle"))}`);
  const baikSrt = join(tmp, "baik.srt");
  writeFileSync(baikSrt, "1\n00:00:00,000 --> 00:00:01,000\nHalo awvd\n\n2\n00:00:01.200 --> 00:00:02.200\nSelamat datang\n");
  const ok2 = await periksaJson(f, "--subtitle", baikSrt);
  tegas(ok2.kode === 0 && ok2.cari("subtitle").data.cue === 2, "SRT baik harus lolos dengan 2 cue");
  // --cps ketat membuat cue baik gagal
  const ketat = await periksaJson(f, "--subtitle", baikVtt, "--cps", "5");
  tegas(ketat.kode === 1 && ketat.cari("subtitle").data.masalah.some((m) => m.jenis === "cps-terlalu-tinggi"), "--cps 5 harus gagal");
});

daftar("(d2) subtitle: cue yang bisa dipecah lebih baik -> PERINGATAN, exit 0", async () => {
  const f = await videoBaik();
  const vtt = join(tmp, "saran.vtt");
  // dua baris sah (<= 42), tetapi pecahBaris memilih potongan lain ("...mendaftar layanan" / "secara daring ...")
  writeFileSync(vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nWarga dapat mendaftar\nlayanan secara daring melalui situs resmi\n");
  const r = await periksaJson(f, "--subtitle", vtt);
  const s = r.cari("subtitle");
  tegas(s.status === "PERINGATAN" && r.kode === 0, `status ${s.status}, exit ${r.kode}: ${JSON.stringify(s.rincian)}`);
  tegas(s.data.peringatan[0].cue === 1, "peringatan harus menyebut cue 1");
});

daftar("(e) argumen salah -> exit 2", async () => {
  const f = await videoBaik();
  const kasus = [
    [],
    [f, "--jenis", "iklan"],
    [f, "--kenyaringan", "mati"],
    [f, "--cps", "0"],
    [join(tmp, "tidak-ada.mp4")],
    [f, "--subtitle", join(tmp, "tidak-ada.vtt")],
    [join(tmp, "nada.wav")], // tanpa trek video
    [f, f],
  ];
  for (const a of kasus) {
    const r = await jalankan(["bun", periksa, ...a]);
    tegas(r.kode === 2, `${JSON.stringify(a)}: exit ${r.kode}, harapan 2 (${r.err.split("\n")[0]})`);
  }
});

daftar("(f) --json menghasilkan JSON valid; --jenis penjelasan/promo memengaruhi durasi", async () => {
  const f = await videoBaik();
  const r = await jalankan(["bun", periksa, f, "--json", "--jenis", "penjelasan"]);
  const j = JSON.parse(r.out);
  tegas(typeof j.lolos === "boolean" && Array.isArray(j.pemeriksaan), "bentuk JSON tidak sesuai");
  tegas(j.lolos === (r.kode === 0), "lolos tidak konsisten dengan exit code");
  for (const p of j.pemeriksaan) {
    tegas(["LOLOS", "GAGAL", "PERINGATAN", "INFO", "LEWATI"].includes(p.status), `status ${p.status}`);
  }
  const d = j.pemeriksaan.find((p) => p.id === "durasi");
  tegas(d.status === "LOLOS", `durasi penjelasan 2 s: ${d.status}`);
  const pr = (await periksaJson(f, "--jenis", "promo")).cari("durasi");
  tegas(pr.status === "INFO", `durasi promo: ${pr.status}`);
  const teks = await jalankan(["bun", periksa, f]);
  tegas(/LOLOS\s+Encoding/.test(teks.out) && /bukan sertifikasi PEAT/.test(teks.out), "tabel teks tidak lengkap");
});

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
