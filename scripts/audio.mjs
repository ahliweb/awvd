#!/usr/bin/env bun
/**
 * awvd / audio.mjs — perakit timeline audio deterministik dengan pemegang suara
 * eksklusif: narasi induk, musik induk, dan audio klip tertanam menjadi satu WAV.
 *
 *   bun scripts/audio.mjs <rencana-audio.json> --fps N --out campuran.wav
 *        [--klip-props klip-props.json] [--ketat-campur]
 *
 * WAV hasil (48 kHz stereo, float 32-bit, tanpa metadata versi) diberikan ke
 * `render.mjs --audio`, yang menormalisasi kenyaringan campuran (--kenyaringan).
 *
 * Aturan (ringkas; rincian dan dasar di README §Timeline audio):
 *   - Mode klip: "bergantian" (bawaan; klip memegang suara eksklusif pada rentangnya,
 *     validasi GAGAL bila narasi induk tumpang tindih), "campur" (semua terdengar;
 *     audio induk tetap pada level normal, audio KLIP diturunkan turunDb, bawaan 12 dB,
 *     selama narasi aktif), "bisu" (tidak dimasukkan).
 *   - Musik induk: bebas pada level bebasDb saat tak ada suara, turun ke levelDb (bawaan
 *     -12 dB di bawah ucapan) saat ada narasi/klip bersuara, bisu saat klip bergantian.
 *   - Fade 200 ms (100..300) di batas klip dan di setiap perubahan pemegang suara.
 *   - Tiap sumber diukur (EBU R 128, ebur128) dan disamakan ke ucapanLufs (bawaan -16)
 *     sebelum dicampur, supaya pergantian narasi-klip tidak melonjak.
 *   - Perakitan ffmpeg deterministik: volume eval=frame, adelay, amix normalize=0.
 * Kode keluar 0 berhasil, 2 rencana/argumen tidak valid, 1 galat ffmpeg. Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";

export const SR = 48000;
const MODE = ["bergantian", "campur", "bisu"];
const BATAS = { fadeMs: [100, 300], turunDb: [8, 20], musikLevelDb: [-20, -8] };
const GRANULARITAS = 480; // sampel per blok volume: 10 ms, kemiringan fade tidak patah-patah

// ------------------------------------------------------------- envelope murni
/**
 * Envelope gain (linear) dari target per frame: turun lebih dulu (rampa selesai tepat di
 * batas frame), naik mulai di batas; kemiringan maksimum puncak/fade per frame. Mengembalikan
 * array G[0..N] (gain pada waktu f/fps) yang tidak pernah melebihi target.
 */
export function batasiKemiringan(target, fade) {
  const N = target.length;
  if (N === 0) return [0];
  const puncak = Math.max(...target);
  if (puncak <= 0) return new Array(N + 1).fill(0);
  const s = puncak / Math.max(1, fade);
  const U = new Array(N + 1);
  U[0] = target[0];
  U[N] = target[N - 1];
  for (let f = 1; f < N; f++) U[f] = Math.min(target[f], target[f - 1]);
  const B = U.slice();
  for (let f = N - 1; f >= 0; f--) B[f] = Math.min(U[f], B[f + 1] + s);
  const G = B.slice();
  for (let f = 1; f <= N; f++) G[f] = Math.min(B[f], G[f - 1] + s);
  return G;
}

/** Titik patah (waktu detik, gain) dari G; titik segaris dibuang. */
export function titikPatah(G, fps) {
  const p = G.map((g, f) => [f / fps, g]);
  const hasil = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const [t0, g0] = hasil[hasil.length - 1], [t1, g1] = p[i], [t2, g2] = p[i + 1];
    const k1 = (g1 - g0) / (t1 - t0), k2 = (g2 - g1) / (t2 - t1);
    if (Math.abs(k1 - k2) > 1e-9) hasil.push(p[i]);
  }
  if (p.length > 1) hasil.push(p[p.length - 1]);
  return hasil;
}

/** Ekspresi volume ffmpeg (linear per bagian) dalam waktu t; null bila gain konstan. */
export function ekspresiEnvelope(G, fps) {
  const pts = titikPatah(G, fps);
  if (pts.every((q) => Math.abs(q[1] - pts[0][1]) < 1e-9)) return null;
  const f = (x) => x.toFixed(6);
  let e = f(pts[pts.length - 1][1]);
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, g0] = pts[i], [t1, g1] = pts[i + 1];
    e = `if(lt(t,${f(t1)}),${f(g0)}+(${f(g1 - g0)})*(t-${f(t0)})/${f(t1 - t0)},${e})`;
  }
  return e.replace(/,/g, "\\,");
}

