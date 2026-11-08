#!/usr/bin/env bun
/**
 * uji-timeline.mjs — uji validator timeline (timeline.mjs): skema, aturan R01-R17, peringatan,
 * rujukan ke manifest nyata, kode keluar CLI, pemetaan waktu permil (termasuk kesetaraan dengan
 * runtime.js), dan kebijakan kutipan.
 * Fixture: templat templates/timeline-contoh (aset buatan sendiri) disalin ke folder sementara;
 * tidak ada aset pihak ketiga dan tidak memerlukan Chromium. Exit 0 bila semua lolos, 1 bila gagal.
 *
 *   bun scripts/uji-timeline.mjs [--hanya h]   # hanya uji yang namanya diawali "(h)"
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { muatKonteks, muatSkema, offsetMaks, periksaAturan, periksaTimeline, petaWaktu, validasiSkema } from "./timeline.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const timelineMjs = join(akar, "scripts", "timeline.mjs");
const klipMjs = join(akar, "scripts", "klip.mjs");
const templat = join(akar, "templates", "timeline-contoh");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-timeline-"));
const hanyaIdx = process.argv.indexOf("--hanya");
const hanya = hanyaIdx > 0 ? `(${process.argv[hanyaIdx + 1]})` : null;
const j = (...p) => join(tmp, ...p);
const muat = createRequire(import.meta.url);
const RT = muat("./runtime.js");
const TR = muat("./transisi.js");

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function samaIsi(a, b, nama) {
  tegas(JSON.stringify(a) === JSON.stringify(b), `${nama}: dapat ${JSON.stringify(a)}, harapan ${JSON.stringify(b)}`);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const bun = (...a) => jalankan(["bun", ...a]);
const salin = (o) => JSON.parse(JSON.stringify(o));
const tulisJson = (f, o) => writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);
const bacaJson = (f) => JSON.parse(readFileSync(f, "utf8"));

const dirDasar = j("dasar");
cpSync(templat, dirDasar, { recursive: true });
const tlDasar = bacaJson(join(dirDasar, "timeline.json"));
const tlSederhana = bacaJson(join(dirDasar, "timeline-sederhana.json"));
let konDasar;
async function konteksDasar() {
  konDasar ??= await muatKonteks(tlDasar, dirDasar);
  return konDasar;
}
/** Jalankan aturan pada timeline dasar yang diubah `ubah`, memakai konteks manifest yang sudah dimuat. */
async function aturanDengan(ubah, { konteks, t0 = tlDasar, opsi } = {}) {
  const t = salin(t0);
  ubah(t);
  const g = validasiSkema(t);
  tegas(g.length === 0, `fixture melanggar skema: ${JSON.stringify(g.slice(0, 3))}`);
  return periksaAturan(t, konteks ?? await konteksDasar(), opsi);
}
const kodeAda = (r, kode, prefiksLok) => r.galat.find((x) => x.kode === kode && (prefiksLok === undefined || x.lok.startsWith(prefiksLok)));
const ringkas = (r) => JSON.stringify(r.galat.map((x) => `${x.kode} ${x.lok}: ${x.pesan.slice(0, 70)}`));

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

// =============================================================== (a) contoh lolos
daftar("(a) contoh templates/timeline-contoh lolos: in-process dan CLI (kode keluar 0, tanpa peringatan)", async () => {
  for (const [nama, t] of [["timeline.json", tlDasar], ["timeline-sederhana.json", tlSederhana]]) {
    const r = await periksaTimeline(t, { dir: dirDasar });
    tegas(r.lolos && r.galat.length === 0, `${nama}: ${ringkas(r)}`);
    samaIsi(r.peringatan, [], `${nama} peringatan`);
    const c = await bun(timelineMjs, "periksa", join(dirDasar, nama));
    tegas(c.kode === 0, `${nama} CLI exit ${c.kode}: ${c.out}${c.err}`);
    tegas(c.out.includes("LOLOS"), `${nama} CLI: ${c.out}`);
  }
  const r = await periksaTimeline(tlDasar, { dir: dirDasar });
  samaIsi(r.ringkasan, { track: 7, butir: 11, transisi: 2, frame: 450, fps: 30, detik: 15 }, "ringkasan");
  // determinisme keluaran: dua kali jalan, keluaran JSON identik
  const a = await bun(timelineMjs, "periksa", join(dirDasar, "timeline.json"), "--json");
  const b = await bun(timelineMjs, "periksa", join(dirDasar, "timeline.json"), "--json");
  tegas(a.out === b.out && JSON.parse(a.out).lolos === true, "keluaran --json tidak deterministik");
});

// =============================================================== (b) kode keluar CLI
daftar("(b) CLI: kode keluar 2 untuk galat skema, JSON rusak, berkas hilang, argumen salah; --json; petunjuk", async () => {
  const dir = j("cli");
  cpSync(templat, dir, { recursive: true });
  // galat skema: bidang asing + fps pecahan + jenis butir salah
  const rusak = salin(tlDasar);
  rusak.proyek.fps = 29.97;
  rusak.track[0].butir[0].kecepatan = 2;
  rusak.bidangAsing = true;
  tulisJson(join(dir, "rusak.json"), rusak);
  const r = await bun(timelineMjs, "periksa", join(dir, "rusak.json"));
  tegas(r.kode === 2, `galat skema harus exit 2, dapat ${r.kode}: ${r.out}${r.err}`);
  for (const potong of ["[SKEMA] /proyek/fps", '[SKEMA] /track/0/butir/0/kecepatan', '[SKEMA] /bidangAsing', "GAGAL: 3 galat"]) {
    tegas(r.out.includes(potong), `keluaran harus memuat ${potong}:\n${r.out}`);
  }
  const rj = await bun(timelineMjs, "periksa", join(dir, "rusak.json"), "--json");
  tegas(rj.kode === 2, `--json galat harus exit 2, dapat ${rj.kode}`);
  const hj = JSON.parse(rj.out);
  tegas(hj.lolos === false && hj.galat.length === 3 && hj.galat.every((x) => x.kode === "SKEMA" && x.lok.startsWith("/")), `JSON galat: ${rj.out}`);
  // JSON tidak valid
  writeFileSync(join(dir, "bukan.json"), "{ ini bukan json");
  const b = await bun(timelineMjs, "periksa", join(dir, "bukan.json"));
  tegas(b.kode === 2 && b.err.includes("bukan JSON valid"), `JSON rusak: exit ${b.kode} ${b.err}`);
  // berkas tidak ada
  const h = await bun(timelineMjs, "periksa", join(dir, "tidak-ada.json"));
  tegas(h.kode === 2 && h.err.includes("tidak ditemukan"), `berkas hilang: exit ${h.kode} ${h.err}`);
  // argumen
  const p = await bun(timelineMjs, "periksa", "a.json", "b.json");
  tegas(p.kode === 2, `dua berkas harus exit 2, dapat ${p.kode}`);
  const s = await bun(timelineMjs, "periksa", join(dir, "timeline.json"), "--tidak-dikenal");
  tegas(s.kode === 2, `opsi asing harus exit 2, dapat ${s.kode}`);
  const x = await bun(timelineMjs, "render");
  tegas(x.kode === 2 && x.err.includes("perintah tidak dikenal"), `perintah asing: exit ${x.kode}`);
  const tanpa = await bun(timelineMjs);
  tegas(tanpa.kode === 2 && tanpa.out.includes("Pemakaian"), `tanpa perintah: exit ${tanpa.kode}`);
  const bantu = await bun(timelineMjs, "--help");
  tegas(bantu.kode === 0 && bantu.out.includes("Kode keluar"), `--help: exit ${bantu.kode}`);
  // berkas terlalu besar
  const besar = salin(tlDasar);
  besar.proyek.judul = "x".repeat(10);
  writeFileSync(join(dir, "besar.json"), JSON.stringify(besar) + " ".repeat(5_100_000));
  const bz = await bun(timelineMjs, "periksa", join(dir, "besar.json"));
  tegas(bz.kode === 2 && bz.err.includes("melebihi batas"), `berkas besar: exit ${bz.kode} ${bz.err}`);
});

// =============================================================== (c) skema = kontrak
daftar("(c) skema: sinkron dengan runtime.js dan transisi.js (easing, jenis transisi, jenis animasi) dan metadata skema", async () => {
  const s = muatSkema();
  tegas(s.$schema === "https://json-schema.org/draft/2020-12/schema" && s.$id === "urn:awvd:timeline:skema-1", "metadata skema");
  const enumKf = s.$defs.properti.properties.x.oneOf[1].items.properties.easing.oneOf[0].enum;
  samaIsi(enumKf.slice().sort(), Object.keys(RT.easing).filter((k) => k !== "bezier").sort(), "easing keyframe = runtime.js");
  const enumTr = s.$defs.transisi.properties.easing.oneOf[0].enum;
  samaIsi(enumTr.slice().sort(), Object.keys(TR.easing).filter((k) => k !== "bezier" && k !== "pegasEasing").sort(), "easing transisi = transisi.js");
  const kat = TR.katalog();
  const trNama = kat.filter((x) => x.kategori === "transisi").map((x) => x.nama);
  samaIsi(s.$defs.transisi.properties.jenis.enum.slice().sort(), trNama.filter((n) => n !== "potong").sort(), "jenis transisi = katalog (tanpa potong)");
  const anNama = new Set(kat.filter((x) => x.kategori === "animasi").map((x) => x.nama));
  for (const n of [...s.$defs.animasi.properties.masuk.properties.jenis.enum, ...s.$defs.animasi.properties.penekanan.items.properties.jenis.enum]) {
    tegas(anNama.has(n), `animasi "${n}" tidak ada di katalog transisi.js`);
  }
  samaIsi(s.properties.proyek.properties.jenisVideo.enum.length, 13, "13 jenis video");
  samaIsi(s.properties.track.maxItems, 64, "batas track");
  tegas(!JSON.stringify(s).includes("DRAF"), "skema tidak boleh lagi bertanda DRAF");
});

