#!/usr/bin/env bun
/**
 * uji-audio-timeline.mjs — uji rencana audio turunan timeline.json (audio.mjs --timeline,
 * rencanaDariTimeline): pemetaan track ke rencana, aturan klip dan ducking, fail-closed bila
 * timeline tidak valid, kesetaraan pemetaan waktu dengan runtime.js, dan kenyaringan hasil rakitan.
 *
 * Fixture: aset.json, sumber.json, dan media kecil dari templates/timeline-contoh (buatan sendiri,
 * CC0/CC BY milik proyek: klip 1000 Hz dan 700 Hz, narasi 330 Hz, musik akor 220/277/330 Hz).
 * Timeline uji ditulis di sini sendiri (bukan dari templat) agar tidak bergantung pada perubahan
 * templat. Tanpa Chromium, tanpa jaringan. Exit 0 bila semua lolos, 1 bila gagal.
 *
 *   bun scripts/uji-audio-timeline.mjs
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { rencanaDariTimeline, validasiRencana } from "./audio.mjs";
import { akhirAudioButir, butirBerikutnya } from "./timeline.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const audioMjs = join(akar, "scripts", "audio.mjs");
const klipMjs = join(akar, "scripts", "klip.mjs");
const templat = join(akar, "templates", "timeline-contoh");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-audio-tl-"));
const j = (...p) => join(tmp, ...p);
const RT = createRequire(import.meta.url)("./runtime.js");
const FPS = 30;

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
const dekat = (nyata, harapan, tol, nama) => tegas(Math.abs(nyata - harapan) <= tol, `${nama}: dapat ${nyata.toFixed(2)}, harapan ${harapan} +-${tol}`);
const salin = (o) => JSON.parse(JSON.stringify(o));
const tulisJson = (f, o) => writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);
const bacaJson = (f) => JSON.parse(readFileSync(f, "utf8"));
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const bun = (...a) => jalankan(["bun", ...a]);

/** WAV float32 stereo keluaran audio.mjs -> { kiri, sr } */
function bacaWav(berkas) {
  const b = readFileSync(berkas);
  let o = 12;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === "data") {
      const d = b.subarray(o + 8, o + 8 + n);
      const s = new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
      return { kiri: Float32Array.from({ length: s.length / 2 }, (_, i) => s[i * 2]), sr: 48000 };
    }
    o += 8 + n;
  }
  throw new Error(`tidak ada chunk data di ${berkas}`);
}
const potong = (w, dari, sampai) => w.kiri.subarray(Math.round(dari * w.sr), Math.round(sampai * w.sr));
/** Daya (dB, relatif 1.0) komponen sinus pada hz di jendela [dari, sampai) detik. */
function dayaDb(w, hz, dari, sampai) {
  const x = potong(w, dari, sampai), N = x.length;
  let a = 0, c = 0;
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * hz * i) / w.sr;
    a += x[i] * Math.cos(t);
    c += x[i] * Math.sin(t);
  }
  return 10 * Math.log10(((2 / N) ** 2 * (a * a + c * c)) / 2 + 1e-20);
}
/** Kenyaringan terintegrasi (LUFS, EBU R 128) jendela [dari, sampai) detik dari WAV. */
async function lufs(berkas, dari, sampai) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-i", berkas, "-af", `atrim=start=${dari}:end=${sampai},ebur128=framelog=quiet`, "-f", "null", "-"]);
  tegas(r.kode === 0, `ffmpeg ebur128 gagal: ${r.err}`);
  const m = [...r.err.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  tegas(m, `ebur128 tidak melaporkan I: ${r.err}`);
  return Number(m[1]);
}

// ----------------------------------------------------------------- fixture
const dir = j("proyek");
cpSync(templat, dir, { recursive: true });
for (const f of ["timeline.json", "timeline-sederhana.json"]) rmSync(join(dir, f), { force: true }); // timeline uji ditulis di bawah
const k = await bun(klipMjs, join(dir, "sumber.json"), "--fps", String(FPS), "--out", join(dir, "klip"));
tegas(k.kode === 0, `klip.mjs gagal: ${k.err}${k.out}`);
const klipPropsBerkas = join(dir, "klip", "klip-props.json");
const klipProps = { dok: bacaJson(klipPropsBerkas), dir: dirname(klipPropsBerkas) };

