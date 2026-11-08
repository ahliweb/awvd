#!/usr/bin/env bun
/**
 * uji-audio-waktu.mjs — uji audio klip ber-speed (konstan dan ramp) di audio.mjs: atempo sinkron
 * dengan pemetaan frame runtime.js (RT.petaWaktuKlip), panjang sampel tepat, tanpa drift, nada tetap,
 * reverse/freeze ditolak (fail-closed), dan rakitan deterministik byte demi byte.
 *
 * Sumber uji sintetis (tanpa aset, tanpa jaringan): bip 1 kHz selama 40 ms mulai tepat di tiap kelipatan 10
 * frame sumber (30 fps), dan sinus 700 Hz untuk uji nada. Sinkron diukur dengan mendeteksi awal tiap klik
 * di WAV hasil dan membandingkannya dengan RT.petaWaktuKlip (sumber tunggal waktu). Tabel runtime memakai
 * lantai (K[f] = lantai(posisi(f))), jadi waktu sebenarnya frame sumber s ada di (f*-1, f*] dengan f* =
 * frame lokal pertama yang menampilkan K >= s. Selisih = jarak waktu klik terdeteksi ke selang itu (0 bila di
 * dalamnya). Ambang lulus: selisih <= 1 frame (kriteria issue); angka terukur dicetak.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-audio-waktu.mjs
 */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bangunGrafik, rencanaWaktuAudio, SR, validasiRencana } from "./audio.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const audioMjs = join(akar, "scripts", "audio.mjs");
const RT = createRequire(import.meta.url)("./runtime.js");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-audio-waktu-"));
const j = (...p) => join(tmp, ...p);
const FPS = 30;
const sam = (f) => Math.round((f * SR) / FPS);
const SPF = SR / FPS; // sampel per frame (1600)

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
}
function bacaWav(berkas) {
  const b = readFileSync(berkas);
  let o = 12;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === "data") {
      const d = b.subarray(o + 8, o + 8 + n);
      const s = new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
      return Float32Array.from({ length: s.length / 2 }, (_, i) => s[i * 2]);
    }
    o += 8 + n;
  }
  throw new Error(`tidak ada chunk data di ${berkas}`);
}
/** Sampel awal tiap klik: bip > 25% puncak setelah >= 30 ms tenang. */
function awalKlik(x, dari, sampai) {
  let puncak = 0;
  for (let i = dari; i < sampai; i++) puncak = Math.max(puncak, Math.abs(x[i]));
  const ambang = 0.25 * puncak, hasil = [];
  let terakhir = -Infinity;
  for (let i = dari; i < sampai; i++) {
    if (Math.abs(x[i]) > ambang) {
      if (i - terakhir > 0.03 * SR) hasil.push(i);
      terakhir = i;
    }
  }
  return hasil;
}
function dayaDb(x, hz, dari, sampai) {
  const N = sampai - dari;
  let a = 0, c = 0;
  for (let i = 0; i < N; i++) {
    const w = (2 * Math.PI * hz * i) / SR;
    a += x[dari + i] * Math.cos(w);
    c += x[dari + i] * Math.sin(w);
  }
  return 10 * Math.log10(((2 / N) ** 2 * (a * a + c * c)) / 2 + 1e-20);
}
const sama = (a, b) => Buffer.compare(readFileSync(a), readFileSync(b)) === 0;

// ------------------------------------------------------------ rakit dan ukur
const MULAI = 15; // frame mulai klip di timeline (menguji adelay)
let nomor = 0;
/** Rakit satu klip ber-speed dengan CLI; kembalikan WAV dan keluaran. */
async function rakit(klip, { berkas = "klik.wav", total = 200 } = {}) {
  const id = `r${nomor++}`;
  const rencana = j(`${id}.json`), wav = j(`${id}.wav`);
  writeFileSync(rencana, JSON.stringify({ durasiFrame: total, fadeMs: 100, klip: [{ id: "k", berkas, mulai: MULAI, mode: "bergantian", ...klip }] }));
  const r = await jalankan(["bun", audioMjs, rencana, "--fps", String(FPS), "--out", wav]);
  return { ...r, wav };
}
/**
 * Selisih sinkron (frame) tiap klik: jarak posisi terdeteksi di keluaran ke selang (f*-1, f*] dengan f* =
 * frame lokal pertama yang menampilkan frame sumber klik itu menurut RT.petaWaktuKlip. Klik di dalam fade
 * klip (4 frame) tidak diukur.
 */
