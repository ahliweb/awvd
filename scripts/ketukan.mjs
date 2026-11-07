#!/usr/bin/env bun
/**
 * awvd / ketukan.mjs — deteksi ketukan (beat) dan onset dari berkas audio lokal, untuk
 * menyelaraskan potongan, transisi, dan gerak komposisi ke musik.
 *
 *   bun scripts/ketukan.mjs <audio> [--fps 30] [--out ketukan.json]
 *
 * Alur (semuanya di proses ini; satu-satunya alat luar adalah ffmpeg untuk dekode):
 *   1. ffmpeg mendekode audio menjadi PCM float32 mono 22050 Hz (stdout, tanpa berkas sementara).
 *   2. Onset: STFT (jendela Hann 1024, hop 128 = 5,8 ms) dengan FFT radix-2 buatan sendiri,
 *      24 pita berjarak logaritmik 40 Hz..10 kHz, kompresi log, lalu fluks spektral (jumlah
 *      kenaikan positif per pita terhadap 2 hop sebelumnya, dirata-rata per pita).
 *   3. Puncak fluks dipilih dengan ambang adaptif (rata-rata lokal + sebagian selisih ke
 *      maksimum lokal) dan lantai mutlak; waktu tiap puncak dipertajam lewat kenaikan energi
 *      log di bentuk gelombang (menghilangkan bias awal akibat jendela panjang).
 *   4. Tempo: autokorelasi fungsi onset pada lag 60..200 BPM dengan pembobot perseptual
 *      (log-Gaussian berpusat 120 BPM), lalu dipertajam dengan pemindaian periode halus yang
 *      memaksimalkan pemusatan fase onset (resultan lingkaran berbobot). Fase datang dari
 *      arah resultan itu.
 *   5. Ketukan = grid periode dan fase tersebut, diselaraskan ke onset terdekat (dalam
 *      toleransi) bila ada; selain itu tetap di posisi grid.
 *
 * Rujukan algoritma (hanya konsep; tidak ada kode yang disalin):
 *   - Bello dkk., "A Tutorial on Onset Detection in Music Signals", IEEE Trans. Speech and
 *     Audio Processing 13(5), 2005 (fluks spektral, ambang adaptif).
 *   - Ellis, "Beat Tracking by Dynamic Programming", J. New Music Research 36(1), 2007
 *     (autokorelasi fungsi onset dengan jendela perseptual tempo 120 BPM).
 *   - Cooley dan Tukey, 1965 (FFT radix-2).
 *
 * Deterministik: aritmetika murni tanpa Date.now, Math.random, atau urutan non-deterministik;
 * waktu dibulatkan ke 0,1 ms. Hasil pada berkas yang sama identik antarjalan (pada platform
 * dan versi ffmpeg yang sama).
 *
 * Kode keluar: 0 berhasil (juga bila tak ada ketukan: lihat `peringatan`), 2 argumen tidak
 * valid, 1 galat dekode ffmpeg. Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const VERSI_KETUKAN = 1;

/** Parameter algoritma; diekspor agar uji dan dokumen merujuk angka yang sama. */
export const PARAMETER = Object.freeze({
  sampleRate: 22050,
  ukuranFft: 1024,
  hop: 128,
  jumlahPita: 24,
  frekPita: [40, 10000],
  lambdaLog: 100, // kompresi log1p(lambda * magnitudo ternormalisasi)
  lagFluks: 2, // selisih terhadap 2 hop sebelumnya
  jendelaLokalDetik: 1.0, // rata-rata dan maksimum lokal untuk ambang adaptif (+-)
  deltaAmbang: 0.25, // bagian selisih (maksimum lokal - rata-rata lokal) di atas rata-rata
  lantaiFluks: 0.2, // kenaikan log rata-rata per pita minimum (nat) agar dihitung onset
  jarakMinOnsetDetik: 0.05,
  bpmMin: 60,
  bpmMax: 200,
  bpmPusatPrior: 120,
  lebarPriorOktaf: 1.0,
  toleransiSnapDetik: 0.05,
  toleransiSnapRelatif: 0.2, // juga dibatasi 20 % periode
  minOnset: 4,
});