// =============================================================== (d) kasus negatif skema
const kasusSkema = [
  ["bidang tingkat atas asing", (t) => { t.zzz = 1; }, "/zzz", "tidak dikenal"],
  ["versi skema asing", (t) => { t.skema = 2; }, "/skema", "tidak dikenal"],
  ["skema bukan bilangan bulat", (t) => { t.skema = "1"; }, "/skema", "tidak dikenal"],
  ["proyek.fps pecahan (skema 2)", (t) => { t.proyek.fps = 29.97; }, "/proyek/fps", "integer"],
  ["proyek.fps nol", (t) => { t.proyek.fps = 0; }, "/proyek/fps", ">= 1"],
  ["proyek.durasi melewati batas", (t) => { t.proyek.durasi = 1_000_001; }, "/proyek/durasi", "<= 1000000"],
  ["proyek.lebar tidak ada", (t) => { delete t.proyek.lebar; }, "/proyek", "lebar"],
  ["proyek bidang asing", (t) => { t.proyek.bitrate = 1; }, "/proyek/bitrate", "tidak dikenal"],
  ["profil lansia (durasi diskalakan)", (t) => { t.proyek.profil = "lansia"; }, "/proyek/profil", "salah satu dari standar, kurangiGerak"],
  ["jenisVideo asing", (t) => { t.proyek.jenisVideo = "iklan"; }, "/proyek/jenisVideo", "salah satu dari"],
  ["latar bukan warna hex", (t) => { t.proyek.latar = "hitam"; }, "/proyek/latar", "warna"],
  ["jalur manifes memuat ..", (t) => { t.manifes.aset = "../aset.json"; }, "/manifes/aset", "pola"],
  ["jalur manifes URL", (t) => { t.manifes.sumber = "https://contoh.test/sumber.json"; }, "/manifes/sumber", "pola"],
  ["jalur manifes mutlak", (t) => { t.manifes.aset = "/etc/aset.json"; }, "/manifes/aset", "pola"],
  ["audio.fadeMs di luar rentang", (t) => { t.audio.fadeMs = 50; }, "/audio/fadeMs", ">= 100"],
  ["track kosong", (t) => { t.track = []; }, "/track", "minimal 1"],
  ["track jenis asing", (t) => { t.track[0].jenis = "efek"; }, "/track/0/jenis", "salah satu dari"],
  ["id track salah pola", (t) => { t.track[0].id = "Latar Utama"; }, "/track/0/id", "id harus"],
  ["track video memuat butir teks", (t) => { t.track[0].butir[2] = { id: "teks-x", jenis: "teks", peran: "isi", isi: "x", mulai: 140, durasi: 10 }; }, "/track/0/butir/2/jenis", "salah satu dari video, gambar, warna"],
  ["track teks memuat transisi", (t) => { t.track[3].butir[0].transisi = { jenis: "pudar", durasi: 5 }; }, "/track/3/butir/0/transisi", "tidak dikenal"],
  ["track overlay memuat transisi", (t) => { t.track[1].butir[1].transisi = { jenis: "pudar", durasi: 5 }; }, "/track/1/butir/1/transisi", "tidak diizinkan"],
  ["gainDb di track video", (t) => { t.track[0].gainDb = -3; }, "/track/0/gainDb", "tidak diizinkan"],
  ["track audio memuat butir video", (t) => { t.track[5].butir[0] = { id: "v", jenis: "video", klip: "k1", mulai: 0, durasi: 5 }; }, "/track/5/butir/0/jenis", "audio"],
  ["butir tanpa durasi", (t) => { delete t.track[0].butir[0].durasi; }, "/track/0/butir/0", "durasi"],
  ["butir mulai negatif", (t) => { t.track[0].butir[0].mulai = -1; }, "/track/0/butir/0/mulai", ">= 0"],
  ["butir durasi pecahan", (t) => { t.track[0].butir[0].durasi = 10.5; }, "/track/0/butir/0/durasi", "integer"],
  ["butir video tanpa klip", (t) => { delete t.track[0].butir[0].klip; }, "/track/0/butir/0", "klip"],
  ["butir video bidang asing", (t) => { t.track[0].butir[0].volume = 1; }, "/track/0/butir/0/volume", "tidak dikenal"],
  ["butir video memuat aset (bukan klip)", (t) => { t.track[0].butir[0].aset = "logo-contoh"; }, "/track/0/butir/0/aset", "tidak dikenal"],
  ["id klip salah pola", (t) => { t.track[0].butir[0].klip = "../k1"; }, "/track/0/butir/0/klip", "id harus"],
  ["waktu.kecepatan 0", (t) => { t.track[0].butir[1].waktu.kecepatan = 0; }, "/track/0/butir/1/waktu/kecepatan", ">= 0.1"],
  ["waktu.kecepatan teks", (t) => { t.track[0].butir[1].waktu.kecepatan = "cepat"; }, "/track/0/butir/1/waktu/kecepatan", "bentuk"],
  ["waktu.habis asing", (t) => { t.track[0].butir[1].waktu.habis = "ulangi"; }, "/track/0/butir/1/waktu/habis", "salah satu dari tolak, tahan, ulang"],
  ["audio.mode asing", (t) => { t.track[0].butir[0].audio.mode = "keras"; }, "/track/0/butir/0/audio/mode", "salah satu dari"],
  ["transisi.jenis asing", (t) => { t.track[0].butir[1].transisi.jenis = "potong"; }, "/track/0/butir/1/transisi/jenis", "salah satu dari"],
  ["transisi bidang asing", (t) => { t.track[0].butir[1].transisi.cepat = true; }, "/track/0/butir/1/transisi/cepat", "tidak dikenal"],
  ["transisi.durasi nol", (t) => { t.track[0].butir[1].transisi.durasi = 0; }, "/track/0/butir/1/transisi/durasi", ">= 1"],
  ["transisi.easing nama asing", (t) => { t.track[0].butir[1].transisi.easing = "melompat"; }, "/track/0/butir/1/transisi/easing", "salah satu dari"],
  ["transisi.easing bezier salah", (t) => { t.track[0].butir[1].transisi.easing = [2, 0, 0.5, 1]; }, "/track/0/butir/1/transisi/easing/0", "<= 1"],
  ["keyframe hanya satu titik", (t) => { t.track[1].butir[0].properti.opasitas = [{ pada: 0, nilai: 0 }]; }, "/track/1/butir/0/properti/opasitas", "minimal 2 anggota"],
  ["keyframe nilai di luar rentang", (t) => { t.track[1].butir[0].properti.opasitas[1].nilai = 2; }, "/track/1/butir/0/properti/opasitas/1/nilai", "<= 1"],
  ["keyframe easing asing", (t) => { t.track[1].butir[0].properti.opasitas[0].easing = "melenting"; }, "/track/1/butir/0/properti/opasitas/0/easing", "salah satu dari"],
  ["properti asing", (t) => { t.track[1].butir[0].properti.blur = 3; }, "/track/1/butir/0/properti/blur", "tidak dikenal"],
  ["tata.lebar nol", (t) => { t.track[1].butir[0].tata.lebar = 0; }, "/track/1/butir/0/tata/lebar", "> 0"],
  ["tata.fit asing", (t) => { t.track[1].butir[0].tata.fit = "regang"; }, "/track/1/butir/0/tata/fit", "salah satu dari"],
  ["animasi.masuk.jenis asing", (t) => { t.track[3].butir[0].animasi.masuk.jenis = "meledak"; }, "/track/3/butir/0/animasi/masuk/jenis", "salah satu dari"],
  ["teks tanpa peran", (t) => { delete t.track[3].butir[0].peran; }, "/track/3/butir/0", "peran"],
  ["teks isi kosong", (t) => { t.track[3].butir[0].isi = ""; }, "/track/3/butir/0/isi", "pendek"],
  ["teks warna salah", (t) => { t.track[3].butir[0].gaya.warna = "merah"; }, "/track/3/butir/0/gaya/warna", "warna"],
  ["teks.ukuran terlalu kecil", (t) => { t.track[3].butir[0].gaya.ukuran = 2; }, "/track/3/butir/0/gaya/ukuran", ">= 8"],
  ["gambar tanpa aset", (t) => { delete t.track[2].butir[0].aset; }, "/track/2/butir/0", "aset"],
  ["warna butir tanpa warna", (t) => { t.track[0].butir[2] = { id: "w", jenis: "warna", mulai: 140, durasi: 10 }; }, "/track/0/butir/2", "warna"],
  ["audio butir bidang asing", (t) => { t.track[5].butir[0].kenBurns = {}; }, "/track/5/butir/0/kenBurns", "tidak dikenal"],
  ["ducking di luar rentang", (t) => { t.track[6].butir[0].ducking.levelDb = 0; }, "/track/6/butir/0/ducking/levelDb", "<= -8"],
  ["penanda tanpa label", (t) => { delete t.penanda[0].label; }, "/penanda/0", "label"],
  ["penanda terlalu banyak", (t) => { t.penanda = Array.from({ length: 501 }, (_, i) => ({ id: `p${i}`, pada: 0, label: "x" })); }, "/penanda", "maksimal 500"],
  ["butir terlalu banyak (2000)", (t) => { t.track[0].butir = Array.from({ length: 2001 }, (_, i) => ({ id: `w${i}`, jenis: "warna", warna: "#000", mulai: 0, durasi: 1 })); }, "/track/0/butir", "maksimal 2000"],
];
daftar("(d) skema: kasus negatif, tiap galat ber-JSON-pointer yang menunjuk bidang bermasalah (fail-closed)", async () => {
  for (const [nama, ubah, lok, potong] of kasusSkema) {
    const t = salin(tlDasar);
    ubah(t);
    const g = validasiSkema(t);
    const kena = g.find((x) => x.lok === lok && x.pesan.includes(potong));
    tegas(kena, `${nama}: tidak ada galat di ${lok} memuat "${potong}"; dapat ${JSON.stringify(g.slice(0, 4))}`);
    const r = await periksaTimeline(t, { dir: dirDasar });
    tegas(!r.lolos && r.galat.every((x) => x.kode === "SKEMA"), `${nama}: galat skema harus menghentikan pemeriksaan (kode SKEMA saja)`);
  }
  // __proto__ dari JSON ditolak sebagai bidang asing, bukan mencemari prototipe
  const p = JSON.parse('{"__proto__": {"x": 1}, "skema": 1}');
  tegas(validasiSkema(p).some((x) => x.lok === "/__proto__"), "__proto__ harus ditolak");
  tegas(({}).x === undefined, "prototipe Object tercemar");
  // JSON pointer: ~ dan / di nama kunci dilepas (RFC 6901)
  const q = salin(tlDasar);
  q["a/b~c"] = 1;
  tegas(validasiSkema(q).some((x) => x.lok === "/a~1b~0c"), "pointer harus melepas / dan ~");
  // akar bukan objek
  samaIsi(validasiSkema([]).map((x) => x.pesan), ["timeline harus objek JSON"], "akar array");
  samaIsi(validasiSkema(null).length, 1, "akar null");
  // timeline sah minimal
  tegas(validasiSkema({ skema: 1, proyek: { lebar: 16, tinggi: 16, fps: 1, durasi: 1 }, track: [{ id: "a", jenis: "teks", butir: [] }] }).length === 0, "timeline minimal harus lolos skema");
});

