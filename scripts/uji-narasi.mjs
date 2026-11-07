#!/usr/bin/env bun
/**
 * uji-narasi.mjs — uji narasi.mjs (naskah.json -> cue, stempel kata, rencana audio).
 * Audio uji dibangkitkan skrip (nada sinus bergerak seperti ucapan, jeda diketahui) atau ffmpeg
 * lavfi lewat templat narasi-contoh; tanpa jaringan, tanpa TTS, tanpa aset pihak ketiga.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-narasi.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bacaAudio, deteksiBicara, kataDariPenanda, selaraskanToken, sukuKata, tokenisasi } from "./narasi-selaras.mjs";
import { keSrt, keVtt, periksaCue, susunCue } from "./narasi-cue.mjs";
import { buatNarasi, daftarkanMesin, hapusMesin, validasiNaskah } from "./narasi.mjs";

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
console.log(`\n${uji.length - gagalCount}/${uji.length} uji narasi lolos (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(gagalCount ? 1 : 0);
