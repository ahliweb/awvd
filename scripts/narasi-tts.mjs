/**
 * awvd / narasi-tts.mjs — adaptor mesin suara TTS lokal opsional untuk `bun run narasi`.
 *
 * Mendaftar sebagai mesin `sherpa-onnx` di registri narasi.mjs (dipanggil lewat suara.mesin).
 * Dirancang untuk CLI sherpa-onnx (`sherpa-onnx-offline-tts`, Apache-2.0) dengan model
 * Supertonic 3 (bahasa Indonesia dan Inggris) dan Kokoro (Inggris), tetapi perintahnya
 * pluggable: tiap mesin di suara.json adalah larik argumen (tanpa shell) berplaceholder,
 * jadi CLI lain yang menulis WAV juga bisa didaftarkan.
 *
 * Prinsip:
 *   - awvd TIDAK membundel biner maupun model; pengguna memasangnya sendiri. Bila tidak
 *     terpasang dan WAV belum ada di cache, narasi gagal dengan pesan yang menunjuk cara
 *     memasang (bukan crash). Bila WAV sudah ada di cache, mesin tidak diperlukan.
 *   - Keluaran TTS saraf tidak identik antar-run, jadi WAV dibekukan: tiap kalimat disintesis
 *     sekali, disimpan di cache berkunci hash (teks ternormalisasi, mesin, versi, model,
 *     speaker, kecepatan, ...), dipakai ulang, dan disahkan dengan SHA-256 tiap dibaca.
 *   - Tiap kalimat dinormalkan kenyaringannya (ffmpeg loudnorm dua langkah, mode linear) ke
 *     48 kHz mono PCM 16-bit, lalu disambung dengan jeda senyap menjadi satu WAV per segmen.
 *   - Teks Indonesia dinormalisasi (normalisasi-id.mjs) saat naskah divalidasi, sehingga
 *     `bacaan` (teks yang dibacakan dan dianalisis timing) sudah berupa kata.
 *   - Kata di luar leksikon Kokoro dilewati diam-diam oleh sherpa-onnx; adaptor memeriksa
 *     leksikon dan menggagalkan sintesis (atau memperingatkan) alih-alih menghasilkan suara
 *     yang kehilangan kata.
 *   - Label suara sintetis wajib: tiap proses menulis suara-kredit.json dan kredit-suara.txt.
 *   - Konten medis: bobot dengan `larangMedis` (Supertonic, OpenRAIL-M butir l) ditolak untuk
 *     jenisKonten "medis"; peringatan untuk kesehatan umum dan teks yang tampak medis.
 *
 * Render (`render.mjs`) tidak pernah memanggil modul ini. Karya asli repo ini; rincian di
 * docs/narasi-caption.md §TTS lokal.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bacaAudio } from "./narasi-selaras.mjs";
import { normalisasiTeks } from "./normalisasi-id.mjs";

/** Naik bila aturan normalisasi atau pembersihan teks berubah (masuk kunci cache). */
export const VERSI_PRAPROSES = 1;
export const SUARA_BAWAAN = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "suara.json");
const SR_AKHIR = 48000;
const PLACEHOLDER = ["teks", "bahasa", "speaker", "kecepatan", "panjangSkala", "langkah", "thread", "keluaran", "model"];
const adalahObjek = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const teksIsi = (x) => typeof x === "string" && x.trim() !== "";
const angka = (x) => typeof x === "number" && Number.isFinite(x);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Galat lingkungan mesin (tidak terpasang, gagal jalan): dipakai CLI untuk pesan tanpa jejak tumpukan. */
export class GalatMesin extends Error {}

// ------------------------------------------------------------------ suara.json
/**
 * Memvalidasi isi suara.json. Mengembalikan { galat[], data } (data null bila ada galat).
 * `dir` = folder suara.json (untuk jalur relatif biner dan model).
 */