// =============================================================== (e) kasus negatif aturan
// Kasus dari prototipe riset #30 (indeks track: 0 latar, 1 pip, 2 logo, 3 teks-1, 4 teks-2, 5 narasi, 6 musik).
const kasusAturan = [
  ["R01", "id butir ganda", (t) => { t.track[1].butir[0].id = "logo"; }, "/track/2/butir/0/id"],
  ["R01", "id track ganda", (t) => { t.track[1].id = "t-latar"; }, "/track/1/id"],
  ["R02", "klip tak tercatat", (t) => { t.track[0].butir[0].klip = "k99"; }, "/track/0/butir/0/klip"],
  ["R02", "aset tak tercatat", (t) => { t.track[2].butir[0].aset = "logo-hantu"; }, "/track/2/butir/0/aset"],
  ["R02", "aset berjenis salah (audio untuk butir gambar)", (t) => { t.track[2].butir[0].aset = "musik-1"; }, "/track/2/butir/0/aset"],
  ["R02", "aset audio untuk butir audio berjenis salah", (t) => { t.track[5].butir[0].aset = "logo-contoh"; }, "/track/5/butir/0/aset"],
  ["R02", "font tak tercatat", (t) => { t.track[3].butir[0].gaya.font = "font-hantu"; }, "/track/3/butir/0/gaya/font"],
  ["R02", "font berjenis salah", (t) => { t.track[3].butir[0].gaya.font = "logo-contoh"; }, "/track/3/butir/0/gaya/font"],
  ["R02", "placeholder [isi]", (t) => { t.track[3].butir[0].isi = "[isi judul]"; }, "/track/3/butir/0/isi"],
  ["R03", "butir melewati proyek.durasi", (t) => { t.track[0].butir[2].durasi = 400; }, "/track/0/butir/2"],
  ["R03", "penanda melewati proyek.durasi", (t) => { t.penanda[1].pada = 450; }, "/penanda/1/pada"],
  ["R04", "tumpang tindih tanpa transisi (video)", (t) => { delete t.track[0].butir[1].transisi; }, "/track/0/butir/1"],
  ["R04", "tumpang tindih tanpa transisi (overlay)", (t) => { t.track[1].butir[1].mulai = 240; }, "/track/1/butir/1"],
  ["R04", "tiga butir bertumpuk", (t) => { t.track[0].butir[2].mulai = 80; t.track[0].butir[2].durasi = 100; }, "/track/0/butir/2"],
  ["R04", "teks tumpang tindih di satu track", (t) => { t.track[3].butir[1].mulai = 100; }, "/track/3/butir/1"],
  ["R05", "transisi.durasi tidak sama dengan tumpang tindih", (t) => { t.track[0].butir[1].transisi.durasi = 10; }, "/track/0/butir/1/transisi/durasi"],
  ["R05", "transisi di butir pertama", (t) => { t.track[0].butir[0].transisi = { jenis: "pudar", durasi: 5 }; }, "/track/0/butir/0/transisi"],
  ["R05", "durasi di bawah minimum jenis kilat", (t) => { const b = t.track[0].butir[1]; b.transisi = { jenis: "kilat", durasi: 8 }; b.mulai = 82; b.durasi = 73; b.waktu = {}; }, "/track/0/butir/1/transisi/durasi"],
  ["R05", "dua transisi berurutan saling tumpang", (t) => { t.track[0].butir[2].mulai = 85; t.track[0].butir[2].transisi.durasi = 5; }, "/track/0/butir/2"],
  ["R06", "dua transisi bersamaan di track berbeda", (t) => { t.track.push({ id: "t-v2", jenis: "video", butir: [{ id: "w1", jenis: "warna", warna: "#111111", mulai: 0, durasi: 95 }, { id: "w2", jenis: "warna", warna: "#222222", mulai: 80, durasi: 100, transisi: { jenis: "pudar", durasi: 15 } }] }); }, "/track/7/butir/1"],
  ["R07", "keyframe pada melewati durasi butir", (t) => { t.track[1].butir[0].properti.opasitas[1].pada = 70; }, "/track/1/butir/0/properti/opasitas/1/pada"],
  ["R07", "keyframe tidak naik tegas", (t) => { t.track[1].butir[0].properti.opasitas[1].pada = 0; }, "/track/1/butir/0/properti/opasitas/1/pada"],
  ["R07", "easing di keyframe terakhir", (t) => { t.track[1].butir[0].properti.opasitas[1].easing = "linear"; }, "/track/1/butir/0/properti/opasitas/1/easing"],
  ["R08", "membaca frame di luar klip", (t) => { t.track[0].butir[1].durasi = 100; t.track[0].butir[2].mulai = 160; t.track[0].butir[2].transisi.durasi = 15; t.track[0].butir[1].waktu.kecepatan = 2; }, "/track/0/butir/1"],
  ["R08", "bekukan dan balik digabung", (t) => { t.track[1].butir[1].waktu.balik = true; }, "/track/1/butir/1/waktu"],
  ["R08", "kecepatan lebih dari 3 desimal", (t) => { t.track[0].butir[1].waktu.kecepatan = 1.2345; }, "/track/0/butir/1/waktu/kecepatan"],
  ["R08", "dari di luar klip", (t) => { t.track[1].butir[0].dari = 95; }, "/track/1/butir/0"],
  ["R09", "audio klip dengan freeze bukan bisu", (t) => { t.track[0].butir[1].audio.mode = "campur"; t.track[0].butir[1].waktu = { bekukan: true }; }, "/track/0/butir/1/audio/mode"],
  ["R09", "audio klip dengan reverse bukan bisu", (t) => { t.track[1].butir[0].audio = { mode: "campur" }; }, "/track/1/butir/0/audio/mode"],
  ["R10", "narasi dipotong", (t) => { t.track[5].butir[0].durasi = 60; }, "/track/5/butir/0"],
  ["R10", "musik tidak mulai di frame 0", (t) => { t.track[6].butir[0].mulai = 30; t.track[6].butir[0].durasi = 400; }, "/track/6/butir/0/mulai"],
  ["R10", "musik membaca melebihi berkas", (t) => { t.track[6].butir[0].dari = 30; }, "/track/6/butir/0"],
  ["R10", "ducking untuk narasi", (t) => { t.track[5].butir[0].ducking = { levelDb: -12 }; }, "/track/5/butir/0/ducking"],
  ["R10", "dua butir musik", (t) => { t.track[6].butir.push({ id: "musik-2", jenis: "audio", aset: "musik-1", mulai: 0, durasi: 100 }); }, "/track"],
  ["R11", "narasi tumpang tindih audio klip bergantian", (t) => { t.track[5].butir[0].mulai = 20; }, "/track/0/butir/0"],
  ["R11", "dua narasi tumpang tindih", (t) => { t.track[5].butir.push({ id: "narasi-b", jenis: "audio", aset: "narasi-1", mulai: 200, durasi: 90 }); }, "/track/5/butir/0"],
  ["R12", "atribusi CC BY tanpa butir kredit", (t) => { t.track[3].butir.pop(); }, "/track"],
  ["R13", "logo di bawah ukuran minimum", (t) => { t.track[2].butir[0].tata.lebar = 60; t.track[2].butir[0].tata.tinggi = 20; }, "/track/2/butir/0/tata"],
  ["R13", "logo mengecil lewat properti.skala", (t) => { t.track[2].butir[0].properti = { skala: 0.4 }; }, "/track/2/butir/0/tata"],
  ["R13", "logo dirotasi", (t) => { t.track[2].butir[0].properti = { rotasi: 5 }; }, "/track/2/butir/0/properti/rotasi"],
  ["R13", "logo didistorsi (fill)", (t) => { t.track[2].butir[0].tata = { x: 40, y: 30, lebar: 300, tinggi: 64, fit: "fill" }; }, "/track/2/butir/0/tata/fit"],
  ["R15", "animasi masuk + keluar melebihi durasi", (t) => { t.track[3].butir[0].animasi.masuk.durasi = 120; t.track[3].butir[0].animasi.keluar.durasi = 100; }, "/track/3/butir/0/animasi"],
  ["R15", "penekanan melewati durasi butir", (t) => { t.track[3].butir[0].animasi.penekanan = [{ jenis: "denyut", mulai: 170, durasi: 30 }]; }, "/track/3/butir/0/animasi/penekanan/0"],
  ["R16", "kenBurns bersama properti.skala", (t) => { t.track[2].butir[0].kenBurns = { dari: {}, ke: {} }; t.track[2].butir[0].properti = { skala: 1 }; }, "/track/2/butir/0/kenBurns"],
];
daftar("(e) aturan lintas-bidang: tiap kasus negatif menghasilkan kode galat dan lokasi yang diharapkan", async () => {
  const kon = await konteksDasar();
  const lihat = new Set();
  for (const [kode, nama, ubah, lok] of kasusAturan) {
    const r = await aturanDengan(ubah, { konteks: kon });
    const kena = kodeAda(r, kode, lok);
    tegas(kena, `${kode} ${nama}: tidak ada galat ${kode} di ${lok}; dapat ${ringkas(r)}`);
    lihat.add(kode);
  }
  for (const kode of ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R15", "R16"]) {
    tegas(lihat.has(kode), `aturan ${kode} tidak punya kasus negatif`);
  }
  // dasar tetap bersih (kasus-kasus tidak bocor lewat konteks bersama)
  const dasar = await aturanDengan(() => {}, { konteks: kon });
  samaIsi(dasar.galat, [], "dasar setelah semua kasus");
});

