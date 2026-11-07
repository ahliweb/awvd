#!/usr/bin/env bun
/**
 * awvd / narasi.mjs — dari naskah.json ke cue caption (VTT/SRT), stempel kata, dan rencana audio.
 *
 *   bun scripts/narasi.mjs <naskah.json> [--out DIR]      # bawaan out/narasi
 *   bun scripts/narasi.mjs <naskah.json> --selaras whisper  # stempel kata dari ASR whisper.cpp lokal
 *   bun scripts/narasi.mjs transkripsi <audio> [--out DIR]  # caption dari audio tanpa naskah (ASR)
 *
 * Keluaran di DIR: caption.vtt, caption.srt, kata.json, rencana-audio.json, laporan.json.
 *   - rencana-audio.json masuk ke `bun run audio` (scripts/audio.mjs) tanpa perubahan.
 *   - kata.json (stempel kata dalam detik dan frame, per cue) disiapkan untuk mode caption
 *     di komposisi; render.mjs tidak memanggil skrip ini dan tidak pernah memanggil mesin
 *     suara: narasi menulis aset beku, render hanya membaca (determinisme).
 *
 * Tiap segmen (satu WAV; satu adegan atau satu kalimat) dianalisis energinya, jeda senyap
 * nyata dipasangkan ke tanda baca (estimasi berjangkar jeda), lalu kata dikelompokkan
 * menjadi cue yang divalidasi terhadap batas cps profil audiens (data/audiens.json),
 * baris, karakter, dan durasi. Mesin suara bersifat pluggable (`daftarkanMesin`); yang
 * tersedia: `berkas-beku` (WAV sudah jadi) dan `sherpa-onnx` (adaptor TTS lokal opsional,
 * narasi-tts.mjs; tidak dibundel, WAV dibekukan di cache berhash, label suara sintetis wajib).
 * ASR opsional (narasi-asr.mjs; whisper.cpp lokal, tidak dibundel): `--selaras whisper` memetakan
 * stempel kata ASR ke kata naskah (skor rendah jatuh ke estimasi), dan `transkripsi` membuat
 * caption dari audio tanpa naskah yang ditandai wajib ditinjau manusia.
 *
 * Kode keluar: 0 berhasil (peringatan boleh ada), 1 lint gagal atau galat saat memproses
 * (keluaran tetap ditulis bila memungkinkan), 2 naskah atau argumen tidak valid.
 * Karya asli repo ini; rincian dan dasar riset di docs/narasi-caption.md.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { audiensEfektif, muatData } from "./konsep.mjs";
import { bacaAudio, kataDariPenanda, keFrame, selaraskanToken, sebarkanTampil, tokenisasi } from "./narasi-selaras.mjs";
import { keSrt, keVtt, periksaCue, susunCue } from "./narasi-cue.mjs";
import { JENIS_KONTEN, mesinSherpa } from "./narasi-tts.mjs";
import { bacaTampilAdegan, bacaTampilNaskah, tampilKeKata } from "./narasi-caption.mjs";
import { AMBANG_SKOR_BAWAAN, KOREKSI_DTW_BAWAAN, OPSI_CLI_ASR, PETUNJUK_ASR, infoMesinAsr, jalankanWhisper, kataDariWhisper, opsiAsrDariFlag, ringkasSelaras, selarasWhisper, utamaTranskripsi } from "./narasi-asr.mjs";

// ------------------------------------------------------------------ mesin suara
/**
 * Registri mesin suara. Deskriptor: { daring: boolean, butuhBerkas: boolean,
 * async sintesis(segmen, konteks) -> { berkas: jalurAbsolut, penanda?: [{ teks, mulai, durasi }], info? } }.
 * `penanda` (detik, relatif ke awal berkas, satu per kata) hanya dipakai bila jumlahnya sama
 * dengan jumlah kata; selain itu timing jatuh ke estimasi. Mesin `daring: true` ditolak untuk
 * naskah berklasifikasi `internal` (konten internal tidak dikirim ke layanan daring).
 * `konteks` = { naskah, opsi, peringatan } (opsi: { cache, sintesisUlang }; peringatan: larik
 * yang boleh diisi mesin).
 * Hook opsional untuk mesin yang memanggil TTS (lihat narasi-tts.mjs):
 *   siapkan(naskahMentah, { dir, penutur, jenisKonten, klasifikasi, konfigurasi })
 *     -> { galat[], peringatan[], konfigurasi, bacaan(teks, penuturId) -> teks|null } dipanggil saat validasi;
 *     `bacaan` menormalkan teks yang dibacakan (angka dan tanggal menjadi kata) sehingga naskah
 *     boleh memuat angka. Mesin tanpa `siapkan` tetap menolak angka tanpa `bacaan`.
 *   async selesai({ naskah, segmen: [{ id, adegan, sha256, info }] })
 *     -> { berkas: { nama: isi }, laporan, info[] } berkas tambahan (kredit dan label) dan baris info CLI.
 */