export function validasiSuara(obj, dir = ".") {
  const galat = [];
  const g = (p) => galat.push(p);
  if (!adalahObjek(obj)) return { galat: ["isi harus objek JSON"], data: null };
  if (obj.versi !== 1) g(`versi harus 1 (dapat ${JSON.stringify(obj.versi)})`);
  const target = obj.kenyaringanTargetLUFS ?? -16, puncak = obj.puncakMaksDBTP ?? -1.5;
  if (!angka(target) || target > -10 || target < -30) g("kenyaringanTargetLUFS harus angka -30..-10");
  if (!angka(puncak) || puncak > 0 || puncak < -6) g("puncakMaksDBTP harus angka -6..0");
  const kamus = obj.kamus ?? {};
  if (!adalahObjek(kamus) || !Object.values(kamus).every((v) => typeof v === "string")) g("kamus harus objek { kata: bacaan } berisi teks");

  const mesin = {};
  if (!adalahObjek(obj.mesin) || Object.keys(obj.mesin).length === 0) g("mesin harus objek tak kosong");
  else {
    for (const [id, m] of Object.entries(obj.mesin)) {
      const p = `mesin.${id}`;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) { g(`${p}: id hanya huruf, angka, _ atau -`); continue; }
      if (!adalahObjek(m)) { g(`${p} harus objek`); continue; }
      if (!Array.isArray(m.perintah) || m.perintah.length < 2 || !m.perintah.every((x) => typeof x === "string")) { g(`${p}.perintah harus larik teks (nama program lalu argumen)`); continue; }
      const dipakai = new Set();
      for (const a of m.perintah) for (const x of a.matchAll(/\{(\w+)\}/g)) dipakai.add(x[1]);
      for (const x of dipakai) if (!PLACEHOLDER.includes(x)) g(`${p}.perintah: placeholder {${x}} tidak dikenal (sah: ${PLACEHOLDER.join(", ")})`);
      for (const wajib of ["teks", "keluaran"]) if (!dipakai.has(wajib)) g(`${p}.perintah: placeholder {${wajib}} wajib ada`);
      if (!teksIsi(m.versi)) g(`${p}.versi wajib (teks; masuk kunci cache)`);
      for (const k of ["lisensiKode", "lisensiBobot", "sumber"]) if (!teksIsi(m[k])) g(`${p}.${k} wajib (pencatatan lisensi)`);
      if (!Array.isArray(m.syaratPakai) || !m.syaratPakai.every(teksIsi)) g(`${p}.syaratPakai harus larik teks`);
      for (const k of ["larangMedis", "daring", "deterministik"]) if (m[k] !== undefined && typeof m[k] !== "boolean") g(`${p}.${k} harus boolean`);
      for (const k of ["biner", "model", "modelSha256", "kredit"]) if (m[k] !== undefined && m[k] !== null && !teksIsi(m[k])) g(`${p}.${k} harus teks atau null`);
      const langkah = m.langkah ?? 5, thread = m.thread ?? 4;
      if (!Number.isInteger(langkah) || langkah < 1 || langkah > 50) g(`${p}.langkah harus bilangan bulat 1..50`);
      if (!Number.isInteger(thread) || thread < 1 || thread > 64) g(`${p}.thread harus bilangan bulat 1..64`);
      if (m.leksikon !== undefined && (!Array.isArray(m.leksikon) || !m.leksikon.every(teksIsi))) g(`${p}.leksikon harus larik jalur`);
      if (m.oov !== undefined && m.oov !== "gagal" && m.oov !== "peringatan") g(`${p}.oov harus "gagal" atau "peringatan"`);
      const bahasa = m.bahasa ?? ["id", "en"];
      if (!Array.isArray(bahasa) || bahasa.length === 0 || !bahasa.every(teksIsi)) g(`${p}.bahasa harus larik kode bahasa`);
      mesin[id] = {
        id, perintah: m.perintah, biner: m.biner ?? null, model: m.model ?? null, versi: m.versi, modelSha256: m.modelSha256 ?? null,
        bahasa, langkah, thread, leksikon: m.leksikon ?? [], oov: m.oov ?? "gagal", lisensiKode: m.lisensiKode, lisensiBobot: m.lisensiBobot,
        syaratPakai: m.syaratPakai ?? [], larangMedis: m.larangMedis ?? false, daring: m.daring ?? false, deterministik: m.deterministik ?? false,
        kredit: m.kredit ?? m.versi, sumber: m.sumber,
      };
    }
  }

  const karakter = {};
  if (!adalahObjek(obj.karakter) || Object.keys(obj.karakter).length === 0) g("karakter harus objek tak kosong");
  else {
    for (const [id, k] of Object.entries(obj.karakter)) {
      const p = `karakter.${id}`;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) { g(`${p}: id hanya huruf, angka, _ atau -`); continue; }
      if (!adalahObjek(k)) { g(`${p} harus objek`); continue; }
      if (!teksIsi(k.nama)) g(`${p}.nama wajib`);
      if (!teksIsi(k.bahasa)) g(`${p}.bahasa wajib`);
      if (!teksIsi(k.mesin) || !mesin[k.mesin]) g(`${p}.mesin "${k.mesin}" tidak ada di mesin (${Object.keys(mesin).join(", ")})`);
      else if (teksIsi(k.bahasa) && !mesin[k.mesin].bahasa.includes(k.bahasa)) g(`${p}: mesin "${k.mesin}" tidak mendukung bahasa "${k.bahasa}" (mendukung ${mesin[k.mesin].bahasa.join(", ")})`);
      if (!Number.isInteger(k.speaker) || k.speaker < 0) g(`${p}.speaker harus bilangan bulat >= 0`);
      const kec = k.kecepatan ?? 1;
      if (!angka(kec) || kec < 0.5 || kec > 2) g(`${p}.kecepatan harus angka 0,5..2`);
      if (typeof k.orangNyata !== "boolean") g(`${p}.orangNyata wajib boolean (true bila suara meniru atau dilatih dari orang nyata)`);
      else if (k.orangNyata && !teksIsi(k.izinBerkas)) g(`${p}: orangNyata true wajib punya izinBerkas (jalur atau rujukan izin tertulis pemilik suara)`);
      const jeda = k.jeda ?? {};
      for (const j of ["antarKalimatMs", "antarSegmenMs"]) if (jeda[j] !== undefined && (!angka(jeda[j]) || jeda[j] < 0 || jeda[j] > 3000)) g(`${p}.jeda.${j} harus angka 0..3000`);
      karakter[id] = {
        id, nama: k.nama, bahasa: k.bahasa, gender: k.gender ?? null, mesin: k.mesin, speaker: k.speaker, kecepatan: kec,
        gaya: k.gaya ?? null, cocokUntuk: k.cocokUntuk ?? [], jedaKalimatMs: jeda.antarKalimatMs ?? 400, jedaSegmenMs: jeda.antarSegmenMs ?? 800,
        sumberSuara: k.sumberSuara ?? null, orangNyata: k.orangNyata === true, izinBerkas: k.izinBerkas ?? null,
      };
    }
  }
  if (galat.length) return { galat, data: null };
  return { galat, data: { versi: 1, dir, targetLufs: target, puncakDb: puncak, kamus, mesin, karakter } };
}