// ------------------------------------------------------------------- ffmpeg
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}

async function probeAudio(berkas) {
  const r = await jalankan(["ffprobe", "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=channels,duration:format=duration", "-of", "json", berkas]);
  if (r.kode !== 0) return { galat: `ffprobe gagal: ${r.err.trim()}` };
  const j = JSON.parse(r.out);
  const s = j.streams?.[0];
  if (!s) return { galat: "tidak ada trek audio" };
  const durasi = Number(j.format?.duration ?? s.duration);
  if (!Number.isFinite(durasi)) return { galat: "durasi audio tidak terbaca" };
  return { kanal: Number(s.channels), durasi };
}

// resample ke 48 kHz lalu ke stereo; mono diduplikasi tepat (tanpa potongan -3 dB)
function rantaiMasuk(kanal) {
  const stereo = kanal === 1 ? "pan=stereo|c0=c0|c1=c0" : kanal === 2 ? "anull" : "aformat=channel_layouts=stereo";
  return `aresample=${SR},${stereo}`;
}

/** Kenyaringan terintegrasi (LUFS) bagian sumber yang dipakai; NaN bila senyap/tak terukur. */
async function ukurLufs(berkas, kanal, { mulai = 0, durasi } = {}) {
  const a = ["-hide_banner", "-nostats"];
  if (mulai) a.push("-ss", mulai.toFixed(6));
  if (durasi) a.push("-t", durasi.toFixed(6));
  a.push("-i", berkas, "-vn", "-af", `${rantaiMasuk(kanal)},ebur128`, "-f", "null", "-");
  const r = await jalankan(["ffmpeg", ...a]);
  if (r.kode !== 0) throw new Error(`ffmpeg ebur128 gagal untuk ${berkas}: ${r.err.trim()}`);
  const ringkas = r.err.slice(r.err.lastIndexOf("Summary:"));
  const m = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(ringkas);
  if (!m) throw new Error(`ringkasan ebur128 tidak terbaca untuk ${berkas}`);
  const v = m[1] === "-inf" ? -Infinity : Number(m[1]);
  return Number.isFinite(v) && v > -69.9 ? v : NaN;
}

// --------------------------------------------------------------- rencana
const rentang = (a, e) => `${a}..${e - 1}`;
const tumpang = (x, y) => Math.max(x.mulai, y.mulai) < Math.min(x.akhir, y.akhir);
const irisan = (x, y) => rentang(Math.max(x.mulai, y.mulai), Math.min(x.akhir, y.akhir));
const bulat = (v) => Number.isInteger(v);
const adaTeks = (v) => typeof v === "string" && v.trim() !== "";
const mutlak = (dir, p) => (isAbsolute(p) ? p : resolve(dir, p));

/**
 * Membaca dan memvalidasi rencana. Mengembalikan { galat[], peringatan[], rencana }.
 * rencana = { fps, total, fade, ucapanLufs, narasi[], klip[], musik|null } dengan
 * rentang frame setengah terbuka [mulai, akhir).
 */