daftar("(f) AC #31: rujukan aset/klip tak tercatat ditolak; butir tumpang tindih di satu track ditolak; galat skema exit 2", async () => {
  const dir = j("ac");
  cpSync(templat, dir, { recursive: true });
  const jalan = async (nama, ubah) => {
    const t = salin(tlDasar);
    ubah(t);
    tulisJson(join(dir, nama), t);
    return bun(timelineMjs, "periksa", join(dir, nama));
  };
  const a1 = await jalan("a1.json", (t) => { t.track[2].butir[0].aset = "tidak-tercatat"; });
  tegas(a1.kode === 2 && a1.out.includes("[R02] /track/2/butir/0/aset") && a1.out.includes('aset "tidak-tercatat" tidak tercatat di aset.json'), `aset tak tercatat: exit ${a1.kode}\n${a1.out}`);
  const a2 = await jalan("a2.json", (t) => { t.track[0].butir[0].klip = "klip-hantu"; });
  tegas(a2.kode === 2 && a2.out.includes("[R02] /track/0/butir/0/klip") && a2.out.includes("tidak tercatat di sumber.json"), `klip tak tercatat: exit ${a2.kode}\n${a2.out}`);
  const a3 = await jalan("a3.json", (t) => { t.track[3].butir[1].mulai = 100; });
  tegas(a3.kode === 2 && a3.out.includes("[R04] /track/3/butir/1") && a3.out.includes("tumpang tindih"), `tumpang tindih: exit ${a3.kode}\n${a3.out}`);
  const a4 = await jalan("a4.json", (t) => { t.track[0].butir[0].mulai = 10; });
  tegas(a4.kode === 2 && a4.out.includes("[R05]"), `geser butir merusak transisi: exit ${a4.kode}\n${a4.out}`);
  const a5 = await jalan("a5.json", (t) => { delete t.proyek.fps; });
  tegas(a5.kode === 2 && a5.out.includes("[SKEMA] /proyek"), `galat skema: exit ${a5.kode}\n${a5.out}`);
  // timeline tanpa manifes tetapi merujuk media = ditolak (tidak ada rujukan yang bisa diverifikasi)
  const a6 = await jalan("a6.json", (t) => { delete t.manifes; });
  tegas(a6.kode === 2 && a6.out.includes("manifes.sumber tidak diisi") && a6.out.includes("manifes.aset tidak diisi"), `tanpa manifes: exit ${a6.kode}\n${a6.out}`);
  // transisi sah yang bertumpuk BUKAN galat R04 (contoh dasar memilikinya dan lolos)
  const ok = await periksaTimeline(tlDasar, { dir: dirDasar });
  tegas(ok.lolos && ok.ringkasan.transisi === 2, "transisi sah harus diterima");
});

// =============================================================== (g) manifest nyata
daftar("(g) manifest nyata: hash rusak, aset.json cacat, jalur di luar folder, JSON manifest rusak, konflik jenisVideo", async () => {
  const dir = j("manifest");
  cpSync(templat, dir, { recursive: true });
  const jalan = (nama = "timeline.json") => bun(timelineMjs, "periksa", join(dir, nama));
  // 1) bit pada klip berubah: hash tidak cocok -> ditolak lewat validasiManifest
  const klipA = join(dir, "aset", "klip-a.mkv");
  const asli = readFileSync(klipA);
  const ubah = Buffer.from(asli);
  ubah[ubah.length - 1] ^= 0xff;
  writeFileSync(klipA, ubah);
  let r = await jalan();
  tegas(r.kode === 2 && r.out.includes("[R02] sumber.json") && r.out.includes("hash tidak cocok"), `hash klip: exit ${r.kode}\n${r.out}`);
  writeFileSync(klipA, asli);
  // 2) aset.json: lisensi kosong
  const aset = bacaJson(join(dir, "aset.json"));
  const asliAset = salin(aset);
  aset.aset[0].lisensi = "";
  tulisJson(join(dir, "aset.json"), aset);
  r = await jalan();
  tegas(r.kode === 2 && r.out.includes("[R02] aset.json") && r.out.includes("lisensi kosong ditolak"), `aset lisensi: exit ${r.kode}\n${r.out}`);
  // 3) audio tanpa audio.peran
  const a2 = salin(asliAset);
  delete a2.aset[1].audio;
  tulisJson(join(dir, "aset.json"), a2);
  r = await jalan();
  tegas(r.kode === 2 && r.out.includes("audio.peran"), `audio tanpa peran: exit ${r.kode}\n${r.out}`);
  // 4) jenisVideo berbeda dengan aset.json
  const a3 = salin(asliAset);
  a3.proyek.jenisVideo = "formal";
  tulisJson(join(dir, "aset.json"), a3);
  r = await jalan();
  tegas(r.kode === 2 && r.out.includes("[R02] /proyek/jenisVideo"), `jenisVideo: exit ${r.kode}\n${r.out}`);
  tulisJson(join(dir, "aset.json"), asliAset);
  // 5) JSON manifest rusak
  writeFileSync(join(dir, "sumber.json"), "{ rusak");
  r = await jalan();
  tegas(r.kode === 2 && r.out.includes("[R02] /manifes/sumber") && r.out.includes("bukan JSON valid"), `sumber rusak: exit ${r.kode}\n${r.out}`);
  cpSync(join(templat, "sumber.json"), join(dir, "sumber.json"));
  // 6) manifest yang dirujuk tidak ada / lolos skema tetapi di luar folder lewat simlink
  const t = salin(tlDasar);
  t.manifes.aset = "hilang.json";
  tulisJson(join(dir, "hilang.json.tl.json"), t);
  r = await jalan("hilang.json.tl.json");
  tegas(r.kode === 2 && r.out.includes("[R02] /manifes/aset") && r.out.includes("tidak ditemukan"), `manifest hilang: exit ${r.kode}\n${r.out}`);
  // 7) setelah dipulihkan: lolos lagi
  r = await jalan();
  tegas(r.kode === 0, `pemulihan: exit ${r.kode}\n${r.out}`);
  // 8) sumber tak dipakai klip + klip tanpa sumber -> galat dari validasiManifest muncul sebagai R02
  const sm = bacaJson(join(dir, "sumber.json"));
  sm.klip[0].sumber = "tidak-ada";
  tulisJson(join(dir, "sumber.json"), sm);
  r = await jalan();
  tegas(r.kode === 2 && r.out.includes("[R02] sumber.json") && r.out.includes('sumber "tidak-ada" tidak ada di daftar sumber'), `klip tanpa sumber: exit ${r.kode}\n${r.out}`);
});

