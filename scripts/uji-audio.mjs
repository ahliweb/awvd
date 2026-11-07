#!/usr/bin/env bun
/**
 * uji-audio.mjs — uji olah suara per trek di audio.mjs: peredam bising (afftdn, arnndn) dan
 * pengubah nada/tempo (rubberband, cadangan asetrate + atempo). Sinyal uji dibangkitkan ffmpeg
 * lavfi (sinus + derau putih ber-seed); tanpa model, tanpa jaringan, tanpa aset pihak ketiga.
 * Model RNNoise tidak dibundel, jadi arnndn diuji lewat validasi, rantai filter, dan berkas
 * model palsu (stub) yang harus ditolak dengan pesan jelas.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-audio.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bangunGrafik, filterTersedia, lolosOpsi, rantaiOlah, validasiOlah, validasiRencana } from "./audio.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const audioMjs = join(akar, "scripts", "audio.mjs");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-audio-"));
const j = (...p) => join(tmp, ...p);
const FPS = 30;

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
const samaDengan = (nyata, harapan, nama) =>
  tegas(nyata === harapan, `${nama}: dapat ${JSON.stringify(nyata)}, harapan ${JSON.stringify(harapan)}`);
const memuat = (teks, potongan, nama) => tegas(teks.includes(potongan), `${nama}: "${potongan}" tidak ada dalam:\n${teks}`);
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
}
const tulisJson = (berkas, obj) => writeFileSync(berkas, JSON.stringify(obj, null, 2));

/** WAV float32 stereo (keluaran audio.mjs) -> { kiri: Float32Array, sr } */
function bacaWav(berkas) {
  const b = readFileSync(berkas);
  let o = 12;
  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === "data") {
      const d = b.subarray(o + 8, o + 8 + n);
      const s = new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
      const N = s.length / 2;
      return { kiri: Float32Array.from({ length: N }, (_, i) => s[i * 2]), sr: 48000 };
    }
    o += 8 + n;
  }
  throw new Error(`tidak ada chunk data di ${berkas}`);
}
const potong = (w, dari, sampai) => w.kiri.subarray(Math.round(dari * w.sr), Math.round(sampai * w.sr));

/** Daya komponen sinus pada hz (korelasi sin/cos; tak peka pergeseran fase) dan daya total. */
function dayaNada(x, hz, sr) {
  const N = x.length;
  let a = 0, c = 0, e = 0;
  for (let i = 0; i < N; i++) {
    const w = (2 * Math.PI * hz * i) / sr;
    a += x[i] * Math.cos(w);
    c += x[i] * Math.sin(w);
    e += x[i] * x[i];
  }
  return { nada: ((2 / N) ** 2 * (a * a + c * c)) / 2, total: e / N };
}
/** SNR (dB) = daya nada / daya sisa; tanpa membutuhkan sinyal acuan yang sejajar. */
function snr(berkas, hz, dari = 0.5) {
  const w = bacaWav(berkas);
  const { nada, total } = dayaNada(potong(w, dari, w.kiri.length / w.sr), hz, w.sr);
  return 10 * Math.log10(nada / (total - nada));
}
/**
 * Bagian daya total yang berada pada nada hz +-lebar (0..1), dirata-rata per jendela 0,2 s: tiap
 * jendela memakai frekuensi terbaik dalam pita (rubberband menggoyang frekuensi beberapa Hz).
 */
