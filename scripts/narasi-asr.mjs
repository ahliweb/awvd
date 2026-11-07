/**
 * awvd / narasi-asr.mjs — ASR lokal opsional (whisper.cpp) untuk `bun run narasi`.
 *
 * Dua kegunaan, keduanya hanya di sisi pembuatan aset beku (render tidak pernah memanggil
 * modul ini):
 *   1. Penyelarasan narasi (`--selaras whisper`): stempel kata dari ASR dipetakan ke kata naskah
 *      lewat penyelarasan teks (Needleman-Wunsch pada kata ternormalisasi, kemiripan kata
 *      toleran salah eja), menggantikan estimasi per kata. Kata naskah yang tak berpasangan
 *      diisi dengan menarik garis waktu estimasi di antara dua jangkar ASR; bila skor
 *      penyelarasan rendah, hasilnya dibuang dan pemanggil jatuh ke estimasi.
 *   2. Caption dari audio tanpa naskah (`bun run narasi transkripsi <audio>`): kata ASR
 *      menjadi cue VTT/SRT dan kata.json mentah, ditandai "hasil ASR, wajib ditinjau manusia".
 *
 * Prinsip:
 *   - awvd TIDAK membundel biner maupun model. Biner dan model dicari lewat flag, lalu env
 *     (AWVD_WHISPER_BIN, AWVD_WHISPER_MODEL), lalu PATH (`whisper-cli`). Bila tidak ada,
 *     GalatAsr berpesan jelas (cara memasang) dan CLI keluar dengan kode 1 tanpa keluaran.
 *   - whisper.cpp berjalan LOKAL (tanpa jaringan), jadi boleh dipakai untuk naskah
 *     `klasifikasi: "internal"`; audio tidak pernah dikirim ke layanan daring.
 *   - Mesin dijalankan sebagai proses anak dengan larik argumen (tanpa shell).
 *   - Keluaran JSON whisper.cpp dicache (kunci = hash audio, model, bahasa, argumen) agar proses
 *     ulang cepat dan deterministik; cache bersifat turunan dan boleh dihapus.
 *   - Stempel kata memakai DTW per token (`-dtw <preset> -nfa`); tanpa preset (model tak
 *     dikenal) dipakai stempel token biasa yang jauh kurang presisi dan diperingatkan.
 *
 * Karya asli repo ini (dasar: dokumentasi CLI whisper.cpp, MIT, dan riset awvd 2026-11-07).
 * Rincian di docs/narasi-caption.md §ASR lokal.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { audiensEfektif, muatData } from "./konsep.mjs";
import { keSrt, keVtt, periksaCue, susunCue } from "./narasi-cue.mjs";
import { bacaAudio, keFrame, selaraskanToken, tokenisasi } from "./narasi-selaras.mjs";
import { terbilang } from "./normalisasi-id.mjs";

/** Naik bila cara membaca atau menjalankan whisper berubah (masuk kunci cache). */
export const VERSI_ASR = 1;
/** Skor penyelarasan minimum (0..1) agar stempel ASR dipakai; di bawahnya jatuh ke estimasi. */
export const AMBANG_SKOR_BAWAAN = 0.6;
/** Kemiripan kata minimum agar sepasang kata dianggap sama (salah eja ASR ditoleransi). */
export const KEMIRIPAN_MIN = 0.6;
/**
 * Koreksi tetap (detik) yang dikurangkan dari stempel DTW. Stempel DTW whisper.cpp
 * terbaca lebih lambat dari awal artikulasi (riset awvd: bias +0,23 s pada TTS bersih, model
 * base dan small q5_1, lima klip); nilai ini disetel pada data yang sama (in-sample) dan BELUM
 * diuji pada suara manusia. Hanya berlaku untuk stempel DTW, tidak untuk stempel token biasa.
 */
export const KOREKSI_DTW_BAWAAN = 0.23;
export const TINJAUAN_ASR = "hasil ASR, wajib ditinjau manusia";

const adalahObjek = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Galat lingkungan ASR (tidak terpasang, gagal jalan): dipakai CLI untuk pesan tanpa jejak tumpukan. */
export class GalatAsr extends Error {}

// ------------------------------------------------------------------ mesin eksternal
const PETUNJUK_PASANG = "awvd tidak membundel ASR. Pasang whisper.cpp (MIT; bangun dengan cmake dari repositori resminya) dan unduh model GGML (bobot Whisper berlisensi MIT), lalu tunjuk lewat AWVD_WHISPER_BIN (jalur whisper-cli) dan AWVD_WHISPER_MODEL (berkas model .bin), atau flag --whisper-bin dan --whisper-model. Langkahnya ada di docs/narasi-caption.md (bagian ASR lokal). Tanpa ASR, hilangkan --selaras whisper (timing memakai estimasi berjangkar jeda).";