function ukurSinkron(wav, { waktu, durasi, akhir, dariFrame = 0 }) {
  const x = bacaWav(wav);
  const L = akhir - MULAI;
  const K = RT.petaWaktuKlip(waktu, durasi + 1);
  const klik = awalKlik(x, sam(MULAI), sam(akhir));
  const selisih = [];
  for (let m = 0; m < 400; m++) {
    const s = 10 * m - dariFrame; // frame sumber relatif `dari`
    if (s < 0) continue;
    const f = K.findIndex((v) => v >= s);
    if (f < 0 || f >= L) break;
    if (f < 4 || f > L - 4) continue; // di dalam fade klip
    const harap = sam(MULAI) + f * SPF;
    const dekat = klik.reduce((b, v) => (Math.abs(v - harap) < Math.abs(b - harap) ? v : b), Infinity);
    const p = (dekat - harap) / SPF; // frame relatif f*
    selisih.push(p < -1 ? -1 - p : p > 0 ? p : 0);
  }
  return { selisih, maks: Math.max(...selisih), jumlah: selisih.length, terdeteksi: klik.length, x };
}

const kasus = [];
const uji = (nama, fn) => kasus.push([nama, fn]);

// ------------------------------------------------------------------ fixture
async function siapkan() {
  await ffmpeg("-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,1/3),0.04),0.8*sin(2*PI*1000*t),0)':s=48000:d=30", "-ac", "1", j("klik.wav"));
  await ffmpeg("-f", "lavfi", "-i", "sine=f=700:r=48000:d=20", "-ac", "1", j("nada.wav"));
}

// ------------------------------------------------------------ (a) rencana murni
uji("a. rencanaWaktuAudio: konstan satu potongan, ramp berpotongan menyambung, identitas, reverse/freeze ditolak", () => {
  let r = rencanaWaktuAudio(RT, { kecepatan: 1.5 }, 90, 90, FPS);
  tegas(r.segmen.length === 1 && r.segmen[0].tempo === 1.5 && r.segmen[0].s1 === 135, `konstan: ${JSON.stringify(r)}`);
  tegas(r.galatMaks < 1, `galat konstan ${r.galatMaks}`);
  r = rencanaWaktuAudio(RT, { kecepatan: 1 }, 90, 90, FPS);
  tegas(r.identitas === true, "speed 1 = identitas");
  r = rencanaWaktuAudio(RT, { kecepatan: [{ pada: 0, nilai: 1 }, { pada: 89, nilai: 1 }] }, 90, 90, FPS);
  tegas(r.identitas === true, "ramp konstan 1x = identitas");
  r = rencanaWaktuAudio(RT, {}, 90, 90, FPS);
  tegas(r.identitas === true, "tanpa waktu = identitas");
  for (const w of [{ balik: true }, { bekukan: true }]) {
    r = rencanaWaktuAudio(RT, w, 90, 90, FPS);
    tegas(/tidak mendukung (reverse|freeze)/.test(r.galat ?? ""), `${JSON.stringify(w)} ditolak: ${JSON.stringify(r)}`);
  }
  for (const v of [0.3, 0.499, 4.1, 10]) {
    r = rencanaWaktuAudio(RT, { kecepatan: v }, 90, 90, FPS);
    tegas(/di luar jangkauan audio 0\.5\.\.4x/.test(r.galat ?? ""), `kecepatan ${v} ditolak: ${JSON.stringify(r)}`);
  }
  r = rencanaWaktuAudio(RT, { kecepatan: [{ pada: 0, nilai: 0.3 }, { pada: 89, nilai: 1 }] }, 90, 90, FPS);
  tegas(/ramp kecepatan tidak dapat dipetakan/.test(r.galat ?? ""), `ramp di bawah 0,5x ditolak: ${JSON.stringify(r)}`);
  r = rencanaWaktuAudio(RT, { kecepatan: 1.2345 }, 90, 90, FPS);
  tegas(/3 desimal/.test(r.galat ?? ""), `kecepatan 4 desimal ditolak oleh runtime: ${JSON.stringify(r)}`);
  r = rencanaWaktuAudio(RT, { kecepatan: 2 }, 90, 91, FPS);
  tegas(/1\.\.durasi/.test(r.galat ?? ""), `panjang melewati durasi: ${JSON.stringify(r)}`);

  r = rencanaWaktuAudio(RT, { kecepatan: [{ pada: 0, nilai: 0.5 }, { pada: 119, nilai: 2 }] }, 120, 120, FPS);
  tegas(r.segmen && r.segmen.length > 1, `ramp harus beberapa potongan: ${JSON.stringify(r).slice(0, 200)}`);
  tegas(r.segmen[0].f0 === 0 && r.segmen.at(-1).f1 === 120, "potongan menutup 0..durasi");
  const K = RT.petaWaktuKlip({ kecepatan: [{ pada: 0, nilai: 0.5 }, { pada: 119, nilai: 2 }] }, 121);
  for (let n = 0; n < r.segmen.length; n++) {
    const s = r.segmen[n];
    tegas(n === 0 || s.f0 === r.segmen[n - 1].f1, "keluaran menyambung tanpa celah");
    tegas(s.s0 === K[s.f0] && s.s1 === K[s.f1], `sumber potongan ${n} = tabel runtime`);
    tegas(n === 0 || s.s0 === r.segmen[n - 1].s1, "sumber menyambung tanpa celah atau tumpang tindih");
    tegas(s.f1 - s.f0 <= Math.round(0.25 * FPS) && s.tempo > 0, `potongan ${n} wajar`);
  }
  tegas(r.galatMaks <= 1, `galat ramp ${r.galatMaks} frame`);
  console.log(`  ramp 0,5x..2x: ${r.segmen.length} potongan, galat garis maks ${r.galatMaks.toFixed(3)} frame`);
});