// =============================================================== (h) pemetaan waktu
daftar("(h) petaWaktu (permil): 2x, 0,5x, reverse, freeze, 0,29x di frame 100, ramp monoton dan deterministik", async () => {
  samaIsi(petaWaktu({ durasi: 5, kecepatan: 2 }), [0, 2, 4, 6, 8], "2x");
  samaIsi(petaWaktu({ durasi: 5, kecepatan: 0.5 }), [0, 0, 1, 1, 2], "0,5x");
  samaIsi(petaWaktu({ durasi: 5 }), [0, 1, 2, 3, 4], "1x identitas");
  samaIsi(petaWaktu({ durasi: 5, kecepatan: 2, balik: true }), [8, 6, 4, 2, 0], "reverse 2x");
  samaIsi(petaWaktu({ durasi: 4, bekukan: true }), [0, 0, 0, 0], "freeze");
  for (const sp of [0.25, 0.5, 1, 1.5, 1.75, 2, 3.333]) {
    for (const d of [1, 2, 7, 30]) {
      const m = petaWaktu({ durasi: d, kecepatan: sp }), b = petaWaktu({ durasi: d, kecepatan: sp, balik: true });
      samaIsi(m.slice().reverse(), b, `reverse = maju dibalik (sp=${sp}, d=${d})`);
      tegas(b[d - 1] === 0 && b[0] === m[d - 1], `batas reverse (sp=${sp}, d=${d})`);
    }
  }
  tegas(Math.floor(100 * 0.29) === 28, "(demonstrasi) lantai floating-point salah");
  samaIsi(petaWaktu({ durasi: 101, kecepatan: 0.29 })[100], 29, "0,29x pada frame 100");
  const ramp = [{ pada: 0, nilai: 1 }, { pada: 30, nilai: 3 }];
  const r1 = petaWaktu({ durasi: 31, kecepatan: ramp }), r2 = petaWaktu({ durasi: 31, kecepatan: ramp });
  samaIsi(r1, r2, "ramp deterministik");
  for (let i = 1; i < r1.length; i++) tegas(r1[i] >= r1[i - 1], "ramp monoton");
  tegas(r1[0] === 0 && r1[30] > 30 && r1[30] < 90, `ramp rentang wajar: ${r1[30]}`);
  for (const [k, d] of [[[{ pada: 0, nilai: 1, easing: "masukQuad" }, { pada: 30, nilai: 4 }], 31], [[{ pada: 0, nilai: 3 }, { pada: 39, nilai: 0.5 }], 40], [[{ pada: 0, nilai: 1, easing: [0.4, 0, 0.2, 1] }, { pada: 20, nilai: 2 }], 25]]) {
    const r = petaWaktu({ durasi: d, kecepatan: k });
    for (let i = 1; i < r.length; i++) tegas(r[i] >= r[i - 1], `ramp ${JSON.stringify(k)} monoton`);
  }
  let melempar = 0;
  for (const f of [() => petaWaktu({ durasi: 3, bekukan: true, balik: true }), () => petaWaktu({ durasi: 0 }), () => petaWaktu({ durasi: 3, kecepatan: 0 }),
    () => petaWaktu({ durasi: 40, kecepatan: [{ pada: 0, nilai: 3, easing: "keluarBack" }, { pada: 10, nilai: 0.1 }] })]) {
    try { f(); } catch { melempar++; }
  }
  samaIsi(melempar, 4, "masukan tak sah harus melempar");
  // butir video di timeline memakai peta ini: batas bawah dari ramp
  const kon = await konteksDasar();
  const r = await aturanDengan((t) => { t.track[0].butir[1].waktu.kecepatan = [{ pada: 0, nilai: 1 }, { pada: 79, nilai: 3 }]; }, { konteks: kon });
  tegas(kodeAda(r, "R08", "/track/0/butir/1"), `ramp 1x-3x selama 80 frame membaca >120 frame klip: ${ringkas(r)}`);
  const r3 = await aturanDengan((t) => { t.track[0].butir[1].waktu = { kecepatan: [{ pada: 0, nilai: 1 }, { pada: 79, nilai: 3 }], habis: "tahan" }; }, { konteks: kon });
  tegas(!kodeAda(r3, "R08"), `habis "tahan" menghilangkan galat R08: ${ringkas(r3)}`);
  const r4 = await aturanDengan((t) => { t.track[0].butir[1].waktu = { kecepatan: 1.5, balik: true }; }, { konteks: kon });
  tegas(!kodeAda(r4, "R08"), `reverse 1,5x sah: ${ringkas(r4)}`);
});

// =============================================================== (i) klip-props nyata
daftar("(i) --klip-props: jumlah frame nyata dari klip.mjs sama dengan perkiraan; jumlah kecil memicu R08; fps beda ditolak", async () => {
  const dir = j("klipprops");
  cpSync(templat, dir, { recursive: true });
  const k = await bun(klipMjs, join(dir, "sumber.json"), "--fps", "30", "--out", join(dir, "klip"));
  tegas(k.kode === 0, `klip.mjs gagal: ${k.err}${k.out}`);
  const props = bacaJson(join(dir, "klip", "klip-props.json"));
  const kon = await konteksDasar();
  for (const p of props.klip) samaIsi(kon.ring.klip[p.id].jumlah, p.jumlah, `perkiraan jumlah klip ${p.id} = hasil klip.mjs`);
  const c = await bun(timelineMjs, "periksa", join(dir, "timeline.json"), "--klip-props", join(dir, "klip", "klip-props.json"));
  tegas(c.kode === 0, `dengan --klip-props: exit ${c.kode}\n${c.out}`);
  // jumlah nyata lebih kecil dari perkiraan
  const kecil = salin(props);
  kecil.klip.find((x) => x.id === "k2").jumlah = 100;
  tulisJson(join(dir, "kecil.json"), kecil);
  const d = await bun(timelineMjs, "periksa", join(dir, "timeline.json"), "--klip-props", join(dir, "kecil.json"));
  tegas(d.kode === 2 && d.out.includes("[R08] /track/0/butir/1") && d.out.includes("hanya 100 frame"), `klip-props kecil: exit ${d.kode}\n${d.out}`);
  // fps klip-props berbeda
  const beda = salin(props);
  beda.klip[0].fps = 25;
  tulisJson(join(dir, "beda.json"), beda);
  const e = await bun(timelineMjs, "periksa", join(dir, "timeline.json"), "--klip-props", join(dir, "beda.json"));
  tegas(e.kode === 2 && e.out.includes("diekstrak pada 25 fps"), `klip-props fps: exit ${e.kode}\n${e.out}`);
  // klip-props bukan bentuk yang benar
  tulisJson(join(dir, "salah.json"), { x: 1 });
  const f = await bun(timelineMjs, "periksa", join(dir, "timeline.json"), "--klip-props", join(dir, "salah.json"));
  tegas(f.kode === 2 && f.err.includes('array "klip"'), `klip-props salah bentuk: exit ${f.kode} ${f.err}`);
  // audio klip dari klip-props (null = tidak beraudio) memicu R09
  const bisu = salin(props);
  bisu.klip.find((x) => x.id === "k1").audio = null;
  tulisJson(join(dir, "bisu.json"), bisu);
  const g = await bun(timelineMjs, "periksa", join(dir, "timeline.json"), "--klip-props", join(dir, "bisu.json"));
  tegas(g.kode === 2 && g.out.includes("[R09] /track/0/butir/0/audio/mode") && g.out.includes("tidak beraudio"), `klip-props tanpa audio: exit ${g.kode}\n${g.out}`);
});