// ---------------------------------------------------------------- FFT radix-2
/** FFT in-place iteratif (Cooley-Tukey radix-2) untuk panjang pangkat dua. */
export function fft(re, im) {
  const n = re.length;
  if (n & (n - 1)) throw new Error("panjang FFT harus pangkat dua");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const sudut = (-2 * Math.PI) / len;
    const wr = Math.cos(sudut), wi = Math.sin(sudut);
    const separuh = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < separuh; k++) {
        const a = i + k, b = a + separuh;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// ----------------------------------------------------------------- dekode
/** Dekode audio ke Float32Array mono pada sampleRate lewat ffmpeg (stdout). */
export async function dekodeAudio(berkas, sampleRate = PARAMETER.sampleRate) {
  let proses;
  try {
    proses = Bun.spawn(
      ["ffmpeg", "-v", "error", "-nostdin", "-i", berkas, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-"],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch (e) {
    throw new Error(`ffmpeg tidak dapat dijalankan: ${e.message}`);
  }
  const [buf, err, kode] = await Promise.all([
    new Response(proses.stdout).arrayBuffer(),
    new Response(proses.stderr).text(),
    proses.exited,
  ]);
  if (kode !== 0) throw new Error(`ffmpeg gagal mendekode audio (kode ${kode}): ${err.trim().split("\n").slice(-2).join(" ")}`);
  const n = Math.floor(buf.byteLength / 4);
  return new Float32Array(buf, 0, n);
}

// ------------------------------------------------------------ fungsi onset
function tepiPita(p) {
  const { sampleRate: sr, ukuranFft: N, jumlahPita: B, frekPita: [f0, f1] } = p;
  const hz = sr / N;
  const tepi = [];
  for (let b = 0; b <= B; b++) {
    const f = f0 * (f1 / f0) ** (b / B);
    let i = Math.round(f / hz);
    if (b > 0 && i <= tepi[b - 1]) i = tepi[b - 1] + 1;
    tepi.push(Math.min(i, N / 2));
  }
  return tepi;
}

/**
 * Fungsi onset (fluks spektral berkompresi log) per hop.
 * Frame ke-t berpusat pada sampel t*hop. Mengembalikan Float64Array.
 */
export function fungsiOnset(x, p = PARAMETER) {
  const { ukuranFft: N, hop, jumlahPita: B, lambdaLog, lagFluks } = p;
  const jumlah = Math.floor(x.length / hop) + 1;
  const tepi = tepiPita(p);
  const jendela = new Float64Array(N);
  for (let i = 0; i < N; i++) jendela[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const norm = N / 4; // sinus skala penuh -> magnitudo 1
  const pita = new Float64Array(jumlah * B);
  const re = new Float64Array(N), im = new Float64Array(N);
  const ambil = (t, i) => {
    const s = t * hop - N / 2 + i;
    return s >= 0 && s < x.length ? x[s] * jendela[i] : 0;
  };
  // dua frame nyata dibungkus dalam satu FFT kompleks (a + i b), lalu dipisah.
  for (let t = 0; t < jumlah; t += 2) {
    const ada2 = t + 1 < jumlah;
    for (let i = 0; i < N; i++) {
      re[i] = ambil(t, i);
      im[i] = ada2 ? ambil(t + 1, i) : 0;
    }
    fft(re, im);
    for (let b = 0; b < B; b++) {
      let sa = 0, sb = 0;
      for (let k = tepi[b]; k < tepi[b + 1]; k++) {
        const k2 = (N - k) & (N - 1);
        const ar = 0.5 * (re[k] + re[k2]), ai = 0.5 * (im[k] - im[k2]);
        const br = 0.5 * (im[k] + im[k2]), bi = -0.5 * (re[k] - re[k2]);
        sa += Math.hypot(ar, ai);
        sb += Math.hypot(br, bi);
      }
      const lebar = Math.max(1, tepi[b + 1] - tepi[b]);
      pita[t * B + b] = Math.log1p((lambdaLog * sa) / lebar / norm);
      if (ada2) pita[(t + 1) * B + b] = Math.log1p((lambdaLog * sb) / lebar / norm);
    }
  }
  const o = new Float64Array(jumlah);
  for (let t = lagFluks; t < jumlah; t++) {
    let s = 0;
    for (let b = 0; b < B; b++) {
      const d = pita[t * B + b] - pita[(t - lagFluks) * B + b];
      if (d > 0) s += d;
    }
    o[t] = s / B;
  }
  return o;
}

/** Rata-rata dan maksimum bergerak (jendela +-w) dalam O(n). */
function statistikLokal(o, w) {
  const n = o.length;
  const awal = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) awal[i + 1] = awal[i] + o[i];
  const rata = new Float64Array(n), maks = new Float64Array(n);
  const dq = new Int32Array(n);
  let kepala = 0, ekor = 0, tambah = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n - 1, i + w);
    rata[i] = (awal[b + 1] - awal[a]) / (b - a + 1);
    for (; tambah <= b; tambah++) {
      while (ekor > kepala && o[dq[ekor - 1]] <= o[tambah]) ekor--;
      dq[ekor++] = tambah;
    }
    while (dq[kepala] < a) kepala++;
    maks[i] = o[dq[kepala]];
  }
  return { rata, maks };
}

/** Indeks puncak fungsi onset: maksimum lokal, di atas ambang adaptif dan lantai mutlak. */
export function puncakOnset(o, p = PARAMETER) {
  const fr = p.sampleRate / p.hop; // hop per detik
  const w = Math.round(p.jendelaLokalDetik * fr);
  const jarak = Math.max(1, Math.round(p.jarakMinOnsetDetik * fr));
  const { rata, maks } = statistikLokal(o, w);
  const kandidat = [];
  for (let i = 1; i < o.length - 1; i++) {
    const v = o[i];
    if (v < p.lantaiFluks) continue;
    if (v <= rata[i] + p.deltaAmbang * (maks[i] - rata[i])) continue;
    let puncak = true;
    for (let j = Math.max(0, i - jarak); j <= Math.min(o.length - 1, i + jarak) && puncak; j++) {
      if (j < i && o[j] >= v) puncak = false;
      if (j > i && o[j] > v) puncak = false;
    }
    if (puncak) kandidat.push(i);
  }
  return kandidat;
}

/**
 * Pertajam waktu onset di bentuk gelombang: pada jendela [t0 - 5 ms, t0 + 35 ms] cari
 * kenaikan energi log terbesar antarblok 64 sampel (hop 32). Fluks berjendela panjang
 * menyala lebih awal daripada serangan sebenarnya (dan seberapa awal bergantung pada
 * kerasnya bunyi); langkah ini menghilangkan bias itu. Mengembalikan detik.
 */
export function pertajamOnset(x, detikPerkiraan, sampleRate = PARAMETER.sampleRate) {
  const BLOK = 64, LANGKAH = 32;
  const dari = Math.max(0, Math.round((detikPerkiraan - 0.005) * sampleRate));
  const sampai = Math.min(x.length - BLOK, Math.round((detikPerkiraan + 0.035) * sampleRate));
  if (sampai - dari < BLOK + LANGKAH) return detikPerkiraan;
  const jumlah = Math.floor((sampai - dari) / LANGKAH);
  const loge = new Float64Array(jumlah);
  for (let m = 0; m < jumlah; m++) {
    let e = 0;
    for (let i = 0; i < BLOK; i++) { const v = x[dari + m * LANGKAH + i]; e += v * v; }
    loge[m] = Math.log(e / BLOK + 1e-10);
  }
  let terbaik = -Infinity, indeks = -1;
  for (let m = 1; m < jumlah; m++) {
    const naik = loge[m] - loge[m - 1];
    if (naik > terbaik) { terbaik = naik; indeks = m; }
  }
  if (indeks < 0) return detikPerkiraan;
  // serangan jatuh di 32 sampel terakhir blok pertama yang memuatnya
  return (dari + indeks * LANGKAH + BLOK - LANGKAH / 2) / sampleRate;
}

// -------------------------------------------------------------- tempo
/**
 * Autokorelasi fungsi onset (tanpa bias, setelah dikurangi rata-rata lokal) pada lag
 * bpmMax..bpmMin; mengembalikan {lag (hop, pecahan), bpm kasar, rasio (0..1)}.
 */
export function tempoAutokorelasi(o, p = PARAMETER) {
  const fr = p.sampleRate / p.hop;
  const { rata } = statistikLokal(o, Math.round(p.jendelaLokalDetik * fr));
  const n = o.length;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.max(0, o[i] - rata[i]);
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += s[i] * s[i];
  if (r0 <= 0) return null;
  const lagMin = Math.floor((60 * fr) / p.bpmMax), lagMax = Math.ceil((60 * fr) / p.bpmMin);
  if (lagMax + 2 >= n) return null;
  const r = new Float64Array(lagMax + 2);
  for (let l = Math.max(1, lagMin - 1); l <= lagMax + 1; l++) {
    let a = 0;
    for (let i = 0; i + l < n; i++) a += s[i] * s[i + l];
    r[l] = a / (n - l) / (r0 / n); // tanpa bias, dinormalkan ke r[0]
  }
  const lag0 = (60 * fr) / p.bpmPusatPrior;
  const bobot = (l) => Math.exp(-0.5 * (Math.log2(l / lag0) / p.lebarPriorOktaf) ** 2);
  let terbaik = -Infinity, lagTerbaik = -1;
  for (let l = lagMin; l <= lagMax; l++) {
    const v = r[l] * bobot(l);
    if (v > terbaik) { terbaik = v; lagTerbaik = l; }
  }
  if (lagTerbaik < 0 || r[lagTerbaik] <= 0) return null;
  // interpolasi parabola agar lag pecahan
  const y0 = r[lagTerbaik - 1], y1 = r[lagTerbaik], y2 = r[lagTerbaik + 1];
  const pen = y0 - 2 * y1 + y2;
  const geser = pen < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / pen)) : 0;
  const lag = lagTerbaik + geser;
  return { lag, bpm: (60 * fr) / lag, rasio: Math.max(0, Math.min(1, r[lagTerbaik])) };
}