uji("a2. grafik: tiap potongan dipaksa tepat sam(f1)-sam(f0) sampel; jumlah panjang = sam(panjang)", async () => {
  const waktu = { kecepatan: [{ pada: 0, nilai: 1 }, { pada: 99, nilai: 3 }] };
  const rencana = { durasiFrame: 200, klip: [{ id: "k", berkas: j("klik.wav"), mulai: MULAI, akhir: MULAI + 100, mode: "bergantian", waktu, durasi: 100 }] };
  const v = await validasiRencana(rencana, tmp, { fps: FPS });
  tegas(v.galat.length === 0, `validasi: ${v.galat.join("; ")}`);
  const c = v.rencana.klip[0];
  c.gainEq = 0;
  const g = bangunGrafik(v.rencana).filter;
  const panjang = [...g.matchAll(/apad=whole_len=(\d+),atrim=end_sample=(\d+),aformat/g)];
  tegas(panjang.length === c.waktuAudio.segmen.length, `${panjang.length} potongan di grafik`);
  tegas(panjang.every((m) => m[1] === m[2]), "apad dan atrim memakai panjang sama");
  tegas(panjang.reduce((a, m) => a + Number(m[1]), 0) === sam(100), "jumlah panjang potongan = sam(100)");
  tegas(/concat=n=\d+:v=0:a=1/.test(g) && /atempo/.test(g), "grafik memakai concat dan atempo");
  // rencana tanpa waktu: tidak ada atempo (jalur lama tak berubah)
  const v0 = await validasiRencana({ durasiFrame: 200, klip: [{ id: "k", berkas: j("klik.wav"), mulai: 0, akhir: 100, mode: "bergantian" }] }, tmp, { fps: FPS });
  v0.rencana.klip[0].gainEq = 0;
  tegas(!/atempo|concat|asplit/.test(bangunGrafik(v0.rencana).filter), "tanpa waktu: tanpa atempo");
});