function bagianNada(berkas, hz, dari, sampai, lebar = 12) {
  const w = bacaWav(berkas);
  const hasil = [];
  for (let t = dari; t + 0.2 <= sampai + 1e-9; t += 0.2) {
    const x = potong(w, t, t + 0.2);
    let terbaik = 0;
    for (let f = hz - lebar; f <= hz + lebar; f += 2) {
      const { nada, total } = dayaNada(x, f, w.sr);
      terbaik = Math.max(terbaik, nada / total);
    }
    hasil.push(terbaik);
  }
  return hasil.reduce((x, y) => x + y, 0) / hasil.length;
}
function rmsDb(berkas, dari, sampai) {
  const x = potong(bacaWav(berkas), dari, sampai);
  let e = 0;
  for (const v of x) e += v * v;
  return 10 * Math.log10(e / x.length + 1e-20);
}
async function lufs(berkas) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-nostats", "-i", berkas, "-vn", "-af", "ebur128", "-f", "null", "-"]);
  const ringkas = r.err.slice(r.err.lastIndexOf("Summary:"));
  const m = /I:\s+(-?[\d.]+)\s+LUFS/.exec(ringkas);
  tegas(m, `ringkasan ebur128 tidak terbaca: ${ringkas}`);
  return Number(m[1]);
}
async function audio(rencana, nama, ...extra) {
  const berkas = j(`${nama}.json`);
  tulisJson(berkas, rencana);
  const r = await jalankan(["bun", audioMjs, berkas, "--fps", String(FPS), "--out", j(`${nama}.wav`), ...extra]);
  return { ...r, wav: j(`${nama}.wav`) };
}
const sama = (a, b) => Buffer.compare(readFileSync(a), readFileSync(b)) === 0;

// ----------------------------------------------------------- bahan uji
// Sinus 440 Hz (0,3 FS) + derau putih ber-seed (amplitudo 0,05): SNR sekitar -0,7 dB
async function siapkan() {
  await ffmpeg("-f", "lavfi", "-i", "sine=f=440:r=48000:d=6,volume=0.3", "-f", "lavfi", "-i", "anoisesrc=r=48000:d=6:seed=7:color=white:amplitude=0.05",
    "-filter_complex", "[0][1]amix=inputs=2:normalize=0,aformat=channel_layouts=mono", "-c:a", "pcm_f32le", j("berbising.wav"));
  await ffmpeg("-f", "lavfi", "-i", "sine=f=440:r=48000:d=6,volume=0.5", "-ac", "1", "-c:a", "pcm_f32le", j("nada.wav"));
}
const narasi = (olah = {}, berkas = "berbising.wav") => ({ durasiFrame: 6 * FPS, narasi: [{ id: "n", berkas: j(berkas), mulai: 0, ...olah }] });
const BERSIH = { bersih: { metode: "afftdn", nr: 20, nf: -40 } };

const kasus = [];
const uji = (nama, fn) => kasus.push([nama, fn]);

// ----------------------------------------------------------------- uji
uji("a. validasi blok bersih dan suara (fail-closed)", async () => {
  const dir = tmp;
  const cek = (k, izinTempo = true) => validasiOlah(k, 'narasi "n"', dir, { izinTempo });
  samaDengan(cek({}).olah, null, "tanpa blok");
  samaDengan(cek({}).galat.length, 0, "tanpa blok: tanpa galat");
  const bawaan = cek({ bersih: {} }).olah.bersih;
  samaDengan(JSON.stringify(bawaan), JSON.stringify({ metode: "afftdn", nr: 12, nf: -40, jenis: "putih", lacak: true }), "bawaan afftdn");
  memuat(cek({ bersih: { nr: 100 } }).galat[0], "bersih.nr di luar 0.01..97", "nr");
  memuat(cek({ bersih: { nf: -10 } }).galat[0], "bersih.nf di luar -80..-20", "nf");
  memuat(cek({ bersih: { jenis: "merah" } }).galat[0], 'bersih.jenis "merah" tidak dikenal', "jenis");
  memuat(cek({ bersih: { metode: "afftdn", model: "x" } }).galat[0], "bersih.model tidak dikenal untuk metode afftdn", "kunci asing");
  memuat(cek({ bersih: { metode: "lain" } }).galat[0], 'bersih.metode "lain" tidak dikenal', "metode");
  memuat(cek({ suara: { nadaSemiton: 13 } }).galat[0], "suara.nadaSemiton di luar -12..12", "semiton");
  memuat(cek({ suara: { tempo: 3 } }).galat[0], "suara.tempo di luar 0.5..2", "tempo");
  memuat(cek({ suara: { tempo: 1.2 } }, false).galat[0], "suara.tempo tidak berlaku untuk klip", "tempo klip");
  samaDengan(cek({ suara: { nadaSemiton: 2 } }, false).galat.length, 0, "nada pada klip boleh");
  memuat(cek({ suara: { mesin: "x" } }).galat[0], 'suara.mesin "x" tidak dikenal', "mesin");
  memuat(cek({ suara: { kecepatan: 2 } }).galat[0], "suara.kecepatan tidak dikenal", "kunci suara");
  samaDengan(cek({ suara: { nadaSemiton: 0, tempo: 1 } }).olah, null, "suara netral dibuang");
});