export async function validasiRencana(r, dir, { fps, klipProps, ketatCampur = false }) {
  const galat = [], peringatan = [];
  const g = (p) => galat.push(p);
  if (r === null || typeof r !== "object" || Array.isArray(r)) return { galat: ["rencana harus objek JSON"], peringatan };
  if (r.fps !== undefined && r.fps !== fps) g(`rencana.fps (${r.fps}) berbeda dari --fps (${fps})`);
  if (!bulat(r.durasiFrame) || r.durasiFrame <= 0) g("durasiFrame wajib bilangan bulat positif (jumlah frame komposisi)");
  const total = r.durasiFrame;

  const fadeMs = r.fadeMs ?? 200;
  if (typeof fadeMs !== "number" || fadeMs < BATAS.fadeMs[0] || fadeMs > BATAS.fadeMs[1]) {
    g(`fadeMs di luar ${BATAS.fadeMs[0]}..${BATAS.fadeMs[1]} ms (dapat ${JSON.stringify(r.fadeMs)})`);
  }
  const fade = Math.max(1, Math.round((fadeMs * fps) / 1000));
  const ucapanLufs = r.ucapanLufs ?? -16;
  if (typeof ucapanLufs !== "number" || !(ucapanLufs >= -40 && ucapanLufs <= -5)) g("ucapanLufs harus angka -40..-5");

  // narasi
  const narasi = [];
  for (const [i, n] of (r.narasi ?? []).entries()) {
    if (n === null || typeof n !== "object") { g(`narasi[${i}] harus objek`); continue; }
    const id = adaTeks(n.id) ? n.id : adaTeks(n.berkas) ? basename(n.berkas, extname(n.berkas)) : `narasi${i}`;
    const nama = `narasi "${id}"`;
    if (!adaTeks(n.berkas)) { g(`${nama}: berkas wajib`); continue; }
    const berkas = mutlak(dir, n.berkas);
    if (!bulat(n.mulai) || n.mulai < 0 || (bulat(total) && n.mulai >= total)) { g(`${nama}: mulai harus bilangan bulat 0..${total - 1}`); continue; }
    if (!existsSync(berkas)) { g(`${nama}: berkas tidak ditemukan: ${n.berkas}`); continue; }
    const pa = await probeAudio(berkas);
    if (pa.galat) { g(`${nama}: ${pa.galat}`); continue; }
    const akhir = n.mulai + Math.ceil(pa.durasi * fps - 1e-6);
    if (akhir > total) peringatan.push(`${nama}: berakhir di frame ${akhir - 1}, melewati durasiFrame (${total}); dipotong`);
    narasi.push({ id, berkas, mulai: n.mulai, akhir: Math.min(akhir, total), kanal: pa.kanal, durasi: pa.durasi });
  }
  const idN = new Set();
  for (const n of narasi) { if (idN.has(n.id)) g(`narasi "${n.id}": id ganda`); idN.add(n.id); }

  // musik
  let musik = null;
  if (r.musik !== undefined && r.musik !== null) {
    const m = r.musik;
    const levelDb = m.levelDb ?? -12, bebasDb = m.bebasDb ?? -6;
    if (!adaTeks(m.berkas)) g("musik: berkas wajib");
    else if (!existsSync(mutlak(dir, m.berkas))) g(`musik: berkas tidak ditemukan: ${m.berkas}`);
    if (typeof levelDb !== "number" || levelDb < BATAS.musikLevelDb[0] || levelDb > BATAS.musikLevelDb[1]) {
      g(`musik.levelDb di luar ${BATAS.musikLevelDb[0]}..${BATAS.musikLevelDb[1]} dB (selisih musik di bawah ucapan harus 8..20 dB; dapat ${JSON.stringify(m.levelDb)})`);
    } else if (typeof bebasDb !== "number" || bebasDb < levelDb || bebasDb > 0) {
      g(`musik.bebasDb harus di antara levelDb (${levelDb}) dan 0 (dapat ${JSON.stringify(m.bebasDb)})`);
    } else if (adaTeks(m.berkas) && existsSync(mutlak(dir, m.berkas))) {
      const berkas = mutlak(dir, m.berkas);
      const pa = await probeAudio(berkas);
      if (pa.galat) g(`musik: ${pa.galat}`);
      else {
        if (pa.durasi * fps < total - 1) peringatan.push(`musik lebih pendek (${pa.durasi.toFixed(2)} s) daripada video (${(total / fps).toFixed(2)} s); sisanya senyap`);
        musik = { berkas, levelDb, bebasDb, kanal: pa.kanal };
      }
    }
  }

  // klip
  const klip = [];
  const idK = new Set();
  for (const [i, k] of (r.klip ?? []).entries()) {
    if (k === null || typeof k !== "object") { g(`klip[${i}] harus objek`); continue; }
    const id = adaTeks(k.id) ? k.id : `klip${i}`;
    const nama = `klip "${id}"`;
    if (idK.has(id)) g(`${nama}: id ganda`);
    idK.add(id);
    const mode = k.mode ?? "bergantian";
    if (!MODE.includes(mode)) { g(`${nama}: mode "${k.mode}" tidak dikenal (${MODE.join(", ")})`); continue; }
    if (!bulat(k.mulai) || !bulat(k.akhir) || k.mulai < 0 || k.akhir <= k.mulai || (bulat(total) && k.akhir > total)) {
      g(`${nama}: rentang frame harus bilangan bulat 0 <= mulai < akhir <= durasiFrame (${total}); akhir eksklusif (dapat ${k.mulai}..${k.akhir})`);
      continue;
    }
    const turunDb = k.turunDb ?? 12;
    if (typeof turunDb !== "number" || turunDb < BATAS.turunDb[0] || turunDb > BATAS.turunDb[1]) {
      g(`${nama}: turunDb di luar ${BATAS.turunDb[0]}..${BATAS.turunDb[1]} dB (dapat ${JSON.stringify(k.turunDb)}); selisih audio induk terhadap klip harus 8..20 dB`);
      continue;
    }
    const gainDb = k.gainDb ?? 0;
    const dariDetik = k.dariDetik ?? 0;
    if (typeof gainDb !== "number" || !Number.isFinite(gainDb) || typeof dariDetik !== "number" || dariDetik < 0) {
      g(`${nama}: gainDb harus angka dan dariDetik >= 0`);
      continue;
    }
    const e = { id, mode, mulai: k.mulai, akhir: k.akhir, turunDb, gainDb, dariDetik, berkas: null };
    if (mode !== "bisu") {
      let rel = k.berkas;
      if (!adaTeks(rel) && klipProps) {
        const p = (klipProps.dok.klip ?? []).find((x) => x.id === id);
        if (!p) { g(`${nama}: berkas audio tidak ada di rencana dan id tidak ditemukan di --klip-props`); continue; }
        if (!p.audio) { g(`${nama}: sumber klip tidak punya trek audio, padahal mode "${mode}"; ubah mode menjadi "bisu"`); continue; }
        e.berkas = mutlak(klipProps.dir, p.audio);
      } else if (!adaTeks(rel)) {
        g(`${nama}: berkas audio wajib untuk mode "${mode}" (atau beri --klip-props); klip tanpa suara pakai mode "bisu"`);
        continue;
      } else {
        e.berkas = mutlak(dir, rel);
      }
      if (!existsSync(e.berkas)) { g(`${nama}: berkas audio tidak ditemukan: ${e.berkas}`); continue; }
      const pa = await probeAudio(e.berkas);
      if (pa.galat) { g(`${nama}: ${pa.galat}`); continue; }
      e.kanal = pa.kanal;
      e.durasiAudio = pa.durasi;
      const perlu = (k.akhir - k.mulai) / fps;
      if (pa.durasi - dariDetik < perlu - 1 / fps) {
        peringatan.push(`${nama}: audio (${(pa.durasi - dariDetik).toFixed(2)} s) lebih pendek daripada rentang klip (${perlu.toFixed(2)} s); sisanya senyap`);
      }
    }
    klip.push(e);
  }

  // aturan pemegang suara
  const bergantian = klip.filter((k) => k.mode === "bergantian");
  const campur = klip.filter((k) => k.mode === "campur");
  for (const [i, a] of narasi.entries()) {
    for (const b of narasi.slice(i + 1)) {
      if (tumpang(a, b)) g(`dua narasi tumpang tindih: "${a.id}" (frame ${rentang(a.mulai, a.akhir)}) dan "${b.id}" (frame ${rentang(b.mulai, b.akhir)}) pada frame ${irisan(a, b)}`);
    }
  }
  for (const k of bergantian) {
    for (const n of narasi) {
      if (tumpang(k, n)) {
        g(`narasi "${n.id}" (frame ${rentang(n.mulai, n.akhir)}) tumpang tindih audio klip "${k.id}" mode bergantian (frame ${rentang(k.mulai, k.akhir)}) pada frame ${irisan(k, n)}; geser salah satunya, atau ubah mode klip menjadi "campur" atau "bisu"`);
      }
    }
  }
  const bersuara = [...bergantian, ...campur];
  for (const [i, a] of bersuara.entries()) {
    for (const b of bersuara.slice(i + 1)) {
      if (tumpang(a, b)) g(`dua klip bersuara tumpang tindih: "${a.id}" (${a.mode}, frame ${rentang(a.mulai, a.akhir)}) dan "${b.id}" (${b.mode}, frame ${rentang(b.mulai, b.akhir)}) pada frame ${irisan(a, b)}`);
    }
  }
  for (const k of campur) {
    for (const n of narasi) {
      if (!tumpang(k, n)) continue;
      const pesan = `narasi "${n.id}" tumpang tindih klip "${k.id}" mode campur pada frame ${irisan(k, n)}: dua aliran ucapan bersamaan (masking informasional); klip diturunkan ${k.turunDb} dB selama narasi`;
      if (ketatCampur) g(`${pesan} (--ketat-campur)`); else peringatan.push(pesan);
    }
  }
  return { galat, peringatan, rencana: { fps, total, fade, ucapanLufs, narasi, klip, musik } };
}

