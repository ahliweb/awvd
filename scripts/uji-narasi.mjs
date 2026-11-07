#!/usr/bin/env bun
/**
 * uji-narasi.mjs — uji narasi.mjs (naskah.json -> cue, stempel kata, rencana audio).
 * Audio uji dibangkitkan skrip (nada sinus bergerak seperti ucapan, jeda diketahui) atau ffmpeg
 * lavfi lewat templat narasi-contoh; tanpa jaringan, tanpa aset pihak ketiga. Adaptor TTS
 * (sherpa-onnx) diuji dengan mesin palsu (skrip bun yang menulis nada); uji integrasi dengan
 * sherpa-onnx sungguhan hanya jalan bila AWVD_SHERPA_BIN dan AWVD_MODEL_SUPERTONIC3 diset,
 * selain itu dilewati.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-narasi.mjs
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bacaAudio, deteksiBicara, kataDariPenanda, selaraskanToken, sukuKata, tokenisasi } from "./narasi-selaras.mjs";
import { keSrt, keVtt, periksaCue, susunCue } from "./narasi-cue.mjs";
import { buatNarasi, daftarkanMesin, hapusMesin, validasiNaskah } from "./narasi.mjs";
import { isiPlaceholder, kanonik, kunciKalimat, muatSuara, periksaOov, validasiSuara } from "./narasi-tts.mjs";
import { normalisasiId, terbilang } from "./normalisasi-id.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const narasiMjs = join(akar, "scripts", "narasi.mjs");
const audioMjs = join(akar, "scripts", "audio.mjs");
const templat = join(akar, "templates", "narasi-contoh");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-narasi-"));
const j = (...p) => join(tmp, ...p);

// ---- runtime.js (UMD, butuh window sementara) untuk parseVtt/parseSrt/captionAktif
function muatRuntime() {
  const sebelum = globalThis.window;
  globalThis.window = { location: { search: "" } };
  try { return createRequire(import.meta.url)(join(akar, "scripts", "runtime.js")); } finally {
    if (sebelum === undefined) delete globalThis.window; else globalThis.window = sebelum;
  }
}
const { parseVtt, parseSrt, captionAktif } = muatRuntime();

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function samaDengan(nyata, harapan, nama) {
  const a = JSON.stringify(nyata), b = JSON.stringify(harapan);
  tegas(a === b, `${nama}: dapat ${a}, harapan ${b}`);
}
function dekat(nyata, harapan, eps, nama) {
  tegas(Math.abs(nyata - harapan) <= eps, `${nama}: dapat ${nyata}, harapan ${harapan} (+-${eps})`);
}
function memuat(teks, potongan, nama) {
  tegas(String(teks).includes(potongan), `${nama}: "${potongan}" tidak ada dalam:\n${teks}`);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const bun = (...a) => jalankan(["bun", ...a]);
const salin = (o) => JSON.parse(JSON.stringify(o));
const bacaJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** WAV PCM 16-bit mono: lari [["b"|"s", detik]...]; "b" = nada 200 Hz bertremolo 4 Hz, "s" = nol digital. */
function buatWav(jalur, lari, sr = 16000) {
  const n = lari.reduce((a, [, d]) => a + Math.round(d * sr), 0);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  let i = 0;
  for (const [jenis, d] of lari) {
    const m = Math.round(d * sr);
    for (let k = 0; k < m; k++, i++) {
      const t = k / sr;
      const v = jenis === "b" ? 0.3 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 200 * t) : 0;
      b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
  }
  writeFileSync(jalur, b);
  return jalur;
}

/** Kata sintetis berstempel tetap: tiap kata `dt` detik, berurutan, tanpa jeda. */
function kataSintetik(kalimat, { mulai = 0, dt = 0.4, adegan = "a", penutur = "narator" } = {}) {
  const hasil = [];
  let t = mulai;
  kalimat.forEach((teks, ki) => {
    const tok = tokenisasi(teks);
    tok[tok.length - 1].tp = "titik";
    for (const k of tok) {
      hasil.push({ ...k, mulai: t, akhir: t + dt, adegan, kalimat: ki, penutur });
      t += dt;
    }
  });
  return hasil;
}

const naskahDasar = (berkas) => ({
  versi: 1, fps: 30, klasifikasi: "publik",
  adegan: [{ id: "a1", berkas, kalimat: [{ teks: "Halo semua, selamat datang." }, { teks: "Kita mulai hari ini dengan tenang." }] }],
});

const uji = [];
const tes = (nama, fn) => uji.push([nama, fn]);
class Lewati extends Error {}

// ------------------------------------------------------------------ teks
tes("sukuKata dan tokenisasi", () => {
  samaDengan([sukuKata("meja"), sukuKata("merapikan"), sukuKata("pantai"), sukuKata("di")], [2, 4, 2, 1], "suku kata");
  const tok = tokenisasi('Halo, "dunia" — ya. ... Selesai!');
  samaDengan(tok.map((t) => t.teks), ["Halo", "dunia", "ya", "Selesai"], "inti token");
  samaDengan(tok.map((t) => t.tp), ["koma", "", "titik", "titik"], "tanda baca token");
  samaDengan(tok.map((t) => t.tampil).join(" "), 'Halo, "dunia" — ya. ... Selesai!', "tidak ada teks hilang");
});