/**
 * Menemukan biner dan model whisper.cpp. `konfig` = { bin?, model? } (flag CLI); lalu env;
 * lalu `whisper-cli` di PATH untuk biner. Melempar GalatAsr bila ada yang kurang.
 * Mengembalikan { biner, model, env, dtw } (dtw = preset DTW atau null).
 */
export function pastikanWhisper(konfig = {}, env = process.env) {
  const masalah = [];
  const nama = konfig.bin || env.AWVD_WHISPER_BIN || "whisper-cli";
  let biner = null;
  if (nama.includes("/")) {
    const p = resolve(nama);
    if (existsSync(p) && statSync(p).isFile()) biner = p; else masalah.push(`biner tidak ditemukan: ${p}`);
  } else {
    biner = Bun.which(nama, { PATH: env.PATH ?? "" });
    if (!biner) masalah.push(`biner "${nama}" tidak ada di PATH (set AWVD_WHISPER_BIN atau --whisper-bin)`);
  }
  const mentah = konfig.model || env.AWVD_WHISPER_MODEL;
  let model = null;
  if (!mentah) masalah.push("berkas model belum ditentukan (set AWVD_WHISPER_MODEL atau --whisper-model)");
  else {
    model = resolve(mentah);
    if (!existsSync(model) || !statSync(model).isFile()) { masalah.push(`berkas model tidak ditemukan: ${model}`); model = null; }
  }
  if (masalah.length) {
    throw new GalatAsr(`ASR whisper.cpp belum terpasang atau belum lengkap:\n${masalah.map((x) => `  - ${x}`).join("\n")}\n${PETUNJUK_PASANG}`);
  }
  const lingkungan = { ...env };
  const dirLib = [dirname(biner), join(dirname(dirname(biner)), "lib")].filter((d) => existsSync(d));
  if (dirLib.length) lingkungan.LD_LIBRARY_PATH = [...dirLib, ...(env.LD_LIBRARY_PATH ? [env.LD_LIBRARY_PATH] : [])].join(":");
  const paksa = env.AWVD_WHISPER_DTW;
  const dtw = paksa ? (/^(tidak|off|none|0)$/i.test(paksa) ? null : paksa) : presetDtw(model);
  return { biner, model, env: lingkungan, dtw };
}

/** Preset DTW whisper.cpp dari nama berkas model (ggml-small-q5_1.bin -> small); null bila tak dikenal. */
export function presetDtw(jalurModel) {
  let n = basename(String(jalurModel)).toLowerCase().replace(/\.bin$/, "").replace(/^ggml-/, "");
  n = n.replace(/-(q\d(_[a-z0-9])?(_[a-z0-9])?|f16|f32)$/, "");
  let m = /^(tiny|base|small|medium)(\.en)?$/.exec(n);
  if (m) return m[1] + (m[2] ?? "");
  m = /^large(?:-v([123]))?(-turbo)?$/.exec(n);
  if (m) return `large.v${m[1] ?? "1"}${m[2] ? ".turbo" : ""}`;
  return null;
}

async function jalankan(cmd, env) {
  let p;
  try { p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env }); } catch (e) {
    throw new GalatAsr(`tidak dapat menjalankan "${cmd[0]}" (${e.code ?? e.message}); periksa izin eksekusi dan keberadaannya`);
  }
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}

const FORMAT_LANGSUNG = [".wav", ".mp3", ".ogg", ".flac"];

/**
 * Menjalankan whisper.cpp pada satu berkas audio (atau memakai cache). Mengembalikan
 * { json, dariCache, model, dtw } dengan `json` = keluaran `-ojf` apa adanya.
 * `opsi`: { bahasa, cache, ulang, konfig, peringatan }.
 */