/** Pemegang suara per frame: { kode, narasi, klip } untuk tiap frame 0..total-1. */
export function pemegangPerFrame(rencana) {
  const { total, narasi, klip, musik } = rencana;
  const hasil = new Array(total);
  for (let f = 0; f < total; f++) {
    const n = narasi.find((x) => x.mulai <= f && f < x.akhir) ?? null;
    const kb = klip.find((x) => x.mode === "bergantian" && x.mulai <= f && f < x.akhir) ?? null;
    const kc = klip.find((x) => x.mode === "campur" && x.mulai <= f && f < x.akhir) ?? null;
    let kode;
    if (kb) kode = "klip";
    else if (kc) kode = n ? "campur" : "klip_campur";
    else if (n) kode = "narasi";
    else kode = musik ? "musik" : "senyap";
    hasil[f] = { kode, narasi: n ? n.id : null, klip: kb ? kb.id : kc ? kc.id : null };
  }
  return hasil;
}

/** Rentang frame berturut-turut dengan pemegang yang sama. */
export function rentangPemegang(rencana) {
  const per = pemegangPerFrame(rencana);
  const hasil = [];
  for (let f = 0; f < per.length; f++) {
    const p = per[f], akhir = hasil[hasil.length - 1];
    if (akhir && akhir.kode === p.kode && akhir.narasi === p.narasi && akhir.klip === p.klip) akhir.akhir = f + 1;
    else hasil.push({ ...p, mulai: f, akhir: f + 1 });
  }
  return hasil;
}