// =============================================================== (j) peringatan
daftar("(j) peringatan W01-W09 dan --ketat (peringatan menjadi galat, exit 2)", async () => {
  const kon = await konteksDasar();
  const lihat = (r, kode, lok) => r.peringatan.find((x) => x.kode === kode && (lok === undefined || x.lok.startsWith(lok)));
  let r = await aturanDengan((t) => { t.track[3].butir[0].gaya.ukuran = 30; }, { konteks: kon });
  tegas(lihat(r, "W01", "/track/3/butir/0/gaya/ukuran") && r.galat.length === 0, `W01: ${JSON.stringify(r.peringatan)}`);
  r = await aturanDengan((t) => { t.track[3].butir[0].tata = { x: 0, y: 0, lebar: 300, tinggi: 80 }; }, { konteks: kon });
  tegas(lihat(r, "W02", "/track/3/butir/0/tata"), `W02: ${JSON.stringify(r.peringatan)}`);
  r = await aturanDengan((t) => { t.proyek.durasi = 500; }, { konteks: kon });
  tegas(lihat(r, "W04"), `W04: ${JSON.stringify(r.peringatan)}`);
  r = await aturanDengan((t) => {
    for (let n = 0; n < 5; n++) t.track.push({ id: `pip-${n}`, jenis: "overlay", butir: [{ id: `pip-${n}-a`, jenis: "video", klip: "k1", mulai: 0, durasi: 60, audio: { mode: "bisu" } }] });
  }, { konteks: kon });
  tegas(lihat(r, "W03"), `W03: ${JSON.stringify(r.peringatan)}`);
  r = await aturanDengan((t) => { t.track[0].butir[0].audio.mode = "campur"; t.track[5].butir[0].mulai = 60; t.track[0].butir[0].durasi = 100; t.track[0].butir[1].mulai = 85; t.track[0].butir[1].transisi.durasi = 15; t.track[0].butir[1].durasi = 70; t.track[0].butir[1].waktu = {}; t.track[0].butir[1].audio = { mode: "bisu" }; }, { konteks: kon });
  tegas(lihat(r, "W05"), `W05: ${JSON.stringify(r.peringatan)} ${ringkas(r)}`);
  // R09: speed konstan dan ramp pada klip bersuara lolos (atempo di audio.mjs); freeze/reverse tetap ditolak (tabel R09)
  r = await aturanDengan((t) => { t.track[0].butir[1].audio.mode = "campur"; }, { konteks: kon });
  tegas(!kodeAda(r, "R09"), `speed konstan bersuara tidak boleh R09: ${ringkas(r)}`);
  r = await aturanDengan((t) => { t.track[0].butir[1].audio.mode = "campur"; t.track[0].butir[1].waktu.kecepatan = [{ pada: 0, nilai: 1 }, { pada: 79, nilai: 2 }]; }, { konteks: kon });
  tegas(!kodeAda(r, "R09"), `ramp bersuara tidak boleh R09: ${ringkas(r)}`);
  r = await aturanDengan((t) => { t.audio.ketatCampur = true; t.track[0].butir[0].audio.mode = "campur"; t.track[5].butir[0].mulai = 60; t.track[0].butir[0].durasi = 100; t.track[0].butir[1].mulai = 85; t.track[0].butir[1].transisi.durasi = 15; t.track[0].butir[1].durasi = 70; t.track[0].butir[1].waktu = {}; t.track[0].butir[1].audio = { mode: "bisu" }; }, { konteks: kon });
  tegas(kodeAda(r, "R11", "/track/0/butir/0"), `ketatCampur menjadikan W05 galat R11: ${ringkas(r)}`);
  // W06: tiga kilatan beruntun hanya peringatan (empat tidak dapat dibangun: R06 dan durasi minimum jenis berkilat)
  r = await aturanDengan((t) => {
    t.track = t.track.filter((x) => ["t-latar"].includes(x.id));
    t.track[0].butir = [
      { id: "q1", jenis: "warna", warna: "#111111", mulai: 0, durasi: 40 },
      { id: "q2", jenis: "warna", warna: "#222222", mulai: 28, durasi: 24, transisi: { jenis: "kilat", durasi: 12 } },
      { id: "q3", jenis: "warna", warna: "#333333", mulai: 40, durasi: 24, transisi: { jenis: "kilat", durasi: 12 } },
      { id: "q4", jenis: "warna", warna: "#444444", mulai: 52, durasi: 24, transisi: { jenis: "kilat", durasi: 12 } },
    ];
    t.proyek.durasi = 76;
  }, { konteks: kon });
  tegas(lihat(r, "W06") && !kodeAda(r, "R14"), `W06: ${JSON.stringify(r.peringatan)} ${ringkas(r)}`);
  // W07: profil kurangiGerak mengganti jenis transisi
  r = await aturanDengan((t) => { t.proyek.profil = "kurangiGerak"; t.track[0].butir[1].transisi.jenis = "geser"; t.track[0].butir[1].transisi.arah = "kiri"; }, { konteks: kon });
  tegas(lihat(r, "W07"), `W07: ${JSON.stringify(r.peringatan)} ${ringkas(r)}`);
  // W08: tanpa jumlah frame klip diketahui
  const k2 = await muatKonteks(tlDasar, dirDasar);
  k2.ring = { ...k2.ring, klip: { ...k2.ring.klip, k1: { ...k2.ring.klip.k1, jumlah: null } } };
  r = periksaAturan(tlDasar, k2);
  tegas(lihat(r, "W08", "/track/0/butir/0") && r.galat.length === 0, `W08: ${JSON.stringify(r.peringatan)}`);
  // W09: peringatan manifest (sumber tak dipakai klip) diteruskan
  const dir = j("w09");
  cpSync(templat, dir, { recursive: true });
  const sm = bacaJson(join(dir, "sumber.json"));
  sm.klip = sm.klip.filter((x) => x.id !== "k2");
  tulisJson(join(dir, "sumber.json"), sm);
  const t2 = salin(tlDasar);
  t2.track[0].butir[1] = { id: "adegan-2", jenis: "warna", warna: "#334455", mulai: 75, durasi: 80, transisi: { jenis: "pudarMelalui", durasi: 15 } };
  t2.track[0].butir[1].transisi = tlDasar.track[0].butir[1].transisi;
  const kk = await muatKonteks(t2, dir);
  const r5 = periksaAturan(t2, kk);
  tegas(lihat(r5, "W09") && r5.peringatan.some((w) => w.pesan.includes('sumber "pola-b" tidak dipakai klip')), `W09: ${JSON.stringify(r5.peringatan)}`);
  // --ketat via CLI
  const dirK = j("ketat");
  cpSync(templat, dirK, { recursive: true });
  const tk = salin(tlDasar);
  tk.track[3].butir[0].gaya.ukuran = 30;
  tulisJson(join(dirK, "timeline.json"), tk);
  const longgar = await bun(timelineMjs, "periksa", join(dirK, "timeline.json"));
  tegas(longgar.kode === 0 && longgar.out.includes("peringatan [W01]") && longgar.out.includes("LOLOS: 1 peringatan"), `tanpa --ketat: exit ${longgar.kode}\n${longgar.out}`);
  const ketat = await bun(timelineMjs, "periksa", join(dirK, "timeline.json"), "--ketat");
  tegas(ketat.kode === 2 && ketat.out.includes("galat [W01]") && ketat.out.includes("--ketat"), `--ketat: exit ${ketat.kode}\n${ketat.out}`);
});