uji("b. arnndn: model wajib, harus ada, harus berformat model; stub ditolak jelas", async () => {
  const cek = (b) => validasiOlah({ bersih: b }, 'narasi "n"', tmp, { izinTempo: true });
  memuat(cek({ metode: "arnndn" }).galat[0], "bersih.model wajib", "tanpa model");
  memuat(cek({ metode: "arnndn" }).galat[0], "tidak membundel model", "pesan tak dibundel");
  memuat(cek({ metode: "arnndn", model: "tidak-ada.rnnn" }).galat[0], "bersih.model tidak ditemukan", "model hilang");
  writeFileSync(j("sampah.rnnn"), "bukan model\n");
  memuat(cek({ metode: "arnndn", model: "sampah.rnnn" }).galat[0], "bukan berkas model arnndn", "header salah");
  memuat(cek({ metode: "arnndn", model: "x.rnnn", campur: 2 }).galat.join("|"), "bersih.campur di luar 0..1", "campur");
  // stub: header benar tetapi bobot tidak ada (model RNNoise asli tidak dibundel) -> lolos validasi awvd
  writeFileSync(j("stub.rnnn"), "rnnoise-nu model file version 1\n");
  const v = cek({ metode: "arnndn", model: "stub.rnnn", campur: 0.5 });
  samaDengan(v.galat.length, 0, "stub lolos validasi format");
  const rantai = rantaiOlah(v.olah);
  memuat(rantai, "arnndn=m=", "rantai arnndn");
  memuat(rantai, "mix=0.5", "mix");
  // ffmpeg menolak bobot kosong; audio.mjs harus gagal dengan pesan, bukan menghasilkan audio diam-diam
  const r = await audio(narasi({ bersih: { metode: "arnndn", model: j("stub.rnnn") } }), "stub-arnndn");
  tegas(r.kode !== 0, "model stub seharusnya membuat audio.mjs gagal");
  memuat(r.err, "audio.mjs:", "pesan galat audio.mjs");
  // exit 2 (rencana tidak valid) untuk model yang tidak ada
  const r2 = await audio(narasi({ bersih: { metode: "arnndn", model: "tidak-ada.rnnn" } }), "tanpa-model");
  samaDengan(r2.kode, 2, "exit rencana tidak valid");
  memuat(r2.err, "bersih.model tidak ditemukan", "pesan model hilang");
  // jalur berisi karakter khusus lolos benar sampai ke ffmpeg (ffmpeg melaporkan jalur apa adanya)
  const aneh = j("d a:b,c;[x]'y");
  mkdirSync(aneh);
  const jalur = join(aneh, "tidak-ada.rnnn");
  const s = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=1", "-filter_complex",
    `[0:a]arnndn=m=${lolosOpsi(jalur)}[o]`, "-map", "[o]", "-f", "null", "-"]);
  memuat(s.err, `Failed to open model file: ${jalur}`, "jalur khusus utuh");
});