/**
 * Pertajam periode dan fase: pindai periode di sekitar perkiraan (+-3 %, langkah 0,002 %)
 * dan ambil yang memaksimalkan resultan lingkaran berbobot |sum k_j exp(2 pi i t_j / P)|
 * (pemusatan fase onset). Fase = arah resultan. Mengembalikan {periode, fase (0..periode), pusat (0..1)}.
 */
export function pertajamTempo(waktu, kuat, periodePerkiraan) {
  let jumlahKuat = 0;
  for (const k of kuat) jumlahKuat += k;
  if (jumlahKuat <= 0) return null;
  let terbaik = -1, periode = periodePerkiraan, fase = 0;
  const langkah = 0.00002;
  for (let u = -1500; u <= 1500; u++) {
    const P = periodePerkiraan * (1 + u * langkah);
    let cr = 0, ci = 0;
    for (let j = 0; j < waktu.length; j++) {
      const th = (2 * Math.PI * waktu[j]) / P;
      cr += kuat[j] * Math.cos(th);
      ci += kuat[j] * Math.sin(th);
    }
    const resultan = Math.hypot(cr, ci);
    if (resultan > terbaik) {
      terbaik = resultan;
      periode = P;
      let a = Math.atan2(ci, cr);
      if (a < 0) a += 2 * Math.PI;
      fase = (a / (2 * Math.PI)) * P;
    }
  }
  return { periode, fase, pusat: terbaik / jumlahKuat };
}