const KREDIT = { id: "kredit-1", jenis: "kredit", mulai: 270, durasi: 30 };
/** Timeline dasar 10 detik: k1 bergantian [0,90), k2 campur [90,190), narasi [150,240), musik penuh. */
function dasar() {
  return {
    skema: 1,
    proyek: { lebar: 1280, tinggi: 720, fps: FPS, durasi: 300, jenisVideo: "promo" },
    manifes: { aset: "aset.json", sumber: "sumber.json" },
    audio: { fadeMs: 200, ucapanLufs: -16 },
    track: [
      { id: "t-v", jenis: "video", butir: [
        { id: "adegan-1", jenis: "video", klip: "k1", mulai: 0, durasi: 90, audio: { mode: "bergantian" } },
        { id: "adegan-2", jenis: "video", klip: "k2", mulai: 90, durasi: 100, audio: { mode: "campur", turunDb: 12 } },
        { id: "latar", jenis: "warna", warna: "#0b1220", mulai: 190, durasi: 110 },
      ] },
      { id: "t-kredit", jenis: "teks", butir: [KREDIT] },
      { id: "a-narasi", jenis: "audio", butir: [{ id: "narasi-1", jenis: "audio", aset: "narasi-1", mulai: 150, durasi: 90 }] },
      { id: "a-musik", jenis: "audio", butir: [{ id: "musik-1", jenis: "audio", aset: "musik-1", mulai: 0, durasi: 300, ducking: { levelDb: -12, bebasDb: -6 } }] },
    ],
  };
}
const dirTl = dir;
const turunkan = (t, opsi = {}) => rencanaDariTimeline(t, dirTl, { klipProps, ...opsi });
const kodeAda = (r, kode, lok) => r.galat.some((x) => x.kode === kode && (lok === undefined || x.lok === lok));
const ringkas = (r) => r.galat.map((x) => `[${x.kode}] ${x.lok}: ${x.pesan}`).join("\n");

const hasil = [];
function daftar(nama, fn) {
  hasil.push({ nama, fn });
}

// ======================================================= (a) pemetaan track ke rencana
daftar("(a) pemetaan: narasi, musik (ducking), klip bergantian/campur, id dan berkas, gain track + butir", async () => {
  const t = dasar();
  t.track[2].gainDb = -3;
  t.track[2].butir[0].gainDb = 1;
  t.track[3].gainDb = -2;
  const r = await turunkan(t);
  tegas(r.galat.length === 0 && r.rencana, `timeline sah harus lolos:\n${ringkas(r)}`);
  const p = r.rencana;
  tegas(p.fps === FPS && p.durasiFrame === 300 && p.fadeMs === 200 && p.ucapanLufs === -16, `kepala rencana: ${JSON.stringify(p)}`);
  tegas(p.narasi.length === 1 && p.narasi[0].id === "narasi-1" && p.narasi[0].mulai === 150 && p.narasi[0].gainDb === -2, `narasi: ${JSON.stringify(p.narasi)}`);
  tegas(p.narasi[0].berkas === join(dir, "aset", "narasi-1.m4a"), `berkas narasi: ${p.narasi[0].berkas}`);
  tegas(p.musik.levelDb === -12 && p.musik.bebasDb === -6 && p.musik.gainDb === -2 && p.musik.berkas === join(dir, "aset", "musik-1.m4a"), `musik: ${JSON.stringify(p.musik)}`);
  const a1 = p.klip.find((x) => x.id === "adegan-1"), a2 = p.klip.find((x) => x.id === "adegan-2");
  tegas(a1.mode === "bergantian" && a1.mulai === 0 && a1.akhir === 90 && a1.dariDetik === 0, `adegan-1: ${JSON.stringify(a1)}`);
  tegas(a2.mode === "campur" && a2.mulai === 90 && a2.akhir === 190 && a2.turunDb === 12, `adegan-2: ${JSON.stringify(a2)}`);
  const kp = klipProps.dok.klip.find((x) => x.id === "k1");
  tegas(a1.berkas === join(klipProps.dir, kp.audio), `berkas audio klip dari klip-props: ${a1.berkas}`);
  tegas(!p.klip.some((x) => x.id === "latar"), "butir warna bukan klip bersuara");
  // rencana turunan lolos validasiRencana (pertahanan kedua)
  const v = await validasiRencana(p, dir, { fps: FPS });
  tegas(v.galat.length === 0, `validasiRencana: ${v.galat.join("; ")}`);
  // narasi tanpa gain tidak menulis gainDb
  const t2 = dasar();
  const r2 = await turunkan(t2);
  tegas(!("gainDb" in r2.rencana.narasi[0]) && !("gainDb" in r2.rencana.musik), "gain 0 tidak ditulis");
});