uji("c. rantai filter: afftdn, rubberband, cadangan asetrate + atempo", async () => {
  const olah = (suara) => ({ suara: { formant: true, ...suara } });
  samaDengan(rantaiOlah(null), "", "tanpa olah");
  samaDengan(rantaiOlah({ bersih: { metode: "afftdn", nr: 20, nf: -35, jenis: "vinil", lacak: false } }), "afftdn=nr=20:nf=-35:nt=v:tn=0", "afftdn");
  samaDengan(rantaiOlah(olah({ nadaSemiton: 12, tempo: 1.25, mesinPakai: "rubberband" })), "rubberband=pitch=2:tempo=1.25:formant=preserved", "rubberband");
  samaDengan(rantaiOlah(olah({ nadaSemiton: 0, tempo: 1.5, formant: false, mesinPakai: "rubberband" })), "rubberband=pitch=1:tempo=1.5", "rubberband tanpa formant");
  samaDengan(rantaiOlah(olah({ nadaSemiton: 12, tempo: 1, mesinPakai: "sederhana" })), "asetrate=96000,aresample=48000,atempo=0.5", "sederhana +12");
  samaDengan(rantaiOlah(olah({ nadaSemiton: 0, tempo: 1.25, mesinPakai: "sederhana" })), "atempo=1.25", "sederhana tempo");
  // faktor di luar 0.5..2 dipecah: nada +12 dan tempo 0.5 -> faktor 0.25
  samaDengan(rantaiOlah(olah({ nadaSemiton: 12, tempo: 0.5, mesinPakai: "sederhana" })), "asetrate=96000,aresample=48000,atempo=0.5,atempo=0.5", "sederhana dipecah");
  samaDengan(rantaiOlah({ bersih: { metode: "afftdn", nr: 12, nf: -40, jenis: "putih", lacak: true }, suara: { nadaSemiton: 0, tempo: 2, mesinPakai: "sederhana" } }),
    "afftdn=nr=12:nf=-40:nt=w:tn=1,atempo=2", "bersih lalu suara");
});

uji("d. rencana: mesin rubberband, cadangan, tempo memendekkan narasi, grafik memuat efek", async () => {
  const r = narasi({ suara: { nadaSemiton: 3, tempo: 2, mesin: "rubberband" } });
  const tanpa = await validasiRencana(r, tmp, { fps: FPS, rubberband: false });
  tegas(tanpa.galat.length === 1, `harus tepat satu galat: ${JSON.stringify(tanpa.galat)}`);
  memuat(tanpa.galat[0], 'suara.mesin "rubberband" diminta tetapi filter rubberband tidak ada', "galat tanpa rubberband");
  memuat(tanpa.galat[0], '"sederhana"', "saran cadangan");

  const oto = await validasiRencana(narasi({ suara: { nadaSemiton: 3, tempo: 2 } }), tmp, { fps: FPS, rubberband: false });
  samaDengan(oto.galat.length, 0, "otomatis tanpa rubberband tidak gagal");
  memuat(oto.peringatan.join("\n"), "cadangan asetrate + atempo", "peringatan cadangan");
  samaDengan(oto.rencana.narasi[0].olah.suara.mesinPakai, "sederhana", "mesinPakai cadangan");

  const ada = await validasiRencana(narasi({ suara: { nadaSemiton: 3, tempo: 2 } }), tmp, { fps: FPS, rubberband: true });
  samaDengan(ada.rencana.narasi[0].olah.suara.mesinPakai, "rubberband", "mesinPakai rubberband");
  samaDengan(ada.peringatan.length, 0, "tanpa peringatan bila rubberband ada");
  samaDengan(ada.rencana.narasi[0].akhir, 90, "tempo 2 memendekkan 180 frame menjadi 90");

  const eksplisit = await validasiRencana(narasi({ suara: { nadaSemiton: 3, mesin: "sederhana" } }), tmp, { fps: FPS, rubberband: true });
  samaDengan(eksplisit.rencana.narasi[0].olah.suara.mesinPakai, "sederhana", "sederhana eksplisit");
  samaDengan(eksplisit.peringatan.length, 0, "sederhana eksplisit tanpa peringatan");

  // klip: nada boleh, tempo ditolak, olah pada mode bisu diabaikan dengan peringatan; grafik memuat efek setelah atrim
  const rk = { durasiFrame: 180, klip: [
    { id: "k", berkas: j("nada.wav"), mulai: 30, akhir: 120, ...BERSIH, suara: { nadaSemiton: -2, mesin: "sederhana" } },
    { id: "b", mulai: 130, akhir: 170, mode: "bisu", bersih: {} },
  ] };
  const v = await validasiRencana(rk, tmp, { fps: FPS });
  samaDengan(v.galat.length, 0, `klip valid: ${v.galat}`);
  memuat(v.peringatan.join("\n"), 'bersih/suara diabaikan pada mode "bisu"', "peringatan bisu");
  for (const c of v.rencana.klip) c.gainEq = 0;
  const g = bangunGrafik(v.rencana).filter;
  memuat(g, "asetpts=PTS-STARTPTS,afftdn=nr=20:nf=-40:nt=w:tn=1,asetrate=", "klip: efek sesudah atrim");
  const rt = { durasiFrame: 180, klip: [{ id: "k", berkas: j("nada.wav"), mulai: 30, akhir: 120, suara: { tempo: 1.5 } }] };
  const vt = await validasiRencana(rt, tmp, { fps: FPS });
  memuat(vt.galat.join("\n"), "suara.tempo tidak berlaku untuk klip", "tempo klip ditolak di rencana");
});