const MESIN = {
  "berkas-beku": { daring: false, butuhBerkas: true, async sintesis(segmen) { return { berkas: segmen.berkas }; } },
};
export function daftarkanMesin(nama, deskriptor) {
  if (typeof nama !== "string" || !nama) throw new Error("nama mesin harus teks");
  if (!deskriptor || typeof deskriptor.sintesis !== "function") throw new Error("mesin butuh fungsi sintesis");
  MESIN[nama] = { daring: false, butuhBerkas: false, ...deskriptor };
}
export function hapusMesin(nama) { if (nama !== "berkas-beku") delete MESIN[nama]; }
export const daftarMesin = () => Object.keys(MESIN);
daftarkanMesin("sherpa-onnx", mesinSherpa);

// ------------------------------------------------------------------ skema naskah
const KUNCI = {
  naskah: ["versi", "catatan", "fps", "bahasa", "klasifikasi", "jenisKonten", "ukuran", "audiens", "caption", "suara", "penutur", "adegan"],
  caption: ["maksKarakter", "maksBaris", "cps", "tahanMaks", "mode", "posisi"],
  suara: ["mesin", "konfigurasi", "cache", "kalibrasi", "jedaAwal", "jedaKalimat", "jedaAdegan"],
  penutur: ["nama", "italik", "label", "karakter"],
  adegan: ["id", "kalimat", "berkas", "durasiMin", "penutur", "posisi", "zonaCaption", "jangkarPenutur"],
  kalimat: ["teks", "bacaan", "penutur", "berkas"],
};
const KALIBRASI_BAWAAN = { awal: 0.1, akhir: 0.04 };
const POLA_ID = /^[A-Za-z0-9_-]+$/;
const adalahObjek = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const teksIsi = (x) => typeof x === "string" && x.trim() !== "";
const bulat = (x) => Number.isInteger(x);
const angka = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * Memvalidasi dan menormalkan naskah. `dir` = folder naskah (untuk jalur berkas relatif).
 * Mengembalikan { galat[], peringatan[], naskah } (naskah null bila ada galat).
 * Hanya teks `bacaan ?? teks` yang dibacakan; angka harus ditulis dengan huruf atau diberi `bacaan`.
 */
