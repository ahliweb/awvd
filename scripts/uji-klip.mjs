#!/usr/bin/env bun
/**
 * uji-klip.mjs — uji video di dalam video (klip.mjs, audio.mjs, helper runtime, templat).
 * Klip dan audio uji dibuat ffmpeg lavfi di folder sementara; tidak ada aset pihak ketiga.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-klip.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  kreditLengkap, namaLisensi, sha256Berkas, validasiManifest,
} from "./klip.mjs";
import {
  batasiKemiringan, ekspresiEnvelope, tabelPemegang, titikPatah, validasiRencana,
} from "./audio.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const klipMjs = join(akar, "scripts", "klip.mjs");
const audioMjs = join(akar, "scripts", "audio.mjs");
const renderMjs = join(akar, "scripts", "render.mjs");
const runtimeJs = join(akar, "scripts", "runtime.js");
const templat = join(akar, "templates", "klip-tertanam");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-klip-"));

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function dekat(nyata, harapan, eps, nama) {
  tegas(Math.abs(nyata - harapan) <= eps, `${nama}: dapat ${nyata}, harapan ${harapan} (+-${eps})`);
}
function samaDengan(nyata, harapan, nama) {
  tegas(nyata === harapan, `${nama}: dapat ${JSON.stringify(nyata)}, harapan ${JSON.stringify(harapan)}`);
}
function memuat(teks, potongan, nama) {
  tegas(teks.includes(potongan), `${nama}: "${potongan}" tidak ada dalam:\n${teks}`);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const bun = (...a) => jalankan(["bun", ...a]);
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
  return r;
}
const j = (...p) => join(tmp, ...p);
const tulisJson = (berkas, obj) => writeFileSync(berkas, JSON.stringify(obj, null, 2));
const salin = (o) => JSON.parse(JSON.stringify(o));

// RMS (dB) sinyal setelah penyaring pita berorde tinggi (4 biquad berantai) pada jendela [mulai, mulai+durasi)
const hp = (f) => Array(4).fill(`highpass=f=${f}`).join(",");
const lp = (f) => Array(4).fill(`lowpass=f=${f}`).join(",");
async function rms(berkas, mulai, durasi, filtro) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-ss", String(mulai), "-t", String(durasi),
    "-i", berkas, "-af", `${filtro},astats=metadata=0`, "-f", "null", "-"]);
  tegas(r.kode === 0, `astats gagal: ${r.err}`);
  const m = [...r.err.matchAll(/RMS level dB:\s+(-?[\d.]+|-inf)/g)].at(-1);
  tegas(m, `RMS tidak terbaca: ${r.err}`);
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}
async function psnr(a, b) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"]);
  tegas(r.kode === 0, `psnr gagal: ${r.err}`);
  const m = /average:(\S+)/.exec(r.err);
  tegas(m, `psnr tidak terbaca: ${r.err}`);
  return m[1] === "inf" ? Infinity : Number(m[1]);
}
async function probeAudio(berkas) {
  const r = await jalankan(["ffprobe", "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,duration_ts,codec_name", "-of", "json", berkas]);
  tegas(r.kode === 0, `ffprobe gagal: ${r.err}`);
  return JSON.parse(r.out).streams[0];
}

// ---------------------------------------------------------- bahan uji (lazy)
let bahanJanji;
function bahan() {
  bahanJanji ??= (async () => {
    const warna = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
    await ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2",
      "-f", "lavfi", "-i", "sine=f=1000:d=2:sample_rate=48000",
      "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", ...warna, "-c:a", "aac", j("src.mp4"));
    const sinus = (nama, f, d) => ffmpeg("-f", "lavfi", "-i", `sine=f=${f}:d=${d}:sample_rate=48000`, "-c:a", "pcm_s16le", j(nama));
    await Promise.all([sinus("n250.wav", 250, 6), sinus("k1200.wav", 1200, 8), sinus("k2400.wav", 2400, 6), sinus("m600.wav", 600, 20)]);
    return { sha: await sha256Berkas(j("src.mp4")) };
  })();
  return bahanJanji;
}
async function manifestDasar() {
  const { sha } = await bahan();
  return {
    proyek: { tujuan: "nonkomersial" },
    sumber: [{
      id: "pola", berkas: "src.mp4", sha256: sha, judul: "Pola uji", pencipta: "Proyek awvd",
      sumberUrl: "https://github.com/ahliweb/awvd", lisensi: "CC0-1.0",
      perubahan: "dipotong; diperkecil; dibuat ulang per frame",
    }],
    klip: [{ id: "k1", sumber: "pola", lebar: 320, tinggi: 180, dari: 0, panjang: 2 }],
  };
}
async function klipDengan(nama, ubah, ekstra = []) {
  const m = await manifestDasar();
  ubah?.(m);
  const berkas = j(`${nama}.json`);
  tulisJson(berkas, m);
  const out = j(`out-${nama}`);
  const r = await bun(klipMjs, berkas, "--fps", "30", "--out", out, ...ekstra);
  return { ...r, out, berkas };
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

// =========================================================== (a) manifest
daftar("(a) manifest ditolak (exit 2, pesan tepat): ND, NC+komersial, atribusi kosong, hash salah, BY-SA tanpa lisensiKeluaran", async () => {
  let r = await klipDengan("nd", (m) => { m.sumber[0].lisensi = "CC-BY-ND-4.0"; });
  samaDengan(r.kode, 2, "ND exit");
  memuat(r.err, 'sumber "pola": lisensi CC-BY-ND-4.0 (ND) ditolak', "ND");
  tegas(!existsSync(r.out), "folder keluaran tidak boleh dibuat saat manifest ditolak");

  r = await klipDengan("nc", (m) => { m.proyek.tujuan = "komersial"; m.sumber[0].lisensi = "CC-BY-NC-4.0"; });
  samaDengan(r.kode, 2, "NC exit");
  memuat(r.err, "lisensi CC-BY-NC-4.0 (NC) ditolak untuk proyek komersial", "NC komersial");

  r = await klipDengan("atr", (m) => { m.sumber[0].pencipta = ""; m.sumber[0].sumberUrl = " "; });
  samaDengan(r.kode, 2, "atribusi exit");
  memuat(r.err, 'atribusi kosong: "pencipta" wajib', "pencipta kosong");
  memuat(r.err, 'atribusi kosong: "sumberUrl" wajib', "sumberUrl kosong");

  r = await klipDengan("hash", (m) => { m.sumber[0].sha256 = "0".repeat(64); });
  samaDengan(r.kode, 2, "hash exit");
  memuat(r.err, "hash tidak cocok", "hash");

  r = await klipDengan("sa", (m) => { m.sumber[0].lisensi = "CC-BY-SA-4.0"; });
  samaDengan(r.kode, 2, "BY-SA exit");
  memuat(r.err, "proyek.lisensiKeluaran wajib diisi CC-BY-SA-x.y", "BY-SA tanpa lisensiKeluaran");
});

daftar("(a2) validasi lisensi: kosong/tak dikenal, STOK tanpa bukti, BY-SA kompatibel, NC nonkomersial lolos", async () => {
  const m0 = await manifestDasar();
  const cek = async (ubah) => {
    const m = salin(m0);
    ubah(m);
    return (await validasiManifest(m, tmp)).galat;
  };
  samaDengan((await cek(() => {})).length, 0, "manifest dasar valid");
  memuat((await cek((m) => { m.sumber[0].lisensi = ""; })).join("\n"), "lisensi kosong ditolak", "lisensi kosong");
  memuat((await cek((m) => { delete m.sumber[0].lisensi; })).join("\n"), "lisensi kosong ditolak", "lisensi hilang");
  memuat((await cek((m) => { m.sumber[0].lisensi = "Bebas-Pakai"; })).join("\n"), 'lisensi "Bebas-Pakai" tidak dikenal', "tak dikenal");
  memuat((await cek((m) => { m.sumber[0].lisensi = "STOK:acme"; })).join("\n"), 'wajib disertai "bukti"', "STOK tanpa bukti");
  samaDengan((await cek((m) => { m.sumber[0].lisensi = "STOK:acme"; m.sumber[0].bukti = "https://contoh.invalid/lisensi"; })).length, 0, "STOK dengan bukti");
  samaDengan((await cek((m) => { m.sumber[0].lisensi = "CC-BY-NC-4.0"; })).length, 0, "NC pada nonkomersial");
  samaDengan((await cek((m) => { m.sumber[0].lisensi = "CC-BY-4.0"; })).length, 0, "CC-BY");
  samaDengan((await cek((m) => { m.sumber[0].lisensi = "PDM-1.0"; })).length, 0, "PDM");
  const sa = (lk) => (m) => { m.sumber[0].lisensi = "CC-BY-SA-4.0"; if (lk) m.proyek.lisensiKeluaran = lk; };
  samaDengan((await cek(sa("CC-BY-SA-4.0"))).length, 0, "BY-SA + keluaran BY-SA 4.0");
  memuat((await cek(sa("CC-BY-4.0"))).join("\n"), "tidak kompatibel", "BY-SA + keluaran BY");
  memuat((await cek(sa("CC-BY-SA-3.0"))).join("\n"), "lebih lama", "BY-SA 4.0 + keluaran 3.0");
  memuat((await cek((m) => { m.proyek.tujuan = "mungkin"; })).join("\n"), "proyek.tujuan wajib", "tujuan tak valid");
  memuat((await cek((m) => { m.sumber[0].perubahan = ""; })).join("\n"), '"perubahan" wajib', "perubahan kosong");
  memuat((await cek((m) => { m.klip[0].sumber = "tidak-ada"; })).join("\n"), 'sumber "tidak-ada" tidak ada', "klip merujuk sumber hilang");
  // tanpaJudul dan penciptaAnonim melonggarkan atribusi
  samaDengan((await cek((m) => { m.sumber[0].judul = ""; m.sumber[0].tanpaJudul = true; m.sumber[0].pencipta = ""; m.sumber[0].penciptaAnonim = true; })).length, 0, "tanpaJudul + anonim");
});

// ========================================================== (b) ekstraksi
daftar("(b) ekstraksi: frame identik dua kali, cache hit, props dan atribusi", async () => {
  const a = await klipDengan("eks-a", null);
  samaDengan(a.kode, 0, `klip.mjs exit (${a.err})`);
  const props = JSON.parse(readFileSync(j("out-eks-a", "klip-props.json"), "utf8"));
  const k = props.klip[0];
  samaDengan(k.jumlah, 60, "jumlah");
  samaDengan(k.fps, 30, "fps");
  tegas(k.akar.startsWith("file://"), "akar harus URL file://");
  samaDengan(k.ekstensi, "jpg", "ekstensi");
  tegas(k.audio && existsSync(join(j("out-eks-a"), k.audio)), "audio klip harus diekstrak");
  memuat(readFileSync(j("out-eks-a", "atribusi.txt"), "utf8"), '"Pola uji" oleh Proyek awvd. Sumber: https://github.com/ahliweb/awvd. Lisensi: CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Diubah:', "atribusi TASL");
  const dirFrame = j("out-eks-a", k.folder);
  const meta = JSON.parse(readFileSync(join(dirFrame, "meta.json"), "utf8"));

  // dua ekstraksi berbeda (folder baru) -> hash frame identik; kunci cache sama
  const b = await bun(klipMjs, a.berkas, "--fps", "30", "--out", j("out-eks-b"));
  samaDengan(b.kode, 0, `klip.mjs b exit (${b.err})`);
  memuat(b.out, "ekstraksi", "ekstraksi kedua di folder baru");
  const metaB = JSON.parse(readFileSync(j("out-eks-b", k.folder, "meta.json"), "utf8"));
  samaDengan(metaB.framesSha256, meta.framesSha256, "hash seluruh frame dua ekstraksi");
  for (const n of ["000000", "000017", "000059"]) {
    const x = await sha256Berkas(join(dirFrame, `${n}.jpg`)), y = await sha256Berkas(j("out-eks-b", k.folder, `${n}.jpg`));
    samaDengan(x, y, `frame ${n}`);
  }

  // cache hit: tidak mengekstrak ulang (berkas tidak disentuh)
  const mtime = statSync(join(dirFrame, "000000.jpg")).mtimeMs;
  const c = await bun(klipMjs, a.berkas, "--fps", "30", "--out", j("out-eks-a"));
  samaDengan(c.kode, 0, "klip.mjs c exit");
  memuat(c.out, "cache hit", "cache hit");
  samaDengan(statSync(join(dirFrame, "000000.jpg")).mtimeMs, mtime, "mtime frame tidak berubah pada cache hit");

  // --paksa mengekstrak ulang dengan hasil identik; fps lain = kunci lain
  const d = await bun(klipMjs, a.berkas, "--fps", "30", "--out", j("out-eks-a"), "--paksa");
  memuat(d.out, "ekstraksi", "--paksa");
  samaDengan(JSON.parse(readFileSync(join(dirFrame, "meta.json"), "utf8")).framesSha256, meta.framesSha256, "hash setelah --paksa");
  const e = await bun(klipMjs, a.berkas, "--fps", "24", "--out", j("out-eks-a"));
  memuat(e.out, "ekstraksi 48 frame", "fps 24 = 48 frame, kunci cache berbeda");

  // --gabung
  tulisJson(j("dasar.json"), { judul: "Halo", jadwal: { x: 1 } });
  const g = await bun(klipMjs, a.berkas, "--fps", "30", "--out", j("out-eks-a"), "--gabung", j("dasar.json"));
  samaDengan(g.kode, 0, "gabung exit");
  const gab = JSON.parse(readFileSync(j("out-eks-a", "props-gabungan.json"), "utf8"));
  samaDengan(gab.judul, "Halo", "props dasar dipertahankan");
  samaDengan(gab.klip[0].id, "k1", "klip digabung");
  tulisJson(j("dasar-bentrok.json"), { klip: [] });
  const h = await bun(klipMjs, a.berkas, "--fps", "30", "--out", j("out-eks-a"), "--gabung", j("dasar-bentrok.json"));
  samaDengan(h.kode, 2, "props dasar bertabrakan kunci klip -> exit 2");
});

// ==================================================== (c) PSNR di video hasil
daftar("(c) frame klip di video hasil render mendekati frame sumber (PSNR area PiP) dan indeks frame benar", async () => {
  await klipDengan("pip", null);
  const props = j("out-pip", "klip-props.json");
  writeFileSync(j("pip.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#202020}#p{position:absolute;left:100px;top:80px;width:320px;height:180px}</style></head><body>
<canvas id="p"></canvas>
<script src="${pathToFileURL(runtimeJs).href}"></script>
<script>
defineVideo({ width: 640, height: 360, fps: 30, durationInFrames: 60,
  async render(frame, ctx) { await klipGambar(document.getElementById("p"), ctx.props.klip[0], frame); } });
</script></body></html>`);
  const r = await bun(renderMjs, j("pip.html"), "--props-file", props, "--dari", "10", "--sampai", "19", "--out", j("pip.mp4"));
  samaDengan(r.kode, 0, `render exit (${r.err})`);
  // frame video ke-5 (= frame komposisi 15), area PiP
  await ffmpeg("-i", j("pip.mp4"), "-vf", "select=eq(n\\,5),crop=320:180:100:80", "-frames:v", "1", j("dapat.png"));
  const rujukan = async (n) => {
    await ffmpeg("-i", j("src.mp4"), "-vf",
      `fps=30,select=eq(n\\,${n}),scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24`,
      "-frames:v", "1", j(`ref${n}.png`));
    return j(`ref${n}.png`);
  };
  const benar = await psnr(j("dapat.png"), await rujukan(15));
  const geser = await psnr(j("dapat.png"), await rujukan(20));
  console.log(`       PSNR area PiP: frame benar ${benar.toFixed(1)} dB, frame +5 ${geser.toFixed(1)} dB`);
  // Ambang dibuat relatif: nilai absolut PSNR bergantung pada penskalaan canvas
  // build Chromium (lokal ~35 dB, CI ~27 dB). Yang diuji adalah frame yang benar.
  tegas(benar >= 22, `PSNR area PiP terhadap frame sumber terlalu rendah: ${benar.toFixed(1)} dB (minimal 22)`);
  tegas(benar > geser + 10, `indeks frame salah? PSNR frame benar ${benar.toFixed(1)} dB vs frame +5 ${geser.toFixed(1)} dB (selisih minimal 10 dB)`);
});

// =========================================================== (d) audio
daftar("(d) audio: bergantian tumpang tindih narasi -> exit 2 dengan rentang frame; dua klip bersuara; konfigurasi di luar batas", async () => {
  await bahan();
  const dasar = {
    durasiFrame: 300,
    narasi: [{ id: "n1", berkas: "n250.wav", mulai: 0 }], // 6 s = frame 0..179
    klip: [{ id: "k", berkas: "k1200.wav", mulai: 150, akhir: 240, mode: "bergantian" }],
  };
  const jalan = async (nama, ubah, ekstra = []) => {
    const rn = salin(dasar);
    ubah(rn);
    tulisJson(j(`${nama}.json`), rn);
    return bun(audioMjs, j(`${nama}.json`), "--fps", "30", "--out", j(`${nama}.wav`), ...ekstra);
  };
  let r = await jalan("tabrak", () => {});
  samaDengan(r.kode, 2, "bergantian bertabrakan exit");
  memuat(r.err, "frame 150..179", "rentang tumpang tindih");
  memuat(r.err, 'narasi "n1"', "id narasi");
  memuat(r.err, 'klip "k"', "id klip");
  tegas(!existsSync(j("tabrak.wav")), "tidak boleh ada WAV saat validasi gagal");

  r = await jalan("dua", (rn) => { rn.klip[0].mulai = 200; rn.klip[0].akhir = 280; rn.klip.push({ id: "k2", berkas: "k2400.wav", mulai: 260, akhir: 290, mode: "campur" }); });
  samaDengan(r.kode, 2, "dua klip bersuara exit");
  memuat(r.err, "dua klip bersuara tumpang tindih", "dua klip");
  memuat(r.err, "frame 260..279", "rentang dua klip");

  r = await jalan("turun", (rn) => { rn.klip[0].mulai = 200; rn.klip[0].akhir = 280; rn.klip[0].mode = "campur"; rn.klip[0].turunDb = 5; });
  samaDengan(r.kode, 2, "turunDb 5 exit");
  memuat(r.err, "turunDb di luar 8..20", "turunDb");
  r = await jalan("fade", (rn) => { rn.fadeMs = 50; });
  samaDengan(r.kode, 2, "fadeMs 50 exit");
  memuat(r.err, "fadeMs di luar 100..300", "fadeMs");
  r = await jalan("tanpa-audio", (rn) => { rn.klip[0].mulai = 200; rn.klip[0].akhir = 280; delete rn.klip[0].berkas; });
  samaDengan(r.kode, 2, "klip tanpa berkas audio exit");
  memuat(r.err, 'mode "bisu"', "saran mode bisu");

  // mode bisu pada rentang narasi diperbolehkan; campur memberi peringatan; --ketat-campur menggagalkan
  const m0 = salin(dasar);
  m0.klip[0].mode = "bisu";
  const vb = await validasiRencana(m0, tmp, { fps: 30 });
  samaDengan(vb.galat.length, 0, "bisu + narasi tidak melanggar");
  const m1 = salin(dasar);
  m1.klip[0].mode = "campur";
  const vc = await validasiRencana(m1, tmp, { fps: 30 });
  samaDengan(vc.galat.length, 0, "campur + narasi bukan galat");
  memuat(vc.peringatan.join("\n"), "dua aliran ucapan bersamaan", "peringatan campur");
  const vk = await validasiRencana(salin(m1), tmp, { fps: 30, ketatCampur: true });
  memuat(vk.galat.join("\n"), "--ketat-campur", "ketat-campur menggagalkan");
  const m2 = salin(dasar);
  m2.narasi.push({ id: "n2", berkas: "n250.wav", mulai: 100 });
  m2.klip = [];
  memuat((await validasiRencana(m2, tmp, { fps: 30 })).galat.join("\n"), "dua narasi tumpang tindih", "narasi bertabrakan");
});

daftar("(e) audio campur: klip diturunkan 12 dB selama narasi, narasi dominan, WAV 48 kHz stereo identik antar-run", async () => {
  await bahan();
  // narasi 250 Hz frame 60..239; klip 1200 Hz campur frame 30..270; 10 detik total
  tulisJson(j("campur.json"), {
    durasiFrame: 300,
    narasi: [{ id: "n1", berkas: "n250.wav", mulai: 60 }],
    klip: [{ id: "k", berkas: "k1200.wav", mulai: 30, akhir: 270, mode: "campur" }],
  });
  const r1 = await bun(audioMjs, j("campur.json"), "--fps", "30", "--out", j("campur1.wav"));
  samaDengan(r1.kode, 0, `audio.mjs exit (${r1.err})`);
  memuat(r1.out, "narasi n1 + klip k (campur; klip -12 dB)", "tabel pemegang suara");
  memuat(r1.out, "klip k (campur, tanpa narasi; level normal)", "tabel pemegang suara (klip sendiri)");
  const r2 = await bun(audioMjs, j("campur.json"), "--fps", "30", "--out", j("campur2.wav"));
  samaDengan(r2.kode, 0, "audio.mjs run 2");
  tegas(Buffer.compare(readFileSync(j("campur1.wav")), readFileSync(j("campur2.wav"))) === 0, "WAV dua run harus identik byte demi byte");
  const p = await probeAudio(j("campur1.wav"));
  samaDengan(p.sample_rate, "48000", "sample rate");
  samaDengan(p.channels, 2, "kanal");
  samaDengan(String(p.duration_ts), "480000", "jumlah sampel (300 frame @ 30 fps x 1600)");

  // level klip: sendirian (1,25-1,75 s) vs selama narasi (3-6 s), pita 1200 Hz
  const sendiri = await rms(j("campur1.wav"), 1.25, 0.5, hp(900));
  const campur = await rms(j("campur1.wav"), 3, 3, hp(900));
  dekat(sendiri - campur, 12, 0.5, "klip diturunkan relatif terhadap levelnya sendiri (dB)");
  // narasi tetap dominan di atas klip selama campur (pita 250 Hz vs 1200 Hz)
  const narasi = await rms(j("campur1.wav"), 3, 3, lp(400));
  tegas(narasi - campur >= 10, `narasi harus dominan atas klip: selisih ${(narasi - campur).toFixed(1)} dB (minimal 10)`);
  // klip kembali normal setelah narasi berakhir (frame 240+; rampa naik selesai 246)
  const sesudah = await rms(j("campur1.wav"), 8.4, 0.4, hp(900));
  dekat(sesudah - sendiri, 0, 0.5, "klip kembali ke level normal setelah narasi");
});

daftar("(f) musik induk: di-duck 6 dB di bawah level bebas saat narasi, bisu saat klip bergantian", async () => {
  await bahan();
  tulisJson(j("musik.json"), {
    durasiFrame: 450,
    narasi: [{ id: "n1", berkas: "n250.wav", mulai: 60 }], // frame 60..239
    musik: { berkas: "m600.wav", levelDb: -12, bebasDb: -6 },
    klip: [{ id: "k", berkas: "k2400.wav", mulai: 300, akhir: 390, mode: "bergantian" }],
  });
  const r = await bun(audioMjs, j("musik.json"), "--fps", "30", "--out", j("musik.wav"));
  samaDengan(r.kode, 0, `audio.mjs exit (${r.err})`);
  memuat(r.out, "klip k (bergantian; musik dibisukan)", "tabel: musik dibisukan");
  const pitaMusik = `${hp(480)},${lp(800)}`;
  const bebas = await rms(j("musik.wav"), 0.2, 0.6, pitaMusik);
  const duck = await rms(j("musik.wav"), 3, 3, pitaMusik);
  dekat(bebas - duck, 6, 0.6, "musik turun dari bebasDb (-6) ke levelDb (-12) selama narasi (dB)");
  const bisu = await rms(j("musik.wav"), 10.8, 1.5, pitaMusik);
  tegas(bisu <= bebas - 30 && bisu <= -60, `musik harus bisu saat klip bergantian: ${bisu.toFixed(1)} dB (bebas ${bebas.toFixed(1)})`);
  const klipTerdengar = await rms(j("musik.wav"), 10.8, 1.5, hp(1800));
  tegas(klipTerdengar > -35, `klip bergantian harus terdengar: ${klipTerdengar.toFixed(1)} dB`);
});

daftar("(g) envelope murni: turun lebih dulu, naik mulai di batas, titik segaris dibuang", () => {
  const fade = 6;
  const T = [...Array(20).fill(1), ...Array(20).fill(0.25), ...Array(20).fill(1)];
  const G = batasiKemiringan(T, fade);
  samaDengan(G.length, 61, "panjang envelope");
  dekat(G[20], 0.25, 1e-9, "turun selesai tepat di batas (frame 20)");
  dekat(G[14], 1, 1e-9, "turun mulai fade frame sebelum batas");
  dekat(G[17], 0.75, 1e-9, "rampa turun linear (kemiringan puncak/fade per frame)");
  dekat(G[40], 0.25, 1e-9, "naik mulai di batas (frame 40)");
  dekat(G[41], 0.25 + 1 / 6, 1e-9, "naik linear");
  dekat(G[40 + fade], 1, 1e-9, "naik selesai paling lama fade frame setelah batas");
  tegas(G.every((g, f) => f === 0 || f === 60 || g <= Math.max(T[f - 1] ?? 0, T[f] ?? 0) + 1e-9), "envelope tidak boleh melebihi target");
  const pts = titikPatah(G, 30);
  tegas(pts.length <= 10, `titik patah harus ringkas: ${pts.length}`);
  const e = ekspresiEnvelope(G, 30);
  tegas(e.includes("if(lt(t") && !/[^\\],/.test(e.replace(/\\,/g, "")), "ekspresi harus lolos escape koma");
  samaDengan(ekspresiEnvelope(batasiKemiringan(new Array(10).fill(1), 6), 30), null, "gain konstan = tanpa ekspresi");
  samaDengan(JSON.stringify(batasiKemiringan(T, fade)), JSON.stringify(G), "murni: dua panggilan sama");
  const tabel = tabelPemegang({
    fps: 30, total: 30, narasi: [{ id: "n", mulai: 0, akhir: 10 }], klip: [], musik: { berkas: "m" },
  });
  memuat(tabel, "0..9", "tabel rentang");
  memuat(tabel, "narasi n", "tabel pemegang");
  memuat(tabel, "10..29", "tabel rentang musik");
});

// ====================================================== (h) helper runtime
daftar("(h) helper runtime: angka, persen, rupiah (id-ID), kenBurns, indeks/jalur frame klip, klipGambar, kreditKlip", async () => {
  const elemen = () => ({ setAttribute() {}, appendChild() {}, style: {} });
  globalThis.window = { location: { search: "" } };
  globalThis.document = { readyState: "complete", createElement: elemen, head: elemen(), documentElement: elemen() };
  await import(runtimeJs);
  const api = globalThis.window.VideoTerprogram;
  for (const k of ["gambarKosong", "indeksFrameKlip", "jalurFrameKlip", "klipGambar", "kreditKlip", "angka", "persen", "rupiah", "kenBurns"]) {
    tegas(api[k] != null && globalThis.window[k] === api[k], `${k} tidak diekspor sebagai API dan global`);
  }
  const { angka, persen, rupiah, kenBurns, indeksFrameKlip, jalurFrameKlip, klipGambar, kreditKlip } = api;
  const melempar = (fn, nama) => {
    let l = false;
    try { fn(); } catch { l = true; }
    tegas(l, `${nama}: seharusnya melempar galat`);
  };

  for (const [n, o, h] of [
    [1234567.891, undefined, "1.234.567,891"], [1000, undefined, "1.000"], [999, undefined, "999"], [0, undefined, "0"],
    [-1234.5, undefined, "-1.234,5"], [1234.5, { desimal: 2 }, "1.234,50"], [1.005, { desimal: 2 }, "1,01"],
    [2.5, { desimal: 0 }, "3"], [-2.5, { desimal: 0 }, "-3"], [-0.0001, { desimal: 2 }, "0,00"], [-0.0001, undefined, "0"],
    [0.1 + 0.2, { desimal: 2 }, "0,30"], [1e6, undefined, "1.000.000"], [12.3456, undefined, "12,346"], [-0, undefined, "0"],
  ]) samaDengan(angka(n, o), h, `angka(${n})`);
  melempar(() => angka(NaN), "angka(NaN)");
  melempar(() => angka(Infinity), "angka(Infinity)");
  melempar(() => angka(1e21), "angka(1e21)");
  melempar(() => angka(1, { desimal: -1 }), "angka desimal negatif");
  for (const [n, o, h] of [
    [0.256, undefined, "25,6%"], [0.25, undefined, "25%"], [1, undefined, "100%"], [0.07, undefined, "7%"],
    [0.256, { desimal: 0 }, "26%"], [-0.5, undefined, "-50%"], [0.123456, undefined, "12,346%"], [0, undefined, "0%"],
  ]) samaDengan(persen(n, o), h, `persen(${n})`);
  for (const [n, o, h] of [
    [1000, undefined, "Rp1.000"], [1500000, undefined, "Rp1.500.000"], [0, undefined, "Rp0"], [-1500, undefined, "-Rp1.500"],
    [1234.5, undefined, "Rp1.235"], [1234.5, { desimal: 2 }, "Rp1.234,50"], [999, undefined, "Rp999"],
  ]) samaDengan(rupiah(n, o), h, `rupiah(${n})`);

  // kenBurns: murni, ujung-ujung tepat, pusat dijepit agar tepi tidak terbuka
  const o = { mulai: 10, durasi: 20, dari: { x: 0.5, y: 0.5, skala: 1 }, ke: { x: 0.7, y: 0.3, skala: 1.2 } };
  samaDengan(kenBurns(0, o), "translate(0.0000%, 0.0000%) scale(1.000000)", "sebelum mulai = dari");
  samaDengan(kenBurns(10, o), kenBurns(-5, o), "sebelum mulai konstan");
  samaDengan(kenBurns(30, o), "translate(-10.0000%, 10.0000%) scale(1.200000)", "akhir = ke (pusat dijepit)");
  samaDengan(kenBurns(99, o), kenBurns(30, o), "sesudah selesai konstan");
  samaDengan(kenBurns(20, o), kenBurns(20, o), "murni");
  tegas(kenBurns(20, o).endsWith("scale(1.100000)"), `skala tengah linear: ${kenBurns(20, o)}`);
  samaDengan(kenBurns(20, { durasi: 20, mulai: 10, easing: api.easing.masukQuad }), "translate(0.0000%, 0.0000%) scale(1.050000)", "easing dipakai");
  melempar(() => kenBurns(0, { durasi: 0 }), "kenBurns durasi 0");
  melempar(() => kenBurns(0, { durasi: 10, ke: { skala: 0.9 } }), "kenBurns skala < 1");

  // indeks dan jalur frame klip
  const klip = { id: "k", akar: "file:///x/", folder: "abc", ekstensi: "jpg", digit: 6, jumlah: 10,
    atribusi: { judul: "J", pencipta: "P", sumberUrl: "https://contoh.invalid/j", lisensi: "CC-BY-4.0", urlLisensi: "https://creativecommons.org/licenses/by/4.0/", perubahan: "dipotong." } };
  samaDengan(indeksFrameKlip(klip, -1), -1, "indeks belum mulai");
  samaDengan(indeksFrameKlip(klip, 0), 0, "indeks 0");
  samaDengan(indeksFrameKlip(klip, 9), 9, "indeks akhir");
  samaDengan(indeksFrameKlip(klip, 15), 9, "ditahan di frame terakhir");
  samaDengan(indeksFrameKlip(klip, 15, { ulang: true }), 5, "diulang");
  samaDengan(indeksFrameKlip(klip, 3, { kecepatan: 2 }), 6, "kecepatan 2");
  melempar(() => indeksFrameKlip({ jumlah: 0 }, 0), "jumlah 0");
  melempar(() => indeksFrameKlip(klip, 0, { kecepatan: 0 }), "kecepatan 0");
  samaDengan(jalurFrameKlip(klip, 3), "file:///x/abc/000003.jpg", "jalur frame");
  samaDengan(jalurFrameKlip(klip, 99), "file:///x/abc/000009.jpg", "jalur ditahan");
  samaDengan(jalurFrameKlip(klip, -2), null, "jalur belum mulai");

  // klipGambar: set src, tunggu decode, tidak mengulang src sama, galat bila gagal
  let setSrc = 0, decode = 0, gagalDecode = false;
  const img = {
    _s: "", get src() { return this._s; }, set src(v) { this._s = v; setSrc++; },
    decode() { decode++; return gagalDecode ? Promise.reject(new Error("x")) : Promise.resolve(); },
  };
  samaDengan(await klipGambar(img, klip, 3), true, "klipGambar mengembalikan true");
  samaDengan(img.src, "file:///x/abc/000003.jpg", "klipGambar menetapkan src");
  await klipGambar(img, klip, 3);
  samaDengan(setSrc, 1, "src sama tidak ditetapkan ulang");
  samaDengan(decode, 2, "decode ditunggu setiap panggilan");
  samaDengan(await klipGambar(img, klip, -1), false, "klip belum mulai -> false");
  samaDengan(setSrc, 1, "belum mulai tidak menyentuh img");
  gagalDecode = true;
  let pesan = "";
  await klipGambar(img, klip, 4).catch((e) => { pesan = e.message; });
  memuat(pesan, "frame klip gagal dimuat", "galat decode");

  // klipGambar target <canvas>: Image lepas didekode lalu digambar sinkron ukuran asli
  let imSrc = 0, imDecode = 0, imGagal = false;
  globalThis.window.Image = class {
    constructor() { this._s = ""; this.naturalWidth = 480; this.naturalHeight = 270; }
    get src() { return this._s; }
    set src(v) { this._s = v; imSrc++; }
    decode() { imDecode++; return imGagal ? Promise.reject(new Error("x")) : Promise.resolve(); }
  };
  const panggilan = [];
  const kanvas = {
    width: 0, height: 0,
    getContext() {
      return { set imageSmoothingEnabled(v) { panggilan.push(["smooth", v]); }, clearRect() { panggilan.push(["clear"]); },
        drawImage(im, x, y) { panggilan.push(["draw", im.src, x, y]); } };
    },
  };
  samaDengan(await klipGambar(kanvas, klip, 5), true, "klipGambar canvas true");
  samaDengan(`${kanvas.width}x${kanvas.height}`, "480x270", "canvas diberi ukuran asli frame");
  samaDengan(JSON.stringify(panggilan.at(-1)), JSON.stringify(["draw", "file:///x/abc/000005.jpg", 0, 0]), "drawImage pada 0,0");
  tegas(panggilan.some((p) => p[0] === "smooth" && p[1] === false), "imageSmoothingEnabled harus false");
  await klipGambar(kanvas, klip, 5);
  samaDengan(imSrc, 1, "Image lepas dipakai ulang; src sama tidak ditetapkan ulang");
  await klipGambar(kanvas, klip, 6);
  samaDengan(imSrc, 2, "src baru ditetapkan");
  samaDengan(imDecode, 3, "decode ditunggu setiap panggilan");
  samaDengan(await klipGambar(kanvas, klip, -1), false, "canvas: belum mulai -> false");
  imGagal = true;
  pesan = "";
  await klipGambar(kanvas, klip, 7).catch((e) => { pesan = e.message; });
  memuat(pesan, "frame klip gagal dimuat", "galat decode canvas");

  // kreditKlip konsisten dengan atribusi.txt (kreditLengkap di klip.mjs)
  samaDengan(kreditKlip(klip), '"J" oleh P · CC BY 4.0 · diubah', "kredit ringkas");
  samaDengan(kreditKlip(klip, { ringkas: false }), '"J" oleh P. Sumber: https://contoh.invalid/j. Lisensi: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Diubah: dipotong.', "kredit lengkap");
  for (const lisensi of ["CC-BY-4.0", "CC-BY-SA-3.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC0-1.0", "PDM-1.0", "STOK:acme"]) {
    for (const ubah of [{}, { penciptaAnonim: true }, { tanpaJudul: true }, { tanpaJudul: true, penciptaAnonim: true }]) {
      const a = { ...klip.atribusi, lisensi, ...ubah };
      samaDengan(kreditKlip({ atribusi: a }, { ringkas: false }), kreditLengkap(a), `kreditKlip lengkap = kreditLengkap (${lisensi} ${JSON.stringify(ubah)})`);
    }
    samaDengan(kreditKlip({ atribusi: { ...klip.atribusi, lisensi } }).split(" · ").at(-2), namaLisensi(lisensi), `nama lisensi ${lisensi}`);
  }
  melempar(() => kreditKlip({}), "kreditKlip tanpa atribusi");
});

// ==================================================== (i) templat klip-tertanam
daftar("(i) templat klip-tertanam: sumber.json valid, jadwal props = rencana audio, alur klip -> audio -> render", async () => {
  const sumber = JSON.parse(readFileSync(join(templat, "sumber.json"), "utf8"));
  const v = await validasiManifest(sumber, templat);
  samaDengan(v.galat.join("; "), "", "sumber.json templat valid (termasuk sha256 klip contoh)");
  const props = JSON.parse(readFileSync(join(templat, "props.json"), "utf8"));
  const rencana = JSON.parse(readFileSync(join(templat, "rencana-audio.json"), "utf8"));
  const ringkas = (a) => a.map((k) => `${k.id}:${k.mulai}-${k.akhir}:${k.mode}`).join(",");
  samaDengan(ringkas(props.jadwal.klip), ringkas(rencana.klip), "jadwal klip props.json sama dengan rencana-audio.json");
  const html = readFileSync(join(templat, "index.html"), "utf8");
  samaDengan(Number(/durationInFrames:\s*(\d+)/.exec(html)[1]), rencana.durasiFrame, "durasi komposisi = durasiFrame rencana");

  const aud = j("contoh-audio");
  let r = await bun(join(templat, "buat-audio.mjs"), aud);
  samaDengan(r.kode, 0, `buat-audio.mjs exit (${r.err})`);
  const out = j("klip-templat");
  r = await bun(klipMjs, join(templat, "sumber.json"), "--fps", "30", "--out", out, "--gabung", join(templat, "props.json"));
  samaDengan(r.kode, 0, `klip.mjs templat exit (${r.err})`);
  const rn = salin(rencana);
  for (const n of rn.narasi) n.berkas = join(aud, n.berkas.split("/").at(-1));
  rn.musik.berkas = join(aud, "musik.wav");
  tulisJson(j("rencana-templat.json"), rn);
  r = await bun(audioMjs, j("rencana-templat.json"), "--fps", "30", "--klip-props", join(out, "klip-props.json"), "--out", j("templat.wav"));
  samaDengan(r.kode, 0, `audio.mjs templat exit (${r.err})`);
  memuat(r.out, "klip k1 (bergantian; musik dibisukan)", "tabel templat: klip bergantian");
  memuat(r.out, "narasi n2 + klip k2 (campur; klip -12 dB)", "tabel templat: campur");
  samaDengan(String((await probeAudio(j("templat.wav"))).duration_ts), String(480 * 1600), "durasi audio templat");

  r = await bun(renderMjs, join(templat, "index.html"), "--props-file", join(out, "props-gabungan.json"), "--still", "150", "--out", j("templat.png"));
  samaDengan(r.kode, 0, `render still templat exit (${r.err})`);
  tegas(statSync(j("templat.png")).size > 50000, "still templat tampak kosong");
  // determinisme: dua render rentang yang melintasi tampil/hilang klip dan caption menghasilkan frame identik
  const md5Frame = async (berkas) => (await jalankan(["ffmpeg", "-v", "error", "-i", berkas, "-f", "framemd5", "-"])).out
    .split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim()).join("\n");
  const rentang = ["--dari", "100", "--sampai", "125"];
  for (const n of ["a", "b"]) {
    r = await bun(renderMjs, join(templat, "index.html"), "--props-file", join(out, "props-gabungan.json"), ...rentang, "--out", j(`det-${n}.mp4`));
    samaDengan(r.kode, 0, `render determinisme ${n} exit (${r.err})`);
  }
  samaDengan(await md5Frame(j("det-a.mp4")), await md5Frame(j("det-b.mp4")), "frame dua render templat identik (framemd5)");
  r = await bun(renderMjs, join(templat, "index.html"), "--still", "150", "--out", j("templat-tanpa-props.png"));
  samaDengan(r.kode, 1, "tanpa props klip, render harus gagal dengan pesan jelas");
  memuat(r.err, "props tidak lengkap", "pesan props kurang");
});

// ------------------------------------------------------------------ jalankan
let gagalCount = 0;
const t0 = Date.now();
try {
  for (const [nama, fn] of uji) {
    const t = Date.now();
    try {
      await fn();
      console.log(`ok     ${nama}  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    } catch (e) {
      gagalCount++;
      console.log(`GAGAL  ${nama}\n       ${String(e.message).replace(/\n/g, "\n       ")}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${uji.length - gagalCount}/${uji.length} uji klip lolos (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(gagalCount ? 1 : 0);