// =============================================================== (k) kutipan turunan dari timeline
daftar("(k) kebijakan kutipan dihitung dari durasi tampil di timeline; konflik dengan nilai manual, audio musik, dan gerbang GH ditolak", async () => {
  const dir = j("kutipan");
  cpSync(templat, dir, { recursive: true });
  const blok = { tujuan: "ulasan", isiAudio: "ucapan", musikDibahas: false, menyasarKarya: true, bukanBagianKhas: true, perubahanMakna: false, orangDikenali: false, sintetis: false };
  const longgar = { sumberMaksPersen: 80, catatanIzinTertulis: "catatan fiktif untuk uji (sumber contoh hanya 4 detik)" };
  const sm0 = bacaJson(join(dir, "sumber.json"));
  const dengan = (ubah) => { const sm = salin(sm0); sm.proyek.kebijakanKutipan = longgar; ubah(sm); tulisJson(join(dir, "sumber.json"), sm); };
  const periksa = async (t, opsi) => periksaAturan(t, await muatKonteks(t, dir), opsi);
  // adegan-2 (k2, sumber pola-b) = kutipan 80 frame; caption di track sendiri menutup seluruh tampilnya
  const tl = salin(tlDasar);
  tl.track.push({ id: "t-cap", jenis: "teks", butir: [{ id: "cap-kutipan", jenis: "teks", peran: "caption", isi: "Komentar atas kutipan (fiktif)", mulai: 75, durasi: 80, gaya: { ukuran: 40 }, tata: { x: 80, y: 560, lebar: 1100, tinggi: 60 } }] });
  const tanpaKomentar = salin(tl);
  tanpaKomentar.track.pop();

  dengan((sm) => { sm.sumber[1].kutipan = blok; });
  let r = await periksa(tl);
  tegas(r.galat.length === 0, `kutipan sah: ${ringkas(r)}`);
  tegas(r.turunan.kutipan && Math.abs(r.turunan.kutipan.persenVideo - (80 / 450) * 100) < 1e-6 && Math.abs(r.turunan.kutipan.persenKomentar - 100) < 1e-6, `turunan kutipan: ${JSON.stringify(r.turunan)}`);
  tegas(r.turunan.kutipan.baris.includes("kutipan: 1 klip, 2.67 s = 17.78%"), `baris ringkasan: ${r.turunan.kutipan.baris}`);
  // tanpa kebijakan longgar, sumber 4 detik hanya boleh dikutip 15% (0,6 detik)
  const sm1 = salin(sm0);
  sm1.sumber[1].kutipan = blok;
  tulisJson(join(dir, "sumber.json"), sm1);
  r = await periksa(tl);
  tegas(r.galat.some((x) => x.kode === "R17" && /melebihi batas 0\.60 s/.test(x.pesan)), `batas per sumber: ${ringkas(r)}`);

  // tanpa komentar yang menutup klip kutipan
  dengan((sm) => { sm.sumber[1].kutipan = blok; });
  r = await periksa(tanpaKomentar);
  tegas(r.galat.some((x) => x.kode === "R17" && /komentar/.test(x.pesan)), `tanpa komentar: ${ringkas(r)}`);

  // kutipan > 25% video baru: klip-b ditampilkan 120 frame dari video 450 frame = 26,7%
  const besar = salin(tl);
  besar.track[0].butir[1].durasi = 120;
  besar.track[0].butir[1].waktu = { habis: "tahan" };
  besar.track[0].butir[2].mulai = 190;
  besar.track[0].butir[2].durasi = 260;
  besar.track[besar.track.length - 1].butir[0].durasi = 120;
  r = await periksa(besar);
  tegas(r.galat.some((x) => x.kode === "R17" && /melebihi batas 25%/.test(x.pesan)), `> 25% video: ${ringkas(r)}`);

  // audio musik sumber kutipan wajib bisu (isiAudio bawaan musik): adegan-1 (pola-a) bermode bergantian
  dengan((sm) => { sm.sumber[0].kutipan = { ...blok, isiAudio: "musik" }; });
  r = await periksa(tlDasar);
  tegas(kodeAda(r, "R09", "/track/0/butir/0/audio/mode") && r.galat.some((x) => /audio musik sumber kutipan/.test(x.pesan)), `audio musik kutipan: ${ringkas(r)}`);
  dengan((sm) => { sm.sumber[0].kutipan = { ...blok, isiAudio: "musik", musikDibahas: true }; });
  r = await periksa(tlDasar);
  tegas(!kodeAda(r, "R09") && r.peringatan.some((x) => x.kode === "W08" && /musik yang dibahas/.test(x.pesan)), `musik dibahas: ${ringkas(r)} ${JSON.stringify(r.peringatan)}`);

  // nilai manual di sumber.json yang bertentangan dengan jadwal turunan
  dengan((sm) => { sm.sumber[1].kutipan = blok; sm.proyek.durasiVideoDetik = 48; });
  r = await periksa(tl);
  tegas(r.galat.some((x) => x.kode === "R17" && x.lok.endsWith("/proyek/durasiVideoDetik")), `durasiVideoDetik konflik: ${ringkas(r)}`);
  dengan((sm) => { sm.sumber[1].kutipan = blok; sm.proyek.durasiVideoDetik = 15; sm.klip[1].mulaiVideo = 9; });
  r = await periksa(tl);
  tegas(r.galat.some((x) => x.kode === "R17" && x.lok.endsWith("/klip/k2/mulaiVideo")) && !r.galat.some((x) => x.lok.endsWith("/proyek/durasiVideoDetik")), `mulaiVideo konflik: ${ringkas(r)}`);
  dengan((sm) => { sm.sumber[1].kutipan = blok; sm.proyek.komentar = [{ mulai: 0, akhir: 1, jenis: "caption" }]; });
  r = await periksa(tl);
  tegas(r.galat.some((x) => x.kode === "R17" && x.lok.endsWith("/proyek/komentar")), `komentar konflik: ${ringkas(r)}`);
  // nilai manual yang sama dengan turunan diterima
  dengan((sm) => {
    sm.sumber[1].kutipan = blok;
    sm.proyek.durasiVideoDetik = 15;
    sm.klip[1].mulaiVideo = 2.5;
    sm.proyek.komentar = [{ mulai: 2.5, akhir: 155 / 30, jenis: "caption" }, { mulai: 160 / 30, akhir: 250 / 30, jenis: "narasi" }];
  });
  r = await periksa(tl);
  tegas(r.galat.length === 0, `nilai manual sama dengan turunan: ${ringkas(r)}`);

  // gerbang hukum GH untuk KUTIPAN-WAJAR: belum disetujui = galat R17, --draf = peringatan
  dengan((sm) => {
    sm.sumber[1].lisensi = "KUTIPAN-WAJAR";
    sm.sumber[1].caraPerolehan = "milik-sendiri";
    sm.sumber[1].tanggalAkses = "2026-11-07";
    sm.sumber[1].kutipan = blok;
  });
  r = await periksa(tl);
  tegas(r.galat.some((x) => x.kode === "R17" && /gerbang hukum GH/.test(x.pesan)), `gerbang GH: ${ringkas(r)}`);
  r = await periksa(tl, { draf: true });
  tegas(!r.galat.some((x) => /gerbang hukum GH/.test(x.pesan)) && r.peringatan.some((x) => /DRAF: gerbang hukum GH/.test(x.pesan)), `gerbang GH --draf: ${ringkas(r)} ${JSON.stringify(r.peringatan)}`);
  // CLI: --draf mengubah galat gerbang menjadi peringatan
  tulisJson(join(dir, "timeline.json"), tl);
  const c1 = await bun(timelineMjs, "periksa", join(dir, "timeline.json"));
  tegas(c1.kode === 2 && c1.out.includes("[R17]"), `CLI tanpa --draf: exit ${c1.kode}\n${c1.out}`);
  const c2 = await bun(timelineMjs, "periksa", join(dir, "timeline.json"), "--draf");
  tegas(c2.kode === 0 && c2.out.includes("DRAF: gerbang hukum GH"), `CLI --draf: exit ${c2.kode}\n${c2.out}`);
});

// =============================================================== (l) masukan jahat dan batas
daftar("(l) masukan jahat: id berprototipe, simlink manifest, batas ukuran dan waktu (ribuan butir, durasi besar)", async () => {
  const kon = await konteksDasar();
  // id seperti nama properti Object.prototype tidak boleh lolos sebagai "tercatat"
  for (const nama of ["constructor"]) { // satu-satunya nama prototipe yang lolos pola id (huruf kecil)
    const r = await aturanDengan((t) => { t.track[0].butir[0].klip = nama; }, { konteks: kon });
    tegas(kodeAda(r, "R02", "/track/0/butir/0/klip"), `klip "${nama}" harus ditolak: ${ringkas(r)}`);
    const a = await aturanDengan((t) => { t.track[2].butir[0].aset = nama; }, { konteks: kon });
    tegas(kodeAda(a, "R02", "/track/2/butir/0/aset"), `aset "${nama}" harus ditolak: ${ringkas(a)}`);
  }
  // manifest yang merupakan simlink ke luar folder ditolak
  const dir = j("simlink");
  cpSync(templat, dir, { recursive: true });
  writeFileSync(j("luar.json"), JSON.stringify({ skema: 1, proyek: { tujuan: "nonkomersial" }, aset: [] }));
  symlinkSync(j("luar.json"), join(dir, "luar.json"));
  const t = salin(tlDasar);
  t.manifes.aset = "luar.json";
  tulisJson(join(dir, "simlink.json"), t);
  const c = await bun(timelineMjs, "periksa", join(dir, "simlink.json"));
  tegas(c.kode === 2 && c.out.includes("simlink"), `simlink: exit ${c.kode}\n${c.out}`);
  // ribuan butir dan banyak track selesai cepat
  const besar = salin(tlSederhana);
  besar.proyek.durasi = 4000;
  besar.track[0].butir = Array.from({ length: 2000 }, (_, i) => ({ id: `w${i}`, jenis: "warna", warna: "#101820", mulai: i * 2, durasi: 2 }));
  for (let n = 1; n < 40; n++) besar.track.push({ id: `tt${n}`, jenis: "teks", butir: Array.from({ length: 100 }, (_, i) => ({ id: `tt${n}-${i}`, jenis: "teks", peran: "isi", isi: "x", mulai: i * 40, durasi: 40 })) });
  tegas(validasiSkema(besar).length === 0, "fixture besar harus sah");
  const w0 = performance.now();
  const rb = await periksaTimeline(besar, { dir: dirDasar });
  const dt = performance.now() - w0;
  tegas(rb.lolos, `fixture besar: ${ringkas(rb)}`);
  tegas(dt < 5000, `terlalu lambat: ${dt.toFixed(0)} ms untuk 6000 butir`);
  // durasi proyek maksimum dengan ramp panjang: tabel dibangun, tanpa kehabisan memori
  const ramp = salin(tlDasar);
  ramp.proyek.durasi = 1_000_000;
  ramp.track[0].butir[1].durasi = 900_000;
  ramp.track[0].butir[1].mulai = 75;
  ramp.track[0].butir[1].waktu = { kecepatan: [{ pada: 0, nilai: 1 }, { pada: 899_999, nilai: 2 }], habis: "tahan" };
  ramp.track[0].butir[2].mulai = 900_060;
  ramp.track[0].butir[2].durasi = 99_940;
  ramp.track[0].butir[2].transisi.durasi = 15;
  ramp.track[5].butir[0].mulai = 900_100;
  const r2 = await periksaAturan(ramp, kon);
  tegas(!r2.galat.some((x) => x.kode === "R08"), `ramp 900.000 frame: ${ringkas(r2)}`);
  // butir yang melewati durasi tidak memicu pembuatan tabel raksasa
  const melewati = salin(tlDasar);
  melewati.track[0].butir[1].durasi = 900_000;
  melewati.track[0].butir[1].waktu = { kecepatan: [{ pada: 0, nilai: 1 }, { pada: 899_999, nilai: 3 }] };
  const w1 = performance.now();
  const r3 = periksaAturan(melewati, kon);
  tegas(kodeAda(r3, "R03") && performance.now() - w1 < 2000, `butir melewati durasi: ${ringkas(r3)}`);
});

