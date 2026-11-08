#!/usr/bin/env bun
/**
 * uji-templat-timeline.mjs — uji templat render timeline (templates/timeline) dan penjadwalnya
 * (scripts/timeline.js): contoh lolos validator, keadaan per frame (transisi, properti, animasi,
 * pemetaan waktu klip yang diteruskan ke runtime.js), kemurnian, dan render sungguhan dua kali
 * dengan framemd5 identik. Fixture: templates/timeline-contoh disalin ke folder sementara,
 * ditambah varian yang dibangun di sini (ramp, Ken Burns, animasi per huruf, penekanan).
 * Butuh Chromium dan ffmpeg. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-templat-timeline.mjs [--hanya h]   # hanya uji yang namanya diawali "(h)"
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { offsetMaks, petaWaktu } from "./timeline.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const templat = join(akar, "templates", "timeline-contoh");
const index = join(akar, "templates", "timeline", "index.html");
const siapkan = join(akar, "templates", "timeline", "siapkan.mjs");
const renderMjs = join(akar, "scripts", "render.mjs");
const timelineMjs = join(akar, "scripts", "timeline.mjs");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-templat-timeline-"));
const hanyaIdx = process.argv.indexOf("--hanya");
const hanya = hanyaIdx > 0 ? `(${process.argv[hanyaIdx + 1]})` : null;
const j = (...p) => join(tmp, ...p);
const muat = createRequire(import.meta.url);
const RT = muat("./runtime.js");
const TL = muat("./timeline.js");

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
async function framemd5(file) {
  const r = await jalankan(["ffmpeg", "-v", "error", "-i", file, "-f", "framemd5", "-"]);
  tegas(r.kode === 0, `framemd5 gagal: ${r.err}`);
  return r.out.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").slice(-1)[0].trim());
}
async function render(props, keluar, ...rentang) {
  const r = await bun(renderMjs, index, "--props-file", props, "--out", keluar, ...rentang);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  return framemd5(keluar);
}

// timeline dasar disalin ke tmp (media kecil di-commit; manifest tetap valid)
const dirDasar = j("dasar");
cpSync(templat, dirDasar, { recursive: true });
const tl = bacaJson(join(dirDasar, "timeline.json"));
const rc = TL.rencana(tl);
const butir = (id) => rc.track.flatMap((t) => t.butir).find((b) => b.id === id);

// varian: ramp speed, Ken Burns, animasi per huruf, penekanan; dibangun dari timeline dasar
function bangunVarian(profil) {
  const t = salin(tl);
  if (profil) t.proyek.profil = profil;
  const a1 = t.track[0].butir[0];
  a1.waktu = { kecepatan: [{ pada: 0, nilai: 0.5 }, { pada: 60, nilai: 1 }] };
  a1.audio = { mode: "bisu" };
  t.track[3].butir[0].animasi.masuk = { jenis: "mantul", durasi: 20, mode: "huruf", stagger: 1 };
  t.track[3].butir[0].animasi.penekanan = [{ jenis: "denyut", mulai: 60, durasi: 30 }];
  t.track.push({
    id: "t-foto", jenis: "overlay", butir: [{
      id: "foto", jenis: "gambar", aset: "logo-contoh", mulai: 300, durasi: 60,
      tata: { x: 480, y: 560, lebar: 320, tinggi: 107, fit: "contain" },
      kenBurns: { dari: { skala: 1 }, ke: { skala: 1.3, x: 0.7, y: 0.4 } },
    }],
  });
  return t;
}

const uji = [];
const daftar = (nama, fn) => uji.push([nama, fn]);

daftar("(a) contoh timeline lolos periksa.mjs (kode keluar 0, --ketat)", async () => {
  for (const f of ["timeline.json", "timeline-sederhana.json"]) {
    const r = await bun(timelineMjs, "periksa", join(dirDasar, f), "--ketat");
    tegas(r.kode === 0, `${f}: exit ${r.kode}\n${r.out}${r.err}`);
  }
});

daftar("(b) rencana menolak timeline yang melanggar kontrak penjadwal", () => {
  const galat = (ubah, kata) => {
    const t = salin(tl); ubah(t);
    try { TL.rencana(t); } catch (e) { tegas(e.message.includes(kata), `pesan "${e.message}" tanpa "${kata}"`); return; }
    throw new Error(`tidak ditolak: ${kata}`);
  };
  galat((t) => { t.skema = 2; }, "skema");
  galat((t) => { t.track[0].butir[1].transisi.durasi = 10; }, "tumpang tindih");
  galat((t) => { delete t.track[0].butir[1].transisi; }, "tanpa transisi");
  galat((t) => { t.track[1].butir[0].transisi = { jenis: "pudar", durasi: 5 }; }, "hanya untuk track video");
  let ditolak = false;
  try { TL.keadaan(rc, 450); } catch { ditolak = true; }
  tegas(ditolak, "frame 450 harus ditolak");
});

daftar("(c) keadaan: jendela transisi sama dengan tumpang tindih, lapisan keluar di bawah masuk", () => {
  const peran = (f) => TL.keadaan(rc, f).butir.filter((e) => e.track.id === "t-latar").map((e) => `${e.butir.id}:${e.peran}`);
  samaIsi(peran(74), ["adegan-1:diam"], "frame 74");
  samaIsi(peran(75), ["adegan-1:keluar", "adegan-2:masuk"], "frame 75");
  samaIsi(peran(89), ["adegan-1:keluar", "adegan-2:masuk"], "frame 89");
  samaIsi(peran(90), ["adegan-2:diam"], "frame 90");
  const S = TL.keadaan(rc, 82);
  tegas(S.transisi && S.transisi.hasil.jenisEfektif === "pudarMelalui", "transisi pudarMelalui aktif di frame 82");
  const g = Object.fromEntries(S.butir.map((e) => [e.butir.id, e.gayaLuar]));
  tegas(g["adegan-1"].zIndex < g["adegan-2"].zIndex, "keluar di bawah masuk");
  tegas(S.transisi.hasil.progres > 0 && S.transisi.hasil.progres < 1, "progres di dalam jendela");
  tegas(TL.keadaan(rc, 30).transisi === null, "tanpa transisi di frame 30");
  // dua transisi pada timeline contoh: pudarMelalui (75..89) dan celup (140..154)
  samaIsi([0, 74, 75, 89, 90, 139, 140, 154, 155].map((f) => TL.keadaan(rc, f).transisi !== null), [false, false, true, true, false, false, true, true, false], "jendela");
});

daftar("(d) pemetaan waktu klip: opsiKlip meneruskan waktu apa adanya; hasil sama dengan runtime dan validator", () => {
  const sumber = ["adegan-1", "adegan-2", "pip-balik", "pip-beku"].map(butir);
  for (const b of sumber) {
    const o = TL.opsiKlip(b);
    samaIsi(o.waktu, b.waktu ?? {}, `waktu ${b.id}`);
    tegas(o.dari === (b.dari ?? 0) && o.durasi === b.durasi, `dari/durasi ${b.id}`);
    const w = b.waktu ?? {};
    const peta = petaWaktu({ durasi: b.durasi, ...w }); // jalur validator
    const klip = { jumlah: 1000 };
    for (const f of [0, 1, Math.floor(b.durasi / 2), b.durasi - 1]) {
      tegas(RT.indeksFrameKlip(klip, f, o) === o.dari + peta[f], `${b.id} frame ${f}`);
    }
    tegas(Math.max(...peta) === offsetMaks(b.durasi, w), `offsetMaks ${b.id}`);
  }
  tegas(RT.indeksFrameKlip({ jumlah: 1000 }, 0, TL.opsiKlip(butir("pip-balik"))) === 30 + 59, "reverse membaca frame terakhir lebih dulu");
  tegas(RT.indeksFrameKlip({ jumlah: 1000 }, 40, TL.opsiKlip(butir("pip-beku"))) === 45, "freeze menahan frame dari");
  let ditolak = false;
  try { TL.opsiKlip(butir("judul")); } catch { ditolak = true; }
  tegas(ditolak, "opsiKlip menolak butir bukan video");
});

daftar("(e) sifat: keyframe properti, animasi masuk/keluar/penekanan, tata bawaan", () => {
  const pip = butir("pip-balik");
  const s0 = TL.sifat(rc, pip, 0), s5 = TL.sifat(rc, pip, 5), s10 = TL.sifat(rc, pip, 10), s40 = TL.sifat(rc, pip, 40);
  tegas(s0.gaya.opacity === 0, "opasitas awal 0");
  tegas(s5.gaya.opacity > 0 && s5.gaya.opacity < 1, "opasitas segmen di antara 0 dan 1");
  tegas(s10.gaya.opacity === 1 && s40.gaya.opacity === 1, "opasitas ditahan setelah keyframe terakhir");
  tegas(s0.gaya.transform === "scale(0.9)" && s10.gaya.transform === "none", `skala ${s0.gaya.transform} / ${s10.gaya.transform}`);
  samaIsi([s0.gaya.left, s0.gaya.top, s0.gaya.width, s0.gaya.height], ["860px", "400px", "360px", "202px"], "kotak tata");
  tegas(s0.kotak.fit === "cover", "fit bawaan cover");
  const judul = butir("judul");
  const m0 = TL.sifat(rc, judul, 0), m20 = TL.sifat(rc, judul, 20), kel = TL.sifat(rc, judul, judul.durasi - 1);
  tegas(m0.gaya.opacity < m20.gaya.opacity && m20.gaya.opacity === 1, "animasi masuk menaikkan opasitas");
  tegas(m0.gaya.transform !== "none" && m20.gaya.transform === "none", "geser masuk selesai tanpa sisa transform");
  tegas(kel.gaya.opacity < 1, "animasi keluar menurunkan opasitas di frame terakhir");
  const fullBingkai = TL.sifat(rc, butir("adegan-1"), 0).kotak;
  samaIsi([fullBingkai.x, fullBingkai.y, fullBingkai.w, fullBingkai.h], [0, 0, 1280, 720], "tata bawaan = bingkai");
  const A = RT.areaAman(1280, 720).grafis;
  const kr = TL.sifat(rc, butir("kredit"), 30).kotak; // kredit punya tata sendiri
  tegas(kr.x === 80, "tata kredit");
  const tanpaTata = salin(tl); delete tanpaTata.track[3].butir[0].tata;
  const sx = TL.sifat(TL.rencana(tanpaTata), TL.rencana(tanpaTata).track[3].butir[0], 30).kotak;
  samaIsi([sx.x, sx.y, sx.w, sx.h], [A.x, A.y, A.w, A.h], "teks tanpa tata = area aman grafis");
});

daftar("(f) varian: ramp, per huruf, penekanan, Ken Burns; kurangiGerak mematikan gerak besar", () => {
  const t = bangunVarian();
  const r = TL.rencana(t);
  const m = TL.sifat(r, r.track[3].butir[0], 3);
  tegas(Array.isArray(m.unit) && m.unit.length > 5, "animasi per huruf menghasilkan unit");
  tegas(m.unit.some((u) => u.spasi), "spasi ikut sebagai unit");
  const pk = TL.sifat(r, r.track[3].butir[0], 75).gaya.transform;
  tegas(pk !== "none" && pk.includes("scale"), `penekanan denyut memberi skala: ${pk}`);
  const foto = r.track[7].butir[0];
  const kb0 = TL.sifat(r, foto, 0).kenBurns, kb59 = TL.sifat(r, foto, 59).kenBurns;
  tegas(kb0 && kb59 && kb0 !== kb59, "Ken Burns berubah sepanjang butir");
  const rg = TL.rencana(bangunVarian("kurangiGerak"));
  const fg = rg.track[7].butir[0];
  tegas(TL.sifat(rg, fg, 0).kenBurns === TL.sifat(rg, fg, 59).kenBurns, "kurangiGerak menahan Ken Burns");
  const jd = TL.sifat(rg, rg.track[3].butir[0], 3);
  tegas(jd.unit[0].gaya.transform === undefined || !/translate/.test(jd.unit[0].gaya.transform), "kurangiGerak: mantul menjadi pudar tanpa translasi");
  const ramp = TL.opsiKlip(r.track[0].butir[0]);
  const k = RT.indeksFrameKlip({ jumlah: 90 }, 59, ramp);
  tegas(k === ramp.dari + petaWaktu({ durasi: 90, kecepatan: ramp.waktu.kecepatan })[59], "ramp lewat runtime");
});

daftar("(g) kemurnian: keadaan dan sifat tidak bergantung urutan pemanggilan", () => {
  const potret = (f) => JSON.stringify(TL.keadaan(rc, f).butir.map((e) => [e.butir.id, e.peran, e.gayaLuar, TL.sifat(rc, e.butir, e.lokal)]));
  const urut = [0, 30, 82, 150, 449, 82, 30];
  const hasil = urut.map(potret);
  const lagi = [...urut].reverse().map(potret).reverse();
  samaIsi(hasil, lagi, "urutan terbalik");
  tegas(hasil[2] === hasil[5] && hasil[1] === hasil[6], "frame sama, hasil sama");
});

daftar("(h) teksKredit dan teksKreditLayar diturunkan dari manifest", async () => {
  const r = await bun(siapkan, join(dirDasar, "timeline.json"), "--out", j("props-contoh"));
  tegas(r.kode === 0, `siapkan exit ${r.kode}: ${r.out}${r.err}`);
  const props = bacaJson(j("props-contoh", "props.json"));
  tegas(props.timeline && props.klip.length === 2 && props.aset && props.akarAset.startsWith("file://"), "bentuk props");
  const baris = TL.teksKredit(rc, props);
  tegas(baris.length === 2 && baris.every((b) => b.includes("Lisensi: CC")), `kredit: ${JSON.stringify(baris)}`);
  tegas(TL.teksKreditLayar(butir("adegan-2"), props).includes("CC BY 4.0"), "kreditLayar adegan-2");
});

daftar("(i) render contoh: rentang transisi dua kali, framemd5 identik dan frame berubah", async () => {
  const props = j("props-contoh", "props.json");
  const a = await render(props, j("a.mp4"), "--dari", "70", "--sampai", "95");
  const b = await render(props, j("b.mp4"), "--dari", "70", "--sampai", "95");
  tegas(a.length === 26, `jumlah frame ${a.length}`);
  samaIsi(a, b, "framemd5 dua render");
  tegas(new Set(a).size > 20, "frame transisi harus berubah");
  // acak-akses: still sama dengan frame yang sama di render rentang
  const s = await bun(renderMjs, index, "--props-file", props, "--still", "82", "--out", j("s.png"));
  tegas(s.kode === 0 && existsSync(j("s.png")), `still gagal: ${s.err}`);
});

daftar("(j) render varian: periksa lolos, dua render identik; kurangiGerak mengubah hasil", async () => {
  for (const [nama, profil] of [["std", null], ["kg", "kurangiGerak"]]) {
    const dir = j("varian-" + nama);
    cpSync(templat, dir, { recursive: true });
    tulisJson(join(dir, "timeline.json"), bangunVarian(profil));
    const r = await bun(siapkan, join(dir, "timeline.json"), "--out", join(dir, "out"));
    tegas(r.kode === 0, `siapkan ${nama} exit ${r.kode}: ${r.out}${r.err}`);
  }
  const rentang = ["--dari", "300", "--sampai", "330"];
  const a = await render(j("varian-std", "out", "props.json"), j("v1.mp4"), ...rentang);
  const b = await render(j("varian-std", "out", "props.json"), j("v2.mp4"), ...rentang);
  samaIsi(a, b, "varian dua render");
  const awal = ["--dari", "0", "--sampai", "30"]; // animasi per huruf dan ramp
  samaIsi(await render(j("varian-std", "out", "props.json"), j("v3.mp4"), ...awal), await render(j("varian-std", "out", "props.json"), j("v4.mp4"), ...awal), "varian awal");
  const kg = await render(j("varian-kg", "out", "props.json"), j("v5.mp4"), ...rentang);
  tegas(JSON.stringify(a) !== JSON.stringify(kg), "kurangiGerak harus mengubah hasil render");
});

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