daftar("(a2) dariDetik dari pemetaan waktu runtime (dari + offset), butir bisu dan track aktif:false", async () => {
  const t = dasar();
  t.track[0].butir[0].dari = 15;
  t.track[0].butir[0].durasi = 60;
  t.track[0].butir[1].audio = { mode: "bisu" };
  const r = await turunkan(t);
  tegas(r.rencana, ringkas(r));
  const a1 = r.rencana.klip.find((x) => x.id === "adegan-1");
  tegas(a1.dariDetik === RT.frameSumber({}, 0, { durasi: 60, dari: 15 }) / FPS && a1.dariDetik === 0.5, `dariDetik ${a1.dariDetik}`);
  const a2 = r.rencana.klip.find((x) => x.id === "adegan-2");
  tegas(a2.mode === "bisu" && !("berkas" in a2), `butir bisu tanpa berkas: ${JSON.stringify(a2)}`);
  // track audio aktif:false dilewati (tetap divalidasi)
  const t2 = dasar();
  t2.track[2].aktif = false;
  t2.track[0].butir[1].audio = { mode: "bisu" };
  const r2 = await turunkan(t2);
  tegas(r2.rencana && r2.rencana.narasi.length === 0, `narasi aktif:false dilewati: ${r2.rencana && JSON.stringify(r2.rencana.narasi)}`);
  const t3 = dasar();
  t3.track[2].aktif = false;
  t3.track[2].butir[0].aset = "tidak-ada";
  const r3 = await turunkan(t3);
  tegas(!r3.rencana && kodeAda(r3, "R02"), `track aktif:false tetap divalidasi: ${ringkas(r3)}`);
});

// ======================================================= (b) aturan klip: transisi, bergantian
daftar("(b) butir keluar berakhir di awal transisi (A-3): dua klip bergantian dengan transisi tidak bertabrakan", async () => {
  const t = dasar();
  t.track[0].butir = [
    { id: "adegan-1", jenis: "video", klip: "k1", mulai: 0, durasi: 90, audio: { mode: "bergantian" } },
    { id: "adegan-2", jenis: "video", klip: "k2", mulai: 75, durasi: 80, audio: { mode: "bergantian" }, transisi: { jenis: "pudarMelalui", durasi: 15 } },
    { id: "latar", jenis: "warna", warna: "#0b1220", mulai: 155, durasi: 145 },
  ];
  t.track[2].butir[0].mulai = 200; // narasi sesudah klip
  const r = await turunkan(t);
  tegas(r.rencana, `timeline sah:\n${ringkas(r)}`);
  const a1 = r.rencana.klip.find((x) => x.id === "adegan-1"), a2 = r.rencana.klip.find((x) => x.id === "adegan-2");
  tegas(a1.akhir === 75 && a2.mulai === 75, `akhir adegan-1 = awal transisi (75): ${a1.akhir}`);
  const v = await validasiRencana(r.rencana, dir, { fps: FPS });
  tegas(v.galat.length === 0, `tidak ada tumpang tindih pemegang suara: ${v.galat.join("; ")}`);
  // helper bersama validator dan perakit
  tegas(akhirAudioButir(90, t.track[0].butir[1]) === 75 && akhirAudioButir(90, undefined) === 90 && akhirAudioButir(90, { mulai: 90 }) === 90, "akhirAudioButir");
  tegas(butirBerikutnya(t.track[0]).get("adegan-1").id === "adegan-2", "butirBerikutnya");
});

// ======================================================= (c) fail-closed
daftar("(c) fail-closed: narasi bertabrakan dengan audio klip bergantian ditolak (R11), tanpa rencana dan tanpa WAV", async () => {
  const t = dasar();
  t.track[0].butir[1].audio = { mode: "bergantian" }; // narasi 150..239 tumpang adegan-2 90..189
  const r = await turunkan(t);
  tegas(!r.rencana && kodeAda(r, "R11", "/track/0/butir/1"), `harus R11:\n${ringkas(r)}`);
  const berkas = join(dir, "tabrak.json"), wav = j("tabrak.wav");
  tulisJson(berkas, t);
  const c = await bun(audioMjs, "--timeline", berkas, "--klip-props", klipPropsBerkas, "--out", wav);
  tegas(c.kode === 2 && /timeline ditolak/.test(c.err) && /\[R11\]/.test(c.err), `exit ${c.kode}\n${c.err}`);
  tegas(!existsSync(wav), "WAV tidak boleh ditulis bila timeline ditolak");
});