uji("e. peredam bising afftdn: SNR naik dan kenyaringan akhir tetap -16 LUFS +-1 (deterministik)", async () => {
  const dasar = await audio(narasi(), "snr-tanpa");
  samaDengan(dasar.kode, 0, `audio.mjs tanpa bersih (${dasar.err})`);
  const bersih = await audio(narasi(BERSIH), "snr-bersih");
  samaDengan(bersih.kode, 0, `audio.mjs dengan bersih (${bersih.err})`);
  memuat(bersih.out, "afftdn nr=20 dB, nf=-40 dB", "laporan olah suara");
  const s0 = snr(dasar.wav, 440), s1 = snr(bersih.wav, 440);
  console.log(`  SNR ${s0.toFixed(2)} dB -> ${s1.toFixed(2)} dB (naik ${(s1 - s0).toFixed(2)} dB)`);
  tegas(s0 < 3, `masukan seharusnya berbising (SNR ${s0.toFixed(2)} dB)`);
  tegas(s1 - s0 >= 10, `SNR naik hanya ${(s1 - s0).toFixed(2)} dB (minimal 10 dB)`);
  for (const [nama, w] of [["tanpa", dasar.wav], ["bersih", bersih.wav]]) {
    const l = await lufs(w);
    console.log(`  kenyaringan ${nama}: ${l.toFixed(2)} LUFS`);
    tegas(Math.abs(l - -16) <= 1, `kenyaringan ${nama} ${l.toFixed(2)} LUFS di luar -16 +-1`);
  }
  const ulang = await audio(narasi(BERSIH), "snr-bersih-2");
  tegas(sama(bersih.wav, ulang.wav), "dua run afftdn tidak identik byte demi byte");
  // jenis bising dan tanpa pelacakan berbeda hasil (parameter benar-benar sampai ke filter)
  const tanpaLacak = await audio(narasi({ bersih: { nr: 20, nf: -40, lacak: false } }), "snr-tanpa-lacak");
  samaDengan(tanpaLacak.kode, 0, `lacak=false (${tanpaLacak.err})`);
  tegas(!sama(bersih.wav, tanpaLacak.wav), "lacak=false seharusnya mengubah hasil");
});