function labelPemegang(p, rencana) {
  const k = p.klip ? rencana.klip.find((x) => x.id === p.klip) : null;
  const musik = rencana.musik ? "; musik dibisukan" : "";
  switch (p.kode) {
    case "narasi": return `narasi ${p.narasi}`;
    case "klip": return `klip ${p.klip} (bergantian${musik})`;
    case "campur": return `narasi ${p.narasi} + klip ${p.klip} (campur; klip -${k.turunDb} dB)`;
    case "klip_campur": return `klip ${p.klip} (campur, tanpa narasi; level normal)`;
    case "musik": return "musik (bebas)";
    default: return "senyap";
  }
}

export function tabelPemegang(rencana) {
  const { fps, total } = rencana;
  const baris = rentangPemegang(rencana).map((p) => [
    rentang(p.mulai, p.akhir),
    `${(p.mulai / fps).toFixed(2)}-${(p.akhir / fps).toFixed(2)} s`,
    labelPemegang(p, rencana),
  ]);
  const lebar = [0, 1].map((i) => Math.max(...baris.map((b) => b[i].length), ["frame", "waktu"][i].length));
  const garis = (b) => `  ${b[0].padEnd(lebar[0])}  ${b[1].padEnd(lebar[1])}  ${b[2]}`;
  const bisu = rencana.klip.filter((k) => k.mode === "bisu").map((k) => `${k.id} (frame ${rentang(k.mulai, k.akhir)})`);
  return [
    `Pemegang suara per rentang frame (${total} frame @ ${fps} fps = ${(total / fps).toFixed(2)} s):`,
    garis(["frame", "waktu", "pemegang"]),
    ...baris.map(garis),
    ...(bisu.length ? [`  klip bisu (tidak dimasukkan): ${bisu.join(", ")}`] : []),
  ].join("\n");
}

// ----------------------------------------------------------------- grafik
const dBkeLinear = (db) => 10 ** (db / 20);
const sam = (f, fps) => Math.round((f * SR) / fps);