// ------------------------------------------------------------ (b) sinkron terukur
const KONSTAN = [ // [nama, kecepatan, panjang frame lokal]
  ["speed 2x (satu atempo)", 2, 100],
  ["speed 1,5x", 1.5, 100],
  ["speed 0,5x", 0.5, 100],
  ["speed 0,75x", 0.75, 100],
  ["speed 3x (rantai atempo 2 x 1,5)", 3, 60],
  ["speed 4x (rantai atempo 2 x 2, batas atas)", 4, 40],
  ["speed 1,333x (permil)", 1.333, 100],
];
const ukuran = [];
for (const [nama, S, panjang] of KONSTAN) {
  uji(`b. sinkron: ${nama}; keluaran tepat sepanjang rencana dan klik tidak drift`, async () => {
    const waktu = { kecepatan: S };
    const akhir = MULAI + panjang;
    const r = await rakit({ akhir, waktu, durasi: panjang }, { total: 260 });
    tegas(r.kode === 0, `audio.mjs gagal (${r.kode}): ${r.err}`);
    const x = bacaWav(r.wav);
    tegas(x.length === sam(260), `panjang WAV ${x.length} sampel, harapan ${sam(260)}`);
    // setelah akhir klip: senyap mutlak (tidak ada audio bocor melewati sam(akhir))
    let bocor = 0;
    for (let i = sam(akhir) + 8; i < x.length; i++) bocor = Math.max(bocor, Math.abs(x[i]));
    tegas(bocor < 1e-6, `audio bocor setelah akhir klip: ${bocor}`);
    const u = ukurSinkron(r.wav, { waktu, durasi: panjang, akhir });
    tegas(u.jumlah >= 3, `terlalu sedikit klik terukur (${u.jumlah} dari ${u.terdeteksi} terdeteksi)`);
    tegas(u.maks <= 1, `drift ${u.maks.toFixed(3)} frame (> 1); selisih: ${u.selisih.map((s) => s.toFixed(2)).join(" ")}`);
    ukuran.push([nama, u.maks, u.jumlah]);
    console.log(`  ${nama}: ${u.jumlah} klik, selisih maks ${u.maks.toFixed(3)} frame [${u.selisih.map((q) => q.toFixed(2)).join(" ")}]`);
  });
}

uji("b2. sinkron dengan dari (trim): klip speed mulai dari frame sumber 30", async () => {
  const waktu = { kecepatan: 1.5 }, panjang = 90, akhir = MULAI + panjang;
  const r = await rakit({ akhir, waktu, durasi: panjang, dariDetik: 1 });
  tegas(r.kode === 0, `audio.mjs gagal: ${r.err}`);
  const u = ukurSinkron(r.wav, { waktu, durasi: panjang, akhir, dariFrame: 30 });
  tegas(u.jumlah >= 3 && u.maks <= 1, `drift ${u.maks.toFixed(3)} frame: ${u.selisih.map((s) => s.toFixed(2)).join(" ")}`);
  console.log(`  dari 30: ${u.jumlah} klik, selisih maks ${u.maks.toFixed(3)} frame`);
});

const RAMP = [
  ["ramp linear 1x..2x", [{ pada: 0, nilai: 1 }, { pada: 119, nilai: 2 }], 120],
  ["ramp 0,5x..2x", [{ pada: 0, nilai: 0.5 }, { pada: 119, nilai: 2 }], 120],
  ["ramp 2x..0,6x dengan easing bezier", [{ pada: 0, nilai: 2, easing: [0.42, 0, 0.58, 1] }, { pada: 119, nilai: 0.6 }], 120],
  ["ramp tiga keyframe 1x..3x..1x", [{ pada: 0, nilai: 1 }, { pada: 40, nilai: 3 }, { pada: 79, nilai: 1 }], 80],
];
for (const [nama, kecepatan, panjang] of RAMP) {
  uji(`c. sinkron: ${nama}; per potongan, tanpa drift melewati 1 frame`, async () => {
    const waktu = { kecepatan };
    const akhir = MULAI + panjang;
    const r = await rakit({ akhir, waktu, durasi: panjang });
    tegas(r.kode === 0, `audio.mjs gagal (${r.kode}): ${r.err}`);
    tegas(bacaWav(r.wav).length === sam(200), "panjang WAV");
    const u = ukurSinkron(r.wav, { waktu, durasi: panjang, akhir });
    tegas(u.jumlah >= 4, `terlalu sedikit klik terukur (${u.jumlah} dari ${u.terdeteksi} terdeteksi)`);
    tegas(u.maks <= 1, `drift ${u.maks.toFixed(3)} frame (> 1); selisih: ${u.selisih.map((s) => s.toFixed(2)).join(" ")}`);
    ukuran.push([nama, u.maks, u.jumlah]);
    console.log(`  ${nama}: ${u.jumlah} klik, selisih maks ${u.maks.toFixed(3)} frame [${u.selisih.map((q) => q.toFixed(2)).join(" ")}]`);
  });
}