export function validasiNaskah(n, dir, { data = muatData() } = {}) {
  const galat = [], peringatan = [];
  const g = (p) => galat.push(p), w = (p) => peringatan.push(p);
  if (!adalahObjek(n)) return { galat: ["naskah harus objek JSON"], peringatan, naskah: null };
  const kunciAneh = (obj, daftar, jalur) => {
    for (const k of Object.keys(obj)) if (!daftar.includes(k)) w(`${jalur}: kunci "${k}" tidak dikenal dan diabaikan`);
  };
  kunciAneh(n, KUNCI.naskah, "naskah");
  if (n.versi !== 1) g(`versi harus 1 (dapat ${JSON.stringify(n.versi)})`);
  const fps = n.fps ?? 30;
  if (!bulat(fps) || fps < 1 || fps > 120) g(`fps harus bilangan bulat 1..120 (dapat ${JSON.stringify(n.fps)})`);
  const bahasa = n.bahasa ?? "id";
  if (!teksIsi(bahasa)) g("bahasa harus teks");
  if (n.klasifikasi !== "publik" && n.klasifikasi !== "internal") g(`klasifikasi wajib "publik" atau "internal" (dapat ${JSON.stringify(n.klasifikasi)})`);
  const jenisKonten = n.jenisKonten ?? "umum";
  if (!JENIS_KONTEN.includes(jenisKonten)) g(`jenisKonten harus salah satu dari ${JENIS_KONTEN.join(", ")} (dapat ${JSON.stringify(n.jenisKonten)})`);

  let ukuran = null;
  if (n.ukuran !== undefined) {
    if (!adalahObjek(n.ukuran) || !bulat(n.ukuran.lebar) || !bulat(n.ukuran.tinggi) || n.ukuran.lebar < 1 || n.ukuran.tinggi < 1) g("ukuran harus { lebar, tinggi } bilangan bulat positif");
    else ukuran = { lebar: n.ukuran.lebar, tinggi: n.ukuran.tinggi };
  }

  // audiens dan batas cps
  const profil = n.audiens ?? ["umum"];
  let efektif = null;
  if (!Array.isArray(profil) || profil.length === 0 || !profil.every((p) => typeof p === "string" && Object.hasOwn(data.audiens.profil, p))) {
    g(`audiens harus daftar tak kosong dari ${Object.keys(data.audiens.profil).join(", ")}`);
  } else efektif = audiensEfektif(data, profil);

  // caption
  const cap = n.caption ?? {};
  if (!adalahObjek(cap)) g("caption harus objek");
  else kunciAneh(cap, KUNCI.caption, "caption");
  const potret = ukuran ? ukuran.tinggi > ukuran.lebar : false;
  const maksKarakter = cap.maksKarakter ?? (potret ? 28 : 42);
  const maksBaris = cap.maksBaris ?? 2;
  if (!bulat(maksKarakter) || maksKarakter < 10 || maksKarakter > 60) g(`caption.maksKarakter harus bilangan bulat 10..60 (dapat ${JSON.stringify(cap.maksKarakter)})`);
  if (!bulat(maksBaris) || maksBaris < 1 || maksBaris > 3) g(`caption.maksBaris harus bilangan bulat 1..3 (dapat ${JSON.stringify(cap.maksBaris)})`);
  let cps = efektif ? efektif.cps : 17;
  if (cap.cps !== undefined) {
    if (!angka(cap.cps) || cap.cps <= 0 || cap.cps > 20) g(`caption.cps harus angka 0..20 (batas SDH dewasa Netflix Indonesia; dapat ${JSON.stringify(cap.cps)})`);
    else {
      if (efektif && cap.cps > efektif.cps) w(`caption.cps ${cap.cps} lebih longgar daripada batas profil audiens (${efektif.cps}); dipakai ${cap.cps}`);
      cps = cap.cps;
    }
  }
  const tahanMaks = cap.tahanMaks ?? 0.5;
  if (!angka(tahanMaks) || tahanMaks < 0 || tahanMaks > 1.5) g("caption.tahanMaks harus angka 0..1,5 detik");
  const tampilNaskah = adalahObjek(cap) ? bacaTampilNaskah(cap, g) : {}; // mode dan posisi tampil (narasi-caption.mjs)

  // suara
  const suara = n.suara ?? {};
  if (!adalahObjek(suara)) g("suara harus objek");
  else kunciAneh(suara, KUNCI.suara, "suara");
  const namaMesin = suara.mesin ?? "berkas-beku";
  const mesin = MESIN[namaMesin];
  if (!mesin) g(`suara.mesin "${namaMesin}" tidak dikenal; tersedia: ${daftarMesin().join(", ")}`);
  else if (n.klasifikasi === "internal" && mesin.daring) g(`suara.mesin "${namaMesin}" memakai layanan daring; ditolak untuk klasifikasi "internal" (konten internal tidak dikirim ke layanan daring)`);
  for (const k of ["konfigurasi", "cache"]) if (suara[k] !== undefined && !teksIsi(suara[k])) g(`suara.${k} harus teks (jalur relatif terhadap folder naskah)`);
  const kalibrasi = { ...KALIBRASI_BAWAAN, ...(adalahObjek(suara.kalibrasi) ? suara.kalibrasi : {}) };
  if (suara.kalibrasi !== undefined && !adalahObjek(suara.kalibrasi)) g("suara.kalibrasi harus objek { awal, akhir }");
  for (const k of ["awal", "akhir"]) {
    if (!angka(kalibrasi[k]) || kalibrasi[k] < 0 || kalibrasi[k] > 0.3) g(`suara.kalibrasi.${k} harus angka 0..0,3 detik`);
  }
  const jeda = {};
  for (const [k, d] of [["jedaAwal", 0.3], ["jedaKalimat", 0.4], ["jedaAdegan", 0.5]]) {
    jeda[k] = suara[k] ?? d;
    if (!angka(jeda[k]) || jeda[k] < 0 || jeda[k] > 5) g(`suara.${k} harus angka 0..5 detik`);
  }

  // penutur
  const penutur = {};
  const pn = n.penutur ?? { narator: { nama: "Narator" } };
  if (!adalahObjek(pn) || Object.keys(pn).length === 0) g("penutur harus objek tak kosong");
  else {
    for (const [id, p] of Object.entries(pn)) {
      if (!POLA_ID.test(id)) { g(`penutur "${id}": id hanya huruf, angka, _ atau -`); continue; }
      if (!adalahObjek(p)) { g(`penutur "${id}" harus objek`); continue; }
      kunciAneh(p, KUNCI.penutur, `penutur.${id}`);
      if (p.nama !== undefined && !teksIsi(p.nama)) g(`penutur.${id}.nama harus teks`);
      if (p.italik !== undefined && typeof p.italik !== "boolean") g(`penutur.${id}.italik harus boolean`);
      if (p.label !== undefined && typeof p.label !== "boolean") g(`penutur.${id}.label harus boolean`);
      if (p.karakter !== undefined && !teksIsi(p.karakter)) g(`penutur.${id}.karakter harus teks (id karakter di suara.json)`);
      penutur[id] = { nama: p.nama ?? id, italik: p.italik ?? false, label: p.label ?? false, karakter: p.karakter ?? null };
    }
  }

  // mesin yang memanggil TTS memeriksa suara.json, karakter, jenis konten, dan menormalkan teks
  let adaptor = null;
  if (mesin && typeof mesin.siapkan === "function") {
    adaptor = mesin.siapkan(n, { dir, penutur, jenisKonten, klasifikasi: n.klasifikasi, konfigurasi: suara.konfigurasi });
    for (const x of adaptor.galat ?? []) g(x);
    for (const x of adaptor.peringatan ?? []) w(x);
  }

  // adegan dan segmen
  const adegan = [];
  const idSegmen = new Set();
  const dibacakan = (teks, jalur) => {
    if (/[<>]/.test(teks)) g(`${jalur}: karakter < dan > tidak diizinkan`);
    if (/\p{N}/u.test(teks)) g(`${jalur}: angka harus ditulis dengan huruf atau diberi \`bacaan\` (estimasi tidak mengeja angka)`);
  };
  const cekBerkas = (p, jalur, wajib) => {
    if (p === undefined || p === null) { if (wajib) g(`${jalur}: berkas wajib untuk mesin "${namaMesin}"`); return null; }
    if (!teksIsi(p)) { g(`${jalur}: berkas harus teks`); return null; }
    const abs = isAbsolute(p) ? p : resolve(dir, p);
    if (!existsSync(abs)) { g(`${jalur}: berkas tidak ditemukan: ${p}`); return null; }
    return abs;
  };
  if (!Array.isArray(n.adegan) || n.adegan.length === 0) g("adegan harus daftar tak kosong");
  else {
    const idAdegan = new Set();
    for (const [i, a] of n.adegan.entries()) {
      const pa = `adegan[${i}]`;
      if (!adalahObjek(a)) { g(`${pa} harus objek`); continue; }
      kunciAneh(a, KUNCI.adegan, pa);
      if (!teksIsi(a.id) || !POLA_ID.test(a.id)) { g(`${pa}.id wajib (huruf, angka, _ atau -)`); continue; }
      if (idAdegan.has(a.id)) g(`${pa}: id "${a.id}" ganda`);
      idAdegan.add(a.id);
      const nama = `adegan "${a.id}"`;
      if (a.durasiMin !== undefined && (!angka(a.durasiMin) || a.durasiMin < 0)) g(`${nama}: durasiMin harus angka >= 0 (detik)`);
      if (!Array.isArray(a.kalimat) || a.kalimat.length === 0) { g(`${nama}: kalimat harus daftar tak kosong`); continue; }
      const kal = [];
      for (const [k, kk] of a.kalimat.entries()) {
        const pk = `${nama}, kalimat[${k}]`;
        const o = typeof kk === "string" ? { teks: kk } : kk;
        if (!adalahObjek(o)) { g(`${pk} harus teks atau objek`); continue; }
        kunciAneh(o, KUNCI.kalimat, pk);
        if (!teksIsi(o.teks)) { g(`${pk}: teks wajib`); continue; }
        if (o.bacaan !== undefined && !teksIsi(o.bacaan)) { g(`${pk}: bacaan harus teks`); continue; }
        const p = o.penutur ?? a.penutur ?? "narator";
        let bacaan = o.bacaan === undefined ? null : o.bacaan.replace(/\s+/g, " ").trim();
        if (adaptor?.bacaan && Object.hasOwn(penutur, p)) {
          // mesin TTS menormalkan angka, tanggal, URL, dan singkatan menjadi kata
          const dasar = bacaan ?? o.teks.replace(/\s+/g, " ").trim();
          const nb = adaptor.bacaan(dasar, p);
          if (typeof nb === "string" && nb !== dasar) bacaan = nb;
        }
        dibacakan(bacaan ?? o.teks, pk);
        if (o.bacaan !== undefined && /[<>]/.test(o.teks)) g(`${pk}: karakter < dan > tidak diizinkan`);
        if (!Object.hasOwn(penutur, p)) g(`${pk}: penutur "${p}" tidak ada di daftar penutur`);
        kal.push({ indeks: k, teks: o.teks.replace(/\s+/g, " ").trim(), bacaan, penutur: p, berkas: o.berkas });
      }
      // segmen: satu WAV per adegan, atau satu per kalimat bila tiap kalimat punya berkas
      const wajib = mesin?.butuhBerkas ?? false;
      if (mesin && !wajib && (a.berkas !== undefined || kal.some((x) => x.berkas !== undefined))) w(`${nama}: berkas diabaikan; mesin "${namaMesin}" membuat audionya sendiri`);
      const sebagian = kal.filter((x) => x.berkas !== undefined).length;
      const segmen = [];
      if (kal.length !== a.kalimat.length) continue;
      if (a.berkas !== undefined && sebagian > 0) g(`${nama}: berkas diberikan di adegan dan di kalimat sekaligus; pilih salah satu`);
      else if (a.berkas !== undefined || sebagian === 0) {
        segmen.push({ id: a.id, berkas: cekBerkas(a.berkas, nama, wajib), berkasNaskah: a.berkas ?? null, kalimat: kal });
      } else if (sebagian === kal.length) {
        for (const x of kal) {
          const pk = `${nama}, kalimat[${x.indeks}]`;
          segmen.push({ id: `${a.id}-${x.indeks + 1}`, berkas: cekBerkas(x.berkas, pk, true), berkasNaskah: x.berkas, kalimat: [x] });
        }
      } else g(`${nama}: berkas harus di adegan atau di SEMUA kalimat (sebagian saja tidak sah)`);
      for (const s of segmen) {
        if (idSegmen.has(s.id)) g(`${nama}: id segmen "${s.id}" bentrok dengan adegan lain`);
        idSegmen.add(s.id);
      }
      adegan.push({ id: a.id, durasiMin: a.durasiMin ?? 0, segmen, tampil: bacaTampilAdegan(a, nama, { ukuran, posisiNaskah: tampilNaskah.posisi }, g, w) });
    }
  }
  if (galat.length) return { galat, peringatan, naskah: null };
  return {
    galat, peringatan,
    naskah: {
      fps, bahasa, klasifikasi: n.klasifikasi, jenisKonten, audiens: [...profil], ukuran,
      batas: { cps, maksKarakter, maksBaris, tahanMaks }, tampil: tampilNaskah,
      suara: { mesin: namaMesin, kalibrasi, ...jeda, konfigurasi: adaptor?.konfigurasi ?? null, cache: suara.cache ? resolve(dir, suara.cache) : null },
      penutur, adegan,
    },
  };
}