/** Grid ketukan [awal, akhir] dari periode dan fase, diselaraskan ke onset terdekat. */
export function susunKetukan(onset, periode, fase, p = PARAMETER) {
  if (onset.length === 0) return [];
  const tol = Math.min(p.toleransiSnapDetik, p.toleransiSnapRelatif * periode);
  const awal = onset[0].detik - tol, akhir = onset[onset.length - 1].detik + tol;
  const k0 = Math.ceil((awal - fase) / periode), k1 = Math.floor((akhir - fase) / periode);
  const hasil = [];
  let j = 0;
  for (let k = k0; k <= k1; k++) {
    const g = fase + k * periode;
    if (g < 0) continue;
    while (j + 1 < onset.length && Math.abs(onset[j + 1].detik - g) <= Math.abs(onset[j].detik - g)) j++;
    const cocok = onset.length > 0 && Math.abs(onset[j].detik - g) <= tol;
    hasil.push({ detik: cocok ? onset[j].detik : g, dariOnset: cocok });
  }
  return hasil;
}

// -------------------------------------------------------------- analisis
const bulat = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Analisis PCM mono float -> objek ketukan.json. Murni dan deterministik.
 * @param {Float32Array} x sampel mono pada p.sampleRate
 * @param {{fps?: number}} opsi
 */
