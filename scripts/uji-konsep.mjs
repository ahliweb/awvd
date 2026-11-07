#!/usr/bin/env bun
/**
 * uji-konsep.mjs — uji konsep video (data preset, alur, konsep.mjs, preset runtime, periksa --konsep).
 * Tanpa dependensi tambahan; video uji dibuat dengan ffmpeg lavfi di direktori sementara.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-konsep.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  ATRIBUT, BERKAS, bangunPresetJs, buatBrief, buatKonsep, muatData, periksaData, periksaKonsep, tulisJson,
} from "./konsep.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const konsepCli = join(akar, "scripts", "konsep.mjs");
const periksaCli = join(akar, "scripts", "periksa.mjs");
const contohDir = join(akar, "templates", "konsep-contoh");
const tmp = mkdtempSync(join(tmpdir(), "awvd-konsep-"));

// ---- runtime di Bun (window/document tiruan, seperti uji-runtime.mjs)
const elemenTiruan = () => ({ setAttribute() {}, appendChild() {}, style: {} });
globalThis.window = { location: { search: "" } };
globalThis.document = { readyState: "complete", createElement: elemenTiruan, head: elemenTiruan(), documentElement: elemenTiruan() };
await import(pathToFileURL(join(akar, "scripts", "runtime.js")).href);
const rt = globalThis.window.VideoTerprogram;

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const konsepJalan = (...a) => jalankan(["bun", konsepCli, ...a]);
const baca = (f) => readFileSync(f, "utf8");
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const data = muatData();
const galatDari = (k) => periksaKonsep(data, k).galat;
const ada = (daftar, re) => daftar.some((x) => re.test(x));

// konsep dasar terisi lengkap (lolos periksa pada tahap mana pun)
function konsepIsi(jenis, alur, tambahan = {}) {
  const k = buatKonsep(data, { jenis, alur, judul: `Contoh ${jenis} fiktif` });
  k.tujuan = "Tujuan contoh fiktif.";
  k.tujuanBelajar = ["Tujuan belajar contoh"];
  k.audiens.deskripsi = "Audiens fiktif";
  k.pesanUtama = "Pesan utama contoh.";
  k.cta.teks = "Ajakan contoh";
  k.kepatuhan.dasarHukum = ["Dasar hukum contoh (fiktif)"];
  return Object.assign(k, tambahan);
}
const simpanJson = (nama, k) => { const f = join(tmp, nama); writeFileSync(f, tulisJson(k)); return f; };

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

// ----------------------------------------------------------------- (a) data
daftar("(a) data: 13 jenis, 5 alur, semua atribut + tingkat bukti, easing/token ada di runtime", async () => {
  const kj = Object.keys(data.jenis.jenis);
  tegas(JSON.stringify(kj) === JSON.stringify(["formal", "edukasi", "kreatif", "promo", "produk", "panduan", "dokumenter", "sosial", "data", "testimoni", "psa", "internal", "acara"]), `jenis: ${kj}`);
  tegas(Object.keys(data.alur.alur).sort().join() === "dokumenter,formal,instruksional,ringkas,standar", "alur harus 5: ringkas, standar, instruksional, formal, dokumenter");
  const g = periksaData(data, rt);
  tegas(g.length === 0, g.slice(0, 5).join(" | "));
  for (const [k, j] of Object.entries(data.jenis.jenis)) {
    for (const a of ATRIBUT) tegas(j.bukti[a]?.tingkat && j.bukti[a].rujukan, `${k}.${a}: bukti hilang`);
  }
  const bawaan = { formal: "formal", edukasi: "instruksional", panduan: "instruksional", dokumenter: "dokumenter", promo: "standar", kreatif: "standar", produk: "standar", internal: "ringkas", sosial: "ringkas" };
  for (const [k, a] of Object.entries(bawaan)) tegas(data.jenis.jenis[k].alurBawaan === a, `${k}: alur bawaan ${data.jenis.jenis[k].alurBawaan}, harapan ${a}`);
  // pemeriksa data harus benar-benar menangkap kerusakan
  const rusak = (ubah, re) => {
    const m = structuredClone(data);
    ubah(m);
    tegas(ada(periksaData(m, rt), re), `kerusakan tidak terdeteksi: ${re}`);
  };
  rusak((m) => { delete m.jenis.jenis.promo.bukti.cps; }, /promo\.bukti\.cps/);
  rusak((m) => { m.jenis.jenis.promo.bukti.cps.tingkat = "ilmiah"; }, /tingkat tidak valid/);
  rusak((m) => { m.jenis.jenis.formal.nilai.easing.masuk = "memantul"; }, /easing\.masuk/);
  rusak((m) => { m.jenis.jenis.formal.nilai.transisi = "raksasa"; }, /transisi tidak valid/);
  rusak((m) => { m.jenis.enum.easing.push("tidakAda"); }, /tidak ada di runtime/);
  rusak((m) => { m.jenis.jenis.formal.nilai.durasiTarget = 999; }, /durasiTarget/);
  rusak((m) => { m.jenis.jenis.sosial.nilai.resolusi["9:16"] = { lebar: 1920, tinggi: 1080 }; }, /tidak sesuai rasio/);
  rusak((m) => { m.alur.alur.formal.tahap[1].gate.id = "G1"; }, /gate.id/);
  rusak((m) => { m.alur.alur.ringkas.tahap[0].raci.A = ["PS", "PM"]; }, /raci\.A/);
  rusak((m) => { m.jenis.jenis.formal.alurBawaan = "standar"; }, /alurBawaan/);
});

// ----------------------------------------------------------------- (b) baru / brief deterministik
daftar("(b) baru dan brief deterministik; tanpa argumen mencetak pilihan (exit 2)", async () => {
  const a = join(tmp, "a.json"), b = join(tmp, "b.json");
  const args = ["baru", "--jenis", "promo", "--alur", "standar", "--judul", "Promo Contoh Fiktif"];
  for (const f of [a, b]) {
    const r = await konsepJalan(...args, "--out", f);
    tegas(r.kode === 0, `baru exit ${r.kode}: ${r.err}`);
  }
  tegas(baca(a) === baca(b), "dua kali baru menghasilkan berkas berbeda");
  tegas(baca(a) === tulisJson(buatKonsep(data, { jenis: "promo", alur: "standar", judul: "Promo Contoh Fiktif" })), "CLI berbeda dari buatKonsep");
  const k = JSON.parse(baca(a));
  tegas(k.id === "promo-contoh-fiktif" && k.tahap === "T1" && k.durasiTarget === 30 && k.rasio === "16:9" && k.caption.burnIn === true, "isi konsep tidak sesuai preset promo");
  tegas(k.persetujuan.map((e) => e.gate).join() === "G1,G2,G3,R1,R2,G4,G5", `gate: ${k.persetujuan.map((e) => e.gate)}`);
  const b1 = join(tmp, "brief1.md"), b2 = join(tmp, "brief2.md");
  for (const f of [b1, b2]) tegas((await konsepJalan("brief", a, "--out", f)).kode === 0, "brief gagal");
  tegas(baca(b1) === baca(b2), "dua kali brief menghasilkan berkas berbeda");
  const md = baca(b1);
  for (const s of ["# Brief: Promo Contoh Fiktif", "## Struktur adegan", "## Preset terpilih dan tingkat bukti", "## Rencana alur dan gate", "## Persetujuan", "[isi]", "keputusan-desain"]) tegas(md.includes(s), `brief tanpa "${s}"`);
  tegas(md === buatBrief(data, k), "CLI brief berbeda dari buatBrief");
  tegas(!/\d{4}-\d{2}-\d{2}T/.test(md), "brief memuat cap waktu");
  // semua 13 jenis x 5 alur: konsep sah dan brief bisa dibuat
  for (const j of Object.keys(data.jenis.jenis)) {
    for (const al of Object.keys(data.alur.alur)) {
      const kk = buatKonsep(data, { jenis: j, alur: al, judul: "x" });
      const g = galatDari(kk);
      tegas(g.length === 0, `${j}/${al}: ${g[0]}`);
      tegas(buatBrief(data, kk).includes(data.jenis.jenis[j].label), `${j}/${al}: brief tanpa label`);
    }
  }
  const tanpa = await konsepJalan("baru");
  tegas(tanpa.kode === 2 && /formal/.test(tanpa.err) && /dokumenter/.test(tanpa.err) && /ringkas/.test(tanpa.err), `tanpa argumen: exit ${tanpa.kode}`);
  tegas((await konsepJalan("baru", "--jenis", "promo")).kode === 2, "tanpa --alur harus exit 2");
  tegas((await konsepJalan("baru", "--jenis", "promo", "--alur", "standar")).kode === 2, "tanpa --out harus exit 2");
  tegas((await konsepJalan("baru", "--jenis", "ngawur", "--alur", "standar", "--out", join(tmp, "x.json"))).kode === 2, "jenis ngawur harus exit 2");
  tegas((await konsepJalan(...args, "--out", a)).kode === 2, "menimpa tanpa --timpa harus exit 2");
  tegas((await konsepJalan(...args, "--out", a, "--timpa")).kode === 0, "--timpa harus berhasil");
  const d = await konsepJalan("daftar");
  tegas(d.kode === 0 && /formal/.test(d.out) && /instruksional/.test(d.out), "daftar gagal");
  tegas((await konsepJalan("daftar", "jenis", "promo")).kode === 0 && (await konsepJalan("daftar", "alur", "formal")).kode === 0, "daftar rincian gagal");
  tegas((await konsepJalan("daftar", "jenis", "ngawur")).kode === 2, "daftar kunci ngawur harus exit 2");
});

// ----------------------------------------------------------------- (c) periksa konsep
daftar("(c) periksa menolak konsep rusak dan data pribadi; templat konsep-contoh lolos", async () => {
  const dasar = () => konsepIsi("promo", "standar");
  tegas(galatDari(dasar()).length === 0, `konsep dasar: ${galatDari(dasar())[0]}`);
  const kasus = [
    [(k) => { k.jenis = "ngawur"; }, /jenis tidak dikenal/],
    [(k) => { k.alur = "ngawur"; }, /alur tidak dikenal/],
    [(k) => { k.tahap = "T99"; }, /tahap tidak dikenal/],
    [(k) => { k.durasiTarget = 61; }, /melebihi durasi maks preset/],
    [(k) => { k.rasio = "4:5"; }, /rasio .* tidak sesuai preset/],
    [(k) => { k.override = { fooBar: 1 }; k.overrideAlasan = "x"; }, /kunci tidak dikenal/],
    [(k) => { k.override = { tipografi: { lowerThird: 0.04 } }; k.overrideAlasan = "x"; }, /tipografi\.lowerThird: kunci tidak dikenal/],
    [(k) => { k.override = { durasiMaks: 90 }; }, /overrideAlasan/],
    [(k) => { k.override = { kontrasMin: 3 }; k.overrideAlasan = "x"; }, /kontrasMin/],
    [(k) => { k.override = { easing: { masuk: "memantul" } }; k.overrideAlasan = "x"; }, /easing\.masuk/],
    [(k) => { k.override = { durasiMaks: "banyak" }; k.overrideAlasan = "x"; }, /tipe tidak sesuai/],
    [(k) => { k.rahasia = 1; }, /kunci tidak dikenal di konsep: rahasia/],
    [(k) => { k.caption.cps = 0; }, /caption\.cps/],
    [(k) => { k.kenyaringan = "mati"; }, /kenyaringan/],
    [(k) => { k.jenis = "internal"; k.alur = "ringkas"; k.rasio = "16:9"; k.durasiTarget = 100; k.narasi.mode = "tts-daring"; }, /tts-daring/],
    [(k) => { k.tahap = "T2"; k.tujuan = ""; }, /tujuan: belum terisi/],
    [(k) => { k.persetujuan[0].gate = "G9"; }, /gate tidak dikenal/],
    [(k) => { k.persetujuan[0].status = "disetujui"; }, /disetujui tanpa "oleh"/],
  ];
  for (const [ubah, re] of kasus) {
    const k = dasar();
    ubah(k);
    const g = galatDari(k);
    tegas(ada(g, re), `harus galat ${re}; dapat: ${g.join(" | ") || "(tidak ada)"}`);
  }
  // override sah: durasi maks dinaikkan dengan alasan
  const sah = dasar();
  sah.override = { durasiMaks: 90 };
  sah.overrideAlasan = "Kampanye khusus memakai format 90 detik.";
  sah.durasiTarget = 80;
  tegas(galatDari(sah).length === 0, `override sah: ${galatDari(sah)[0]}`);
  // data pribadi: nilai tidak boleh ikut dicetak
  const pribadi = {
    surel: ["nama.fiktif@contoh.id", "surel"],
    nik: ["NIK 3201010101010001 tercantum", "NIK"],
    nip: ["NIP 198001012005011001 tercantum", "NIP"],
    telepon: ["hubungi 081234567890", "nomor telepon"],
    teleponTetap: ["hubungi 0536-3221234", "nomor telepon"],
    plus62: ["hubungi +628123456789", "nomor telepon"],
  };
  for (const [nama, [teks, jenis]] of Object.entries(pribadi)) {
    const k = dasar();
    k.pesanUtama = teks;
    const g = galatDari(k);
    tegas(ada(g, new RegExp(`pesanUtama: tampak memuat ${jenis}`)), `${nama}: tidak terdeteksi (${g.join(" | ")})`);
    tegas(!g.join("\n").includes(teks.match(/\S*\d\S*|\S+@\S+/)[0]), `${nama}: nilai data pribadi ikut tercetak`);
  }
  const bersih = dasar();
  bersih.pesanUtama = "Diskon 50 persen sampai 31 Desember 2026, 3 langkah mudah.";
  tegas(galatDari(bersih).length === 0, `teks biasa salah dikira data pribadi: ${galatDari(bersih)[0]}`);
  const berhash = dasar();
  berhash.persetujuan[0].hash = "1234567890123456".repeat(4);
  tegas(galatDari(berhash).length === 0, "hash berderet digit salah dikira data pribadi");
  // CLI: exit code
  tegas((await konsepJalan("periksa", simpanJson("ok.json", dasar()))).kode === 0, "konsep dasar harus exit 0");
  const rusak = dasar(); rusak.durasiTarget = 999;
  const r = await konsepJalan("periksa", simpanJson("rusak.json", rusak));
  tegas(r.kode === 2 && /GAGAL/.test(r.out), `konsep rusak harus exit 2, dapat ${r.kode}`);
  const pii = dasar(); pii.tujuan = "kirim ke nama.fiktif@contoh.id";
  const rp = await konsepJalan("periksa", simpanJson("pii.json", pii));
  tegas(rp.kode === 2 && !/nama\.fiktif@contoh\.id/.test(rp.out + rp.err), "data pribadi harus exit 2 tanpa mencetak nilainya");
  const bukanJson = join(tmp, "bukan.json"); writeFileSync(bukanJson, "{ bukan json");
  tegas((await konsepJalan("periksa", bukanJson)).kode === 2, "JSON rusak harus exit 2");
  tegas((await konsepJalan("periksa", join(tmp, "tidak-ada.json"))).kode === 2, "berkas tidak ada harus exit 2");
  tegas((await konsepJalan("brief", simpanJson("rusak2.json", rusak))).kode === 2, "brief dari konsep rusak harus exit 2");
  // templat contoh: lolos, fiktif, brief tidak basi
  const kc = JSON.parse(baca(join(contohDir, "konsep.json")));
  tegas(galatDari(kc).length === 0 && kc.kepatuhan.dataNyata === false, `templat contoh: ${galatDari(kc)[0]}`);
  tegas(baca(join(contohDir, "brief.md")) === buatBrief(data, kc), "templates/konsep-contoh/brief.md basi: jalankan bun run konsep -- brief");
  tegas((await konsepJalan("periksa", join(contohDir, "konsep.json"))).kode === 0, "templat contoh harus exit 0");
});

// ----------------------------------------------------------------- (d) setuju
daftar("(d) setuju: urutan gate formal, tanggal wajib, hash sha256, deterministik", async () => {
  const f = simpanJson("formal.json", konsepIsi("formal", "formal"));
  const video = join(tmp, "final.bin");
  writeFileSync(video, "isi video fiktif versi 1");
  const setuju = (gate, ...lain) => konsepJalan("setuju", f, "--gate", gate, "--oleh", "Peran Uji", "--tanggal", "2026-11-07", ...lain);
  const awal = baca(f);
  // validasi argumen
  tegas((await konsepJalan("setuju", f, "--gate", "G1", "--oleh", "PJ")).kode === 2, "tanpa --tanggal harus exit 2");
  tegas((await konsepJalan("setuju", f, "--gate", "G1", "--oleh", "PJ", "--tanggal", "2026-02-30")).kode === 2, "tanggal tidak sah harus exit 2");
  tegas((await konsepJalan("setuju", f, "--gate", "G1", "--tanggal", "2026-11-07")).kode === 2, "tanpa --oleh harus exit 2");
  tegas((await setuju("G9")).kode === 2, "gate tak dikenal harus exit 2");
  // urutan
  const lompat = await setuju("G2");
  tegas(lompat.kode === 2 && /berurutan/.test(lompat.err), `G2 sebelum G1: exit ${lompat.kode} ${lompat.err}`);
  tegas(baca(f) === awal, "berkas berubah setelah penolakan");
  const g1 = await setuju("G1");
  tegas(g1.kode === 0, `G1: ${g1.err}`);
  tegas(JSON.parse(baca(f)).tahap === "T2", "tahap harus maju ke T2 setelah G1");
  tegas((await setuju("G1")).kode === 2, "G1 dua kali harus exit 2");
  tegas((await setuju("R1")).kode === 2, "R1 sebelum G2, G3 harus exit 2");
  for (const g of ["G2", "G3", "R1", "R2", "G4"]) tegas((await setuju(g)).kode === 0, `gate ${g} gagal`);
  const g5tanpa = await setuju("G5");
  tegas(g5tanpa.kode === 2 && /--berkas/.test(g5tanpa.err), "G5 tanpa --berkas harus exit 2");
  tegas((await setuju("G5", "--berkas", video)).kode === 0, "G5 dengan --berkas gagal");
  tegas((await konsepJalan("periksa", f)).kode === 0, "periksa konsep harus lolos di tengah alur");
  tegas((await setuju("G6", "--berkas", video)).kode === 0, "G6 gagal");
  const k = JSON.parse(baca(f));
  const e5 = k.persetujuan.find((e) => e.gate === "G5");
  tegas(e5.hash === sha(video) && e5.berkas === "final.bin" && e5.tanggal === "2026-11-07" && e5.oleh === "Peran Uji", `rekaman G5: ${JSON.stringify(e5)}`);
  tegas(k.persetujuan.every((e) => e.status === "disetujui") && k.tahap === "T9", `status akhir: tahap ${k.tahap}`);
  // pengesahan atas versi ber-hash
  tegas((await konsepJalan("periksa", f, "--video", video)).kode === 0, "--video sama harus lolos");
  const lain = join(tmp, "final-lain.bin"); writeFileSync(lain, "isi video fiktif versi 2");
  const beda = await konsepJalan("periksa", f, "--video", lain);
  tegas(beda.kode === 2 && /hash/.test(beda.out), "video berbeda dari yang disahkan harus exit 2");
  // berkas tangan: gate terlompat dalam persetujuan -> periksa menolak
  const curang = konsepIsi("formal", "formal");
  curang.persetujuan.find((e) => e.gate === "G3").status = "disetujui";
  Object.assign(curang.persetujuan.find((e) => e.gate === "G3"), { oleh: "X", tanggal: "2026-11-07" });
  tegas(ada(galatDari(curang), /G3 disetujui sebelum G1/), "persetujuan terlompat harus ditolak");
  const kurang = konsepIsi("formal", "formal"); kurang.persetujuan.pop();
  tegas(ada(galatDari(kurang), /harus memuat gate G6/), "formal harus memuat G1-G6");
  // konsep belum lengkap: G1 ditolak agar tahap berikut tidak langsung galat
  const kosong = buatKonsep(data, { jenis: "formal", alur: "formal" });
  const fk = simpanJson("kosong.json", kosong);
  const tolak = await konsepJalan("setuju", fk, "--gate", "G1", "--oleh", "PJ", "--tanggal", "2026-11-07");
  tegas(tolak.kode === 2 && /lengkapi/.test(tolak.err) && baca(fk) === tulisJson(kosong), "G1 pada konsep kosong harus ditolak tanpa mengubah berkas");
  // alur non-formal: urutan longgar (catatan saja) dan deterministik
  const mulai = konsepIsi("sosial", "ringkas");
  const r1 = simpanJson("r1.json", mulai), r2 = simpanJson("r2.json", mulai);
  for (const ff of [r1, r2]) {
    const r = await konsepJalan("setuju", ff, "--gate", "G2", "--oleh", "QC", "--tanggal", "2026-11-07", "--berkas", video);
    tegas(r.kode === 0 && /sebelum G1/.test(r.err), `ringkas G2 dahulu: exit ${r.kode} ${r.err}`);
  }
  tegas(baca(r1) === baca(r2), "setuju tidak deterministik");
  tegas(galatDari(JSON.parse(baca(r1))).length === 0, "hasil setuju ringkas harus sah");
});

// ----------------------------------------------------------------- (e) salinan preset runtime
daftar("(e) salinan preset runtime sinkron dengan data; presetJenis berfungsi", async () => {
  tegas(existsSync(BERKAS.presetJs), "scripts/preset-jenis.js tidak ada: jalankan bun run konsep -- sinkron-preset");
  tegas(baca(BERKAS.presetJs) === bangunPresetJs(data), "scripts/preset-jenis.js basi: jalankan bun run konsep -- sinkron-preset");
  tegas((await konsepJalan("sinkron-preset", "--periksa")).kode === 0, "sinkron-preset --periksa harus exit 0");
  const basi = join(tmp, "preset-basi.js");
  writeFileSync(basi, baca(BERKAS.presetJs).replace('"durasiTarget":30', '"durasiTarget":31'));
  tegas((await konsepJalan("sinkron-preset", "--periksa", "--keluar", basi)).kode === 1, "salinan basi harus exit 1");
  tegas((await konsepJalan("sinkron-preset", "--keluar", basi)).kode === 0 && baca(basi) === baca(BERKAS.presetJs), "sinkron-preset harus menulis ulang");
  // runtime
  let lempar = "";
  try { rt.presetJenis("promo"); } catch (e) { lempar = e.message; }
  tegas(/preset-jenis\.js/.test(lempar), `tanpa data harus melempar galat berpetunjuk: ${lempar}`);
  await import(pathToFileURL(BERKAS.presetJs).href);
  for (const [k, j] of Object.entries(data.jenis.jenis)) {
    const p = rt.presetJenis(k);
    tegas(p.kunci === k && JSON.stringify({ ...p, kunci: undefined }) === JSON.stringify(j), `presetJenis(${k}) berbeda dari data`);
  }
  const p1 = rt.presetJenis("sosial");
  p1.nilai.durasiMaks = 1;
  tegas(rt.presetJenis("sosial").nilai.durasiMaks === 60, "presetJenis harus mengembalikan salinan");
  tegas(typeof globalThis.window.presetJenis === "function" && globalThis.window.VideoTerprogram.presetJenis === rt.presetJenis, "presetJenis harus global dan di VideoTerprogram");
  for (const salah of ["ngawur", undefined, "__proto__", "constructor"]) {
    let msg = "";
    try { rt.presetJenis(salah); } catch (e) { msg = e.message; }
    tegas(/jenis tidak dikenal/.test(msg) && /formal/.test(msg), `presetJenis(${String(salah)}) harus melempar: ${msg}`);
  }
  // preset efektif lewat CLI (injeksi props)
  const ko = konsepIsi("promo", "standar", { override: { cps: 20 }, overrideAlasan: "Teks pendek dan cepat." });
  const out = await konsepJalan("preset", simpanJson("ov.json", ko));
  const pr = JSON.parse(out.out);
  tegas(out.kode === 0 && pr.jenis === "promo" && pr.preset.cps === 20 && pr.preset.durasiMaks === 60, `preset efektif: ${out.out.slice(0, 120)}`);
});

// ----------------------------------------------------------------- (f) periksa --konsep
async function buatVideo(nama, ukuran) {
  const f = join(tmp, nama);
  const r = await jalankan(["ffmpeg", "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x336699:s=${ukuran}:r=30:d=3`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-vf", "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", f]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
  return f;
}
async function periksaJson(video, ...opsi) {
  const r = await jalankan(["bun", periksaCli, video, "--json", ...opsi]);
  let hasil = null;
  try { hasil = JSON.parse(r.out); } catch { /* biarkan null */ }
  return { kode: r.kode, hasil, err: r.err, cari: (id) => hasil?.pemeriksaan.find((p) => p.id === id) };
}