/** Membaca naskah.json dari berkas. Mengembalikan { galat, peringatan, naskah, sha256 }. */
export function bacaNaskah(jalur, opsi = {}) {
  let teks;
  try { teks = readFileSync(jalur); } catch (e) { return { galat: [`naskah tidak terbaca: ${e.message}`], peringatan: [], naskah: null, sha256: null }; }
  let obj;
  try { obj = JSON.parse(teks.toString("utf8")); } catch (e) { return { galat: [`naskah bukan JSON sah: ${e.message}`], peringatan: [], naskah: null, sha256: null }; }
  const v = validasiNaskah(obj, dirname(resolve(jalur)), opsi);
  return { ...v, sha256: createHash("sha256").update(teks).digest("hex") };
}

// ------------------------------------------------------------------ pipeline
const r3 = (x) => Math.round(x * 1000) / 1000;
const sha256Berkas = (jalur) => createHash("sha256").update(readFileSync(jalur)).digest("hex");
const tulisJson = (x) => JSON.stringify(x, null, 2) + "\n";
const jalurRel = (dari, ke) => relative(dari, ke).split("\\").join("/");

/** Token sebuah segmen: baca (untuk estimasi) dan tampil (untuk caption), per kalimat. */
function tokenSegmen(segmen, idAdegan) {
  const baca = [], tampil = [];
  for (const k of segmen.kalimat) {
    const tt = tokenisasi(k.teks);
    const tb = k.bacaan === null ? tt.map((t) => ({ ...t })) : tokenisasi(k.bacaan);
    for (const arr of [tt, tb]) if (arr.length) arr[arr.length - 1].tp = "titik"; // batas kalimat selalu jangkar
    const tag = { adegan: idAdegan, kalimat: k.indeks, penutur: k.penutur, segmen: segmen.id };
    tampil.push(tt.map((t) => ({ ...t, ...tag })));
    baca.push(tb.map((t) => ({ ...t, ...tag })));
  }
  return { baca, tampil };
}