/** Membaca dan memvalidasi suara.json. Mengembalikan { galat[], data }. */
export function muatSuara(jalur) {
  let obj;
  try { obj = JSON.parse(readFileSync(jalur, "utf8")); } catch (e) { return { galat: [`tidak terbaca atau bukan JSON sah: ${e.message}`], data: null }; }
  return validasiSuara(obj, dirname(resolve(jalur)));
}

/** Jalur suara.json untuk naskah: kunci `suara.konfigurasi`, lalu suara.json di folder naskah, lalu data/suara.json awvd. */
export function pilihKonfigurasi(konfigurasi, dirNaskah) {
  if (konfigurasi) return resolve(dirNaskah, konfigurasi);
  const sebelah = join(dirNaskah, "suara.json");
  return existsSync(sebelah) ? sebelah : SUARA_BAWAAN;
}

// ------------------------------------------------------------------ cache dan kunci
/** JSON kanonik (kunci diurutkan) untuk hash yang stabil. */
export function kanonik(x) {
  if (Array.isArray(x)) return `[${x.map(kanonik).join(",")}]`;
  if (adalahObjek(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${kanonik(x[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

/** Teks akhir yang dikirim ke mesin: rapi, tanpa awalan "-" (agar tidak terbaca sebagai flag). */
export function teksUntukMesin(teks) {
  return String(teks).replace(/\s+/g, " ").trim().replace(/^[-–—]+\s*/, "");
}

/** Kunci cache satu kalimat. Tidak memuat nama karakter: suara yang sama (mesin, speaker, kecepatan) memakai cache yang sama. */
export function kunciKalimat({ teks, karakter, mesin }) {
  const k = {
    praprosesVersi: VERSI_PRAPROSES, teks, mesin: mesin.id, mesinVersi: mesin.versi, modelSha256: mesin.modelSha256,
    bahasa: karakter.bahasa, speaker: karakter.speaker, kecepatan: karakter.kecepatan, langkah: mesin.langkah,
    perintah: mesin.perintah,
  };
  if (mesin.deterministik) k.thread = mesin.thread;
  return { kunci: k, hash: sha256(kanonik(k)) };
}

// ------------------------------------------------------------------ mesin eksternal
const idEnv = (id) => id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const luas = (p, dir) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(dir, p));

/** Placeholder diisi satu lintasan: nilai yang diisikan tidak pernah ditafsir ulang (tanpa injeksi). */
export function isiPlaceholder(perintah, nilai) {
  return perintah.map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(nilai, k) ? String(nilai[k]) : m)));
}

const PETUNJUK_PASANG = "awvd tidak membundel mesin TTS. Pasang sherpa-onnx (Apache-2.0) dan model dari rilis resminya, lalu tunjuk lewat AWVD_SHERPA_BIN (jalur biner sherpa-onnx-offline-tts) dan AWVD_MODEL_<ID MESIN> (folder model), atau lewat kunci biner dan model di suara.json. Langkahnya ada di docs/narasi-caption.md (bagian TTS lokal). Alternatif tanpa mesin: rekaman manusia atau WAV beku (suara.mesin berkas-beku).";

/** Memastikan biner dan berkas model ada; mengembalikan { biner, model, env }. Melempar GalatMesin bila tidak. */
export function pastikanMesin(mesin, dir) {
  const masalah = [];
  const env = process.env;
  const nama = env[`AWVD_BIN_${idEnv(mesin.id)}`] || env.AWVD_SHERPA_BIN || mesin.biner || mesin.perintah[0];
  let biner = null;
  if (nama.includes("/")) {
    const p = luas(nama, dir);
    if (existsSync(p) && statSync(p).isFile()) biner = p; else masalah.push(`biner tidak ditemukan: ${p}`);
  } else {
    biner = Bun.which(nama);
    if (!biner) masalah.push(`biner "${nama}" tidak ada di PATH`);
  }
  const perluModel = mesin.perintah.some((a) => a.includes("{model}"));
  let model = null;
  if (perluModel) {
    const mentah = env[`AWVD_MODEL_${idEnv(mesin.id)}`] || mesin.model;
    if (!mentah) masalah.push(`folder model belum ditentukan (set AWVD_MODEL_${idEnv(mesin.id)} atau mesin.${mesin.id}.model di suara.json)`);
    else {
      model = luas(mentah, dir);
      if (!existsSync(model) || !statSync(model).isDirectory()) masalah.push(`folder model tidak ditemukan: ${model}`);
      else {
        for (const a of [...mesin.perintah, ...mesin.leksikon]) {
          if (!a.includes("{model}")) continue;
          const jalur = a.slice(a.indexOf("{model}")).replace("{model}", model);
          if (!existsSync(jalur)) masalah.push(`berkas model tidak ada: ${jalur}`);
        }
      }
    }
  }
  if (masalah.length) {
    throw new GalatMesin(`mesin suara "${mesin.id}" belum terpasang atau belum lengkap:\n${masalah.map((x) => `  - ${x}`).join("\n")}\n${PETUNJUK_PASANG}`);
  }
  // paket sherpa-onnx "shared" menaruh pustaka di ../lib relatif terhadap bin/
  const lib = join(dirname(dirname(biner)), "lib");
  const lingkungan = { ...env };
  if (existsSync(lib)) lingkungan.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${lib}:${env.LD_LIBRARY_PATH}` : lib;
  return { biner, model, env: lingkungan };
}

async function jalankan(cmd, env) {
  let p;
  try { p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env }); } catch (e) {
    throw new GalatMesin(`tidak dapat menjalankan "${cmd[0]}" (${e.code ?? e.message}); periksa izin eksekusi dan keberadaannya${cmd[0] === "ffmpeg" ? " (ffmpeg wajib untuk normalisasi kenyaringan)" : ""}`);
  }
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}

/** Kata di luar leksikon (Kokoro melewatinya diam-diam). Leksikon: baris "kata fonem...". */
export function periksaOov(teks, jalurLeksikon) {
  const ada = new Set();
  for (const j of jalurLeksikon) {
    for (const baris of readFileSync(j, "utf8").split("\n")) {
      const i = baris.indexOf(" ");
      if (i > 0) ada.add(baris.slice(0, i).toLowerCase());
    }
  }
  const hilang = new Set();
  for (const m of teks.matchAll(/[\p{L}][\p{L}']*/gu)) {
    const w = m[0].toLowerCase().replace(/^'+|'+$/g, "");
    if (!w) continue;
    if (ada.has(w) || (w.endsWith("'s") && ada.has(w.slice(0, -2)))) continue;
    hilang.add(w);
  }
  return [...hilang];
}

// ------------------------------------------------------------------ WAV
/** WAV PCM 16-bit: { sr, ch, data(Buffer) } atau null bila bukan PCM 16-bit. */
function bacaPcm16(jalur) {
  const b = readFileSync(jalur);
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return null;
  let fmt = null, data = null, p = 12;
  while (p + 8 <= b.length) {
    const id = b.toString("latin1", p, p + 4);
    const n = b.readUInt32LE(p + 4);
    const isi = b.subarray(p + 8, Math.min(b.length, p + 8 + n));
    if (id === "fmt " && isi.length >= 16) fmt = { tag: isi.readUInt16LE(0), ch: isi.readUInt16LE(2), sr: isi.readUInt32LE(4), bit: isi.readUInt16LE(14) };
    else if (id === "data") data = isi;
    p += 8 + n + (n % 2);
  }
  if (!fmt || !data || fmt.tag !== 1 || fmt.bit !== 16) return null;
  return { sr: fmt.sr, ch: fmt.ch, data };
}
function tulisPcm16(jalur, bagian, sr) {
  const n = bagian.reduce((a, x) => a + x.length, 0);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n, 40);
  writeFileSync(jalur, Buffer.concat([h, ...bagian]));
}

/**
 * Menormalkan kenyaringan satu kalimat: loudnorm dua langkah mode linear, hasil 48 kHz mono PCM 16-bit.
 * Bila kenyaringan tak terukur (terlalu pendek atau senyap), hanya resampling tanpa gain.
 * Mengembalikan { diukur: boolean }.
 */
async function normalkanKenyaringan(masuk, keluar, { target, puncak }) {
  const dasar = ["ffmpeg", "-hide_banner", "-nostats", "-y"];
  const akhir = ["-ar", String(SR_AKHIR), "-ac", "1", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", keluar];
  const satu = await jalankan([...dasar, "-i", masuk, "-af", `loudnorm=I=${target}:TP=${puncak}:LRA=11:print_format=json`, "-f", "null", "-"]);
  if (satu.kode !== 0) throw new GalatMesin(`ffmpeg gagal mengukur kenyaringan (${masuk}): ${satu.err.trim().split("\n").slice(-3).join(" | ")}`);
  const blok = satu.err.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  let m = null;
  try { m = blok ? JSON.parse(blok[0]) : null; } catch { m = null; }
  const ok = m && ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"].every((k) => Number.isFinite(Number.parseFloat(m[k])));
  const filter = ok
    ? `loudnorm=I=${target}:TP=${puncak}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : null;
  const dua = await jalankan([...dasar, "-i", masuk, ...(filter ? ["-af", filter] : []), ...akhir]);
  if (dua.kode !== 0) throw new GalatMesin(`ffmpeg gagal menormalkan kenyaringan (${masuk}): ${dua.err.trim().split("\n").slice(-3).join(" | ")}`);
  return { diukur: Boolean(ok) };
}

// ------------------------------------------------------------------ sintesis
const jedaSenyap = (ms) => Buffer.alloc(Math.round((ms / 1000) * SR_AKHIR) * 2);
const lewatTulis = (jalur) => jalur.replace(/\.wav$/, ".tmp.wav");

/** Satu kalimat: dari cache (disahkan SHA-256) atau disintesis lewat mesin eksternal. */
async function kalimatKeCache({ cache, hash, kunci, teks, karakter, mesin, dirSuara, opsi, sudahBaru, peringatan }) {
  const wav = join(cache, `${hash}.wav`), meta = join(cache, `${hash}.json`);
  const paksa = Boolean(opsi.sintesisUlang) && !sudahBaru.has(hash);
  if (!paksa && existsSync(wav) && existsSync(meta)) {
    let m;
    try { m = JSON.parse(readFileSync(meta, "utf8")); } catch { m = null; }
    const nyata = sha256(readFileSync(wav));
    if (!m || m.sha256Mentah !== nyata) {
      throw new GalatMesin(`cache suara rusak: hash WAV ${wav} tidak cocok dengan catatan (${m ? m.sha256Mentah : "catatan tak terbaca"}). Hapus berkas cache itu agar disintesis ulang, atau jalankan dengan --sintesis-ulang untuk mengganti semua kalimat (suara berubah).`);
    }
    return { dariCache: true, sha256Mentah: nyata, durasiMentah: m.durasiMentah };
  }
  // perlu sintesis: mesin harus ada
  const { biner, model, env } = pastikanMesin(mesin, dirSuara);
  if (mesin.leksikon.length) {
    const oov = periksaOov(teks, mesin.leksikon.map((l) => (model ? l.replace("{model}", model) : l)));
    if (oov.length) {
      const pesan = `kalimat memuat kata di luar leksikon mesin "${mesin.id}" (akan dilewati tanpa suara): ${oov.join(", ")}. Ganti katanya, atau tambahkan entri ke leksikon (mesin.${mesin.id}.leksikon dan argumen perintah). Kalimat: "${teks}"`;
      if (mesin.oov === "gagal") throw new GalatMesin(pesan);
      peringatan.push(pesan);
    }
  }
  mkdirSync(cache, { recursive: true });
  const tmp = lewatTulis(wav);
  const args = isiPlaceholder(mesin.perintah.slice(1), {
    teks, bahasa: karakter.bahasa, speaker: karakter.speaker, kecepatan: karakter.kecepatan, panjangSkala: Math.round((1 / karakter.kecepatan) * 10000) / 10000,
    langkah: mesin.langkah, thread: mesin.thread, keluaran: tmp, model: model ?? "",
  });
  const r = await jalankan([biner, ...args], env);
  if (r.kode !== 0 || !existsSync(tmp)) {
    throw new GalatMesin(`mesin suara "${mesin.id}" gagal (kode ${r.kode}) untuk kalimat "${teks}": ${(r.err || r.out).trim().split("\n").slice(-4).join(" | ")}`);
  }
  const audio = await bacaAudio(tmp);
  const mentah = readFileSync(tmp);
  renameSync(tmp, wav);
  const sha = sha256(mentah);
  writeFileSync(meta, `${JSON.stringify({ versi: 1, hash, kunci, teks, sha256Mentah: sha, durasiMentah: Math.round(audio.durasi * 1000) / 1000 }, null, 2)}\n`);
  sudahBaru.add(hash);
  return { dariCache: false, sha256Mentah: sha, durasiMentah: Math.round(audio.durasi * 1000) / 1000 };
}

async function sintesisSegmen(segmen, { naskah, opsi = {}, peringatan = [] }) {
  if (!naskah.suara.konfigurasi) throw new GalatMesin("naskah.suara.konfigurasi kosong (naskah belum divalidasi oleh mesin sherpa-onnx)");
  const dirSuara = naskah.suara.konfigurasi ? dirname(naskah.suara.konfigurasi) : ".";
  const { galat, data } = muatSuara(naskah.suara.konfigurasi);
  if (!data) throw new GalatMesin(`suara.json tidak sah:\n${galat.map((x) => `  - ${x}`).join("\n")}`);
  const cache = resolve(opsi.cache ?? naskah.suara.cache ?? ".cache/awvd/suara");
  const sudahBaru = (opsi.sudahBaru ??= new Set());
  const pasangan = { target: data.targetLufs, puncak: data.puncakDb };
  const tagAkhir = sha256(kanonik({ ...pasangan, sr: SR_AKHIR, v: 1 })).slice(0, 8);
  const bagian = [], info = [];
  let jedaSesudah = 0;
  for (const [i, k] of segmen.kalimat.entries()) {
    const karakter = data.karakter[naskah.penutur[k.penutur].karakter];
    if (!karakter) throw new GalatMesin(`penutur "${k.penutur}": karakter tidak ada di suara.json`);
    const mesin = data.mesin[karakter.mesin];
    const teks = teksUntukMesin(k.bacaan ?? k.teks);
    const { kunci, hash } = kunciKalimat({ teks, karakter, mesin });
    const c = await kalimatKeCache({ cache, hash, kunci, teks, karakter, mesin, dirSuara, opsi: { ...opsi, sudahBaru }, sudahBaru, peringatan });
    const akhir = join(cache, `${hash}.${tagAkhir}.akhir.wav`);
    if (!existsSync(akhir)) {
      const tmp = lewatTulis(akhir);
      const n = await normalkanKenyaringan(join(cache, `${hash}.wav`), tmp, pasangan);
      renameSync(tmp, akhir);
      if (!n.diukur) peringatan.push(`kalimat "${teks}": kenyaringan tak terukur (terlalu pendek atau senyap); hanya diresampling tanpa penyesuaian level`);
    }
    const pcm = bacaPcm16(akhir);
    if (!pcm || pcm.sr !== SR_AKHIR || pcm.ch !== 1) throw new GalatMesin(`WAV kalimat tidak terbaca sebagai PCM 16-bit 48 kHz mono: ${akhir}`);
    if (i > 0) bagian.push(jedaSenyap(jedaSesudah));
    bagian.push(pcm.data);
    jedaSesudah = karakter.jedaKalimatMs;
    info.push({ penutur: k.penutur, karakter: karakter.id, mesin: mesin.id, hash, sha256Mentah: c.sha256Mentah, dariCache: c.dariCache, teksDibacakan: teks });
  }
  const idSegmen = sha256(kanonik({ tag: tagAkhir, bagian: info.map((x) => [x.hash, x.sha256Mentah]), jeda: segmen.kalimat.map((k) => data.karakter[naskah.penutur[k.penutur].karakter].jedaKalimatMs) })).slice(0, 24);
  const berkas = join(cache, `segmen-${idSegmen}.wav`);
  if (!existsSync(berkas)) {
    const tmp = lewatTulis(berkas);
    tulisPcm16(tmp, bagian, SR_AKHIR);
    renameSync(tmp, berkas);
  }
  return { berkas, info };
}

// ------------------------------------------------------------------ medis dan label
export const JENIS_KONTEN = ["umum", "kesehatan", "medis"];
const KATA_MEDIS = [
  "dosis", "obat", "diagnosis", "diagnosa", "resep dokter", "gejala", "penyakit", "terapi", "pengobatan", "efek samping", "vaksin",
  "imunisasi", "hasil laboratorium", "hasil lab", "tekanan darah", "gula darah", "kolesterol",
  "dosage", "medication", "prescription", "symptom", "treatment", "side effect", "vaccine", "diagnos",
];
const POLA_MEDIS = new RegExp(String.raw`(?<![\p{L}])(?:${KATA_MEDIS.join("|")})`, "iu");

const LABEL = {
  id: { kalimat: "Suara dalam video ini sintetis (dihasilkan komputer).", suara: "Suara", sintetis: "suara sintetis", mesin: "Mesin suara" },
  en: { kalimat: "The voice in this video is synthetic (computer-generated).", suara: "Voice", sintetis: "synthetic voice", mesin: "Voice engine" },
};

/** Hook validasi dipanggil validasiNaskah: memeriksa suara.json, karakter penutur, klasifikasi, dan jenis konten. */
function siapkan(n, { dir, penutur, jenisKonten, klasifikasi, konfigurasi }) {
  const galat = [], peringatan = [];
  const jalur = pilihKonfigurasi(konfigurasi, dir);
  if (!existsSync(jalur)) return { galat: [`suara.konfigurasi: berkas tidak ditemukan: ${jalur}`], peringatan, bacaan: null, konfigurasi: null };
  const { galat: gs, data } = muatSuara(jalur);
  if (!data) return { galat: gs.map((x) => `suara.json (${jalur}): ${x}`), peringatan, bacaan: null, konfigurasi: null };

  // penutur yang dipakai (urutan pemakaian) dan teksnya
  const dipakai = [];
  const semuaTeks = [];
  for (const a of Array.isArray(n.adegan) ? n.adegan : []) {
    if (!adalahObjek(a)) continue;
    for (const kk of Array.isArray(a.kalimat) ? a.kalimat : []) {
      const o = typeof kk === "string" ? { teks: kk } : kk;
      if (!adalahObjek(o)) continue;
      const p = o.penutur ?? a.penutur ?? "narator";
      if (!dipakai.includes(p)) dipakai.push(p);
      if (typeof o.teks === "string") semuaTeks.push(o.teks);
      if (typeof o.bacaan === "string") semuaTeks.push(o.bacaan);
    }
  }
  const tersedia = Object.keys(data.karakter).join(", ");
  for (const [id, p] of Object.entries(penutur)) {
    if (!p.karakter) { if (dipakai.includes(id)) galat.push(`penutur "${id}": karakter wajib untuk mesin sherpa-onnx (pilihan di ${jalur}: ${tersedia})`); continue; }
    if (!Object.hasOwn(data.karakter, p.karakter)) galat.push(`penutur "${id}": karakter "${p.karakter}" tidak ada di suara.json (pilihan: ${tersedia})`);
  }
  const dikenal = dipakai.filter((id) => penutur[id]?.karakter && data.karakter[penutur[id].karakter]);
  const kar = dikenal.map((id) => data.karakter[penutur[id].karakter]);
  const mesinDipakai = [...new Set(kar.map((k) => k.mesin))].map((m) => data.mesin[m]);

  if (klasifikasi === "internal") {
    for (const m of mesinDipakai) if (m.daring) galat.push(`mesin "${m.id}" di suara.json memakai layanan daring; ditolak untuk klasifikasi "internal" (konten internal tidak dikirim ke layanan daring)`);
  }
  const medis = mesinDipakai.filter((m) => m.larangMedis);
  if (jenisKonten === "medis") {
    for (const m of medis) galat.push(`jenisKonten "medis" ditolak untuk mesin "${m.id}": bobotnya (${m.lisensiBobot}) melarang nasihat atau interpretasi medis. Pakai rekaman manusia (suara.mesin berkas-beku) atau layanan daring untuk konten publik`);
    if (medis.length === 0 && mesinDipakai.length) peringatan.push(`jenisKonten "medis": suara sintetis tidak dianjurkan untuk konten medis; utamakan rekaman manusia dan tinjau dengan tenaga kesehatan sebelum tayang`);
  } else if (jenisKonten === "kesehatan") {
    for (const m of medis) peringatan.push(`jenisKonten "kesehatan" memakai mesin "${m.id}" yang bobotnya (${m.lisensiBobot}) melarang nasihat atau interpretasi medis: edukasi kesehatan umum berada di wilayah abu-abu, minta keputusan pemilik; konten klinis wajib "medis"`);
  } else {
    const cocok = semuaTeks.map((t) => t.match(POLA_MEDIS)).find(Boolean);
    if (cocok && mesinDipakai.length) peringatan.push(`teks memuat istilah yang tampak medis ("${cocok[0]}") tetapi jenisKonten "umum": bila ini nasihat atau interpretasi medis, setel jenisKonten "medis" (rekaman manusia atau layanan daring); bila hanya edukasi kesehatan umum, setel "kesehatan"`);
  }
  for (const k of kar) if (k.orangNyata) peringatan.push(`karakter "${k.id}" meniru atau dilatih dari orang nyata: pastikan izin tertulis pemilik suara (${k.izinBerkas})`);

  return {
    galat, peringatan, konfigurasi: jalur,
    bacaan(teks, penuturId) {
      const k = data.karakter[penutur[penuturId]?.karakter];
      return k ? normalisasiTeks(teks, k.bahasa, { kamus: data.kamus }) : null;
    },
  };
}

/** Berkas label dan kredit sesudah sintesis: suara-kredit.json dan kredit-suara.txt. */
async function selesai({ naskah, segmen }) {
  const { data } = muatSuara(naskah.suara.konfigurasi);
  const bhs = naskah.bahasa === "id" ? "id" : "en";
  const L = LABEL[bhs];
  const karakterId = [], mesinId = [];
  for (const s of segmen) for (const x of s.info ?? []) {
    if (!karakterId.includes(x.karakter)) karakterId.push(x.karakter);
    if (!mesinId.includes(x.mesin)) mesinId.push(x.mesin);
  }
  const kar = karakterId.map((id) => data.karakter[id]);
  const mesin = mesinId.map((id) => data.mesin[id]);
  const kreditLayar = kar.map((k) => `${L.suara}: ${k.nama} (${L.sintetis})`);
  const kreditMesin = mesin.map((m) => `${L.mesin}: ${m.kredit}`);
  const deskripsi = `${L.kalimat} ${kreditLayar.join("; ")}. ${kreditMesin.join("; ")}.`;
  const kredit = {
    versi: 1,
    sintetis: true,
    label: L.kalimat,
    jenisKonten: naskah.jenisKonten,
    kreditLayar, kreditMesin, deskripsi,
    metadata: { comment: deskripsi },
    mesin: mesin.map((m) => ({ id: m.id, versi: m.versi, modelSha256: m.modelSha256, lisensiKode: m.lisensiKode, lisensiBobot: m.lisensiBobot, syaratPakai: m.syaratPakai, sumber: m.sumber, deterministik: m.deterministik })),
    karakter: kar.map((k) => ({ id: k.id, nama: k.nama, bahasa: k.bahasa, mesin: k.mesin, speaker: k.speaker, kecepatan: k.kecepatan, orangNyata: k.orangNyata, izinBerkas: k.izinBerkas })),
    segmen: segmen.map((s) => ({ id: s.id, sha256: s.sha256, kalimat: (s.info ?? []).map((x) => ({ penutur: x.penutur, karakter: x.karakter, hash: x.hash, sha256Mentah: x.sha256Mentah, teksDibacakan: x.teksDibacakan })) })),
  };
  const ringkas = segmen.flatMap((s) => s.info ?? []);
  const baru = ringkas.filter((x) => !x.dariCache).length;
  return {
    berkas: {
      "suara-kredit.json": `${JSON.stringify(kredit, null, 2)}\n`,
      "kredit-suara.txt": `${[...kreditLayar, ...kreditMesin, "", deskripsi].join("\n")}\n`,
    },
    laporan: { sintetis: true, mesin: mesinId, karakter: karakterId, jenisKonten: naskah.jenisKonten, kalimat: ringkas.length },
    info: [`suara sintetis: tampilkan kredit di video dan deskripsi (kredit-suara.txt, suara-kredit.json); ${ringkas.length} kalimat, ${baru} disintesis baru, ${ringkas.length - baru} dari cache`],
  };
}

/** Deskriptor mesin untuk registri narasi.mjs (nama: sherpa-onnx). */
export const mesinSherpa = {
  daring: false,
  butuhBerkas: false,
  sintetis: true,
  siapkan,
  sintesis: (segmen, konteks) => sintesisSegmen(segmen, konteks),
  selesai,
};