daftar("(c2) fail-closed: skema salah, rujukan aset hilang, waktu bukan identitas, musik terpotong, audio klip tanpa --klip-props", async () => {
  let t = dasar();
  t.track[0].butir[0].audio.mode = "keras";
  let r = await turunkan(t);
  tegas(!r.rencana && kodeAda(r, "SKEMA"), `skema:\n${ringkas(r)}`);

  t = dasar();
  t.track[2].butir[0].aset = "narasi-hantu";
  r = await turunkan(t);
  tegas(!r.rencana && kodeAda(r, "R02", "/track/2/butir/0/aset"), `aset hilang:\n${ringkas(r)}`);

  // speed pada klip bersuara: ditolak validator (R09); bila lolos validator, A04 menahannya (diuji langsung di bawah)
  t = dasar();
  t.track[0].butir[1].waktu = { kecepatan: 1.5 };
  r = await turunkan(t);
  tegas(!r.rencana && kodeAda(r, "R09", "/track/0/butir/1/audio/mode"), `speed bersuara:\n${ringkas(r)}`);

  // musik dipotong: R10 tidak mengatur akhir musik, audio.mjs memutar sepanjang video -> A02
  t = dasar();
  t.track[3].butir[0].durasi = 200;
  r = await turunkan(t);
  tegas(!r.rencana && kodeAda(r, "A02", "/track/3/butir/0"), `musik pendek:\n${ringkas(r)}`);
  t = dasar();
  t.track[3].butir[0].dari = 30;
  r = await turunkan(t);
  tegas(!r.rencana && kodeAda(r, "A02", "/track/3/butir/0"), `musik beroffset:\n${ringkas(r)}`);

  // audio klip bersuara tanpa --klip-props
  t = dasar();
  r = await rencanaDariTimeline(t, dirTl, {});
  tegas(!r.rencana && kodeAda(r, "A01", "/track/0/butir/0/audio/mode"), `tanpa klip-props:\n${ringkas(r)}`);
  // ... tetapi timeline yang semua klipnya bisu tidak membutuhkannya
  t = dasar();
  t.track[0].butir[0].audio = { mode: "bisu" };
  t.track[0].butir[1].audio = { mode: "bisu" };
  r = await rencanaDariTimeline(t, dirTl, {});
  tegas(r.rencana, `semua bisu tanpa klip-props:\n${ringkas(r)}`);

  // klip tanpa audio di klip-props
  t = dasar();
  const tanpa = { dok: salin(klipProps.dok), dir: klipProps.dir };
  tanpa.dok.klip.find((x) => x.id === "k1").audio = null;
  r = await rencanaDariTimeline(t, dirTl, { klipProps: tanpa });
  tegas(!r.rencana && (kodeAda(r, "R09") || kodeAda(r, "A01")), `klip tanpa audio:\n${ringkas(r)}`);

  // galat dari musik: ducking di luar rentang audio.mjs (bebasDb < levelDb) ditahan validasiRencana
  t = dasar();
  t.track[3].butir[0].ducking = { levelDb: -8, bebasDb: -12 };
  r = await turunkan(t);
  tegas(r.rencana, `rencana terbentuk: ${ringkas(r)}`);
  const v = await validasiRencana(r.rencana, dir, { fps: FPS });
  tegas(v.galat.some((x) => /bebasDb harus di antara levelDb/.test(x)), `validasiRencana menolak ducking: ${v.galat.join("; ")}`);
});

daftar("(c3) fail-closed: audio.mjs menolak gainDb di luar rentang dan --fps yang berbeda dari timeline", async () => {
  const t = dasar();
  const r = await turunkan(t);
  const p = salin(r.rencana);
  p.narasi[0].gainDb = 40;
  const v = await validasiRencana(p, dir, { fps: FPS });
  tegas(v.galat.some((x) => /gainDb harus angka -60\.\.12/.test(x)), `gainDb narasi: ${v.galat.join("; ")}`);
  const berkas = join(dir, "fps.json");
  tulisJson(berkas, t);
  const c = await bun(audioMjs, "--timeline", berkas, "--klip-props", klipPropsBerkas, "--fps", "25", "--out", j("fps.wav"));
  tegas(c.kode === 2 && /berbeda dari proyek\.fps/.test(c.err), `exit ${c.kode}\n${c.err}`);
  const d = await bun(audioMjs, "--timeline", berkas, "--klip-props", klipPropsBerkas);
  tegas(d.kode === 2 && /--out/.test(d.err), `tanpa --out: exit ${d.kode}\n${d.err}`);
  const e = await bun(audioMjs, berkas, "--fps", "30", "--out", j("x.wav"), "--draf");
  tegas(e.kode === 2 && /hanya untuk --timeline/.test(e.err), `--draf tanpa --timeline: exit ${e.kode}\n${e.err}`);
});