/**
 * Menjalankan seluruh pipeline pada naskah ternormalisasi. Tidak menulis berkas.
 * `dirKeluaran` dipakai untuk jalur relatif di rencana-audio.json dan laporan.
 * Mengembalikan { berkas: { "caption.vtt", ... teks }, cues, gagal[], peringatan[], laporan }.
 * `selaras` (opsional): { mode: "whisper", konfig: { bin, model }, cache, ulang, koreksi, ambang }
 * memakai whisper.cpp lokal untuk stempel kata (narasi-asr.mjs); tanpa itu timing = estimasi.
 * Prioritas sumber waktu per segmen: penanda mesin TTS, lalu whisper (skor penyelarasan >=
 * ambang), lalu estimasi berjangkar jeda.
 */
export async function buatNarasi(naskah, { dirKeluaran, sha256Naskah = null, opsiMesin = {}, selaras = null } = {}) {
  const { fps, batas, suara, penutur } = naskah;
  const mesin = MESIN[suara.mesin];
  const peringatan = [], gagal = [];
  const ke = (x) => Math.ceil(x * fps - 1e-6);
  const jedaF = (d) => Math.round(d * fps);

  // 1) berkas audio per segmen dan durasi
  const segmen = [];
  for (const a of naskah.adegan) {
    for (const s of a.segmen) {
      const hasil = await mesin.sintesis(s, { naskah, opsi: opsiMesin, peringatan });
      if (!hasil || typeof hasil.berkas !== "string" || !existsSync(hasil.berkas)) throw new Error(`segmen "${s.id}": mesin tidak menghasilkan berkas audio`);
      const audio = await bacaAudio(hasil.berkas);
      segmen.push({ ...s, adegan: a.id, berkas: hasil.berkas, penanda: hasil.penanda ?? null, info: hasil.info ?? null, audio, sha256: sha256Berkas(hasil.berkas) });
    }
  }

  // 2) garis waktu (frame bulat)
  let kursor = 0;
  const adeganWaktu = [];
  for (const a of naskah.adegan) {
    const mulaiA = kursor;
    let t = mulaiA + jedaF(suara.jedaAwal);
    const daftar = segmen.filter((s) => s.adegan === a.id);
    daftar.forEach((s, i) => {
      if (i > 0) t += jedaF(suara.jedaKalimat);
      s.mulaiFrame = t;
      s.durasiFrame = Math.max(1, ke(s.audio.durasi));
      t += s.durasiFrame;
    });
    const durasiA = Math.max(Math.ceil(a.durasiMin * fps - 1e-6), t + jedaF(suara.jedaAdegan) - mulaiA);
    adeganWaktu.push({ id: a.id, mulaiFrame: mulaiA, durasiFrame: durasiA, akhirNarasiFrame: t, tampil: a.tampil });
    kursor += durasiA;
  }
  const totalFrame = kursor;
  const akhirAdegan = Object.fromEntries(adeganWaktu.map((a) => [a.id, a.mulaiFrame + a.durasiFrame]));

  // 3) stempel kata per segmen
  const kata = [];
  const batasKalimat = [];
  const sumberSegmen = [];
  const asrSegmen = [];
  let asrMesin = null;
  for (const s of segmen) {
    const { baca, tampil } = tokenSegmen(s, s.adegan);
    const alir = baca.flat();
    let hasil = null, sumber = "estimasi", jangkar = 0, titikJangkar = 0, jeda = [];
    if (s.penanda) {
      const kp = kataDariPenanda(alir, s.penanda);
      if (kp) { hasil = kp; sumber = "penanda-tts"; } else peringatan.push(`segmen "${s.id}": jumlah penanda mesin (${s.penanda.length}) tidak sama dengan jumlah kata (${alir.length}); memakai estimasi`);
    }
    const est = selaraskanToken(alir, s.audio, { kalibrasi: suara.kalibrasi });
    jeda = est.jeda; jangkar = est.jangkar; titikJangkar = est.titikJangkar;
    if (!est.ada) gagal.push({ n: null, tingkat: "gagal", kode: "senyap", pesan: `segmen "${s.id}": tidak ada ucapan terdeteksi (audio senyap)` });
    if (!hasil && selaras?.mode === "whisper" && est.ada) {
      // ASR lokal: kata ASR dipetakan ke kata naskah; skor rendah jatuh ke estimasi dengan peringatan
      const r = await jalankanWhisper(s.berkas, { bahasa: naskah.bahasa.split("-")[0], cache: selaras.cache, ulang: selaras.ulang, konfig: selaras.konfig, peringatan });
      asrMesin ??= infoMesinAsr(r);
      const { kata: kataAsr, presisi } = kataDariWhisper(r.json);
      const sw = selarasWhisper(alir, kataAsr, est, { ambang: selaras.ambang ?? AMBANG_SKOR_BAWAAN, koreksi: selaras.koreksi ?? KOREKSI_DTW_BAWAAN, presisi, durasi: s.audio.durasi });
      asrSegmen.push({ ...ringkasSelaras(s.id, sw), presisi });
      if (sw.ok) { hasil = sw.kata; sumber = "whisper"; }
      else peringatan.push(`segmen "${s.id}": penyelarasan whisper tidak dipakai (${sw.alasan}); memakai estimasi`);
    }
    if (!hasil) hasil = est.kata;
    else { jangkar = 0; titikJangkar = 0; }
    const durasi = s.audio.durasi;
    const offset = s.mulaiFrame / fps;
    // kembali ke struktur per kalimat; token tampil disebar bila bacaan berbeda
    let p = 0;
    baca.forEach((tb, ki) => {
      const potong = hasil.slice(p, p + tb.length);
      p += tb.length;
      const tt = tampil[ki];
      const sama = s.kalimat[ki].bacaan === null;
      const kk = sama ? potong : sebarkanTampil(tt, potong[0].mulai, potong[potong.length - 1].akhir);
      for (const x of kk) {
        kata.push({ teks: x.teks, tampil: x.tampil, tp: x.tp, mulai: offset + Math.min(durasi, x.mulai), akhir: offset + Math.min(durasi, x.akhir),
          adegan: x.adegan, kalimat: x.kalimat, penutur: x.penutur, segmen: x.segmen });
      }
      // batas ke kalimat berikutnya di segmen yang sama: harus jatuh di jeda senyap
      if (ki + 1 < baca.length) {
        const a = potong[potong.length - 1].akhir, b = hasil[p].mulai;
        const tengah = (a + b) / 2, tol = 1 / fps;
        const diJeda = jeda.some((gp) => tengah >= gp.a - tol && tengah <= gp.b + tol);
        batasKalimat.push({ jenis: "kalimat", adegan: s.adegan, segmen: s.id, dari: s.kalimat[ki].indeks, ke: s.kalimat[ki + 1].indeks, tengah: r3(offset + tengah), diJeda });
        if (!diJeda) peringatan.push(`adegan "${s.adegan}", batas kalimat ${s.kalimat[ki].indeks} ke ${s.kalimat[ki + 1].indeks} tidak jatuh di jeda senyap terdeteksi (estimasi proporsional); beri jeda di audio atau periksa naskah`);
      }
    });
    sumberSegmen.push({ id: s.id, adegan: s.adegan, berkas: dirKeluaran ? jalurRel(dirKeluaran, s.berkas) : s.berkas, sha256: s.sha256,
      durasi: r3(durasi), mulaiFrame: s.mulaiFrame, durasiFrame: s.durasiFrame, sumber,
      jangkar: { terpasang: jangkar, tanda: titikJangkar }, jedaTerdeteksi: jeda.length });
  }
  // batas antar-segmen (jeda yang ditulis naskah): jatuh di senyap bila ada celah >= 1 frame
  for (let i = 0; i + 1 < segmen.length; i++) {
    const a = segmen[i], b = segmen[i + 1];
    const celah = b.mulaiFrame - (a.mulaiFrame + a.durasiFrame);
    batasKalimat.push({ jenis: a.adegan === b.adegan ? "segmen" : "adegan", adegan: b.adegan, segmen: b.id, dari: a.id, ke: b.id,
      tengah: r3((a.mulaiFrame + a.durasiFrame + b.mulaiFrame) / 2 / fps), diJeda: celah >= 1 });
    if (celah < 1) peringatan.push(`batas segmen "${a.id}" ke "${b.id}" tidak punya jeda (naikkan suara.jedaKalimat atau suara.jedaAdegan)`);
  }

  // 4) cue dan lint
  const opsiCue = { fps, maksKarakter: batas.maksKarakter, maksBaris: batas.maksBaris, cps: batas.cps, tahanMaks: batas.tahanMaks, totalFrame, akhirAdegan, penutur };
  const cues = susunCue(kata, opsiCue);
  const lint = periksaCue(cues, opsiCue);
  for (const c of lint) (c.tingkat === "gagal" ? gagal : peringatan).push(c.tingkat === "gagal" ? c : `cue ${c.n}: ${c.pesan}`);
  const kataBingkai = keFrame(kata, fps);
  const cueDariKata = new Array(kata.length).fill(0);
  for (const c of cues) for (const i of c.indeks) cueDariKata[i] = c.n;

  const sumber = [...new Set(sumberSegmen.map((x) => x.sumber))];
  const fileKata = {
    versi: 1, fps, sumber: sumber.length === 1 ? sumber[0] : "campuran", durasiFrame: totalFrame,
    ...(Object.keys(naskah.tampil ?? {}).length ? { caption: naskah.tampil } : {}),
    adegan: adeganWaktu.map((a) => ({ id: a.id, mulaiFrame: a.mulaiFrame, durasiFrame: a.durasiFrame, ...tampilKeKata(a.tampil, a.mulaiFrame, a.durasiFrame) })),
    kata: kataBingkai.map((k, i) => ({ teks: k.teks, tampil: k.tampil, mulai: r3(k.mulai), akhir: r3(k.akhir), mulaiFrame: k.mulaiFrame, akhirFrame: k.akhirFrame,
      adegan: k.adegan, kalimat: k.kalimat, penutur: k.penutur, cue: cueDariKata[i] })),
  };
  const rencana = {
    versi: 1, fps, durasiFrame: totalFrame,
    narasi: sumberSegmen.map((s) => ({ id: s.id, berkas: s.berkas, mulai: s.mulaiFrame, sha256: s.sha256 })),
  };
  const cpsDaftar = cues.map((c) => c.cps).sort((x, y) => x - y);
  const median = cpsDaftar.length ? cpsDaftar[Math.floor((cpsDaftar.length - 1) / 2)] : 0;
  const laporan = {
    versi: 1, naskahSha256: sha256Naskah, fps, durasiFrame: totalFrame,
    audiens: { profil: naskah.audiens, cps: batas.cps }, batas,
    ringkasan: { adegan: adeganWaktu.length, segmen: segmen.length, kata: kata.length, cue: cues.length,
      cpsMaks: r3(cpsDaftar.length ? cpsDaftar[cpsDaftar.length - 1] : 0), cpsMedian: r3(median),
      gagal: gagal.length, peringatan: peringatan.length },
    segmen: sumberSegmen,
    batasKalimat,
    cue: cues.map((c) => ({ n: c.n, mulaiFrame: c.mulaiFrame, akhirFrame: c.akhirFrame, adegan: c.adegan, penutur: c.penutur, karakter: c.karakter, cps: r3(c.cps), teks: c.baris.join(" / ") })),
    gagal: gagal.map((x) => ({ cue: x.n, kode: x.kode, pesan: x.pesan })),
    peringatan,
  };
  if (asrMesin || asrSegmen.length) {
    laporan.asr = { ...asrMesin, koreksiDtw: selaras.koreksi ?? KOREKSI_DTW_BAWAAN, ambangSkor: selaras.ambang ?? AMBANG_SKOR_BAWAAN, segmen: asrSegmen };
  }
  // berkas tambahan dari mesin (TTS: kredit dan label suara sintetis)
  let ekstra = null;
  if (typeof mesin.selesai === "function") {
    ekstra = await mesin.selesai({ naskah, segmen: segmen.map((s) => ({ id: s.id, adegan: s.adegan, sha256: s.sha256, info: s.info })) });
    if (ekstra.laporan) laporan.suara = ekstra.laporan;
  }
  return {
    cues, gagal, peringatan, laporan, kata: fileKata, rencana, info: ekstra?.info ?? [],
    berkas: {
      "caption.vtt": keVtt(cues, fps, penutur),
      "caption.srt": keSrt(cues, fps, penutur),
      "kata.json": tulisJson(fileKata),
      "rencana-audio.json": tulisJson(rencana),
      "laporan.json": tulisJson(laporan),
      ...(ekstra?.berkas ?? {}),
    },
  };
}