daftar("(f) periksa --konsep memakai ambang preset (durasi maks, rasio, cps, kenyaringan, burn-in)", async () => {
  const [v169] = await Promise.all([buatVideo("v169.mp4", "320x180")]);
  const kP = simpanJson("k-promo.json", buatKonsep(data, { jenis: "promo", alur: "standar", judul: "Promo" }));
  const kV = simpanJson("k-vertikal.json", { ...buatKonsep(data, { jenis: "promo", alur: "standar", judul: "Promo" }), rasio: "9:16" });
  const kPendek = simpanJson("k-pendek.json", konsepIsi("promo", "standar", { override: { durasiMaks: 2 }, overrideAlasan: "Spot ekstra pendek.", durasiTarget: 2 }));
  const kSiaran = simpanJson("k-siaran.json", { ...buatKonsep(data, { jenis: "psa", alur: "standar", judul: "PSA" }), kenyaringan: "siaran" });
  const kSosial = simpanJson("k-sosial.json", buatKonsep(data, { jenis: "sosial", alur: "ringkas", judul: "Sosial" }));
  const kRusak = simpanJson("k-rusak.json", { ...buatKonsep(data, { jenis: "promo", alur: "standar" }), durasiTarget: 999 });
  const vtt = join(tmp, "cepat.vtt");
  writeFileSync(vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHalo halo halo halo\n"); // 19 karakter per detik
  const [a, b, c, d, dFlag, e, eFlag, eTanpa, f, tanpaKonsep] = await Promise.all([
    periksaJson(v169, "--konsep", kP),
    periksaJson(v169, "--konsep", kV),
    periksaJson(v169, "--konsep", kPendek, "--jenis", "promo"),
    periksaJson(v169, "--konsep", kSiaran),
    periksaJson(v169, "--konsep", kSiaran, "--kenyaringan", "web"),
    periksaJson(v169, "--konsep", kSosial, "--subtitle", vtt),
    periksaJson(v169, "--konsep", kSosial, "--subtitle", vtt, "--cps", "17"),
    periksaJson(v169, "--subtitle", vtt),
    jalankan(["bun", periksaCli, v169, "--konsep", kRusak]),
    periksaJson(v169),
  ]);
  // a: promo 16:9, 3 s
  tegas(a.cari("rasio")?.status === "LOLOS" && a.cari("rasio").wajib === true, `rasio sesuai: ${JSON.stringify(a.cari("rasio"))}`);
  tegas(a.cari("durasi")?.status === "LOLOS" && a.cari("durasi").data.maks === 60 && a.cari("durasi").data.jenis === "promo", `durasi: ${JSON.stringify(a.cari("durasi"))}`);
  tegas(a.cari("burn-in")?.status === "INFO" && a.cari("burn-in").data.burnIn === true && a.cari("burn-in").wajib === false, "burn-in harus INFO (promo: ya)");
  tegas(a.hasil.konsep.jenis === "promo" && a.hasil.konsep.alur === "standar", "hasil.konsep tidak lengkap");
  tegas(a.cari("encoding").status === "LOLOS" && a.cari("kilatan").status === "LOLOS", "pemeriksaan dasar tetap berjalan");
  // b: rasio konsep 9:16, video 16:9
  tegas(b.cari("rasio").status === "GAGAL" && b.kode === 1 && b.hasil.lolos === false, `rasio berbeda harus GAGAL dan exit 1: ${b.kode}`);
  // c: durasi maks override 2 s, video 3 s -> peringatan; --jenis diabaikan
  tegas(c.cari("durasi").status === "PERINGATAN" && c.cari("durasi").data.maks === 2 && c.cari("durasi").rincian.some((x) => /--jenis diabaikan/.test(x)), `durasi override: ${JSON.stringify(c.cari("durasi"))}`);
  tegas(c.cari("durasi").wajib === false, "durasi tidak wajib");
  // d: kenyaringan dari konsep, flag eksplisit menang
  tegas(d.cari("kenyaringan").nama === "Kenyaringan (siaran)" && d.cari("kenyaringan").data.target.I === -23, `kenyaringan konsep: ${d.cari("kenyaringan").nama}`);
  tegas(dFlag.cari("kenyaringan").nama === "Kenyaringan (web)" && dFlag.cari("kenyaringan").data.target.I === -16, "--kenyaringan eksplisit harus menang");
  // e: cps dari konsep sosial (20) memperbolehkan 19 cps; flag eksplisit 17 atau tanpa konsep menolak
  tegas(e.cari("subtitle").status === "LOLOS" && e.cari("subtitle").data.cps === 20, `cps konsep sosial: ${JSON.stringify(e.cari("subtitle")?.rincian)}`);
  tegas(eFlag.cari("subtitle").status === "GAGAL" && eFlag.cari("subtitle").data.cps === 17, "--cps eksplisit harus menang");
  tegas(eTanpa.cari("subtitle").status === "GAGAL" && eTanpa.cari("subtitle").data.cps === 17, "tanpa --konsep bawaan tetap 17 cps");
  // f: konsep rusak -> exit 2
  tegas(f.kode === 2 && /konsep tidak valid/.test(f.err), `konsep rusak: exit ${f.kode} ${f.err.split("\n")[0]}`);
  tegas((await jalankan(["bun", periksaCli, v169, "--konsep", join(tmp, "tidak-ada.json")])).kode === 2, "--konsep berkas tidak ada harus exit 2");
  // tanpa --konsep: perilaku lama (tidak ada pemeriksaan rasio/burn-in, durasi INFO)
  tegas(!tanpaKonsep.cari("rasio") && !tanpaKonsep.cari("burn-in") && tanpaKonsep.cari("durasi").status === "INFO" && !tanpaKonsep.hasil.konsep, "tanpa --konsep perilaku harus tidak berubah");
});

// ----------------------------------------------------------------- jalankan
const t0 = Date.now();
let gagal = 0;
try {
  for (const [nama, fn] of uji) {
    const t = Date.now();
    try {
      await fn();
      console.log(`LOLOS  ${nama} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    } catch (e) {
      gagal++;
      console.log(`GAGAL  ${nama}: ${e.message}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${uji.length - gagal}/${uji.length} lolos, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(gagal ? 1 : 0);