// ======================================================= (d) kesetaraan pemetaan waktu dengan runtime
daftar("(d) pemetaan waktu: identitas ditentukan RT.petaWaktuKlip (ramp 1x identitas; speed, reverse, freeze bukan); bersuara + non-identitas ditolak", async () => {
  const identitas = RT.petaWaktuKlip({ kecepatan: [{ pada: 0, nilai: 1 }, { pada: 59, nilai: 1 }] }, 60);
  tegas(identitas.every((v, n) => v === n), "ramp konstan 1x = identitas di runtime");
  for (const [nama, w] of [["speed", { kecepatan: 2 }], ["reverse", { balik: true }], ["freeze", { bekukan: true }]]) {
    const tabel = RT.petaWaktuKlip(w, 60);
    tegas(!tabel.every((v, n) => v === n), `${nama} bukan identitas di runtime`);
  }
  // validator (R09) menolak lebih dulu; A04 di rencanaDariTimeline adalah lapis kedua bila aturan R09 kelak melonggar
  const t = dasar();
  t.track[0].butir[0].waktu = { balik: true };
  const r = await turunkan(t);
  tegas(!r.rencana && kodeAda(r, "R09", "/track/0/butir/0/audio/mode"), `reverse bersuara ditolak:\n${ringkas(r)}`);
  const sumber = readFileSync(join(akar, "scripts", "audio.mjs"), "utf8");
  tegas(/RT\.petaWaktuKlip\(/.test(sumber) && /RT\.frameSumber\(/.test(sumber), "audio.mjs memakai RT.petaWaktuKlip dan RT.frameSumber");
});

// ======================================================= (e) rakit nyata: tabrakan dan kenyaringan
let wavUtama;
daftar("(e) rakit: CLI --timeline menulis WAV dan rencana turunan; audio klip tidak bertabrakan dengan audio utama", async () => {
  const berkas = join(dir, "timeline.json");
  tulisJson(berkas, dasar());
  wavUtama = j("campuran.wav");
  const rencanaKeluar = j("rencana", "turunan.json");
  const c = await bun(audioMjs, "--timeline", berkas, "--klip-props", klipPropsBerkas, "--out", wavUtama, "--rencana-keluar", rencanaKeluar);
  tegas(c.kode === 0, `exit ${c.kode}\n${c.err}\n${c.out}`);
  tegas(/peringatan \[W05\]/.test(c.err), `peringatan narasi di atas klip campur:\n${c.err}`);
  tegas(/Pemegang suara per rentang frame/.test(c.out) && /campur/.test(c.out), `tabel pemegang:\n${c.out}`);
  const rencana = bacaJson(rencanaKeluar);
  tegas(rencana.klip.length === 2 && rencana.narasi.length === 1, "rencana turunan tertulis");
  const w = bacaWav(wavUtama);
  dekat(w.kiri.length / w.sr, 10, 0.001, "durasi WAV (s)");
  // [0,3) klip k1 bergantian: 1000 Hz ada; narasi (330) dan musik (220) hening (jendela 0,3..2,7 di luar fade)
  const k1 = dayaDb(w, 1000, 0.3, 2.7), n330 = dayaDb(w, 330, 0.3, 2.7), m220 = dayaDb(w, 220, 0.3, 2.7);
  tegas(k1 > -30, `klip 1000 Hz terdengar: ${k1.toFixed(1)} dB`);
  tegas(k1 - n330 > 50 && k1 - m220 > 50, `klip eksklusif: 1000 Hz ${k1.toFixed(1)} dB, 330 Hz ${n330.toFixed(1)} dB, 220 Hz ${m220.toFixed(1)} dB`);
  // [6.34,8) narasi saja (tanpa klip): 1000 Hz dan 700 Hz hening
  const k700 = dayaDb(w, 700, 6.6, 7.8), k1k = dayaDb(w, 1000, 6.6, 7.8), nar = dayaDb(w, 330, 6.6, 7.8);
  tegas(nar - k700 > 40 && nar - k1k > 40, `narasi sendirian: 330 Hz ${nar.toFixed(1)}, 700 Hz ${k700.toFixed(1)}, 1000 Hz ${k1k.toFixed(1)}`);
  // klip campur diturunkan 12 dB selama narasi (jendela 1 s = 4 periode tremolo)
  const bebas = dayaDb(w, 700, 3.5, 4.5), duck = dayaDb(w, 700, 5.25, 6.25);
  console.log(`  ukur: klip1000=${k1.toFixed(1)} n330=${n330.toFixed(1)} m220=${m220.toFixed(1)} bebas700=${bebas.toFixed(1)} duck700=${duck.toFixed(1)}`);
  dekat(bebas - duck, 12, 1.5, "penurunan klip campur selama narasi (dB)");
  // musik: bebas -6 dB relatif ucapan, ducking ke -12 dB saat narasi (220 Hz unik musik), bisu saat klip bergantian
  const mBebas = dayaDb(w, 220, 8.4, 9.9), mNarasi = dayaDb(w, 220, 6.6, 7.8), mBebasAwal = dayaDb(w, 220, 3.3, 4.7);
  dekat(mBebas - mNarasi, 6, 1.5, "ducking musik saat narasi (dB)");
  tegas(mBebasAwal - mBebas < 8 && mBebasAwal - mBebas > -8, `musik bebas konsisten: ${mBebasAwal.toFixed(1)} vs ${mBebas.toFixed(1)}`);
});

daftar("(e2) kenyaringan: narasi, klip bergantian, dan musik bebas mendekati target ucapanLufs; deterministik", async () => {
  // timeline tanpa tumpang tindih agar tiap sumber terukur sendiri: k1 bergantian, narasi, lalu musik sendirian
  const t = dasar();
  t.track[0].butir[1] = { id: "adegan-2", jenis: "video", klip: "k2", mulai: 90, durasi: 100, audio: { mode: "bisu" } };
  t.track[2].butir[0].mulai = 120; // narasi 120..209 (4,0..7,0 s)
  t.proyek.durasi = 450; // 15 s: musik bebas 7..15 s
  t.track[0].butir[2] = { id: "latar", jenis: "warna", warna: "#0b1220", mulai: 190, durasi: 260 };
  t.track[1].butir[0] = { ...KREDIT, mulai: 420 };
  t.track[3].butir[0].durasi = 450;
  const tl = join(dir, "timeline-l.json");
  tulisJson(tl, t);
  const w1 = j("l1.wav"), w2 = j("l2.wav");
  for (const w of [w1, w2]) {
    const c = await bun(audioMjs, "--timeline", tl, "--klip-props", klipPropsBerkas, "--out", w);
    tegas(c.kode === 0, `exit ${c.kode}\n${c.err}`);
  }
  tegas(Buffer.compare(readFileSync(w1), readFileSync(w2)) === 0, "dua rakitan identik byte demi byte");
  const klipL = await lufs(w1, 0.4, 2.8);
  const narasiL = await lufs(w1, 4.2, 6.8);
  dekat(klipL, -16, 1.0, "kenyaringan klip bergantian (LUFS)");
  // narasi: musik ducking ikut terukur (-12 dB di bawah, nada 330 Hz sama dengan narasi), toleransi lebih longgar
  dekat(narasiL, -16, 1.5, "kenyaringan narasi + musik ducking (LUFS)");
  // musik bebas (7,6..14,6 s): ucapanLufs + bebasDb = -22
  const musikL = await lufs(w1, 7.6, 14.6);
  dekat(musikL, -22, 1.0, "kenyaringan musik bebas (LUFS)");
});

// ----------------------------------------------------------------- jalankan
let gagal = 0;
for (const { nama, fn } of hasil) {
  try {
    await fn();
    console.log(`ok   ${nama}`);
  } catch (e) {
    gagal++;
    console.log(`GAGAL ${nama}\n  ${String(e.message).replace(/\n/g, "\n  ")}`);
  }
}
rmSync(tmp, { recursive: true, force: true });
if (gagal) {
  console.log(`${gagal} dari ${hasil.length} uji audio timeline gagal`);
  process.exit(1);
}
console.log(`semua ${hasil.length} uji audio timeline lolos`);