// ------------------------------------------------------------------ CLI
const PETUNJUK = `awvd narasi: naskah.json -> caption VTT/SRT, stempel kata, rencana audio

Pemakaian:
  bun scripts/narasi.mjs <naskah.json> [--out DIR] [--selaras whisper]
  bun scripts/narasi.mjs transkripsi <audio> [--out DIR]   (caption dari audio tanpa naskah; lihat transkripsi --bantuan)

Flag TTS (hanya untuk suara.mesin "sherpa-onnx"):
  --cache DIR        folder cache WAV beku (bawaan .cache/awvd/suara atau suara.cache di naskah)
  --sintesis-ulang   sintesis ulang semua kalimat dan ganti cache (suara berubah; bukan bawaan)

Penyelarasan:
  --selaras MODE     estimasi (bawaan) atau whisper (stempel kata dari whisper.cpp lokal; skor
                     penyelarasan rendah jatuh ke estimasi dengan peringatan)

${PETUNJUK_ASR}

Keluaran di DIR (bawaan out/narasi): caption.vtt, caption.srt, kata.json,
rencana-audio.json (masukan bun run audio), laporan.json; untuk TTS juga
suara-kredit.json dan kredit-suara.txt (label suara sintetis, wajib ditampilkan).
Berkas audio narasi (WAV) disebut di naskah dan dibaca apa adanya; mesin suara tidak
dipanggil saat render. Kode keluar: 0 berhasil, 1 lint gagal atau galat proses (termasuk
mesin TTS atau ASR yang diminta tidak terpasang), 2 naskah atau argumen tidak valid.`;