export async function jalankanWhisper(audio, { bahasa = "id", cache = null, ulang = false, konfig = {}, peringatan = [], env = process.env } = {}) {
  const dataAudio = readFileSync(audio);
  const mesin = (() => { try { return pastikanWhisper(konfig, env); } catch (e) { return e; } })();
  // kunci cache tidak butuh mesin terpasang; tetapi tanpa mesin ia hanya terpakai bila tersimpan
  const info = mesin instanceof Error ? null : { model: `${basename(mesin.model)}:${statSync(mesin.model).size}`, dtw: mesin.dtw };
  const kunci = info && { versi: VERSI_ASR, audio: sha256(dataAudio), model: info.model, bahasa, dtw: info.dtw };
  const hash = kunci && sha256(JSON.stringify(kunci));
  const berkasCache = cache && hash ? join(cache, `${hash}.json`) : null;
  if (berkasCache && !ulang && existsSync(berkasCache)) {
    try {
      const c = JSON.parse(readFileSync(berkasCache, "utf8"));
      if (c && c.versi === VERSI_ASR && adalahObjek(c.keluaran)) return { json: c.keluaran, dariCache: true, model: info.model, dtw: info.dtw };
    } catch { /* cache rusak: dijalankan ulang */ }
  }
  if (mesin instanceof Error) throw mesin;
  if (!mesin.dtw) peringatan.push(`model "${basename(mesin.model)}" tidak punya preset DTW yang dikenal (set AWVD_WHISPER_DTW=<preset>); stempel kata memakai stempel token biasa yang jauh kurang presisi`);

  const tmp = mkdtempSync(join(tmpdir(), "awvd-asr-"));
  try {
    let masuk = audio;
    if (!FORMAT_LANGSUNG.includes(extname(audio).toLowerCase())) {
      masuk = join(tmp, "masuk.wav");
      const k = await jalankan(["ffmpeg", "-v", "error", "-y", "-i", audio, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", masuk], mesin.env);
      if (k.kode !== 0) throw new GalatAsr(`audio tidak terbaca ffmpeg (${audio}): ${k.err.trim().split("\n").slice(-2).join(" | ") || `kode ${k.kode}`}`);
    }
    const dasar = join(tmp, "keluaran");
    const cmd = [mesin.biner, "-m", mesin.model, "-f", masuk, "-l", bahasa, "-ojf", "-of", dasar, "-np", "-t", "4", ...(mesin.dtw ? ["-dtw", mesin.dtw, "-nfa"] : [])];
    const r = await jalankan(cmd, mesin.env);
    if (r.kode !== 0 || !existsSync(`${dasar}.json`)) {
      throw new GalatAsr(`whisper.cpp gagal (kode ${r.kode}) pada ${audio}: ${(r.err || r.out).trim().split("\n").slice(-4).join(" | ")}`);
    }
    let json;
    try { json = JSON.parse(readFileSync(`${dasar}.json`, "utf8")); } catch (e) { throw new GalatAsr(`keluaran JSON whisper.cpp tidak terbaca: ${e.message}`); }
    if (berkasCache) {
      mkdirSync(cache, { recursive: true });
      const sementara = `${berkasCache}.tmp`;
      writeFileSync(sementara, JSON.stringify({ versi: VERSI_ASR, kunci, keluaran: json }));
      renameSync(sementara, berkasCache);
    }
    return { json, dariCache: false, model: info.model, dtw: mesin.dtw };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ keluaran whisper -> kata
const adaHuruf = (s) => /[\p{L}\p{N}]/u.test(s);
const KHUSUS = /^\s*(\[_[A-Za-z0-9_]*_?\]|<\|[^|]*\|>)\s*$/;

/**
 * Keluaran `-ojf` whisper.cpp menjadi kata: [{ teks, tampil, mulai, awalToken, akhirToken, keyakinan }]
 * (detik). Token digabung menjadi kata (token berawalan spasi memulai kata baru); token khusus
 * ([_BEG_], [_TT_*]) dibuang; tanda baca menempel ke kata sebelumnya (`tampil`). `mulai` = stempel
 * DTW (`t_dtw`, sentidetik) token pertama bila ada, selain itu awal token biasa. Mengembalikan
 * { kata, presisi: "dtw"|"token"|"kosong" }.
 */
export function kataDariWhisper(json) {
  const segmen = Array.isArray(json?.transcription) ? json.transcription : [];
  const kata = [];
  let adaDtw = false, adaToken = false;
  for (const s of segmen) {
    for (const t of Array.isArray(s?.tokens) ? s.tokens : []) {
      if (typeof t?.text !== "string" || KHUSUS.test(t.text)) continue;
      const teks = t.text;
      const dari = Number.isFinite(t.offsets?.from) ? t.offsets.from / 1000 : null;
      const sampai = Number.isFinite(t.offsets?.to) ? t.offsets.to / 1000 : null;
      const dtw = Number.isFinite(t.t_dtw) && t.t_dtw >= 0 ? t.t_dtw / 100 : null;
      const baru = /^\s/.test(teks) || kata.length === 0;
      if (baru && !adaHuruf(teks)) {
        if (kata.length) kata[kata.length - 1].tampil += teks.trim();
        continue;
      }
      if (baru) {
        kata.push({ tampil: teks.trim(), mulaiDtw: dtw, mulaiToken: dari, akhirToken: sampai, p: [] });
      } else {
        const k = kata[kata.length - 1];
        k.tampil += teks;
        if (sampai !== null) k.akhirToken = sampai;
        if (k.mulaiDtw === null && dtw !== null) k.mulaiDtw = dtw;
      }
      const k = kata[kata.length - 1];
      if (Number.isFinite(t.p) && adaHuruf(teks)) k.p.push(t.p); // tanda baca tak membawa informasi keyakinan kata
      if (dtw !== null) adaDtw = true;
      if (dari !== null) adaToken = true;
    }
  }
  const hasil = [];
  for (const k of kata) {
    const inti = k.tampil.replace(/^[("'“‘]+|[)"'”’,;:.!?…]+$/gu, "");
    if (!adaHuruf(inti)) { if (hasil.length) hasil[hasil.length - 1].tampil += k.tampil; continue; }
    const mulai = adaDtw ? (k.mulaiDtw ?? k.mulaiToken) : k.mulaiToken;
    if (mulai === null || mulai === undefined) continue;
    hasil.push({
      teks: inti, tampil: k.tampil, mulai, awalToken: k.mulaiToken, akhirToken: k.akhirToken,
      keyakinan: k.p.length ? r3(k.p.reduce((a, b) => a + b, 0) / k.p.length) : null,
    });
  }
  return { kata: hasil, presisi: hasil.length === 0 ? "kosong" : adaDtw ? "dtw" : "token" };
}

// ------------------------------------------------------------------ penyelarasan teks
/** Kata ternormalisasi untuk pencocokan: huruf kecil, tanpa tanda baca dan diakritik. */
export function normalKata(s) {
  return String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Jarak Levenshtein. */
function levenshtein(a, b) {
  if (a === b) return 0;
  const A = Array.from(a), B = Array.from(b);
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[B.length];
}

/** Kemiripan dua kata ternormalisasi, 0..1 (1 = sama persis). */
export function kemiripan(a, b) {
  if (a === b) return a === "" ? 0 : 1;
  const maks = Math.max(Array.from(a).length, Array.from(b).length);
  if (maks === 0 || Math.abs(Array.from(a).length - Array.from(b).length) / maks > 0.5) return 0;
  return 1 - levenshtein(a, b) / maks;
}

/**
 * Menyelaraskan dua deret kata ternormalisasi (Needleman-Wunsch: pasangan mirip +2*kemiripan,
 * pasangan tak mirip dan celah masing-masing -1). Mengembalikan { pasangan: [[i, j, kemiripan]...] }
 * hanya untuk pasangan dengan kemiripan >= minimum; urut naik pada kedua indeks.
 */
export function selaraskanTeks(a, b, { min = KEMIRIPAN_MIN } = {}) {
  const n = a.length, m = b.length, W = m + 1;
  const sim = new Map();
  const s = (i, j) => {
    const k = i * W + j;
    let v = sim.get(k);
    if (v === undefined) { v = kemiripan(a[i], b[j]); sim.set(k, v); }
    return v;
  };
  const GAP = -1;
  const dp = new Float32Array((n + 1) * W);
  const arah = new Uint8Array((n + 1) * W); // 1 = diagonal, 2 = naik (lewati a), 3 = kiri (lewati b)
  for (let i = 1; i <= n; i++) { dp[i * W] = i * GAP; arah[i * W] = 2; }
  for (let j = 1; j <= m; j++) { dp[j] = j * GAP; arah[j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const v = s(i - 1, j - 1);
      const diag = dp[(i - 1) * W + j - 1] + (v >= min ? 2 * v : -1);
      const atas = dp[(i - 1) * W + j] + GAP, kiri = dp[i * W + j - 1] + GAP;
      let terbaik = diag, d = 1;
      if (atas > terbaik) { terbaik = atas; d = 2; }
      if (kiri > terbaik) { terbaik = kiri; d = 3; }
      dp[i * W + j] = terbaik; arah[i * W + j] = d;
    }
  }
  const pasangan = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const d = arah[i * W + j];
    if (d === 1) {
      const v = s(i - 1, j - 1);
      if (v >= min) pasangan.push([i - 1, j - 1, v]);
      i--; j--;
    } else if (d === 2) i--; else j--;
  }
  return { pasangan: pasangan.reverse() };
}

/** Angka murni dalam keluaran ASR ("20") diurai menjadi kata ("dua puluh") yang berbagi rentang waktunya. */
function uraiAngkaAsr(kata) {
  const hasil = [];
  kata.forEach((k, i) => {
    if (/^\d{1,15}$/.test(k.teks)) {
      const bagian = terbilang(k.teks).split(" ");
      const akhir = i + 1 < kata.length ? Math.max(k.mulai, kata[i + 1].mulai) : k.mulai + 0.12 * bagian.length;
      const total = bagian.reduce((a, x) => a + x.length, 0);
      let t = k.mulai;
      for (const b of bagian) {
        hasil.push({ ...k, teks: b, tampil: b, mulai: t, turunan: true });
        t += ((akhir - k.mulai) * b.length) / total;
      }
    } else hasil.push({ ...k });
  });
  return hasil;
}

/**
 * Memetakan stempel kata ASR ke token naskah.
 *
 * `tok`: token naskah [{ teks, tp, ... }] (yang dianalisis, yaitu `bacaan ?? teks`); `asr`: kata
 * dari `kataDariWhisper`; `est`: hasil `selaraskanToken` pada audio yang sama (dipakai untuk
 * durasi kata dan untuk mengisi kata tak berpasangan). Opsi: `ambang` (skor minimum),
 * `koreksi` (detik, dikurangkan dari stempel DTW; `presisi` selain "dtw" menolnya), `identitas` (true = tiap kata ASR adalah
 * kata naskah; dipakai transkripsi), `durasi` (detik, batas atas audio).
 *
 * Kata berpasangan memakai stempel ASR; kata lain diisi dengan menarik garis waktu estimasi
 * secara linear di antara dua jangkar ASR terdekat (di tepi: digeser mengikuti jangkar). Akhir
 * kata = yang lebih kecil antara awal kata berikut dan awal + durasi estimasi.
 *
 * Mengembalikan { ok, kata, skor, cocok, eksak, interpolasi, jumlah, alasan? }. `ok` false
 * bila skor di bawah `ambang` (`kata` null; jatuh ke estimasi).
 */
export function selarasWhisper(tok, asr, est, { ambang = AMBANG_SKOR_BAWAAN, koreksi: koreksiOpsi = KOREKSI_DTW_BAWAAN, presisi = "dtw", identitas = false, durasi = Infinity } = {}) {
  const n = tok.length;
  const koreksi = presisi === "dtw" ? koreksiOpsi : 0;
  if (n === 0) return { ok: false, kata: null, skor: 0, cocok: 0, eksak: 0, interpolasi: 0, jumlah: 0, alasan: "tidak ada kata naskah" };
  if (!asr.length) return { ok: false, kata: null, skor: 0, cocok: 0, eksak: 0, interpolasi: n, jumlah: n, alasan: "ASR tidak mengenali ucapan" };
  const a = identitas ? asr.map((k) => ({ ...k })) : uraiAngkaAsr(asr);
  let pasangan;
  if (identitas) pasangan = asr.map((_, i) => [i, i, 1]);
  else pasangan = selaraskanTeks(tok.map((t) => normalKata(t.teks)), a.map((k) => normalKata(k.teks))).pasangan;
  const skor = identitas ? 1 : pasangan.reduce((x, p) => x + p[2], 0) / n;
  const eksak = pasangan.filter((p) => p[2] === 1).length;
  const ringkas = { skor: r3(skor), cocok: pasangan.length, eksak, interpolasi: n - pasangan.length, jumlah: n };
  if (skor < ambang) return { ok: false, kata: null, ...ringkas, alasan: `skor penyelarasan ${r3(skor)} di bawah ambang ${ambang} (${pasangan.length} dari ${n} kata berpasangan)` };

  // jangkar: indeks token naskah -> awal kata (monoton tak turun)
  const ujung = est.kata;
  const jangkar = [];
  let terakhir = -Infinity;
  for (const [i, j] of pasangan) {
    const t = Math.max(0, a[j].mulai - koreksi);
    const awal = Math.max(t, terakhir);
    jangkar.push({ i, t: awal });
    terakhir = awal;
  }
  const mulai = new Array(n);
  for (const x of jangkar) mulai[x.i] = x.t;
  const pertama = jangkar[0], akhirJ = jangkar[jangkar.length - 1];
  for (let k = 0; k < pertama.i; k++) mulai[k] = Math.max(0, ujung[k].mulai + (pertama.t - ujung[pertama.i].mulai));
  for (let k = akhirJ.i + 1; k < n; k++) mulai[k] = ujung[k].mulai + (akhirJ.t - ujung[akhirJ.i].mulai);
  for (let g = 0; g + 1 < jangkar.length; g++) {
    const L = jangkar[g], R = jangkar[g + 1];
    if (R.i - L.i < 2) continue;
    const lebarEst = ujung[R.i].mulai - ujung[L.i].mulai;
    for (let k = L.i + 1; k < R.i; k++) {
      mulai[k] = lebarEst > 1e-6 ? L.t + ((ujung[k].mulai - ujung[L.i].mulai) * (R.t - L.t)) / lebarEst : L.t + ((k - L.i) * (R.t - L.t)) / (R.i - L.i);
    }
  }
  // monoton dan di dalam audio
  for (let k = 0; k < n; k++) {
    mulai[k] = Math.min(durasi, Math.max(mulai[k], k ? mulai[k - 1] : 0));
  }
  const kata = tok.map((t, k) => {
    const lebarEst = Math.max(0.04, ujung[k].akhir - ujung[k].mulai);
    const batas = k + 1 < n ? mulai[k + 1] : Infinity;
    const akhir = Math.min(durasi, Math.max(mulai[k], Math.min(batas, mulai[k] + lebarEst)));
    return { ...t, mulai: mulai[k], akhir };
  });
  const terpasang = new Set(pasangan.map((p) => p[0]));
  return { ok: true, kata, ...ringkas, terpasang };
}

/** Ringkasan satu segmen untuk laporan.json (tanpa stempel). */
export const ringkasSelaras = (id, h) => ({ id, dipakai: h.ok, skor: h.skor, cocok: h.cocok, eksak: h.eksak, interpolasi: h.interpolasi, ...(h.ok ? {} : { alasan: h.alasan }) });

/** Info mesin untuk laporan (selalu lokal). */
export const infoMesinAsr = ({ model, dtw }) => ({ mesin: "whisper.cpp", lokal: true, daring: false, model, dtw: dtw ?? null, versiAdaptor: VERSI_ASR });

/** Semua keadaan "tidak pasti" tinjauan transkripsi yang ditulis ke kata.json dan laporan.json. */
export const BLOK_TINJAUAN = { status: "belum-ditinjau", pesan: TINJAUAN_ASR };

// ------------------------------------------------------------------ opsi CLI bersama
/** Opsi parseArgs untuk ASR (dipakai `narasi --selaras whisper` dan `narasi transkripsi`). */
export const OPSI_CLI_ASR = {
  "whisper-bin": { type: "string" },
  "whisper-model": { type: "string" },
  "cache-asr": { type: "string" },
  "asr-ulang": { type: "boolean" },
  "koreksi-asr": { type: "string" },
};

/** Nilai flag ASR menjadi { konfig, cache, ulang, koreksi }; melempar Error berpesan bila tak sah. */
export function opsiAsrDariFlag(nilai, env = process.env) {
  let koreksi = KOREKSI_DTW_BAWAAN;
  const mentah = nilai["koreksi-asr"] ?? env.AWVD_WHISPER_KOREKSI;
  if (mentah !== undefined) {
    koreksi = Number(mentah);
    if (!Number.isFinite(koreksi) || koreksi < 0 || koreksi > 1) throw new Error(`--koreksi-asr harus angka 0..1 detik (dapat ${JSON.stringify(mentah)})`);
  }
  return {
    konfig: { bin: nilai["whisper-bin"], model: nilai["whisper-model"] },
    cache: resolve(nilai["cache-asr"] ?? ".cache/awvd/asr"),
    ulang: nilai["asr-ulang"] === true,
    koreksi,
  };
}

export const PETUNJUK_ASR = `Flag ASR lokal (whisper.cpp; untuk --selaras whisper dan transkripsi):
  --whisper-bin JALUR    biner whisper-cli (bawaan: AWVD_WHISPER_BIN, lalu whisper-cli di PATH)
  --whisper-model JALUR  berkas model GGML .bin (bawaan: AWVD_WHISPER_MODEL; tanpa bawaan)
  --cache-asr DIR        cache keluaran ASR (bawaan .cache/awvd/asr; turunan, boleh dihapus)
  --asr-ulang            abaikan cache ASR dan jalankan ulang
  --koreksi-asr DETIK    koreksi stempel DTW, 0..1 (bawaan ${KOREKSI_DTW_BAWAAN}; AWVD_WHISPER_KOREKSI)
whisper.cpp berjalan lokal (tanpa jaringan), jadi boleh dipakai untuk naskah internal.`;

// ------------------------------------------------------------------ transkripsi (audio tanpa naskah)
/**
 * Caption dari audio tanpa naskah. Mengembalikan { berkas, cues, peringatan, laporan, kata, dariCache }
 * (tanpa menulis berkas; keluaran tidak memuat apa pun yang berbeda antara jalan pertama dan dari cache). Seluruh keluaran ditandai "hasil ASR, wajib ditinjau manusia".
 * `opsi`: { bahasa, fps, audiens, cache, ulang, konfig, koreksi, data }.
 */
export async function buatTranskripsi(audio, { bahasa = "id", fps = 30, audiens = ["umum"], cache = null, ulang = false, konfig = {}, koreksi = KOREKSI_DTW_BAWAAN, data = muatData() } = {}) {
  const peringatan = [];
  const efektif = audiensEfektif(data, audiens);
  const wav = await bacaAudio(audio);
  const r = await jalankanWhisper(audio, { bahasa, cache, ulang, konfig, peringatan });
  const { kata: kataAsr, presisi } = kataDariWhisper(r.json);
  if (!kataAsr.length) throw new GalatAsr("ASR tidak mengenali ucapan dalam audio (periksa bahasa --bahasa, kualitas audio, atau model)");

  // token dari kata ASR, satu banding satu (tanda baca bawaan ASR menjadi jangkar cue)
  const tok = [], asr = [];
  for (const k of kataAsr) {
    const t = tokenisasi(k.tampil)[0];
    if (!t) continue;
    tok.push({ ...t }); asr.push(k);
  }
  tok[tok.length - 1].tp = "titik";
  const est = selaraskanToken(tok, wav, { kalibrasi: { awal: 0.1, akhir: 0.04 } });
  if (!est.ada) throw new GalatAsr("audio senyap: tidak ada ucapan terdeteksi (keluaran ASR pada audio senyap tidak dapat dipercaya)");
  const h = selarasWhisper(tok, asr, est, { identitas: true, koreksi, presisi, durasi: wav.durasi });
  let kalimat = 0;
  const kata = h.kata.map((k) => {
    const x = { teks: k.teks, tampil: k.tampil, tp: k.tp, mulai: k.mulai, akhir: k.akhir, adegan: "transkripsi", kalimat, penutur: "narator" };
    if (k.tp === "titik") kalimat++;
    return x;
  });
  const totalFrame = Math.max(1, Math.ceil(wav.durasi * fps - 1e-6));
  const penutur = { narator: { nama: "Narator", italik: false, label: false } };
  const opsiCue = { fps, maksKarakter: 42, maksBaris: 2, cps: efektif.cps, tahanMaks: 0.5, totalFrame, akhirAdegan: { transkripsi: totalFrame }, penutur };
  const cues = susunCue(kata, opsiCue);
  // tidak ada naskah yang bisa diperbaiki: temuan lint hanya saran, bukan galat
  for (const c of periksaCue(cues, opsiCue)) peringatan.push(`cue ${c.n}: ${c.pesan}${c.tingkat === "gagal" ? " (batas dilampaui; ucapan nyata tidak dipercepat atau diperlambat, sunting teks saat ditinjau)" : ""}`);
  if (presisi !== "dtw") peringatan.push("stempel kata memakai stempel token biasa (bukan DTW): galat rata-rata sekitar setengah detik pada riset awvd; sorot kata tidak akan presisi");

  const kataBingkai = keFrame(kata, fps);
  const cueDariKata = new Array(kata.length).fill(0);
  for (const c of cues) for (const i of c.indeks) cueDariKata[i] = c.n;
  const ragu = asr.map((k, i) => ({ i, k })).filter((x) => x.k.keyakinan !== null && x.k.keyakinan < 0.5);
  const fileKata = {
    versi: 1, fps, sumber: "whisper", tinjauan: BLOK_TINJAUAN, durasiFrame: totalFrame,
    adegan: [{ id: "transkripsi", mulaiFrame: 0, durasiFrame: totalFrame }],
    kata: kataBingkai.map((k, i) => ({ teks: k.teks, tampil: k.tampil, mulai: r3(k.mulai), akhir: r3(k.akhir), mulaiFrame: k.mulaiFrame, akhirFrame: k.akhirFrame,
      adegan: k.adegan, kalimat: k.kalimat, penutur: k.penutur, cue: cueDariKata[i], keyakinan: asr[i].keyakinan })),
  };
  const cpsDaftar = cues.map((c) => c.cps).sort((a, b) => a - b);
  const laporan = {
    versi: 1, jenis: "transkripsi", tinjauan: BLOK_TINJAUAN,
    audio: { berkas: basename(audio), sha256: sha256(readFileSync(audio)), durasi: r3(wav.durasi) },
    fps, durasiFrame: totalFrame, audiens: { profil: audiens, cps: efektif.cps },
    asr: { ...infoMesinAsr(r), bahasa, presisi, koreksiDtw: presisi === "dtw" ? koreksi : 0 },
    ringkasan: { kata: kata.length, cue: cues.length, cpsMaks: r3(cpsDaftar.at(-1) ?? 0), cpsMedian: r3(cpsDaftar[Math.floor((cpsDaftar.length - 1) / 2)] ?? 0), ragu: ragu.length, peringatan: peringatan.length },
    ragu: ragu.slice(0, 50).map((x) => ({ kata: x.k.teks, mulai: r3(kata[x.i].mulai), keyakinan: x.k.keyakinan })),
    cue: cues.map((c) => ({ n: c.n, mulaiFrame: c.mulaiFrame, akhirFrame: c.akhirFrame, cps: r3(c.cps), teks: c.baris.join(" / ") })),
    peringatan,
  };
  const vtt = keVtt(cues, fps, penutur).replace(/^WEBVTT\n\n/, `WEBVTT\n\nNOTE\n${TINJAUAN_ASR}\n\n`);
  const catatan = `${TINJAUAN_ASR.toUpperCase()}\n\nCaption di folder ini dibuat otomatis oleh whisper.cpp dari audio tanpa naskah. ASR dapat salah dengar, melewatkan kata, atau mengarang kata pada derau atau musik, dan nama diri, istilah, serta angka paling rawan. Periksa setiap cue terhadap audio (laporan.json memuat kata berkeyakinan rendah), sunting teks, lalu hapus berkas ini hanya setelah ditinjau.\n`;
  return {
    cues, peringatan, laporan, kata: fileKata, dariCache: r.dariCache,
    berkas: {
      "caption.vtt": vtt,
      "caption.srt": keSrt(cues, fps, penutur),
      "kata.json": JSON.stringify(fileKata, null, 2) + "\n",
      "laporan.json": JSON.stringify(laporan, null, 2) + "\n",
      "PERLU-TINJAUAN.txt": catatan,
    },
  };
}

const PETUNJUK_TRANSKRIPSI = `awvd narasi transkripsi: audio tanpa naskah -> caption VTT/SRT dan kata.json mentah (whisper.cpp lokal)

Pemakaian:
  bun scripts/narasi.mjs transkripsi <audio> [--out DIR] [--bahasa id] [--fps 30] [--audiens umum]

  --out DIR        folder keluaran (bawaan out/transkripsi)
  --bahasa KODE    bahasa ucapan untuk whisper (bawaan id)
  --fps N          frame per detik untuk waktu cue dan kata.json (bawaan 30)
  --audiens LIST   profil audiens dipisah koma (data/audiens.json) untuk batas cps (bawaan umum)

${PETUNJUK_ASR}

Keluaran di DIR: caption.vtt, caption.srt, kata.json, laporan.json, PERLU-TINJAUAN.txt.
Semua keluaran ditandai "${TINJAUAN_ASR}". Kode keluar: 0 berhasil, 1 ASR tidak terpasang
atau gagal (tanpa keluaran), 2 argumen tidak valid.`;

export async function utamaTranskripsi(argv) {
  let nilai, posisi;
  try {
    ({ values: nilai, positionals: posisi } = parseArgs({ args: argv, allowPositionals: true, options: { ...OPSI_CLI_ASR, out: { type: "string" }, bahasa: { type: "string" }, fps: { type: "string" }, audiens: { type: "string" }, bantuan: { type: "boolean", short: "h" } } }));
  } catch (e) {
    console.error(`narasi transkripsi: ${e.message}\n\n${PETUNJUK_TRANSKRIPSI}`);
    return 2;
  }
  if (nilai.bantuan) { console.log(PETUNJUK_TRANSKRIPSI); return 0; }
  if (posisi.length !== 1) { console.error(`narasi transkripsi: butuh tepat satu <audio>\n\n${PETUNJUK_TRANSKRIPSI}`); return 2; }
  const audio = resolve(posisi[0]);
  if (!existsSync(audio) || !statSync(audio).isFile()) { console.error(`narasi transkripsi: audio tidak ditemukan: ${audio}`); return 2; }
  const fps = nilai.fps === undefined ? 30 : Number(nilai.fps);
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) { console.error("narasi transkripsi: --fps harus bilangan bulat 1..120"); return 2; }
  const data = muatData();
  const audiens = (nilai.audiens ?? "umum").split(",").map((x) => x.trim()).filter(Boolean);
  if (!audiens.length || !audiens.every((p) => Object.hasOwn(data.audiens.profil, p))) {
    console.error(`narasi transkripsi: --audiens harus daftar dari ${Object.keys(data.audiens.profil).join(", ")}`);
    return 2;
  }
  let opsi;
  try { opsi = opsiAsrDariFlag(nilai); } catch (e) { console.error(`narasi transkripsi: ${e.message}`); return 2; }
  let hasil;
  try {
    hasil = await buatTranskripsi(audio, { bahasa: nilai.bahasa ?? "id", fps, audiens, cache: opsi.cache, ulang: opsi.ulang, konfig: opsi.konfig, koreksi: opsi.koreksi, data });
  } catch (e) {
    console.error(`narasi transkripsi: ${e.message}`);
    return 1;
  }
  const keluar = resolve(nilai.out ?? "out/transkripsi");
  mkdirSync(keluar, { recursive: true });
  for (const [nama, isi] of Object.entries(hasil.berkas)) writeFileSync(join(keluar, nama), isi);
  const r = hasil.laporan.ringkasan;
  console.log(`transkripsi: ${r.cue} cue, ${r.kata} kata, ${hasil.laporan.durasiFrame} frame pada ${fps} fps; ${r.ragu} kata berkeyakinan rendah`);
  for (const p of hasil.peringatan) console.error(`peringatan: ${p}`);
  console.error(`PERHATIAN: ${TINJAUAN_ASR}. Lihat ${join(keluar, "PERLU-TINJAUAN.txt")}.`);
  if (hasil.dariCache) console.log("info: keluaran ASR dipakai dari cache");
  console.log(`keluaran: ${keluar}`);
  return 0;
}