// ------------------------------------------------------------------ audio dan jeda
tes("deteksiBicara: jeda tepat, senyap total, ucapan menerus, WAV non-PCM16", async () => {
  const w = bacaAudio(buatWav(j("jeda.wav"), [["b", 0.8], ["s", 0.5], ["b", 1.0], ["s", 0.2], ["b", 0.6]]));
  const sp = deteksiBicara(await w);
  samaDengan(sp.jeda.length, 2, "jumlah jeda");
  dekat(sp.jeda[0].a, 0.8, 0.04, "jeda 1 mulai"); dekat(sp.jeda[0].b, 1.3, 0.04, "jeda 1 akhir");
  dekat(sp.jeda[1].a, 2.3, 0.04, "jeda 2 mulai"); dekat(sp.jeda[1].b, 2.5, 0.04, "jeda 2 akhir");
  const senyap = deteksiBicara(await bacaAudio(buatWav(j("senyap.wav"), [["s", 2]])));
  samaDengan(senyap.ada, false, "senyap total tidak dianggap ucapan");
  const terus = deteksiBicara(await bacaAudio(buatWav(j("terus.wav"), [["b", 2]])));
  samaDengan([terus.ada, terus.jeda.length], [true, 0], "ucapan menerus tanpa jeda");
  const f = j("float.wav");
  const r = await jalankan(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=1:sample_rate=44100", "-c:a", "pcm_f32le", f]);
  samaDengan(r.kode, 0, `ffmpeg float (${r.err})`);
  const a = await bacaAudio(f);
  samaDengan(a.sr, 16000, "WAV float didekode ke 16 kHz");
  dekat(a.durasi, 1, 0.01, "durasi WAV float");
  let lempar = false;
  try { await bacaAudio(j("tidak-ada.wav")); } catch { lempar = true; }
  tegas(lempar, "berkas tak ada harus melempar galat");
});

tes("selaraskanToken: jangkar di jeda nyata, tahan jeda palsu dan jeda hilang", async () => {
  const tok = tokenisasi("Halo semua, selamat datang. Kita mulai hari ini dengan tenang.");
  const kal = { awal: 0.1, akhir: 0.04 };
  // jeda sesuai tanda baca: koma 0,3 s dan titik 0,7 s
  const ideal = await bacaAudio(buatWav(j("ideal.wav"), [["b", 1.0], ["s", 0.3], ["b", 1.3], ["s", 0.7], ["b", 2.6]]));
  const a = selaraskanToken(tok, ideal, { kalibrasi: kal });
  samaDengan([a.jangkar, a.titikJangkar], [2, 2], "dua tanda baca terjangkar");
  const idxTitik = tok.findIndex((t) => t.tp === "titik");
  const batas = (a.kata[idxTitik].akhir + a.kata[idxTitik + 1].mulai) / 2;
  tegas(batas > 2.6 && batas < 3.3, `batas kalimat ${batas} harus di dalam jeda 2,6..3,3 s`);
  for (let i = 1; i < a.kata.length; i++) tegas(a.kata[i].mulai >= a.kata[i - 1].mulai && a.kata[i].akhir >= a.kata[i].mulai, `stempel monoton di kata ${i}`);
  tegas(a.kata.at(-1).akhir <= ideal.durasi + 0.05, "kata terakhir tidak melewati durasi audio");
  // jeda palsu 0,2 s di tengah klausa: batas kalimat tetap di jeda panjang
  const palsu = await bacaAudio(buatWav(j("palsu.wav"), [["b", 0.6], ["s", 0.2], ["b", 0.4], ["s", 0.3], ["b", 1.3], ["s", 0.7], ["b", 2.6]]));
  const p = selaraskanToken(tok, palsu, { kalibrasi: kal });
  const bp = (p.kata[idxTitik].akhir + p.kata[idxTitik + 1].mulai) / 2;
  tegas(bp > 2.8 && bp < 3.5, `dengan jeda palsu, batas kalimat ${bp} tetap di jeda 2,8..3,5 s`);
  // jeda koma hilang (hanya jeda kalimat): tidak melempar, batas kalimat tetap terjangkar
  const kurang = await bacaAudio(buatWav(j("kurang.wav"), [["b", 2.3], ["s", 0.7], ["b", 2.6]]));
  const k = selaraskanToken(tok, kurang, { kalibrasi: kal });
  samaDengan(k.jangkar, 1, "hanya batas kalimat terjangkar");
  const bk = (k.kata[idxTitik].akhir + k.kata[idxTitik + 1].mulai) / 2;
  tegas(bk > 2.3 && bk < 3.0, `batas kalimat ${bk} di jeda 2,3..3,0 s`);
  // tanpa jeda sama sekali: pembagian proporsional, tanpa galat
  const rata = await bacaAudio(buatWav(j("rata.wav"), [["b", 4]]));
  const r = selaraskanToken(tok, rata, { kalibrasi: kal });
  samaDengan(r.jangkar, 0, "tanpa jeda: tanpa jangkar");
  samaDengan(r.kata.length, tok.length, "semua kata tetap berstempel");
  // kalimat pendek dilafalkan cepat, kalimat panjang lambat: bobot kata saja meleset, jangkar jeda tidak
  const tok2 = tokenisasi("Halo semua. Kita mulai hari ini dengan tenang sekali.");
  const timpang = await bacaAudio(buatWav(j("timpang.wav"), [["b", 0.8], ["s", 0.7], ["b", 4.0]]));
  const t2 = selaraskanToken(tok2, timpang, { kalibrasi: kal });
  const i2 = tok2.findIndex((t) => t.tp === "titik");
  const b2 = (t2.kata[i2].akhir + t2.kata[i2 + 1].mulai) / 2;
  dekat(b2, 1.15, 0.1, "batas kalimat di tengah jeda 0,8..1,5 s");
  const p2 = selaraskanToken(tok2, timpang, { mode: "proporsional", kalibrasi: kal });
  const pb2 = (p2.kata[i2].akhir + p2.kata[i2 + 1].mulai) / 2;
  tegas(Math.abs(pb2 - 1.15) > 0.2, `kontrol: pembagian proporsional murni meleset dari tengah jeda (${pb2})`);
  // masukan sama menghasilkan keluaran persis sama
  samaDengan(selaraskanToken(tok, ideal, { kalibrasi: kal }).kata, a.kata, "deterministik");
});

tes("kataDariPenanda: hanya bila jumlah sama dan monoton", () => {
  const tok = tokenisasi("Satu dua tiga.");
  const ok = kataDariPenanda(tok, [{ teks: "Satu", mulai: 0, durasi: 0.3 }, { teks: "dua", mulai: 0.4, durasi: 0.3 }, { teks: "tiga", mulai: 0.8, durasi: 0.4 }]);
  samaDengan(ok.map((k) => [k.mulai, +k.akhir.toFixed(3)]), [[0, 0.3], [0.4, 0.7], [0.8, 1.2]], "stempel penanda");
  samaDengan(kataDariPenanda(tok, [{ mulai: 0, durasi: 1 }]), null, "jumlah beda");
  samaDengan(kataDariPenanda(tok, [{ mulai: 0.5, durasi: 1 }, { mulai: 0.1, durasi: 1 }, { mulai: 0.9, durasi: 1 }]), null, "tidak monoton");
});

// ------------------------------------------------------------------ cue
tes("susunCue: baris, celah, tanpa tumpang tindih, kalimat dan klausa", () => {
  const kata = kataSintetik([
    "Selamat datang di panduan singkat merapikan meja kerja.",
    "Pertama, singkirkan semua barang yang tidak dipakai hari ini.",
    "Ya.",
  ], { dt: 0.5 });
  const opsi = { fps: 30, cps: 17, totalFrame: 1000 };
  const cues = susunCue(kata, opsi);
  tegas(cues.length >= 3, `cue terlalu sedikit: ${cues.length}`);
  samaDengan(periksaCue(cues, opsi).filter((c) => c.tingkat === "gagal"), [], "tanpa gagal");
  for (const c of cues) {
    tegas(c.baris.length <= 2 && c.baris.every((b) => Array.from(b).length <= 42), `baris cue ${c.n} melebihi batas`);
    tegas(c.akhirFrame > c.mulaiFrame, `cue ${c.n} berdurasi positif`);
  }
  // tidak ada teks hilang: gabungan semua cue = seluruh kata
  samaDengan(cues.flatMap((c) => c.indeks), kata.map((_, i) => i), "setiap kata di tepat satu cue");
  // sisa kalimat tidak yatim satu kata
  tegas(!periksaCue(cues, opsi).some((c) => c.kode === "yatim"), "tidak ada cue yatim");
  // satu kata "Ya." diperpanjang sampai durasi minimum 5/6 s (ruang tersedia)
  const ya = cues.at(-1);
  tegas((ya.akhirFrame - ya.mulaiFrame) / 30 >= 5 / 6 - 1e-9, "cue pendek diperpanjang ke durasi minimum");
});

tes("susunCue: cue berikut membatasi perpanjangan; adegan membatasi cue terakhir", () => {
  const a = kataSintetik(["Dua kata."], { dt: 0.2, mulai: 0 });
  const b = kataSintetik(["Lanjut lagi."], { dt: 0.2, mulai: 0.6, adegan: "b" });
  const cues = susunCue([...a, ...b], { fps: 30, totalFrame: 300, akhirAdegan: { a: 20, b: 40 } });
  samaDengan(cues.length, 2, "dua cue");
  tegas(cues[0].akhirFrame <= cues[1].mulaiFrame - 2, "celah minimum 2 frame ke cue berikut");
  tegas(cues[0].akhirFrame <= 20 && cues[1].akhirFrame <= 40, "tidak melewati akhir adegan");
});

tes("susunCue: penutur memecah cue, label dan italik", () => {
  const penutur = { narator: { nama: "Narator", italik: true, label: false }, budi: { nama: "Pak Budi", italik: false, label: true } };
  const k1 = kataSintetik(["Selamat datang semuanya."], { dt: 0.3, penutur: "narator" });
  const k2 = kataSintetik(["Terima kasih sudah hadir."], { dt: 0.3, mulai: 3, penutur: "budi" });
  const k3 = kataSintetik(["Mari kita mulai."], { dt: 0.3, mulai: 6, penutur: "budi" }).map((k) => ({ ...k, kalimat: 1 }));
  const kata = [...k1, ...k2, ...k3];
  const cues = susunCue(kata, { fps: 30, penutur, totalFrame: 1000 });
  samaDengan(cues.map((c) => c.penutur), ["narator", "budi", "budi"], "penutur per cue");
  memuat(cues[1].teks, "[Pak Budi] Terima", "label di awal giliran");
  tegas(!cues[2].teks.includes("[Pak Budi]"), "tanpa label berulang pada penutur yang sama");
  const vtt = keVtt(cues, 30, penutur);
  memuat(vtt, "<i>Selamat datang semuanya.</i>", "italik narator");
  tegas(!vtt.includes("<i>[Pak Budi]"), "penutur non-italik");
  memuat(keSrt(cues, 30, penutur), "00:00:00,000 --> ", "SRT memakai koma");
});

tes("periksaCue: cps melebihi batas gagal, tidak disembunyikan", () => {
  // 60 karakter dalam 2 s = 30 cps, tanpa ruang perpanjangan (cue berikut menempel)
  const cepat = kataSintetik(["Ini kalimat yang sangat cepat sekali diucapkan oleh narator."], { dt: 0.17 });
  const lain = kataSintetik(["Lanjut."], { dt: 0.4, mulai: 2.0 });
  const opsi = { fps: 30, cps: 17, totalFrame: 500 };
  const cues = susunCue([...cepat, ...lain], opsi);
  const lint = periksaCue(cues, opsi);
  tegas(lint.some((c) => c.tingkat === "gagal" && c.kode === "cps"), `cps tinggi harus gagal: ${JSON.stringify(lint)}`);
  // batas profil lebih longgar meloloskan teks yang sama
  samaDengan(periksaCue(cues, { ...opsi, cps: 40 }).filter((c) => c.kode === "cps"), [], "batas longgar");
  // pemeriksa mandiri mendeteksi tumpang tindih dan celah
  const rusak = salin(cues);
  rusak[1].mulaiFrame = rusak[0].akhirFrame - 1;
  tegas(periksaCue(rusak, opsi).some((c) => c.kode === "tumpang-tindih"), "tumpang tindih terdeteksi");
  rusak[1].mulaiFrame = rusak[0].akhirFrame;
  tegas(periksaCue(rusak, opsi).some((c) => c.kode === "celah"), "celah kurang terdeteksi");
});

tes("susunCue: deterministik dan keluaran VTT/SRT terbaca runtime.js", () => {
  const kata = kataSintetik(["Selamat datang di panduan singkat merapikan meja kerja.", "Pertama, singkirkan barang yang tak dipakai."], { dt: 0.33, mulai: 0.3 });
  const opsi = { fps: 30, totalFrame: 600 };
  const a = susunCue(kata, opsi), b = susunCue(kata, opsi);
  samaDengan(a, b, "dua panggilan identik");
  const vtt = keVtt(a, 30), srt = keSrt(a, 30);
  const pv = parseVtt(vtt), ps = parseSrt(srt);
  samaDengan(pv.length, a.length, "jumlah cue VTT");
  samaDengan(ps.length, a.length, "jumlah cue SRT");
  a.forEach((c, i) => {
    dekat(pv[i].mulai, c.mulaiFrame / 30, 0.0006, `mulai VTT ${i}`);
    dekat(ps[i].akhir, c.akhirFrame / 30, 0.0006, `akhir SRT ${i}`);
    samaDengan(pv[i].teks, c.baris.join("\n"), `teks VTT ${i}`);
    samaDengan(ps[i].teks, c.baris.join("\n"), `teks SRT ${i}`);
    samaDengan(captionAktif(pv, c.mulaiFrame + 1, 30)?.teks, c.baris.join("\n"), `captionAktif cue ${i}`);
  });
  // karakter & dalam VTT di-escape, di SRT tidak
  const amp = susunCue(kataSintetik(["Tom & Jerry bermain."]), { fps: 30, totalFrame: 100 });
  memuat(keVtt(amp, 30), "Tom &amp; Jerry", "escape VTT");
  samaDengan(parseVtt(keVtt(amp, 30))[0].teks, "Tom & Jerry bermain.", "VTT bolak-balik");
  memuat(keSrt(amp, 30), "Tom & Jerry", "SRT apa adanya");
});

// ------------------------------------------------------------------ skema naskah
tes("validasiNaskah: penolakan dan normalisasi", () => {
  const wav = buatWav(j("sk.wav"), [["b", 1]]);
  const dasar = naskahDasar(wav);
  const v0 = validasiNaskah(dasar, tmp);
  samaDengan(v0.galat, [], "naskah dasar sah");
  samaDengan([v0.naskah.batas.cps, v0.naskah.batas.maksKarakter, v0.naskah.suara.mesin], [17, 42, "berkas-beku"], "bawaan");
  const galat = (mut, potongan, nama) => {
    const n = salin(dasar); mut(n);
    const v = validasiNaskah(n, tmp);
    tegas(v.naskah === null && v.galat.length > 0, `${nama}: seharusnya ditolak`);
    memuat(v.galat.join("\n"), potongan, nama);
  };
  galat((n) => { n.versi = 2; }, "versi harus 1", "versi");
  galat((n) => { n.fps = 0; }, "fps", "fps nol");
  galat((n) => { n.fps = 29.97; }, "fps", "fps pecahan");
  galat((n) => { delete n.klasifikasi; }, "klasifikasi", "klasifikasi hilang");
  galat((n) => { n.audiens = ["tidak-ada"]; }, "audiens", "profil audiens tak dikenal");
  galat((n) => { n.adegan = []; }, "adegan", "adegan kosong");
  galat((n) => { n.adegan.push(salin(n.adegan[0])); }, "ganda", "id ganda");
  galat((n) => { n.adegan[0].kalimat[0].teks = "Harganya 5000 rupiah."; }, "angka", "angka di teks");
  galat((n) => { n.adegan[0].kalimat[0].teks = "a < b"; }, "<", "tanda kurung sudut");
  galat((n) => { n.adegan[0].kalimat[0].penutur = "hantu"; }, "penutur", "penutur tak dikenal");
  galat((n) => { n.adegan[0].berkas = j("tidak-ada.wav"); }, "tidak ditemukan", "WAV hilang");
  galat((n) => { delete n.adegan[0].berkas; }, "berkas wajib", "mesin beku tanpa berkas");
  galat((n) => { n.adegan[0].kalimat[0].berkas = wav; }, "sekaligus", "berkas di adegan dan kalimat");
  galat((n) => { delete n.adegan[0].berkas; n.adegan[0].kalimat[0].berkas = wav; }, "SEMUA", "berkas kalimat sebagian");
  galat((n) => { n.suara = { mesin: "tidak-ada" }; }, "tidak dikenal", "mesin tak dikenal");
  galat((n) => { n.suara = { kalibrasi: { awal: 2 } }; }, "kalibrasi", "kalibrasi di luar rentang");
  galat((n) => { n.caption = { cps: 25 }; }, "caption.cps", "cps di atas 20");
  galat((n) => { n.caption = { maksBaris: 9 }; }, "maksBaris", "baris terlalu banyak");
  // bacaan membolehkan angka pada teks tampilan
  const n1 = salin(dasar);
  n1.adegan[0].kalimat[0] = { teks: "Harganya Rp5.000.", bacaan: "Harganya lima ribu rupiah." };
  samaDengan(validasiNaskah(n1, tmp).galat, [], "bacaan membolehkan angka di teks");
  // profil audiens menurunkan batas cps; override lebih longgar hanya memperingatkan
  const n2 = salin(dasar); n2.audiens = ["anak"];
  samaDengan(validasiNaskah(n2, tmp).naskah.batas.cps, 13, "cps profil anak");
  n2.audiens = ["umum", "lowVision"];
  samaDengan(validasiNaskah(n2, tmp).naskah.batas.cps, 13, "profil terketat menang");
  n2.caption = { cps: 17 };
  const v2 = validasiNaskah(n2, tmp);
  samaDengan(v2.naskah.batas.cps, 17, "override dipakai");
  memuat(v2.peringatan.join("\n"), "lebih longgar", "peringatan melonggarkan profil");
  // layar potret memakai 28 karakter per baris
  const n3 = salin(dasar); n3.ukuran = { lebar: 1080, tinggi: 1920 };
  samaDengan(validasiNaskah(n3, tmp).naskah.batas.maksKarakter, 28, "potret 28 karakter");
  // kunci tak dikenal hanya diperingatkan
  const n4 = salin(dasar); n4.zonaCaption = [];
  memuat(validasiNaskah(n4, tmp).peringatan.join("\n"), "zonaCaption", "kunci tak dikenal");
});

// ------------------------------------------------------------------ mesin pluggable
tes("mesin suara: klasifikasi internal menolak daring; penanda dipakai bila cocok", async () => {
  const wav = buatWav(j("mesin.wav"), [["b", 0.9], ["s", 0.3], ["b", 1.2], ["s", 0.7], ["b", 2.2]]);
  const penandaBenar = "Halo semua, selamat datang. Kita mulai hari ini dengan tenang.".split(" ")
    .map((t, i) => ({ teks: t, mulai: 0.3 * i, durasi: 0.25 }));
  let penanda = penandaBenar;
  daftarkanMesin("tts-uji", { daring: true, async sintesis() { return { berkas: wav, penanda }; } });
  try {
    const n = { ...salin(naskahDasar(wav)), suara: { mesin: "tts-uji" } };
    delete n.adegan[0].berkas;
    n.klasifikasi = "internal";
    const tolak = validasiNaskah(n, tmp);
    memuat(tolak.galat.join("\n"), "daring", "internal menolak mesin daring");
    n.klasifikasi = "publik";
    const v = validasiNaskah(n, tmp);
    samaDengan(v.galat, [], "publik menerima mesin daring");
    let h = await buatNarasi(v.naskah, { dirKeluaran: tmp });
    samaDengan(h.kata.sumber, "penanda-tts", "sumber waktu dari penanda");
    dekat(h.kata.kata[1].mulai, 0.3 + 0.3, 0.001, "stempel kata dari penanda (offset jedaAwal)");
    penanda = penandaBenar.slice(0, 3);
    h = await buatNarasi(v.naskah, { dirKeluaran: tmp });
    samaDengan(h.kata.sumber, "estimasi", "penanda tak cocok: jatuh ke estimasi");
    memuat(h.peringatan.join("\n"), "penanda", "peringatan penanda tak cocok");
  } finally { hapusMesin("tts-uji"); }
  tegas(!validasiNaskah({ ...naskahDasar(wav), suara: { mesin: "tts-uji" } }, tmp).naskah, "mesin dihapus dari registri");
});

// ------------------------------------------------------------------ templat narasi-contoh
tes("templat narasi-contoh: cps, batas di jeda, deterministik, rencana audio dapat dirakit", async () => {
  const asetDir = j("contoh", "aset");
  let r = await bun(join(templat, "buat-audio.mjs"), asetDir);
  samaDengan(r.kode, 0, `buat-audio exit (${r.err})`);
  const naskah = readFileSync(join(templat, "naskah.json"), "utf8").replaceAll("../../.cache/awvd/narasi-contoh", "aset");
  writeFileSync(j("contoh", "naskah.json"), naskah);
  const out1 = j("contoh", "keluar-1"), out2 = j("contoh", "keluar-2");
  r = await bun(narasiMjs, j("contoh", "naskah.json"), "--out", out1);
  samaDengan(r.kode, 0, `narasi exit (${r.err})`);
  r = await bun(narasiMjs, j("contoh", "naskah.json"), "--out", out2);
  samaDengan(r.kode, 0, `narasi exit ke-2 (${r.err})`);

  // AC3: masukan sama menghasilkan keluaran sama (byte demi byte)
  for (const f of ["caption.vtt", "caption.srt", "kata.json", "rencana-audio.json", "laporan.json"]) {
    tegas(existsSync(join(out1, f)), `${f} tidak ditulis`);
    tegas(readFileSync(join(out1, f), "utf8") === readFileSync(join(out2, f), "utf8"), `${f} berbeda antar dua jalan`);
  }

  // AC1: tiap cue tidak melampaui batas cps profil audiens (dihitung ulang dari VTT, bukan dari laporan)
  const dataAud = bacaJson(join(akar, "data", "audiens.json"));
  const batasCps = dataAud.profil.umum.nilai.cps;
  const laporan = bacaJson(join(out1, "laporan.json"));
  samaDengan(laporan.audiens.cps, batasCps, "batas cps laporan = profil umum");
  const cues = parseVtt(readFileSync(join(out1, "caption.vtt"), "utf8"));
  samaDengan(cues.length, 5, "jumlah cue templat");
  for (const [i, c] of cues.entries()) {
    const cps = Array.from(c.teks.replace(/\n/g, " ")).length / (c.akhir - c.mulai);
    tegas(cps <= batasCps + 0.05, `cue ${i + 1}: ${cps.toFixed(2)} cps melebihi ${batasCps}`);
    tegas(c.teks.split("\n").length <= 2 && c.teks.split("\n").every((b) => Array.from(b).length <= 42), `cue ${i + 1}: baris melebihi batas`);
  }
  samaDengan(laporan.ringkasan.gagal, 0, "laporan tanpa gagal");

  // AC2: batas antar cue jatuh di jeda senyap. Jeda dihitung ulang dari audio (bukan dari laporan):
  // jeda internal tiap WAV, ditambah celah garis waktu di antara WAV dan di ujung adegan.
  const rencana = bacaJson(join(out1, "rencana-audio.json"));
  const senyap = [];
  let akhirSebelum = 0;
  for (const s of rencana.narasi) {
    const a = await bacaAudio(join(out1, s.berkas));
    const off = s.mulai / 30;
    senyap.push([akhirSebelum, off]);
    for (const g of deteksiBicara(a).jeda) senyap.push([off + g.a, off + g.b]);
    akhirSebelum = off + a.durasi;
  }
  for (let i = 0; i + 1 < cues.length; i++) {
    const tengah = (cues[i].akhir + cues[i + 1].mulai) / 2;
    tegas(senyap.some(([a, b]) => tengah >= a - 1 / 30 && tengah <= b + 1 / 30), `batas cue ${i + 1}/${i + 2} (${tengah.toFixed(2)} s) tidak jatuh di jeda senyap`);
    tegas(cues[i + 1].mulai > cues[i].akhir, `cue ${i + 1} dan ${i + 2} tidak tumpang tindih`);
  }
  // batas kalimat dan segmen di laporan semuanya di jeda
  tegas(laporan.batasKalimat.length >= 4 && laporan.batasKalimat.every((b) => b.diJeda), "semua batas kalimat dan segmen di jeda");
  // jangkar: tiap tanda baca di a1 (dua titik, dua koma) terpasang ke jeda nyata
  const segA1 = laporan.segmen.find((s) => s.id === "a1");
  samaDengan([segA1.jangkar.terpasang, segA1.jangkar.tanda], [4, 4], "jangkar a1");

  // kata.json: monoton dan konsisten dengan cue
  const kata = bacaJson(join(out1, "kata.json"));
  samaDengan(kata.fps, 30, "fps kata.json");
  for (let i = 1; i < kata.kata.length; i++) tegas(kata.kata[i].mulaiFrame >= kata.kata[i - 1].mulaiFrame, `kata ${i} monoton`);
  tegas(kata.kata.every((k) => k.cue >= 1 && k.cue <= cues.length && k.akhirFrame > k.mulaiFrame && k.akhirFrame <= kata.durasiFrame + 1), "kata.json: cue dan frame sah");
  samaDengan(kata.kata[0].mulaiFrame, 9, "kata pertama mulai di jedaAwal 0,3 s");

  // rencana-audio.json dapat dirakit audio.mjs tanpa perubahan; durasi = durasiFrame
  r = await bun(audioMjs, join(out1, "rencana-audio.json"), "--fps", "30", "--out", j("contoh", "campuran.wav"));
  samaDengan(r.kode, 0, `audio.mjs exit (${r.err}${r.out})`);
  const dur = await jalankan(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", j("contoh", "campuran.wav")]);
  dekat(Number(dur.out.trim()), rencana.durasiFrame / 30, 0.05, "durasi audio campuran = durasi garis waktu");

  // batas profil lebih ketat (anak, 13 cps) membuat templat gagal dengan pesan cps dan kode keluar 1
  const ketat = JSON.parse(naskah); ketat.audiens = ["anak"];
  writeFileSync(j("contoh", "naskah-ketat.json"), JSON.stringify(ketat));
  r = await bun(narasiMjs, j("contoh", "naskah-ketat.json"), "--out", j("contoh", "keluar-ketat"));
  samaDengan(r.kode, 1, "cps melebihi profil anak harus kode keluar 1");
  memuat(r.err, "cps melebihi batas 13", "pesan cps");
  tegas(existsSync(j("contoh", "keluar-ketat", "laporan.json")), "laporan tetap ditulis saat lint gagal");
  tegas(bacaJson(j("contoh", "keluar-ketat", "laporan.json")).gagal.length > 0, "laporan memuat butir gagal");
});

tes("CLI: kode keluar 2 untuk argumen dan naskah tidak valid, bantuan kode 0", async () => {
  let r = await bun(narasiMjs);
  samaDengan(r.kode, 2, "tanpa argumen");
  r = await bun(narasiMjs, "--bantuan");
  samaDengan(r.kode, 0, "bantuan");
  memuat(r.out, "naskah.json", "teks bantuan");
  r = await bun(narasiMjs, j("tidak-ada.json"));
  samaDengan(r.kode, 2, "naskah tidak ada");
  writeFileSync(j("rusak.json"), "{ bukan json");
  r = await bun(narasiMjs, j("rusak.json"));
  samaDengan(r.kode, 2, "naskah bukan JSON");
  writeFileSync(j("salah.json"), JSON.stringify({ versi: 9 }));
  r = await bun(narasiMjs, j("salah.json"));
  samaDengan(r.kode, 2, "naskah tidak sah");
  memuat(r.err, "versi harus 1", "pesan galat versi");
  r = await bun(narasiMjs, j("salah.json"), "--tidak-ada");
  samaDengan(r.kode, 2, "flag tak dikenal");
  // audio senyap digagalkan dengan pesan jelas (bukan cue kosong)
  const sunyi = buatWav(j("sunyi.wav"), [["s", 2]]);
  writeFileSync(j("sunyi.json"), JSON.stringify(naskahDasar(sunyi)));
  r = await bun(narasiMjs, j("sunyi.json"), "--out", j("keluar-sunyi"));
  samaDengan(r.kode, 1, "audio senyap");
  memuat(r.err, "tidak ada ucapan terdeteksi", "pesan senyap");
});


// ------------------------------------------------------------------ normalisasi teks Indonesia
tes("normalisasiId: tanggal, jam, rupiah, pasal, URL, surel, angka, singkatan; tanpa angka tersisa", () => {
  const kasus = [
    ["Rp1.500.000 untuk 2 hari", "satu juta lima ratus ribu rupiah untuk dua hari"],
    ["Rp 5 juta dan Rp5.000", "lima juta rupiah dan lima ribu rupiah"],
    ["Pada 12/03/2026 pukul 08.30 WIB.", "Pada dua belas Maret dua ribu dua puluh enam pukul delapan lewat tiga puluh menit Waktu Indonesia Barat."],
    ["Terbit 2026-03-12.", "Terbit dua belas Maret dua ribu dua puluh enam."],
    ["Pasal 5 ayat (2) UU No. 27 Tahun 2022", "Pasal lima ayat dua Undang-Undang Nomor dua puluh tujuh Tahun dua ribu dua puluh dua"],
    ["Di Jl. Merdeka No. 10, dr. Ani.", "Di Jalan Merdeka Nomor sepuluh, dokter Ani."],
    ["Naik 12,5% dan ke-3, ke-1, 5-10 orang, suhu -5.", "Naik dua belas koma lima persen dan ketiga, pertama, lima sampai sepuluh orang, suhu minus lima."],
    ["Berat 5 kg, jarak 3,5 km, file 20 MB.", "Berat lima kilogram, jarak tiga koma lima kilometer, file dua puluh megabyte."],
    ["Hubungi 0812-3456-7890.", "Hubungi nol delapan satu dua tiga empat lima enam tujuh delapan sembilan nol."],
    ["Buka https://contoh.example.com/panduan/awal-1 sekarang.", "Buka contoh titik example titik com garis miring panduan garis miring awal strip satu sekarang."],
    ["Surel info@contoh.example.com.", "Surel info at contoh titik example titik com."],
    ["Isi SOP dan PDF; 4G dan A4.", "Isi es o pe dan pe de ef; empat G dan A empat."],
    ["10.30 saja dan 15.000 orang, kode 007.", "sepuluh koma tiga nol saja dan lima belas ribu orang, kode nol nol tujuh."],
    ["Pukul 9.15 dan jam 10:05.", "Pukul sembilan lewat lima belas menit dan jam sepuluh lewat lima menit."],
  ];
  for (const [masuk, harapan] of kasus) samaDengan(normalisasiId(masuk), harapan, `normalisasi "${masuk}"`);
  for (const [masuk] of kasus) {
    const k = normalisasiId(masuk);
    tegas(!/\d/.test(k), `angka tersisa: ${k}`);
    samaDengan(normalisasiId(k), k, `idempoten "${masuk}"`);
  }
  samaDengan(normalisasiId("Proyek AWX selesai", { kamus: { AWX: "a we ix" } }), "Proyek a we ix selesai", "kamus pengguna");
});

tes("terbilang: batas satuan, belasan, ribuan, juta, dan di atas 10^15 dieja per digit", () => {
  const t = { 0: "nol", 11: "sebelas", 12: "dua belas", 100: "seratus", 111: "seratus sebelas", 1000: "seribu", 1001: "seribu satu", 2026: "dua ribu dua puluh enam", 1000000: "satu juta", 1500000: "satu juta lima ratus ribu" };
  for (const [n, harapan] of Object.entries(t)) samaDengan(terbilang(n), harapan, `terbilang ${n}`);
  samaDengan(terbilang("1234567890123456"), "satu dua tiga empat lima enam tujuh delapan sembilan nol satu dua tiga empat lima enam", "di atas batas dieja per digit");
  let lempar = false;
  try { terbilang("12a"); } catch { lempar = true; }
  tegas(lempar, "bukan bilangan harus melempar galat");
});

// ------------------------------------------------------------------ adaptor TTS (mesin palsu)
const bawaan = muatSuara(join(akar, "data", "suara.json"));
tes("data/suara.json: skema sah, 9 karakter id dan 6 en, lisensi dan syarat tercatat, tanpa orang nyata", () => {
  samaDengan(bawaan.galat, [], "galat suara.json bawaan");
  const k = Object.values(bawaan.data.karakter);
  samaDengan([k.filter((x) => x.bahasa === "id").length, k.filter((x) => x.bahasa === "en").length], [9, 6], "jumlah karakter id dan en");
  tegas(k.every((x) => x.orangNyata === false), "karakter bawaan tidak boleh meniru orang nyata");
  const st = bawaan.data.mesin.supertonic3;
  tegas(st.larangMedis === true && /OpenRAIL-M/.test(st.lisensiBobot), "Supertonic harus bertanda larangMedis dan lisensi OpenRAIL-M");
  tegas(st.syaratPakai.some((x) => /sintetis/.test(x)) && st.syaratPakai.some((x) => /medis/.test(x)), "syarat pakai memuat label sintetis dan larangan medis");
  samaDengan(bawaan.data.mesin.kokoro.larangMedis, false, "Kokoro (Apache-2.0) tanpa larangan medis");
  tegas(Object.values(bawaan.data.mesin).every((m) => m.daring === false && m.perintah[0] === "sherpa-onnx-offline-tts"), "mesin bawaan lokal");
});

tes("validasiSuara: menolak placeholder asing, perintah tanpa {teks}, karakter tak berdasar, orangNyata tanpa izin", () => {
  const dasar = () => salin({ versi: 1, mesin: { m: { perintah: ["bin", "--o={keluaran}", "{teks}"], versi: "1", lisensiKode: "MIT", lisensiBobot: "MIT", sumber: "x", syaratPakai: [] } },
    karakter: { a: { nama: "A", bahasa: "id", mesin: "m", speaker: 0, orangNyata: false } } });
  samaDengan(validasiSuara(dasar()).galat, [], "dasar sah");
  const coba = (ubah, potongan) => { const o = dasar(); ubah(o); const r = validasiSuara(o); tegas(r.data === null && r.galat.some((x) => x.includes(potongan)), `harus menolak (${potongan}): ${JSON.stringify(r.galat)}`); };
  coba((o) => { o.mesin.m.perintah.push("{aneh}"); }, "{aneh}");
  coba((o) => { o.mesin.m.perintah = ["bin", "--o={keluaran}"]; }, "{teks}");
  coba((o) => { o.mesin.m.perintah = ["bin", "{teks}"]; }, "{keluaran}");
  coba((o) => { o.karakter.a.mesin = "tidak-ada"; }, "tidak ada di mesin");
  coba((o) => { o.karakter.a.bahasa = "ja"; o.mesin.m.bahasa = ["id"]; }, "tidak mendukung bahasa");
  coba((o) => { delete o.karakter.a.orangNyata; }, "orangNyata wajib");
  coba((o) => { o.karakter.a.orangNyata = true; }, "izinBerkas");
  coba((o) => { o.karakter.a.kecepatan = 5; }, "kecepatan");
  coba((o) => { delete o.mesin.m.lisensiBobot; }, "lisensiBobot");
  coba((o) => { o.versi = 2; }, "versi harus 1");
  const ok = dasar(); ok.karakter.a.orangNyata = true; ok.karakter.a.izinBerkas = "izin/a.pdf";
  samaDengan(validasiSuara(ok).galat, [], "orangNyata dengan izinBerkas sah");
});

tes("isiPlaceholder tanpa injeksi; kunci cache stabil dan peka terhadap suara, teks, versi, model", () => {
  const a = isiPlaceholder(["--x={model}/m", "{teks}"], { model: "/mdl", teks: "kata {model} {keluaran}" });
  samaDengan(a, ["--x=/mdl/m", "kata {model} {keluaran}"], "nilai tidak ditafsir ulang");
  samaDengan(kanonik({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}', "JSON kanonik");
  const kar = { bahasa: "id", speaker: 2, kecepatan: 1.05 };
  const mesin = { id: "m", versi: "1", modelSha256: null, langkah: 5, perintah: ["bin", "{teks}"], deterministik: false, thread: 4 };
  const h = (o = {}) => kunciKalimat({ teks: o.teks ?? "halo", karakter: { ...kar, ...o.kar }, mesin: { ...mesin, ...o.mesin } }).hash;
  samaDengan(h(), h(), "hash stabil");
  samaDengan(h({ mesin: { thread: 8 } }), h(), "thread tidak masuk kunci bila mesin tidak deterministik");
  for (const [nama, ubah] of [["teks", { teks: "halo!" }], ["speaker", { kar: { speaker: 3 } }], ["kecepatan", { kar: { kecepatan: 1 } }], ["versi", { mesin: { versi: "2" } }], ["model", { mesin: { modelSha256: "ab" } }], ["langkah", { mesin: { langkah: 6 } }]]) {
    tegas(h(ubah) !== h(), `kunci harus berubah bila ${nama} berubah`);
  }
  tegas(h({ mesin: { deterministik: true, thread: 8 } }) !== h({ mesin: { deterministik: true } }), "thread masuk kunci bila mesin deterministik");
});

// fixture: mesin palsu (skrip bun yang menulis nada; fase acak sehingga keluaran tidak identik antar-run)
const tts = j("tts");
const logStub = j("tts", "panggilan.log");
function siapkanTts() {
  mkdirSync(j("tts", "model"), { recursive: true });
  writeFileSync(j("tts", "model", "m.onnx"), "palsu");
  writeFileSync(j("tts", "model", "leksikon.txt"), "halo h a l o\nselamat s e l a m a t\ndatang d a t a ng\nthe d ə\nservice s ɜ v\n");
  const stub = j("tts", "stub-tts.mjs");
  writeFileSync(stub, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const n = (k) => a.find((x) => x.startsWith("--" + k + "="))?.slice(k.length + 3);
const teks = a[a.length - 1];
appendFileSync(process.env.STUB_LOG, teks + "\\n");
if (teks.includes("GAGALKAN")) { console.error("stub: sengaja gagal"); process.exit(3); }
const sr = 22050, kec = Number(n("speed") ?? n("length-scale") ?? 1), dur = Math.max(1.4, teks.length * 0.08 / kec);
const fase = Math.random() * 6.28, m = Math.round(dur * sr), b = Buffer.alloc(44 + m * 2);
b.write("RIFF", 0); b.writeUInt32LE(36 + m * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(m * 2, 40);
for (let i = 0; i < m; i++) { const t = i / sr; b.writeInt16LE(Math.round(0.05 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 210 * t + fase) * 32767), 44 + i * 2); }
writeFileSync(n("output-filename"), b);
`);
  chmodSync(stub, 0o755);
  const mesin = (extra = {}) => ({
    perintah: ["stub-tts", "--model={model}/m.onnx", "--sid={speaker}", "--speed={kecepatan}", "--output-filename={keluaran}", "{teks}"],
    model: "model", versi: "stub 1", bahasa: ["id", "en"], lisensiKode: "CC0-1.0", lisensiBobot: "CC0-1.0", sumber: "uji", syaratPakai: ["label sintetis"],
    kredit: "Mesin palsu uji", ...extra,
  });
  writeFileSync(j("tts", "suara.json"), JSON.stringify({
    versi: 1,
    mesin: {
      stub: mesin(),
      terbatas: mesin({ larangMedis: true, lisensiBobot: "OpenRAIL-M uji" }),
      awan: mesin({ daring: true }),
      kokoro: mesin({ perintah: ["stub-tts", "--length-scale={panjangSkala}", "--model={model}/m.onnx", "--sid={speaker}", "--output-filename={keluaran}", "{teks}"], leksikon: ["{model}/leksikon.txt"], bahasa: ["en"] }),
      lunak: mesin({ perintah: ["stub-tts", "--length-scale={panjangSkala}", "--model={model}/m.onnx", "--sid={speaker}", "--output-filename={keluaran}", "{teks}"], leksikon: ["{model}/leksikon.txt"], oov: "peringatan", bahasa: ["en"] }),
    },
    karakter: {
      ani: { nama: "Ani", bahasa: "id", mesin: "stub", speaker: 0, kecepatan: 1, orangNyata: false, jeda: { antarKalimatMs: 500 } },
      budi: { nama: "Budi", bahasa: "id", mesin: "stub", speaker: 1, kecepatan: 1.25, orangNyata: false },
      tegas: { nama: "Tegas", bahasa: "id", mesin: "terbatas", speaker: 0, orangNyata: false },
      mega: { nama: "Mega", bahasa: "id", mesin: "awan", speaker: 0, orangNyata: false },
      eva: { nama: "Eva", bahasa: "en", mesin: "kokoro", speaker: 3, orangNyata: false },
      lena: { nama: "Lena", bahasa: "en", mesin: "lunak", speaker: 3, orangNyata: false },
    },
  }));
  return stub;
}
const naskahTts = (kalimat, ekstra = {}, penutur) => ({
  versi: 1, fps: 30, bahasa: "id", klasifikasi: "publik",
  suara: { mesin: "sherpa-onnx", konfigurasi: "suara.json", cache: "cache", jedaKalimat: 0.4 },
  penutur: penutur ?? { narator: { nama: "Narator", karakter: "ani" } },
  adegan: [{ id: "a1", kalimat }],
  ...ekstra,
});
const tulisNaskah = (nama, o) => { writeFileSync(j("tts", nama), JSON.stringify(o)); return j("tts", nama); };
const jalankanEnv = async (cmd, env) => {
  // lingkungan bersih dari penunjuk mesin milik pemakai agar uji tidak bergantung pada mesin ini
  const dasar = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWVD_(BIN_|MODEL_|SHERPA_BIN)/.test(k)));
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...dasar, ...env } });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
};
const hitungPanggilan = () => (existsSync(logStub) ? readFileSync(logStub, "utf8").split("\n").filter(Boolean).length : 0);
const ukurLufs = async (berkas) => {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-i", berkas, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const m = r.err.slice(r.err.lastIndexOf("Summary:")).match(/I:\s+(-?[\d.]+)\s+LUFS/);
  tegas(m, `ebur128 tidak terbaca: ${r.err.slice(-200)}`);
  return Number(m[1]);
};
const KALIMAT_TTS = [
  "Selamat datang di layanan kami hari ini.",
  "Pengajuan dibuka pada 12/03/2026 pukul 08.30 WIB sesuai Pasal 5 ayat (2).",
  "Silakan siapkan berkas persyaratan sebelum datang.",
];

tes("naskah TTS: karakter wajib, jenis konten medis, daring ditolak untuk internal, angka dinormalkan menjadi bacaan", () => {
  siapkanTts();
  const dir = tts;
  const cek = (o) => validasiNaskah(o, dir);
  // karakter wajib dan harus ada
  let r = cek(naskahTts(["Halo."], {}, { narator: { nama: "N" } }));
  tegas(r.galat.some((x) => x.includes('penutur "narator": karakter wajib')), `karakter wajib: ${r.galat}`);
  r = cek(naskahTts(["Halo."], {}, { narator: { nama: "N", karakter: "tidak-ada" } }));
  tegas(r.galat.some((x) => x.includes('karakter "tidak-ada" tidak ada')), `karakter tak ada: ${r.galat}`);
  r = cek(naskahTts(["Halo."], { jenisKonten: "olahraga" }));
  tegas(r.galat.some((x) => x.includes("jenisKonten harus salah satu")), `jenisKonten tak sah: ${r.galat}`);
  r = cek(naskahTts(["Halo."], {}));
  samaDengan(r.galat, [], "naskah dasar sah");
  samaDengan(r.naskah.suara.konfigurasi, j("tts", "suara.json"), "jalur suara.json terselesaikan");
  samaDengan(r.naskah.penutur.narator.karakter, "ani", "karakter tersimpan");
  // angka dan tanggal menjadi bacaan; teks (caption) tetap asli
  r = cek(naskahTts(KALIMAT_TTS));
  samaDengan(r.galat, [], "angka di naskah TTS diterima");
  const k = r.naskah.adegan[0].segmen[0].kalimat[1];
  tegas(k.teks.includes("12/03/2026"), "caption tetap memuat teks asli");
  tegas(k.bacaan.includes("dua belas Maret dua ribu dua puluh enam") && !/\d/.test(k.bacaan), `bacaan ternormalisasi: ${k.bacaan}`);
  samaDengan(r.naskah.adegan[0].segmen[0].kalimat[0].bacaan, null, "kalimat tanpa perubahan tidak membuat bacaan");
  // mesin berkas-beku tetap menolak angka
  r = cek({ ...naskahTts(KALIMAT_TTS), suara: { mesin: "berkas-beku" } });
  tegas(r.galat.some((x) => x.includes("angka harus ditulis dengan huruf")), "berkas-beku tetap menolak angka");
  // medis
  r = cek(naskahTts(["Halo."], { jenisKonten: "medis" }, { narator: { nama: "N", karakter: "tegas" } }));
  tegas(r.galat.some((x) => x.includes('jenisKonten "medis" ditolak') && x.includes("OpenRAIL-M uji")), `medis ditolak untuk bobot terlarang: ${r.galat}`);
  r = cek(naskahTts(["Halo."], { jenisKonten: "medis" }));
  samaDengan(r.galat, [], "medis dengan bobot tanpa larangan tidak ditolak");
  tegas(r.peringatan.some((x) => x.includes("tidak dianjurkan untuk konten medis")), `peringatan medis: ${r.peringatan}`);
  r = cek(naskahTts(["Halo."], { jenisKonten: "kesehatan" }, { narator: { nama: "N", karakter: "tegas" } }));
  samaDengan(r.galat, [], "kesehatan bukan galat");
  tegas(r.peringatan.some((x) => x.includes("wilayah abu-abu")), `peringatan kesehatan: ${r.peringatan}`);
  r = cek(naskahTts(["Minum obat sesuai dosis dari dokter."]));
  tegas(r.peringatan.some((x) => x.includes("tampak medis") && x.includes("obat")), `peringatan heuristik: ${r.peringatan}`);
  r = cek(naskahTts(["Halo semua."]));
  samaDengan(r.peringatan, [], "tanpa istilah medis tanpa peringatan");
  // daring ditolak untuk internal
  r = cek(naskahTts(["Halo."], { klasifikasi: "internal" }, { narator: { nama: "N", karakter: "mega" } }));
  tegas(r.galat.some((x) => x.includes("layanan daring")), `daring internal ditolak: ${r.galat}`);
  r = cek(naskahTts(["Halo."], { klasifikasi: "publik" }, { narator: { nama: "N", karakter: "mega" } }));
  samaDengan(r.galat, [], "daring untuk publik tidak ditolak");
});

tes("TTS tanpa mesin terpasang: gagal dengan pesan jelas (bukan crash), baik biner maupun model", async () => {
  siapkanTts();
  const naskah = tulisNaskah("naskah-tanpa-mesin.json", naskahTts(KALIMAT_TTS));
  const cache = j("tts", "cache-kosong");
  let r = await jalankanEnv(["bun", narasiMjs, naskah, "--out", j("tts", "o-tm"), "--cache", cache], { AWVD_SHERPA_BIN: j("tts", "tidak-ada", "sherpa"), STUB_LOG: logStub });
  samaDengan(r.kode, 1, "kode keluar tanpa biner");
  memuat(r.err, 'mesin suara "stub" belum terpasang', "pesan utama");
  memuat(r.err, "biner tidak ditemukan", "penyebab biner");
  memuat(r.err, "docs/narasi-caption.md", "penunjuk panduan pasang");
  memuat(r.err, "AWVD_SHERPA_BIN", "penunjuk variabel lingkungan");
  tegas(!/\n\s+at .*\.mjs/.test(r.err) && !r.err.includes("Bun v"), `bukan crash dengan jejak tumpukan: ${r.err}`);
  tegas(!existsSync(j("tts", "o-tm", "caption.vtt")), "tanpa keluaran palsu bila mesin tidak ada");
  // tanpa variabel lingkungan: dicari di PATH
  r = await jalankanEnv(["bun", narasiMjs, naskah, "--out", j("tts", "o-tm"), "--cache", cache], { AWVD_SHERPA_BIN: "", STUB_LOG: logStub });
  samaDengan(r.kode, 1, "kode keluar tanpa PATH");
  memuat(r.err, '"stub-tts" tidak ada di PATH', "biner tidak di PATH");
  // biner ada, model tidak
  const stub = j("tts", "stub-tts.mjs");
  const dua = JSON.parse(readFileSync(j("tts", "suara.json"), "utf8"));
  dua.mesin.stub.model = "model-hilang";
  writeFileSync(j("tts", "suara-modelhilang.json"), JSON.stringify(dua));
  const n2 = tulisNaskah("naskah-modelhilang.json", naskahTts(KALIMAT_TTS, { suara: { mesin: "sherpa-onnx", konfigurasi: "suara-modelhilang.json", cache: "cache-kosong" } }));
  r = await jalankanEnv(["bun", narasiMjs, n2, "--out", j("tts", "o-tm")], { AWVD_SHERPA_BIN: stub, STUB_LOG: logStub });
  samaDengan(r.kode, 1, "kode keluar tanpa model");
  memuat(r.err, "folder model tidak ditemukan", "penyebab model");
  // suara.json rusak: kode 2 dengan daftar galat
  writeFileSync(j("tts", "suara-rusak.json"), JSON.stringify({ versi: 1, mesin: {}, karakter: {} }));
  const n3 = tulisNaskah("naskah-rusak.json", naskahTts(KALIMAT_TTS, { suara: { mesin: "sherpa-onnx", konfigurasi: "suara-rusak.json" } }));
  r = await jalankanEnv(["bun", narasiMjs, n3, "--out", j("tts", "o-tm")], { AWVD_SHERPA_BIN: stub, STUB_LOG: logStub });
  samaDengan(r.kode, 2, "suara.json tidak sah");
  memuat(r.err, "mesin harus objek tak kosong", "pesan suara.json");
});

tes("TTS dengan mesin palsu: sintesis, kenyaringan -16 LUFS, cache dipakai ulang, label sintetis, tanpa mesin saat cache lengkap", async () => {
  const stub = siapkanTts();
  rmSync(logStub, { force: true });
  rmSync(j("tts", "cache"), { recursive: true, force: true });
  const naskah = tulisNaskah("naskah.json", naskahTts(KALIMAT_TTS));
  const env = { AWVD_SHERPA_BIN: stub, STUB_LOG: logStub };
  const jalan = (out, ...lain) => jalankanEnv(["bun", narasiMjs, naskah, "--out", j("tts", out), ...lain], env);
  let r = await jalan("o1");
  samaDengan(r.kode, 0, `proses pertama (${r.err})`);
  samaDengan(hitungPanggilan(), 3, "tiga kalimat disintesis");
  memuat(r.out, "3 disintesis baru", "ringkasan cache pertama");
  memuat(r.out, "suara sintetis", "info label di CLI");
  const log = readFileSync(logStub, "utf8");
  memuat(log, "dua belas Maret dua ribu dua puluh enam", "mesin menerima teks ternormalisasi");
  memuat(log, "Pasal lima ayat dua", "pasal dan ayat dieja");
  tegas(!log.includes("12/03/2026") && !/\d/.test(log), "mesin tidak menerima angka");
  // WAV segmen: 48 kHz mono PCM16, kenyaringan -16 LUFS
  const rencana = bacaJson(j("tts", "o1", "rencana-audio.json"));
  const wav = join(j("tts", "o1"), rencana.narasi[0].berkas);
  const info = await jalankan(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "csv=p=0", wav]);
  samaDengan(info.out.trim(), "pcm_s16le,48000,1", "format WAV segmen");
  dekat(await ukurLufs(wav), -16, 1, "kenyaringan segmen (LUFS)");
  // jeda antar kalimat dari karakter (500 ms) terdeteksi sebagai batas kalimat
  const lap = bacaJson(j("tts", "o1", "laporan.json"));
  samaDengan(lap.segmen[0].jedaTerdeteksi, 2, "dua jeda antar-kalimat");
  samaDengan(lap.suara.sintetis, true, "laporan menandai suara sintetis");
  // label dan kredit
  const kredit = bacaJson(j("tts", "o1", "suara-kredit.json"));
  samaDengan(kredit.sintetis, true, "suara-kredit.sintetis");
  memuat(kredit.label, "sintetis", "label");
  samaDengan(kredit.kreditLayar, ["Suara: Ani (suara sintetis)"], "kredit layar");
  samaDengan(kredit.mesin[0].lisensiBobot, "CC0-1.0", "lisensi bobot tercatat");
  samaDengan(kredit.segmen[0].sha256, rencana.narasi[0].sha256, "hash WAV di kredit sama dengan rencana audio");
  samaDengan(kredit.segmen[0].kalimat.length, 3, "kalimat tercatat dengan hash cache");
  tegas(readFileSync(j("tts", "o1", "kredit-suara.txt"), "utf8").includes("Suara: Ani (suara sintetis)"), "kredit-suara.txt");
  // proses kedua: cache dipakai ulang, tidak ada panggilan, keluaran identik byte demi byte
  r = await jalan("o2");
  samaDengan(r.kode, 0, `proses kedua (${r.err})`);
  samaDengan(hitungPanggilan(), 3, "cache dipakai ulang: tidak ada panggilan baru");
  memuat(r.out, "0 disintesis baru", "ringkasan cache kedua");
  for (const f of readdirSync(j("tts", "o1"))) samaDengan(readFileSync(j("tts", "o2", f), "utf8"), readFileSync(j("tts", "o1", f), "utf8"), `keluaran identik: ${f}`);
  // cache lengkap: mesin tidak diperlukan
  r = await jalankanEnv(["bun", narasiMjs, naskah, "--out", j("tts", "o3")], { AWVD_SHERPA_BIN: j("tts", "tidak-ada", "x"), STUB_LOG: logStub });
  samaDengan(r.kode, 0, `tanpa mesin dengan cache lengkap (${r.err})`);
  samaDengan(readFileSync(j("tts", "o3", "rencana-audio.json"), "utf8"), readFileSync(j("tts", "o1", "rencana-audio.json"), "utf8"), "rencana identik tanpa mesin");
  // satu kalimat berubah: hanya kalimat itu yang disintesis
  const ubah = [...KALIMAT_TTS]; ubah[2] = "Silakan siapkan berkas persyaratan lengkap sebelum datang.";
  const n4 = tulisNaskah("naskah-ubah.json", naskahTts(ubah));
  r = await jalankanEnv(["bun", narasiMjs, n4, "--out", j("tts", "o4")], env);
  samaDengan(r.kode, 0, `kalimat berubah (${r.err})`);
  samaDengan(hitungPanggilan(), 4, "hanya satu kalimat baru yang disintesis");
  // suara berbeda (kecepatan): kunci berbeda, sintesis ulang; durasi mengikuti kecepatan
  const cepat = tulisNaskah("naskah-budi.json", naskahTts(KALIMAT_TTS, {}, { narator: { nama: "N", karakter: "budi" } }));
  r = await jalankanEnv(["bun", narasiMjs, cepat, "--out", j("tts", "o5")], env);
  samaDengan(r.kode, 0, `karakter lain (${r.err})`);
  samaDengan(hitungPanggilan(), 7, "karakter dengan speaker dan kecepatan lain tidak memakai cache karakter pertama");
  tegas(bacaJson(j("tts", "o5", "laporan.json")).durasiFrame < lap.durasiFrame, "kecepatan 1,25 menghasilkan narasi lebih pendek");
  // --sintesis-ulang mengganti cache
  r = await jalan("o6", "--sintesis-ulang");
  samaDengan(r.kode, 0, `sintesis ulang (${r.err})`);
  samaDengan(hitungPanggilan(), 10, "--sintesis-ulang menyintesis semua kalimat sekali");
  memuat(r.out, "3 disintesis baru", "ringkasan sintesis ulang");
});

tes("TTS: cache rusak digagalkan, mesin yang gagal dilaporkan jelas, OOV leksikon digagalkan atau diperingatkan", async () => {
  const stub = siapkanTts();
  rmSync(j("tts", "cache"), { recursive: true, force: true });
  rmSync(logStub, { force: true });
  const env = { AWVD_SHERPA_BIN: stub, STUB_LOG: logStub };
  const naskah = tulisNaskah("naskah-c.json", naskahTts(["Selamat datang di layanan kami hari ini."]));
  let r = await jalankanEnv(["bun", narasiMjs, naskah, "--out", j("tts", "oc1")], env);
  samaDengan(r.kode, 0, `dasar (${r.err})`);
  const mentah = readdirSync(j("tts", "cache")).find((f) => /^[0-9a-f]{64}\.wav$/.test(f));
  appendFileSync(j("tts", "cache", mentah), Buffer.from([1, 2, 3, 4]));
  r = await jalankanEnv(["bun", narasiMjs, naskah, "--out", j("tts", "oc2")], env);
  samaDengan(r.kode, 1, "cache rusak");
  memuat(r.err, "cache suara rusak", "pesan cache rusak");
  memuat(r.err, "--sintesis-ulang", "petunjuk pemulihan");
  r = await jalankanEnv(["bun", narasiMjs, naskah, "--out", j("tts", "oc3"), "--sintesis-ulang"], env);
  samaDengan(r.kode, 0, `pemulihan (${r.err})`);
  // mesin gagal jalan
  const gagal = tulisNaskah("naskah-gagal.json", naskahTts(["Kalimat ini sengaja GAGALKAN mesin palsu."]));
  r = await jalankanEnv(["bun", narasiMjs, gagal, "--out", j("tts", "oc4")], env);
  samaDengan(r.kode, 1, "mesin gagal");
  memuat(r.err, 'mesin suara "stub" gagal (kode 3)', "pesan mesin gagal");
  memuat(r.err, "stub: sengaja gagal", "stderr mesin dilaporkan");
  // OOV: kata di luar leksikon
  const eng = (penutur) => tulisNaskah(`naskah-${penutur}.json`, naskahTts(["The officer explains the service."], { bahasa: "en" }, { narator: { nama: "N", karakter: penutur } }));
  r = await jalankanEnv(["bun", narasiMjs, eng("eva"), "--out", j("tts", "oc5")], env);
  samaDengan(r.kode, 1, "OOV menggagalkan");
  memuat(r.err, "di luar leksikon", "pesan OOV");
  memuat(r.err, "officer, explains", "kata OOV disebut");
  r = await jalankanEnv(["bun", narasiMjs, eng("lena"), "--out", j("tts", "oc6")], env);
  samaDengan(r.kode, 0, `OOV peringatan (${r.err})`);
  memuat(r.err, "peringatan: kalimat memuat kata di luar leksikon", "peringatan OOV");
  samaDengan(periksaOov("The service, selamat!", [j("tts", "model", "leksikon.txt")]), [], "kata dalam leksikon lolos");
  samaDengan(periksaOov("Don't officers", [j("tts", "model", "leksikon.txt")]), ["don't", "officers"], "kata luar leksikon terdaftar");
});

tes("TTS sungguhan (sherpa-onnx + Supertonic): dilewati bila AWVD_SHERPA_BIN dan AWVD_MODEL_SUPERTONIC3 tidak diset", async () => {
  const bin = process.env.AWVD_SHERPA_BIN, model = process.env.AWVD_MODEL_SUPERTONIC3;
  if (!bin || !model || !existsSync(bin) || !existsSync(model)) throw new Lewati("mesin sungguhan tidak terpasang di mesin ini (opsional; set AWVD_SHERPA_BIN dan AWVD_MODEL_SUPERTONIC3 untuk menjalankannya)");
  mkdirSync(j("tts-nyata"), { recursive: true });
  const naskah = j("tts-nyata", "naskah.json");
  writeFileSync(naskah, JSON.stringify({ versi: 1, fps: 30, bahasa: "id", klasifikasi: "publik", suara: { mesin: "sherpa-onnx", cache: "cache" },
    penutur: { narator: { nama: "Narator", karakter: "sekar" } },
    adegan: [{ id: "a1", kalimat: ["Selamat datang di layanan kami.", "Pengajuan dibuka pada 12/03/2026 pukul 08.30 WIB."] }] }));
  const r = await bun(narasiMjs, naskah, "--out", j("tts-nyata", "out"));
  samaDengan(r.kode, 0, `sintesis sungguhan (${r.err})`);
  const rencana = bacaJson(j("tts-nyata", "out", "rencana-audio.json"));
  const wav = join(j("tts-nyata", "out"), rencana.narasi[0].berkas);
  const a = await bacaAudio(wav);
  tegas(a.durasi > 3, `durasi wajar: ${a.durasi}`);
  dekat(await ukurLufs(wav), -16, 1, "kenyaringan -16 LUFS");
  const r2 = await bun(narasiMjs, naskah, "--out", j("tts-nyata", "out2"));
  samaDengan(r2.kode, 0, "proses kedua");
  memuat(r2.out, "0 disintesis baru", "cache dipakai ulang pada mesin sungguhan");
  samaDengan(bacaJson(j("tts-nyata", "out2", "rencana-audio.json")).narasi[0].sha256, rencana.narasi[0].sha256, "WAV beku identik");
});

// ------------------------------------------------------------------ jalankan
let gagalCount = 0, lewatCount = 0;
const t0 = Date.now();
try {
  for (const [nama, fn] of uji) {
    const t = Date.now();
    try {
      await fn();
      console.log(`ok     ${nama}  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    } catch (e) {
      if (e instanceof Lewati) { lewatCount++; console.log(`lewati ${nama}\n       ${e.message}`); continue; }
      gagalCount++;
      console.log(`GAGAL  ${nama}\n       ${String(e.message).replace(/\n/g, "\n       ")}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${uji.length - gagalCount - lewatCount}/${uji.length} uji narasi lolos${lewatCount ? `, ${lewatCount} dilewati` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(gagalCount ? 1 : 0);