for (const mesin of ["rubberband", "sederhana"]) {
  uji(`f. pengubah nada dan tempo (${mesin}): nada bergeser satu oktaf, durasi mengikuti tempo, deterministik`, async () => {
    if (mesin === "rubberband" && !(await filterTersedia("rubberband"))) {
      console.log("  dilewati: build ffmpeg ini tanpa filter rubberband (jalur cadangan diuji di mesin 'sederhana')");
      return;
    }
    // formant:false karena sinus murni tak punya selubung formant; mempertahankannya pada sinus meredam hasil hingga hampir senyap
    const nada = await audio(narasi({ suara: { nadaSemiton: 12, mesin, formant: false } }, "nada.wav"), `nada-${mesin}`);
    samaDengan(nada.kode, 0, `audio.mjs nada (${nada.err})`);
    const b880 = bagianNada(nada.wav, 880, 1, 5), b440 = bagianNada(nada.wav, 440, 1, 5);
    console.log(`  +12 semiton: bagian daya di 880 Hz ${b880.toFixed(3)}, di 440 Hz ${b440.toFixed(4)}`);
    tegas(b880 > 0.8, `nada +12 semiton: daya di 880 Hz hanya ${b880.toFixed(3)}`);
    tegas(b440 < 0.05, `nada +12 semiton: masih ada daya di 440 Hz (${b440.toFixed(3)})`);
    // durasi nada dipertahankan (tempo 1): bunyi sampai dekat akhir
    tegas(rmsDb(nada.wav, 4.5, 5.5) > -40, "nada: bunyi seharusnya masih ada di detik 4,5..5,5");

    const lambat = await audio(narasi({ suara: { tempo: 2, mesin } }, "nada.wav"), `tempo-${mesin}`);
    samaDengan(lambat.kode, 0, `audio.mjs tempo (${lambat.err})`);
    const ada = rmsDb(lambat.wav, 0.5, 2.5), sunyi = rmsDb(lambat.wav, 3.3, 5.5);
    console.log(`  tempo x2: RMS 0,5..2,5 s ${ada.toFixed(1)} dB, 3,3..5,5 s ${sunyi.toFixed(1)} dB`);
    tegas(ada > -40, `tempo x2: seharusnya berbunyi di 0,5..2,5 s (${ada.toFixed(1)} dB)`);
    tegas(sunyi < -60, `tempo x2: seharusnya senyap setelah 3 s (${sunyi.toFixed(1)} dB)`);
    const l = await lufs(lambat.wav);
    console.log(`  kenyaringan tempo x2: ${l.toFixed(2)} LUFS`);
    tegas(Math.abs(l - -16) <= 1, `kenyaringan tempo x2 ${l.toFixed(2)} LUFS di luar -16 +-1`);

    const ulang = await audio(narasi({ suara: { nadaSemiton: 12, mesin, formant: false } }, "nada.wav"), `nada-${mesin}-2`);
    tegas(sama(nada.wav, ulang.wav), `dua run ${mesin} tidak identik byte demi byte`);
  });
}

uji("g. bersih dan suara bersama; kenyaringan tetap lolos dan hasil deterministik", async () => {
  const olah = { ...BERSIH, suara: { nadaSemiton: -2, tempo: 1.1, mesin: "sederhana" } };
  const a = await audio(narasi(olah), "gabung-1");
  samaDengan(a.kode, 0, `audio.mjs gabungan (${a.err})`);
  const b = await audio(narasi(olah), "gabung-2");
  tegas(sama(a.wav, b.wav), "dua run gabungan tidak identik byte demi byte");
  const l = await lufs(a.wav);
  console.log(`  kenyaringan gabungan: ${l.toFixed(2)} LUFS`);
  tegas(Math.abs(l - -16) <= 1, `kenyaringan gabungan ${l.toFixed(2)} LUFS di luar -16 +-1`);
  memuat(a.out, "narasi \"n\": afftdn", "laporan olah gabungan");
  // rencana tanpa olah tidak berubah perilakunya: grafik tidak memuat filter olah
  const v = await validasiRencana(narasi(), tmp, { fps: FPS });
  v.rencana.narasi[0].gainEq = 0;
  const g = bangunGrafik(v.rencana).filter;
  tegas(!/afftdn|arnndn|rubberband|asetrate|atempo/.test(g), "tanpa olah: grafik tidak boleh memuat filter olah");
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
console.log(`semua ${kasus.length} uji audio lolos`);