export function analisisKetukan(x, opsi = {}) {
  const p = PARAMETER;
  const fps = opsi.fps ?? 30;
  const durasi = x.length / p.sampleRate;
  const frameDari = (d) => Math.round(d * fps);
  const peringatan = [];
  const hasil = {
    versi: VERSI_KETUKAN,
    fps,
    durasi: bulat(durasi, 3),
    tempo: null,
    ketukan: [],
    onset: [],
    keyakinan: 0,
    peringatan,
  };

  const o = fungsiOnset(x, p);
  const idx = puncakOnset(o, p);
  let maksPuncak = 0;
  for (const i of idx) maksPuncak = Math.max(maksPuncak, o[i]);
  const fr = p.sampleRate / p.hop;
  const onset = idx.map((i) => ({
    detik: pertajamOnset(x, i / fr, p.sampleRate),
    kekuatan: o[i] / maksPuncak,
  }));
  onset.sort((a, b) => a.detik - b.detik);
  hasil.onset = onset.map((q) => ({ detik: bulat(q.detik, 4), frame: frameDari(q.detik), kekuatan: bulat(q.kekuatan, 3) }));

  if (onset.length < p.minOnset) {
    peringatan.push(`hanya ${onset.length} onset terdeteksi (minimum ${p.minOnset}); tempo dan ketukan tidak diperkirakan. Audio senyap, terlalu pendek, atau tanpa serangan yang jelas.`);
    return hasil;
  }
  const ac = tempoAutokorelasi(o, p);
  if (!ac) {
    peringatan.push("autokorelasi tidak menemukan periodisitas dalam rentang 60..200 BPM; ketukan tidak diperkirakan.");
    return hasil;
  }
  const halus = pertajamTempo(onset.map((q) => q.detik), onset.map((q) => q.kekuatan), 60 / ac.bpm);
  if (!halus) return hasil;
  const ketukan = susunKetukan(onset, halus.periode, halus.fase, p);
  const cocok = ketukan.filter((k) => k.dariOnset).length;
  const cakupan = ketukan.length ? cocok / ketukan.length : 0;
  hasil.tempo = { bpm: bulat(60 / halus.periode, 2), periode: bulat(halus.periode, 5), fase: bulat(halus.fase, 4) };
  hasil.ketukan = ketukan.map((k) => ({ detik: bulat(k.detik, 4), frame: frameDari(k.detik), dariOnset: k.dariOnset }));
  hasil.keyakinan = bulat(0.5 * ac.rasio + 0.5 * cakupan, 3);
  if (hasil.keyakinan < 0.4) peringatan.push(`keyakinan rendah (${hasil.keyakinan}): periodisitas lemah atau tempo berubah; periksa hasil sebelum memakainya.`);
  return hasil;
}

export async function ketukanDariBerkas(berkas, opsi = {}) {
  const x = await dekodeAudio(berkas);
  return analisisKetukan(x, opsi);
}

// -------------------------------------------------------------------- CLI
function gagal(pesan, kode = 1) {
  console.error(`ketukan: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun scripts/ketukan.mjs <audio> [--fps 30] [--out ketukan.json]
Mendeteksi onset dan ketukan dari berkas audio lokal (ffmpeg wajib ada untuk dekode).
--fps N     frame per detik komposisi (bawaan 30; 0 < N <= 240); menentukan nilai "frame" di keluaran
--out F     berkas JSON keluaran (bawaan ketukan.json); folder tujuan dibuat bila belum ada
Keluaran JSON: versi, fps, durasi, tempo {bpm, periode, fase}, ketukan [{detik, frame, dariOnset}],
onset [{detik, frame, kekuatan}], keyakinan (0..1), peringatan [].
Kode keluar 0 berhasil (termasuk tanpa ketukan; lihat peringatan), 2 argumen tidak valid, 1 galat dekode.`;

async function utama() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        fps: { type: "string", default: "30" },
        out: { type: "string", default: "ketukan.json" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const { values: o, positionals } = args;
  if (o.help) { console.log(PETUNJUK); return; }
  if (positionals.length !== 1) gagal(`harus tepat satu berkas audio.\n${PETUNJUK}`, 2);
  const fps = Number(o.fps);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) gagal("--fps harus angka > 0 dan <= 240.", 2);
  const masukan = positionals[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(masukan)) gagal(`"${masukan}" adalah URL; hanya berkas lokal yang diterima.`, 2);
  const berkas = resolve(masukan);
  if (!existsSync(berkas) || !statSync(berkas).isFile()) gagal(`berkas tidak ditemukan: ${masukan}`, 2);
  let hasil;
  try {
    hasil = await ketukanDariBerkas(berkas, { fps });
  } catch (e) {
    gagal(e.message, 1);
  }
  const keluar = resolve(o.out);
  mkdirSync(dirname(keluar), { recursive: true });
  writeFileSync(keluar, `${JSON.stringify(hasil, null, 2)}\n`);
  for (const w of hasil.peringatan) console.error(`peringatan: ${w}`);
  if (hasil.tempo) {
    console.log(`Tempo ${hasil.tempo.bpm} BPM, ${hasil.ketukan.length} ketukan, ${hasil.onset.length} onset, keyakinan ${hasil.keyakinan} -> ${o.out}`);
  } else {
    console.log(`Tidak ada tempo terdeteksi (${hasil.onset.length} onset) -> ${o.out}`);
  }
}

if (import.meta.main) await utama();