/** Menyusun argumen input dan filter_complex; level sumber sudah diukur (rencana.*.gainEq dB). */
export function bangunGrafik(rencana) {
  const { fps, total, fade, narasi, klip, musik } = rencana;
  const N = sam(total, fps);
  const fadeDtk = fade / fps;
  const f6 = (x) => x.toFixed(6);
  const inp = [], baris = [], label = [];
  const tambah = (berkas) => { inp.push("-i", berkas); return inp.length / 2 - 1; };
  const narasiAktif = (f) => narasi.some((n) => n.mulai <= f && f < n.akhir);
  const per = pemegangPerFrame(rencana);

  baris.push(`anullsrc=r=${SR}:cl=stereo,atrim=end_sample=${N}[dasar]`);
  label.push("[dasar]");

  for (const [i, n] of narasi.entries()) {
    const k = tambah(n.berkas);
    baris.push(`[${k}:a]${rantaiMasuk(n.kanal)},volume=${n.gainEq.toFixed(4)}dB,adelay=${sam(n.mulai, fps)}S|${sam(n.mulai, fps)}S,apad=whole_len=${N},atrim=end_sample=${N}[n${i}]`);
    label.push(`[n${i}]`);
  }

  for (const [i, c] of klip.entries()) {
    if (c.mode === "bisu") continue;
    const k = tambah(c.berkas);
    const panjang = (c.akhir - c.mulai) / fps;
    const efektif = Math.min(panjang, c.durasiAudio - c.dariDetik);
    const rant = [`[${k}:a]${rantaiMasuk(c.kanal)}`,
      `atrim=start=${f6(c.dariDetik)}:end=${f6(c.dariDetik + efektif)}`, "asetpts=PTS-STARTPTS",
      `volume=${(c.gainEq + c.gainDb).toFixed(4)}dB`,
      `afade=t=in:st=0:d=${f6(fadeDtk)}`, `afade=t=out:st=${f6(Math.max(0, efektif - fadeDtk))}:d=${f6(fadeDtk)}`,
      `adelay=${sam(c.mulai, fps)}S|${sam(c.mulai, fps)}S`, `apad=whole_len=${N}`, `atrim=end_sample=${N}`];
    if (c.mode === "campur") {
      const dd = dBkeLinear(-c.turunDb);
      const T = Array.from({ length: total }, (_, f) => (narasiAktif(f) ? dd : 1));
      const e = ekspresiEnvelope(batasiKemiringan(T, fade), fps);
      if (e) rant.push(`asetnsamples=n=${GRANULARITAS}:p=0`, `volume='${e}':eval=frame`);
    }
    baris.push(`${rant.join(",")}[c${i}]`);
    label.push(`[c${i}]`);
  }

  if (musik) {
    const k = tambah(musik.berkas);
    const duck = dBkeLinear(musik.levelDb - musik.bebasDb);
    const T = per.map((p) => (p.kode === "musik" ? 1 : p.kode === "klip" ? 0 : duck));
    const e = ekspresiEnvelope(batasiKemiringan(T, fade), fps);
    const rant = [`[${k}:a]${rantaiMasuk(musik.kanal)}`, `volume=${musik.gainEq.toFixed(4)}dB`,
      `apad=whole_len=${N}`, `atrim=end_sample=${N}`];
    if (e) rant.push(`asetnsamples=n=${GRANULARITAS}:p=0`, `volume='${e}':eval=frame`);
    baris.push(`${rant.join(",")}[musik]`);
    label.push("[musik]");
  }

  baris.push(`${label.join("")}amix=inputs=${label.length}:normalize=0:duration=first:dropout_transition=0,` +
    `aresample=${SR},aformat=sample_fmts=flt:channel_layouts=stereo,atrim=end_sample=${N}[keluar]`);
  return { inp, filter: baris.join(";"), sampel: N };
}

