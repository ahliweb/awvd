#!/usr/bin/env bun
/**
 * periksa.mjs — pemeriksaan mutu (QC) pasca-render untuk video MP4.
 *
 *   bun scripts/periksa.mjs <video.mp4> [--subtitle F.vtt|.srt]
 *        [--kenyaringan web|siaran] [--jenis penjelasan|promo] [--cps 17]
 *        [--konsep konsep.json] [--json]
 *
 * Pemeriksaan: encoding (YouTube Help), kenyaringan (EBU R 128, AES TD1004/TD1008),
 * kilatan fotosensitif (WCAG 2.2 SC 2.3.1, penyaringan konservatif), subtitle (Netflix
 * Timed Text Style Guide), durasi (Guo, Kim & Rubin 2014). Memakai ffmpeg/ffprobe sistem.
 * Dengan --konsep, ambang durasi (maks preset), cps, dan kenyaringan diambil dari konsep.json
 * (preset jenis + override), dan rasio video dibandingkan dengan rasio konsep.
 * Exit 0 bila semua pemeriksaan wajib lolos, 1 bila ada yang gagal, 2 untuk argumen salah
 * atau berkas yang tidak bisa dibaca. Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bacaKonsepBerkas } from "./konsep.mjs";

const PETUNJUK = `Pemakaian:
  bun scripts/periksa.mjs <video.mp4> [opsi]
Opsi: --subtitle F(.vtt|.srt), --kenyaringan web|siaran (bawaan web),
      --jenis penjelasan|promo, --cps N (bawaan 17), --konsep konsep.json, --json, -h/--help
Exit: 0 semua pemeriksaan wajib lolos, 1 ada yang gagal, 2 argumen salah/berkas tak terbaca.`;

function keluarSalah(pesan) {
  console.error(`periksa.mjs: ${pesan}\n${PETUNJUK}`);
  process.exit(2);
}

// ------------------------------------------------------------------ argumen
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      subtitle: { type: "string" },
      kenyaringan: { type: "string" },
      jenis: { type: "string" },
      cps: { type: "string" },
      konsep: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  keluarSalah(e.message);
}
const { values: o, positionals } = args;
if (o.help) {
  console.log(PETUNJUK);
  process.exit(0);
}
if (positionals.length !== 1) keluarSalah("harus tepat satu berkas video.");
const berkas = positionals[0];
if (!existsSync(berkas) || !statSync(berkas).isFile()) keluarSalah(`berkas tidak ditemukan: ${berkas}`);
// --konsep: pilihan proyek (kenyaringan, cps) menjadi bawaan; flag eksplisit menang.
let konsep = null;
let presetKonsep = null;
if (o.konsep !== undefined) {
  if (!existsSync(o.konsep)) keluarSalah(`--konsep: berkas tidak ditemukan: ${o.konsep}`);
  const rk = bacaKonsepBerkas(o.konsep);
  if (rk.galat.length) keluarSalah(`--konsep: konsep tidak valid: ${rk.galat.join("; ")} (periksa dengan: bun run konsep -- periksa ${o.konsep})`);
  konsep = rk.konsep;
  presetKonsep = rk.efektif;
}
o.kenyaringan ??= konsep?.kenyaringan ?? "web";
o.cps ??= String(konsep?.caption?.cps ?? 17);
if (!["web", "siaran"].includes(o.kenyaringan)) keluarSalah(`--kenyaringan tidak valid: "${o.kenyaringan}" (pilih web atau siaran)`);
if (o.jenis !== undefined && !["penjelasan", "promo"].includes(o.jenis)) keluarSalah(`--jenis tidak valid: "${o.jenis}" (pilih penjelasan atau promo)`);
const cps = Number(o.cps);
if (!Number.isFinite(cps) || cps <= 0) keluarSalah(`--cps tidak valid: "${o.cps}"`);
if (o.subtitle !== undefined) {
  if (!existsSync(o.subtitle)) keluarSalah(`--subtitle: berkas tidak ditemukan: ${o.subtitle}`);
  if (![".vtt", ".srt"].includes(extname(o.subtitle).toLowerCase())) keluarSalah("--subtitle harus berekstensi .vtt atau .srt");
}

// ------------------------------------------------------------------ ambang
// Kenyaringan: EBU R 128 (siaran -23 LUFS +-1 LU, true peak <= -1 dBTP); streaming web
// -16 LUFS (AES TD1004/TD1008, rentang -14..-20), true peak <= -1 dBTP.
const TARGET_KENYARINGAN = {
  web: { I: -16, toleransi: 1, TPmaks: -1.0 },
  siaran: { I: -23, toleransi: 1, TPmaks: -1.0 },
};
// Kilatan: WCAG 2.2 SC 2.3.1 (Three Flashes or Below Threshold).
const KILATAN = {
  deltaLuminans: 0.10, // perubahan luminans relatif >= 10% dari maksimum (1,0)
  sisiGelapMaks: 0.80, // sisi lebih gelap < 0,80
  deltaMerah: 20, // perubahan (R-G-B)*320 >= 20 untuk transisi merah
  rasioMerah: 0.8, // merah jenuh: R/(R+G+B) >= 0,8
  transisiMaks: 6, // > 3 flash (= 6 transisi berlawanan) dalam 1 detik -> gagal
};
const BATAS_DURASI_PENJELASAN_DETIK = 6 * 60; // Guo, Kim & Rubin (2014)
const BATAS_CUE = { barisMaks: 42, barisPerCue: 2, durasiMin: 5 / 6, durasiMaks: 7 };

// ------------------------------------------------------------------ utilitas proses
async function jalankan(cmd, { binerStdout = false } = {}) {
  let p;
  try {
    p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    throw new Error(`tidak bisa menjalankan ${cmd[0]}: ${e.message}`);
  }
  const [out, err, kode] = await Promise.all([
    binerStdout ? new Response(p.stdout).arrayBuffer() : new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, kode };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const angka = (t) => (t === "-inf" ? -Infinity : Number(t));

function butir(nama, nilai, harapan, ok) {
  return { nama, nilai: nilai ?? null, harapan, ok };
}
function item(id, nama, wajib, status, ringkas, rincian = [], data = undefined) {
  const r = { id, nama, wajib, status, ringkas, rincian };
  if (data !== undefined) r.data = data;
  return r;
}

// ------------------------------------------------------------------ 1. encoding
// Urutan atom tingkat atas MP4 (hanya membaca header kotak): faststart = 'moov' muncul
// sebelum 'mdat'.
async function urutanAtom(file) {
  const f = Bun.file(file);
  const ukuran = f.size;
  const urut = [];
  let off = 0;
  while (off + 8 <= ukuran && urut.length < 64) {
    const h = new DataView(await f.slice(off, Math.min(off + 16, ukuran)).arrayBuffer());
    let panjang = h.getUint32(0);
    const tipe = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    let kepala = 8;
    if (panjang === 1 && h.byteLength >= 16) {
      panjang = Number(h.getBigUint64(8));
      kepala = 16;
    } else if (panjang === 0) {
      panjang = ukuran - off;
    }
    urut.push(tipe);
    if (tipe === "moov" || tipe === "mdat") break;
    if (panjang < kepala) break;
    off += panjang;
  }
  return urut;
}

async function periksaEncoding(file, probe) {
  const daftar = [];
  const v = probe.streams.find((s) => s.codec_type === "video");
  daftar.push(butir("video codec", v.codec_name, "h264", v.codec_name === "h264"));
  daftar.push(butir("video profil", v.profile, "High", v.profile === "High"));
  daftar.push(butir("video pix_fmt", v.pix_fmt, "yuv420p", v.pix_fmt === "yuv420p"));
  daftar.push(butir("video color_primaries", v.color_primaries, "bt709", v.color_primaries === "bt709"));
  daftar.push(butir("video color_transfer", v.color_transfer, "bt709", v.color_transfer === "bt709"));
  daftar.push(butir("video color_space", v.color_space, "bt709", v.color_space === "bt709"));
  daftar.push(butir("video color_range", v.color_range, "tv", v.color_range === "tv"));

  const urut = await urutanAtom(file);
  const iMoov = urut.indexOf("moov");
  const iMdat = urut.indexOf("mdat");
  let nilaiAtom;
  let okAtom;
  if (urut[0] !== "ftyp") {
    nilaiAtom = "bukan MP4/ISO BMFF";
    okAtom = false;
  } else if (iMoov >= 0 && (iMdat < 0 || iMoov < iMdat)) {
    nilaiAtom = "moov sebelum mdat";
    okAtom = true;
  } else {
    nilaiAtom = "mdat sebelum moov";
    okAtom = false;
  }
  daftar.push(butir("faststart", nilaiAtom, "moov sebelum mdat", okAtom));

  const audio = probe.streams.filter((s) => s.codec_type === "audio");
  audio.forEach((a, i) => {
    const pre = audio.length > 1 ? `audio#${i} ` : "audio ";
    daftar.push(butir(`${pre}codec`, a.codec_name, "aac", a.codec_name === "aac"));
    daftar.push(butir(`${pre}sample_rate`, a.sample_rate, "48000", a.sample_rate === "48000"));
  });

  const gagal = daftar.filter((b) => !b.ok);
  const ringkas = gagal.length === 0
    ? `${v.codec_name} ${v.profile} ${v.pix_fmt} BT.709 ${v.color_range}, faststart${audio.length ? `, aac ${audio[0].sample_rate} Hz` : ", tanpa audio"}`
    : `${gagal.length} dari ${daftar.length} butir tidak sesuai`;
  return item(
    "encoding", "Encoding", true, gagal.length ? "GAGAL" : "LOLOS", ringkas,
    gagal.map((b) => `${b.nama}: ${b.nilai ?? "(tidak ditandai)"}, harapan ${b.harapan}`),
    { butir: daftar },
  );
}

// ------------------------------------------------------------------ 2. kenyaringan
async function periksaKenyaringan(file, probe) {
  const t = TARGET_KENYARINGAN[o.kenyaringan];
  const nama = `Kenyaringan (${o.kenyaringan})`;
  if (!probe.streams.some((s) => s.codec_type === "audio")) {
    return item("kenyaringan", nama, false, "LEWATI", "tanpa audio");
  }
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", file, "-vn",
    "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  if (r.kode !== 0) throw new Error(`ffmpeg ebur128 gagal (exit ${r.kode}): ${r.err.trim()}`);
  const ringkasan = r.err.slice(r.err.lastIndexOf("Summary:"));
  const mI = ringkasan.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  const mTP = ringkasan.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  if (!mI || !mTP) throw new Error("ringkasan ebur128 tidak terbaca");
  const I = angka(mI[1]);
  const TP = angka(mTP[1]);
  const okI = Math.abs(I - t.I) <= t.toleransi + 1e-9;
  const okTP = TP <= t.TPmaks + 1e-9;
  const rincian = [];
  if (!okI) rincian.push(`I = ${fmt(I)} LUFS, harapan ${t.I} +-${t.toleransi} LU`);
  if (!okTP) rincian.push(`true peak = ${fmt(TP)} dBTP, harapan <= ${fmt(t.TPmaks)} dBTP`);
  return item(
    "kenyaringan", nama, true, okI && okTP ? "LOLOS" : "GAGAL",
    `I = ${fmt(I)} LUFS (target ${t.I} +-${t.toleransi}), TP = ${fmt(TP)} dBTP (maks ${fmt(t.TPmaks)})`,
    rincian, { I, TP, target: t },
  );
}

// ------------------------------------------------------------------ 3. kilatan
// Pelacak zig-zag per blok: menyaring deret nilai per frame menjadi "ayunan" (transisi
// naik/turun berselang-seling) yang masing-masing >= ambang. Transisi dicatat pada frame
// puncaknya; jendela geser 1 detik menghitung transisi yang masih berada di dalamnya.
class Pelacak {
  constructor(ambang, sahkan, jendela, batas) {
    this.ambang = ambang;
    this.sahkan = sahkan; // (nilaiA, bendaA, nilaiB, bendaB) -> boleh dihitung?
    this.jendela = jendela;
    this.batas = batas;
    this.dir = 0;
    this.pivot = null;
    this.cand = null;
    this.antrean = [];
    this.kepala = 0;
    this.maks = 0;
    this.maksFrame = -1;
    this.gagalFrame = -1;
  }
  catat(frame) {
    this.antrean.push(frame);
    while (this.antrean[this.kepala] <= frame - this.jendela) this.kepala++;
    if (this.kepala > 1024) { this.antrean = this.antrean.slice(this.kepala); this.kepala = 0; }
    const n = this.antrean.length - this.kepala;
    if (n > this.maks) { this.maks = n; this.maksFrame = frame; }
    if (n > this.batas && this.gagalFrame < 0) this.gagalFrame = frame;
  }
  ayunan() {
    if (this.sahkan(this.pivot.v, this.pivot.b, this.cand.v, this.cand.b)) this.catat(this.cand.f);
  }
  tambah(f, v, b) {
    if (this.pivot === null) {
      this.pivot = { v, b, f };
      this.cand = { v, b, f };
      return;
    }
    if (this.dir === 0) {
      if (v - this.pivot.v >= this.ambang - 1e-9) { this.dir = 1; this.cand = { v, b, f }; }
      else if (this.pivot.v - v >= this.ambang - 1e-9) { this.dir = -1; this.cand = { v, b, f }; }
    } else if (this.dir === 1) {
      if (v > this.cand.v) this.cand = { v, b, f };
      else if (this.cand.v - v >= this.ambang - 1e-9) {
        this.ayunan();
        this.pivot = this.cand;
        this.dir = -1;
        this.cand = { v, b, f };
      }
    } else if (v < this.cand.v) {
      this.cand = { v, b, f };
    } else if (v - this.cand.v >= this.ambang - 1e-9) {
      this.ayunan();
      this.pivot = this.cand;
      this.dir = 1;
      this.cand = { v, b, f };
    }
  }
  selesai() {
    if (this.dir !== 0) this.ayunan();
  }
}

// Kisi sampel G x G (rata-rata area oleh ffmpeg), dibagi sel C x C; jendela uji = 2x2 sel
// (1/9 luas layar) digeser satu sel -> 5x5 jendela. Kisi 3x3 sejajar adalah himpunan
// bagiannya (jendela di indeks 0, 2, 4).
const G = 48;
const C = 8;
const NS = G / C; // 6 sel per sisi
const NW = NS - 1; // 5 jendela per sisi

const LUT_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LUT_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

async function periksaKilatan(file, fps) {
  const jendela = Math.max(1, Math.round(fps));
  const umum = [];
  const merah = [];
  for (let k = 0; k < NW * NW; k++) {
    umum.push(new Pelacak(KILATAN.deltaLuminans,
      (a, _ba, b) => Math.min(a, b) < KILATAN.sisiGelapMaks, jendela, KILATAN.transisiMaks));
    merah.push(new Pelacak(KILATAN.deltaMerah,
      (_a, ba, _b, bb) => ba || bb, jendela, KILATAN.transisiMaks));
  }
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", file,
    "-map", "0:v:0", "-an", "-sn", "-fps_mode", "passthrough",
    "-vf", `scale=${G}:${G}:flags=area,format=rgb24`, "-f", "rawvideo", "-"],
  { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stderrTeks = new Response(p.stderr).text();

  const ukuranFrame = G * G * 3;
  const buf = new Uint8Array(ukuranFrame);
  let isi = 0;
  let nFrame = 0;
  const sel = new Float64Array(NS * NS * 3);
  const luasJendela = 4 * C * C; // sampel per jendela

  function prosesFrame() {
    sel.fill(0);
    for (let y = 0; y < G; y++) {
      const baris = (y / C | 0) * NS;
      for (let x = 0; x < G; x++) {
        const s = (baris + (x / C | 0)) * 3;
        const i = (y * G + x) * 3;
        sel[s] += LUT_LINEAR[buf[i]];
        sel[s + 1] += LUT_LINEAR[buf[i + 1]];
        sel[s + 2] += LUT_LINEAR[buf[i + 2]];
      }
    }
    for (let wy = 0; wy < NW; wy++) {
      for (let wx = 0; wx < NW; wx++) {
        let R = 0, Gg = 0, B = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const s = ((wy + dy) * NS + wx + dx) * 3;
            R += sel[s]; Gg += sel[s + 1]; B += sel[s + 2];
          }
        }
        R /= luasJendela; Gg /= luasJendela; B /= luasJendela;
        const lum = 0.2126 * R + 0.7152 * Gg + 0.0722 * B;
        const jumlah = R + Gg + B;
        const k = wy * NW + wx;
        umum[k].tambah(nFrame, lum, false);
        merah[k].tambah(nFrame, (R - Gg - B) * 320, jumlah > 0 && R / jumlah >= KILATAN.rasioMerah);
      }
    }
    nFrame++;
  }

  const pembaca = p.stdout.getReader();
  for (;;) {
    const { done, value } = await pembaca.read();
    if (done) break;
    let pos = 0;
    while (pos < value.length) {
      const n = Math.min(ukuranFrame - isi, value.length - pos);
      buf.set(value.subarray(pos, pos + n), isi);
      isi += n;
      pos += n;
      if (isi === ukuranFrame) { prosesFrame(); isi = 0; }
    }
  }
  const kode = await p.exited;
  const err = (await stderrTeks).trim();
  if (kode !== 0) throw new Error(`ffmpeg dekode gagal (exit ${kode}): ${err}`);
  if (nFrame === 0) throw new Error("tidak ada frame yang terdekode");
  for (const t of [...umum, ...merah]) t.selesai();

  const ringkasKelompok = (daftar, id, nama) => {
    let idx = 0;
    for (let k = 1; k < daftar.length; k++) {
      if (daftar[k].maks > daftar[idx].maks) idx = k;
    }
    const t = daftar[idx];
    const gagal = daftar.some((x) => x.gagalFrame >= 0);
    const wy = (idx / NW) | 0;
    const wx = idx % NW;
    const area = `x ${Math.round(wx * 100 / NS)}-${Math.round((wx + 2) * 100 / NS)}%, y ${Math.round(wy * 100 / NS)}-${Math.round((wy + 2) * 100 / NS)}%`;
    const mulai = Math.max(0, (t.maksFrame - jendela + 1) / fps);
    const rincian = [];
    if (gagal) {
      const awal = daftar.filter((x) => x.gagalFrame >= 0).reduce((m, x) => Math.min(m, x.gagalFrame), Infinity);
      rincian.push(
        `maks ${t.maks} transisi (~${(t.maks / 2).toFixed(1)} flash) dalam 1 s, jendela mulai ${mulai.toFixed(2)} s, area ${area}; batas ${KILATAN.transisiMaks} transisi (3 flash)`,
        `pelanggaran pertama berakhir pada ${(awal / fps).toFixed(2)} s`,
      );
    }
    return item(
      id, nama, true, gagal ? "GAGAL" : "LOLOS",
      gagal
        ? `${t.maks} transisi dalam 1 s (batas ${KILATAN.transisiMaks})`
        : `maks ${t.maks} transisi dalam 1 s (batas ${KILATAN.transisiMaks}), ${nFrame} frame @ ${fmt(fps, 2)} fps`,
      rincian,
      { maksTransisi: t.maks, batasTransisi: KILATAN.transisiMaks, frame: nFrame, fps, jendelaFrame: jendela },
    );
  };
  const catatan = "Penyaringan konservatif atas WCAG 2.2 SC 2.3.1 (perkiraan kisi blok), bukan sertifikasi PEAT/Harding.";
  const a = ringkasKelompok(umum, "kilatan", "Kilatan umum (WCAG 2.3.1)");
  const b = ringkasKelompok(merah, "kilatan-merah", "Kilatan merah (WCAG 2.3.1)");
  a.catatan = catatan;
  b.catatan = catatan;
  return [a, b];
}

// ------------------------------------------------------------------ 4. subtitle
async function muatRuntime() {
  const elemenTiruan = () => ({ setAttribute() {}, appendChild() {}, style: {} });
  globalThis.window = { location: { search: "" } };
  globalThis.document = {
    readyState: "complete",
    createElement: elemenTiruan,
    head: elemenTiruan(),
    documentElement: elemenTiruan(),
  };
  const akar = dirname(fileURLToPath(import.meta.url));
  await import(pathToFileURL(join(akar, "runtime.js")).href);
  return globalThis.window.VideoTerprogram;
}

async function periksaSubtitle(berkasSub) {
  const rt = await muatRuntime();
  const teks = readFileSync(berkasSub, "utf8");
  const cues = extname(berkasSub).toLowerCase() === ".srt" ? rt.parseSrt(teks) : rt.parseVtt(teks);
  const masalah = [];
  const peringatan = [];
  const tambah = (cue, jenis, pesan) => masalah.push({ cue, jenis, pesan });
  const panjang = (s) => Array.from(s).length;
  const ms = (x) => Math.round(x * 1000);

  cues.forEach((c, i) => {
    const no = i + 1;
    const baris = c.teks.split("\n").map((s) => s.replace(/\s+$/, ""));
    const panjangMaks = Math.max(...baris.map(panjang));
    if (panjangMaks > BATAS_CUE.barisMaks) tambah(no, "baris-terlalu-panjang", `cue ${no}: baris ${panjangMaks} karakter (maks ${BATAS_CUE.barisMaks})`);
    if (baris.length > BATAS_CUE.barisPerCue) tambah(no, "terlalu-banyak-baris", `cue ${no}: ${baris.length} baris (maks ${BATAS_CUE.barisPerCue})`);
    const dur = (ms(c.akhir) - ms(c.mulai)) / 1000;
    const gabung = baris.join(" ").replace(/\s+/g, " ").trim();
    const laju = panjang(gabung) / dur;
    if (laju > cps + 1e-9) tambah(no, "cps-terlalu-tinggi", `cue ${no}: ${fmt(laju)} cps (maks ${cps})`);
    if (dur < BATAS_CUE.durasiMin - 1e-6) tambah(no, "durasi-terlalu-pendek", `cue ${no}: durasi ${fmt(dur, 2)} s (min ${fmt(BATAS_CUE.durasiMin, 2)} s)`);
    if (dur > BATAS_CUE.durasiMaks + 1e-6) tambah(no, "durasi-terlalu-panjang", `cue ${no}: durasi ${fmt(dur, 2)} s (maks ${BATAS_CUE.durasiMaks} s)`);
    // saran pemecahan baris: hanya untuk cue yang lolos batas baris
    if (panjangMaks <= BATAS_CUE.barisMaks && baris.length <= BATAS_CUE.barisPerCue) {
      const saran = rt.pecahBaris(gabung, { maks: BATAS_CUE.barisMaks, baris: BATAS_CUE.barisPerCue });
      if (!saran.melebihi && JSON.stringify(saran) !== JSON.stringify(baris)) {
        peringatan.push({ cue: no, jenis: "pemecahan-baris", pesan: `cue ${no}: pemecahan baris bisa lebih baik: ${JSON.stringify(saran.join(" / "))}` });
      }
    }
  });
  // cue tumpang tindih (urut waktu mulai, nomor cue tetap nomor asli)
  const urut = cues.map((c, i) => ({ ...c, no: i + 1 })).sort((a, b) => a.mulai - b.mulai || a.no - b.no);
  for (let i = 0; i + 1 < urut.length; i++) {
    if (ms(urut[i + 1].mulai) < ms(urut[i].akhir)) {
      tambah(urut[i].no, "tumpang-tindih", `cue ${urut[i].no} dan ${urut[i + 1].no} tumpang tindih`);
    }
  }
  if (cues.length === 0) tambah(0, "kosong", "tidak ada cue yang terbaca dari berkas subtitle");

  const status = masalah.length ? "GAGAL" : peringatan.length ? "PERINGATAN" : "LOLOS";
  const ringkas = masalah.length
    ? `${masalah.length} masalah pada ${new Set(masalah.map((m) => m.cue)).size} cue dari ${cues.length}`
    : `${cues.length} cue sesuai (baris <= ${BATAS_CUE.barisMaks}, <= ${BATAS_CUE.barisPerCue} baris, <= ${cps} cps, ${fmt(BATAS_CUE.durasiMin, 2)}-${BATAS_CUE.durasiMaks} s)${peringatan.length ? `, ${peringatan.length} saran` : ""}`;
  return item(
    "subtitle", "Subtitle", true, status, ringkas,
    [...masalah.map((m) => m.pesan), ...peringatan.map((m) => m.pesan)],
    { cue: cues.length, masalah, peringatan, cps },
  );
}

// ------------------------------------------------------------------ 5. durasi
function periksaDurasi(detik) {
  const menit = detik / 60;
  const teks = `${fmt(detik, 1)} s (${fmt(menit, 1)} menit)`;
  if (konsep) {
    const maks = presetKonsep.durasiMaks;
    const target = konsep.durasiTarget;
    const rincian = [`target konsep ${target} s (selisih ${detik >= target ? "+" : ""}${fmt(detik - target, 1)} s)`];
    if (o.jenis !== undefined) rincian.push("--jenis diabaikan karena --konsep dipakai");
    const data = { detik, target, maks, jenis: konsep.jenis };
    return detik > maks + 1e-9
      ? item("durasi", `Durasi (${konsep.jenis})`, false, "PERINGATAN", `${teks}, di atas durasi maks preset ${maks} s`, rincian, data)
      : item("durasi", `Durasi (${konsep.jenis})`, false, "LOLOS", `${teks}, <= durasi maks preset ${maks} s (target ${target} s)`, rincian, data);
  }
  if (o.jenis === "penjelasan") {
    return detik > BATAS_DURASI_PENJELASAN_DETIK
      ? item("durasi", "Durasi (penjelasan)", false, "PERINGATAN", `${teks}, di atas 6 menit: keterlibatan penonton menurun (Guo, Kim & Rubin 2014)`)
      : item("durasi", "Durasi (penjelasan)", false, "LOLOS", `${teks}, <= 6 menit`);
  }
  if (o.jenis === "promo") {
    return item("durasi", "Durasi (promo)", false, "INFO", `${teks}; tidak ada ambang berbasis bukti untuk promo`);
  }
  return item("durasi", "Durasi", false, "INFO", `${teks}; tanpa --jenis, tidak dinilai`);
}

// ------------------------------------------------------------------ 6. konsep: rasio dan burn-in
function periksaRasio(v) {
  const [a, b] = konsep.rasio.split(":").map(Number);
  const lebar = v.width;
  const tinggi = v.height;
  const nyata = lebar / tinggi;
  const harapan = a / b;
  const ok = Math.abs(nyata - harapan) / harapan <= 0.01;
  return item("rasio", "Rasio (konsep)", true, ok ? "LOLOS" : "GAGAL",
    ok ? `${lebar}x${tinggi} sesuai rasio konsep ${konsep.rasio}` : `${lebar}x${tinggi} (${fmt(nyata, 3)}) tidak sesuai rasio konsep ${konsep.rasio} (${fmt(harapan, 3)})`,
    [], { lebar, tinggi, rasioKonsep: konsep.rasio });
}
function infoBurnIn() {
  const ya = konsep.caption.burnIn;
  return item("burn-in", "Burn-in (konsep)", false, "INFO",
    `konsep mengharapkan caption ${ya ? "burn-in (tertanam di gambar)" : "sidecar/trek lunak"}; tidak bisa dideteksi otomatis, periksa secara visual`,
    [], { burnIn: ya, mode: konsep.caption.mode });
}

// ------------------------------------------------------------------ main
const t0 = Date.now();
const pr = await jalankan(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", berkas]).catch((e) => {
  keluarSalah(e.message);
});
if (pr.kode !== 0) keluarSalah(`ffprobe tidak bisa membaca ${berkas}: ${pr.err.trim()}`);
const probe = JSON.parse(pr.out);
const v = probe.streams?.find((s) => s.codec_type === "video");
if (!v) keluarSalah(`${berkas} tidak memuat trek video`);
const bagi = (s) => {
  const [a, b] = String(s).split("/").map(Number);
  return b ? a / b : a;
};
let fps = bagi(v.avg_frame_rate);
if (!Number.isFinite(fps) || fps <= 0) fps = bagi(v.r_frame_rate);
if (!Number.isFinite(fps) || fps <= 0) fps = 30;
const durasiDetik = Number(probe.format?.duration ?? v.duration ?? 0);

const galat = (id, nama, wajib, e) => item(id, nama, wajib, "GAGAL", `pemeriksaan tidak dapat dijalankan: ${e.message}`);
const [encoding, kenyaringan, kilatan, subtitle] = await Promise.all([
  periksaEncoding(berkas, probe).catch((e) => galat("encoding", "Encoding", true, e)),
  periksaKenyaringan(berkas, probe).catch((e) => galat("kenyaringan", `Kenyaringan (${o.kenyaringan})`, true, e)),
  periksaKilatan(berkas, fps).catch((e) => [galat("kilatan", "Kilatan umum (WCAG 2.3.1)", true, e), galat("kilatan-merah", "Kilatan merah (WCAG 2.3.1)", true, e)]),
  o.subtitle ? periksaSubtitle(o.subtitle).catch((e) => galat("subtitle", "Subtitle", true, e)) : null,
]);
const pemeriksaan = [encoding, kenyaringan, ...kilatan];
if (subtitle) pemeriksaan.push(subtitle);
pemeriksaan.push(periksaDurasi(durasiDetik));
if (konsep) pemeriksaan.push(periksaRasio(v), infoBurnIn());

const jumlah = { LOLOS: 0, GAGAL: 0, PERINGATAN: 0, INFO: 0, LEWATI: 0 };
for (const p of pemeriksaan) jumlah[p.status]++;
const lolos = !pemeriksaan.some((p) => p.wajib && p.status === "GAGAL");
const waktuDetik = Number(((Date.now() - t0) / 1000).toFixed(2));
const hasil = { berkas, lolos, ringkasan: jumlah, durasiDetik, fps, waktuDetik, pemeriksaan };
if (konsep) hasil.konsep = { berkas: o.konsep, id: konsep.id, jenis: konsep.jenis, alur: konsep.alur, tahap: konsep.tahap };

if (o.json) {
  console.log(JSON.stringify(hasil, null, 2));
} else {
  console.log(`Pemeriksaan mutu: ${berkas}`);
  if (konsep) console.log(`Konsep: ${o.konsep} (jenis ${konsep.jenis}, alur ${konsep.alur}, tahap ${konsep.tahap}; kenyaringan ${o.kenyaringan}, cps ${o.cps})`);
  const lebar = Math.max(...pemeriksaan.map((p) => p.nama.length));
  for (const p of pemeriksaan) {
    console.log(`  ${p.status.padEnd(10)} ${p.nama.padEnd(lebar)} ${p.ringkas}`);
    for (const r of p.rincian) console.log(`             - ${r}`);
  }
  console.log(`\nCatatan: ${pemeriksaan.find((p) => p.catatan)?.catatan ?? ""}`);
  console.log(`Hasil: ${lolos ? "LOLOS" : "GAGAL"} (${jumlah.LOLOS} lolos, ${jumlah.GAGAL} gagal, ${jumlah.PERINGATAN} peringatan, ${waktuDetik} s)`);
}
process.exit(lolos ? 0 : 1);