// ------------------------------------------------------------ (d) nada, kenyaringan, fail-closed
uji("d. nada tetap: sinus 700 Hz pada speed 1,5x tidak naik ke 1050 Hz (atempo mengubah tempo, bukan nada)", async () => {
  const waktu = { kecepatan: 1.5 }, panjang = 120, akhir = MULAI + panjang;
  const r = await rakit({ akhir, waktu, durasi: panjang }, { berkas: "nada.wav" });
  tegas(r.kode === 0, `audio.mjs gagal: ${r.err}`);
  const x = bacaWav(r.wav);
  const a = sam(MULAI) + SR / 2, b = sam(akhir) - SR / 2;
  const asli = dayaDb(x, 700, a, b), naik = dayaDb(x, 1050, a, b);
  tegas(asli - naik > 40, `700 Hz ${asli.toFixed(1)} dB vs 1050 Hz ${naik.toFixed(1)} dB`);
  console.log(`  700 Hz ${asli.toFixed(1)} dB, 1050 Hz ${naik.toFixed(1)} dB`);
});

uji("e. fail-closed: reverse, freeze, kecepatan 4 desimal, dan durasi butir tidak sah ditolak (kode 2, tanpa WAV)", async () => {
  for (const [nama, k, pola] of [
    ["reverse", { waktu: { balik: true }, durasi: 60 }, /reverse/],
    ["freeze", { waktu: { bekukan: true }, durasi: 60 }, /freeze/],
    ["kecepatan 4 desimal", { waktu: { kecepatan: 1.2345 }, durasi: 60 }, /3 desimal/],
    ["durasi butir lebih pendek dari rentang", { waktu: { kecepatan: 2 }, durasi: 30 }, /durasi \(frame butir\)/],
    ["bidang waktu asing", { waktu: { cepat: 2 }, durasi: 60 }, /tidak dikenal/],
  ]) {
    const r = await rakit({ akhir: MULAI + 60, ...k });
    tegas(r.kode === 2 && pola.test(r.err), `${nama}: kode ${r.kode}\n${r.err}`);
    tegas(!existsSync(r.wav), `${nama}: WAV tidak boleh ditulis`);
  }
  // klip bisu dengan waktu apa pun tetap sah (tidak ada audio)
  const rb = await rakit({ akhir: MULAI + 60, mode: "bisu", waktu: { balik: true }, durasi: 60 });
  tegas(rb.kode === 0, `klip bisu + reverse sah: ${rb.err}`);
});

uji("f. deterministik: dua rakitan klip speed konstan dan ramp identik byte demi byte", async () => {
  for (const [nama, waktu, panjang] of [["konstan", { kecepatan: 1.5 }, 90], ["ramp", { kecepatan: [{ pada: 0, nilai: 0.5 }, { pada: 89, nilai: 2 }] }, 90]]) {
    const a = await rakit({ akhir: MULAI + panjang, waktu, durasi: panjang });
    const b = await rakit({ akhir: MULAI + panjang, waktu, durasi: panjang });
    tegas(a.kode === 0 && b.kode === 0, `rakit gagal: ${a.err}${b.err}`);
    tegas(sama(a.wav, b.wav), `dua rakitan ${nama} tidak identik byte demi byte`);
  }
});

uji("g. klip speed di akhir sumber: sumber habis dipotong senyap, peringatan, tanpa galat", async () => {
  // sumber 20 s; speed 3x pada 300 frame lokal membaca 900 frame = 30 s > 20 s
  const waktu = { kecepatan: 3 }, panjang = 300;
  const r = await rakit({ akhir: MULAI + panjang, waktu, durasi: panjang }, { berkas: "nada.wav", total: 320 });
  tegas(r.kode === 0 && /lebih pendek/.test(r.err), `kode ${r.kode}\n${r.err}`);
  const x = bacaWav(r.wav);
  tegas(x.length === sam(320), "panjang WAV");
});

// ----------------------------------------------------------------- jalankan
let gagal = 0;
try {
  await siapkan();
  for (const [nama, fn] of kasus) {
    try {
      await fn();
      console.log(`ok   ${nama}`);
    } catch (e) {
      gagal++;
      console.error(`GAGAL ${nama}\n  ${String(e.message ?? e).split("\n").join("\n  ")}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (gagal) {
  console.error(`${gagal} uji gagal`);
  process.exit(1);
}
console.log(`semua ${kasus.length} uji audio-waktu lolos`);