export async function utama(argv) {
  if (argv[0] === "transkripsi") return utamaTranskripsi(argv.slice(1));
  let nilai, posisi;
  try {
    ({ values: nilai, positionals: posisi } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" }, cache: { type: "string" }, "sintesis-ulang": { type: "boolean" }, selaras: { type: "string" }, ...OPSI_CLI_ASR, bantuan: { type: "boolean", short: "h" } } }));
  } catch (e) {
    console.error(`narasi: ${e.message}\n\n${PETUNJUK}`);
    return 2;
  }
  if (nilai.bantuan) { console.log(PETUNJUK); return 0; }
  if (posisi.length !== 1) { console.error(`narasi: butuh tepat satu <naskah.json>\n\n${PETUNJUK}`); return 2; }
  const jalur = resolve(posisi[0]);
  const modeSelaras = nilai.selaras ?? "estimasi";
  if (modeSelaras !== "estimasi" && modeSelaras !== "whisper") { console.error(`narasi: --selaras harus "estimasi" atau "whisper" (dapat ${JSON.stringify(nilai.selaras)})`); return 2; }
  let selaras = null;
  if (modeSelaras === "whisper") {
    try { selaras = { mode: "whisper", ...opsiAsrDariFlag(nilai) }; } catch (e) { console.error(`narasi: ${e.message}`); return 2; }
  } else if (["whisper-bin", "whisper-model", "cache-asr", "asr-ulang", "koreksi-asr"].some((k) => nilai[k] !== undefined)) {
    console.error("peringatan: flag ASR diabaikan tanpa --selaras whisper");
  }
  const { galat, peringatan, naskah, sha256 } = bacaNaskah(jalur);
  for (const p of peringatan) console.error(`peringatan: ${p}`);
  if (!naskah) {
    console.error(`naskah tidak valid (${galat.length} galat):`);
    for (const x of galat) console.error(`  - ${x}`);
    return 2;
  }
  const keluar = resolve(nilai.out ?? "out/narasi");
  let hasil;
  try {
    hasil = await buatNarasi(naskah, { dirKeluaran: keluar, sha256Naskah: sha256, opsiMesin: { cache: nilai.cache, sintesisUlang: nilai["sintesis-ulang"] === true }, selaras });
  } catch (e) {
    // galat mesin TTS atau ASR (tidak terpasang, gagal jalan, cache rusak) dilaporkan sebagai pesan, bukan jejak tumpukan
    console.error(`narasi: ${e.message}`);
    return 1;
  }
  mkdirSync(keluar, { recursive: true });
  for (const [nama, isi] of Object.entries(hasil.berkas)) writeFileSync(join(keluar, nama), isi);
  const r = hasil.laporan.ringkasan;
  console.log(`narasi: ${r.cue} cue, ${r.kata} kata, ${hasil.laporan.durasiFrame} frame pada ${naskah.fps} fps; cps maks ${r.cpsMaks} (batas ${naskah.batas.cps}), median ${r.cpsMedian}`);
  for (const p of hasil.peringatan) console.error(`peringatan: ${p}`);
  for (const x of hasil.info) console.log(`info: ${x}`);
  for (const x of hasil.gagal) console.error(`GAGAL${x.n ? ` cue ${x.n}` : ""}: ${x.pesan}`);
  console.log(`keluaran: ${keluar}`);
  return hasil.gagal.length ? 1 : 0;
}

if (import.meta.main) process.exit(await utama(process.argv.slice(2)));