// ------------------------------------------------------------------------ CLI
function gagal(pesan, kode = 1) {
  console.error(`audio.mjs: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun scripts/audio.mjs <rencana-audio.json> --fps N --out campuran.wav [--klip-props klip-props.json] [--ketat-campur]
Rencana: { durasiFrame, narasi:[{id?,berkas,mulai}], musik?:{berkas,levelDb?,bebasDb?},
  klip:[{id,berkas?,mulai,akhir,mode?,gainDb?,turunDb?,dariDetik?}], fadeMs?, ucapanLufs? }
Jalur berkas relatif terhadap folder rencana. Kode keluar 2 untuk rencana tidak valid.`;

async function utama() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        fps: { type: "string" },
        out: { type: "string" },
        "klip-props": { type: "string" },
        "ketat-campur": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const { values: o, positionals } = args;
  if (o.help) {
    console.log(PETUNJUK);
    return;
  }
  if (positionals.length !== 1) gagal(`harus tepat satu rencana.\n${PETUNJUK}`, 2);
  if (!o.out) gagal(`--out wajib.\n${PETUNJUK}`, 2);
  const fps = Number(o.fps);
  if (o.fps === undefined || !Number.isFinite(fps) || fps <= 0) gagal(`--fps wajib angka positif.\n${PETUNJUK}`, 2);
  const berkasRencana = resolve(positionals[0]);
  if (!existsSync(berkasRencana)) gagal(`rencana tidak ditemukan: ${positionals[0]}`, 2);
  let rencanaJson;
  try {
    rencanaJson = JSON.parse(readFileSync(berkasRencana, "utf8"));
  } catch (e) {
    gagal(`rencana bukan JSON valid: ${e.message}`, 2);
  }
  let klipProps = null;
  if (o["klip-props"]) {
    try {
      klipProps = { dok: JSON.parse(readFileSync(o["klip-props"], "utf8")), dir: dirname(resolve(o["klip-props"])) };
    } catch (e) {
      gagal(`--klip-props tidak terbaca atau bukan JSON valid: ${e.message}`, 2);
    }
  }
  try {
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
  } catch (e) {
    gagal(`tidak bisa membuat folder keluaran untuk ${o.out}: ${e.message}`, 2);
  }

  const v = await validasiRencana(rencanaJson, dirname(berkasRencana), { fps, klipProps, ketatCampur: o["ketat-campur"] });
  for (const p of v.peringatan) console.error(`peringatan: ${p}`);
  if (v.galat.length) {
    console.error(`audio.mjs: rencana ditolak (${v.galat.length} pelanggaran); tidak ada audio yang dirakit:`);
    for (const g of v.galat) console.error(`  - ${g}`);
    process.exit(2);
  }
  const rencana = v.rencana;
  console.log(tabelPemegang(rencana));

  // penyamaan level: ucapan sama kenyaringan (ucapanLufs); musik relatif terhadap ucapan
  const catatan = [];
  async function samakan(sumber, nama, targetLufs, opsi) {
    const lufs = await ukurLufs(sumber.berkas, sumber.kanal, opsi);
    if (Number.isNaN(lufs)) {
      sumber.gainEq = 0;
      console.error(`peringatan: ${nama}: senyap atau tak terukur, level tidak disamakan`);
      catatan.push(`  ${nama}: senyap/tak terukur, gain 0 dB`);
      return;
    }
    sumber.gainEq = targetLufs - lufs;
    if (Math.abs(sumber.gainEq) > 24) console.error(`peringatan: ${nama}: level asli ${lufs.toFixed(1)} LUFS sangat jauh dari target; gain ${sumber.gainEq.toFixed(1)} dB`);
    catatan.push(`  ${nama}: ${lufs.toFixed(1)} LUFS -> target ${targetLufs.toFixed(1)} (gain ${sumber.gainEq >= 0 ? "+" : ""}${sumber.gainEq.toFixed(1)} dB)`);
  }
  try {
    for (const n of rencana.narasi) await samakan(n, `narasi "${n.id}"`, rencana.ucapanLufs);
    for (const c of rencana.klip) {
      if (c.mode === "bisu") continue;
      await samakan(c, `klip "${c.id}"`, rencana.ucapanLufs, { mulai: c.dariDetik, durasi: Math.min((c.akhir - c.mulai) / fps, c.durasiAudio - c.dariDetik) });
    }
    if (rencana.musik) await samakan(rencana.musik, "musik", rencana.ucapanLufs + rencana.musik.bebasDb);
  } catch (e) {
    gagal(e.message);
  }
  console.log(`Penyamaan level (ucapan ${rencana.ucapanLufs} LUFS):\n${catatan.join("\n")}`);

  const { inp, filter, sampel } = bangunGrafik(rencana);
  const cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...inp,
    "-filter_complex", filter, "-filter_complex_threads", "1", "-map", "[keluar]",
    "-c:a", "pcm_f32le", "-ar", String(SR), "-ac", "2",
    "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", o.out];
  const r = await jalankan(cmd);
  if (r.kode !== 0) gagal(`ffmpeg gagal merakit audio (exit ${r.kode}):\n${r.err.trim()}`);
  console.log(`selesai: ${o.out} (${(rencana.total / fps).toFixed(2)} s, ${sampel} sampel, 48 kHz stereo float32)`);
}

if (import.meta.main) await utama();