// =============================================================== (m) kesetaraan dengan runtime
daftar("(m) pemetaan waktu klip: validator identik dengan runtime.js (petaWaktuKlip, frameSumber) untuk konstan, ramp, balik, bekukan, dan masukan tak sah", async () => {
  const rnd = RT.acak(3101);
  const pilih = (a) => a[Math.floor(rnd() * a.length)];
  const nilai = () => Math.round((0.1 + rnd() * 9.9) * 1000) / 1000; // 0,1..10, 3 desimal (rentang skema)
  const easingSkema = ["linear", "masukQuad", "keluarQuad", "masukKeluarQuad", "masukCubic", "keluarCubic", "masukKeluarCubic",
    "masukBack", "keluarBack", "keluarElastis", "standar", "percepat", "perlambat", "ditekankanMasuk", "ditekankanKeluar"];
  const daftarEasing = [undefined, ...easingSkema, [0.4, 0, 0.2, 1], [0, 0, 1, 1], [0.7, -0.2, 0.3, 1.2]];
  const durasiUji = [1, 2, 3, 7, 30, 61, 101, 250];
  const kasus = []; // { waktu, durasi }
  for (const kec of [0.1, 0.29, 0.5, 0.75, 1, 1.001, 1.5, 1.75, 2, 3.333, 5, 9.999, 10]) {
    for (const d of durasiUji) {
      kasus.push({ waktu: { kecepatan: kec }, durasi: d }, { waktu: { kecepatan: kec, balik: true }, durasi: d });
    }
  }
  kasus.push({ waktu: {}, durasi: 40 }, { waktu: { balik: true }, durasi: 40 });
  for (const d of durasiUji) kasus.push({ waktu: { bekukan: true }, durasi: d }, { waktu: { bekukan: true, kecepatan: 2 }, durasi: d });
  // ramp: dua sampai empat keyframe, easing per segmen dari daftar skema dan bezier, balik acak
  for (let i = 0; i < 600; i++) {
    const d = 2 + Math.floor(rnd() * 119);
    const n = Math.min(2 + Math.floor(rnd() * 3), d);
    const titik = new Set([0]);
    while (titik.size < n) titik.add(1 + Math.floor(rnd() * (d - 1)));
    const pada = [...titik].sort((a, b) => a - b);
    const kf = pada.map((p, k) => {
      const o = { pada: p, nilai: nilai() };
      const e = pilih(daftarEasing);
      if (k < pada.length - 1 && e !== undefined) o.easing = e;
      return o;
    });
    kasus.push({ waktu: { kecepatan: kf, ...(rnd() < 0.3 ? { balik: true } : {}) }, durasi: d });
  }
  // ramp yang sengaja memotong (nilai sama, selisih satu permil, selisih besar) di batas pembulatan
  for (const [a, b] of [[1, 1.001], [1.001, 1], [0.1, 10], [10, 0.1], [1.5, 1.5], [0.999, 1.001]]) {
    for (const d of [3, 4, 31, 97]) kasus.push({ waktu: { kecepatan: [{ pada: 0, nilai: a }, { pada: d - 1, nilai: b }] }, durasi: d });
  }

  let sah = 0, tolak = 0;
  for (const { waktu, durasi } of kasus) {
    const nama = JSON.stringify({ waktu, durasi });
    let rt, galatRt;
    try { rt = RT.petaWaktuKlip(waktu, durasi); } catch (e) { galatRt = e; }
    let v, galatV;
    try { v = petaWaktu({ durasi, ...waktu }); } catch (e) { galatV = e; }
    tegas(!galatRt === !galatV, `melempar tidak sama (runtime: ${galatRt?.message}; validator: ${galatV?.message}) ${nama}`);
    if (galatRt) { tolak++; continue; }
    sah++;
    samaIsi(v, rt, `petaWaktu vs petaWaktuKlip ${nama}`);
    // frameSumber (satu frame, dengan dari) harus sama dengan tabel di setiap frame
    for (const dari of [0, 37]) {
      for (let f = 0; f < durasi; f++) {
        const fs = RT.frameSumber(waktu, f, { durasi, dari });
        tegas(fs === dari + v[f], `frameSumber(${f}, dari ${dari}) = ${fs}, tabel validator ${dari + v[f]} ${nama}`);
      }
    }
    // offset terbesar yang dipakai aturan R08 = maksimum tabel runtime
    let maks = 0;
    for (const x of rt) if (x > maks) maks = x;
    samaIsi(offsetMaks(durasi, waktu), maks, `offsetMaks ${nama}`);
  }

  // masukan tak sah: keduanya menolak (kecepatan di luar rentang, > 3 desimal, bekukan + balik, ramp <= 0)
  const buruk = [
    [{ bekukan: true, balik: true }, 5], [{ kecepatan: 1.2345 }, 5], [{ kecepatan: 0 }, 5], [{ kecepatan: -1 }, 5], [{ kecepatan: 1001 }, 5],
    [{ kecepatan: [{ pada: 0, nilai: 3, easing: "keluarBack" }, { pada: 10, nilai: 0.1 }] }, 40],
    [{ kecepatan: [{ pada: 0, nilai: 1 }, { pada: 0, nilai: 2 }] }, 5], [{ kecepatan: [{ pada: 0, nilai: 1 }] }, 5],
    [{ kecepatan: [{ pada: 0, nilai: 1, easing: "nama-ngawur" }, { pada: 3, nilai: 2 }] }, 5], [{}, 0], [{}, 2.5],
  ];
  for (const [waktu, durasi] of buruk) {
    const nama = JSON.stringify({ waktu, durasi });
    let a = false, b = false;
    try { RT.petaWaktuKlip(waktu, durasi); } catch { a = true; }
    try { petaWaktu({ durasi, ...waktu }); } catch { b = true; }
    tegas(a && b, `masukan tak sah harus ditolak keduanya (runtime ${a}, validator ${b}) ${nama}`);
    tolak++;
  }

  // end-to-end: batas R08 pada timeline memakai offset runtime (jumlah = maks + 1 lolos, jumlah = maks ditolak)
  const kon = await konteksDasar();
  const denganJumlah = (n) => ({ ...kon, ring: { ...kon.ring, klip: { ...kon.ring.klip, k2: { ...kon.ring.klip.k2, jumlah: n, jumlahPerkiraan: false } } } });
  let e2e = 0;
  for (const { waktu, durasi } of kasus) {
    if (durasi > 120 || e2e >= 90 || (e2e > 0 && rnd() < 0.8)) continue;
    if (Array.isArray(waktu.kecepatan) && waktu.kecepatan.some((q) => q.pada >= durasi)) continue;
    let rt;
    try { rt = RT.petaWaktuKlip(waktu, durasi); } catch { continue; }
    const dari = Math.floor(rnd() * 41);
    let maks = 0;
    for (const x of rt) if (x > maks) maks = x;
    const terbesar = dari + maks;
    if (terbesar < 1) continue;
    const ubah = (habis) => (t) => { const b = t.track[0].butir[1]; b.durasi = durasi; b.dari = dari; b.waktu = { ...waktu, ...(habis ? { habis } : {}) }; };
    const nama = JSON.stringify({ waktu, durasi, dari, terbesar });
    const pas = await aturanDengan(ubah(), { konteks: denganJumlah(terbesar + 1) });
    tegas(!kodeAda(pas, "R08", "/track/0/butir/1"), `jumlah ${terbesar + 1} cukup, R08 tak boleh muncul: ${ringkas(pas)} ${nama}`);
    const kurang = await aturanDengan(ubah(), { konteks: denganJumlah(terbesar) });
    tegas(kodeAda(kurang, "R08", "/track/0/butir/1"), `jumlah ${terbesar} kurang, R08 wajib muncul: ${ringkas(kurang)} ${nama}`);
    const tahan = await aturanDengan(ubah("tahan"), { konteks: denganJumlah(terbesar) });
    tegas(!kodeAda(tahan, "R08", "/track/0/butir/1/waktu"), `habis tahan: ${ringkas(tahan)} ${nama}`);
    e2e++;
  }
  tegas(e2e >= 30, `terlalu sedikit kasus end-to-end: ${e2e}`);
  console.log(`       kesetaraan: ${sah} kasus sah + ${tolak} kasus ditolak (fungsi), ${e2e} kasus end-to-end R08`);
});

// ----------------------------------------------------------------- jalankan
const t0 = Date.now();
let gagal = 0;
try {
  for (const [nama, fn] of uji) {
    if (hanya && !nama.startsWith(hanya)) continue;
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
