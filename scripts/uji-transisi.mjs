#!/usr/bin/env bun
/**
 * uji-transisi.mjs — uji modul transisi.js: fungsi murni, registri kustom, kurangiGerak,
 * pemeriksa kilatan (dengan kontrol negatif), render galeri pendek + periksa.mjs, dan
 * determinisme (dua render, framemd5 identik). Tanpa dependensi tambahan.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-transisi.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderCli = join(akar, "scripts", "render.mjs");
const periksaCli = join(akar, "scripts", "periksa.mjs");
const galeri = join(akar, "templates", "transisi-galeri", "index.html");
const tmp = mkdtempSync(join(tmpdir(), "awvd-transisi-"));

// modul dimuat di Bun dengan window tiruan (transisi.js hanya butuh window untuk mendaftar)
globalThis.window = { location: { search: "" } };
await import(pathToFileURL(join(akar, "scripts", "transisi.js")).href);
const T = globalThis.window.Transisi;

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const renderKe = (...a) => jalankan(["bun", renderCli, ...a]);
async function framemd5(file) {
  const r = await jalankan(["ffmpeg", "-v", "error", "-i", file, "-f", "framemd5", "-"]);
  tegas(r.kode === 0, `framemd5 gagal: ${r.err}`);
  return r.out.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").slice(-1)[0].trim()).join("\n");
}

const kat = T.katalog();
const jenisT = kat.filter((k) => k.kategori === "transisi");
const jenisA = kat.filter((k) => k.kategori === "animasi");
const namaT = jenisT.map((k) => k.nama);
const namaA = jenisA.map((k) => k.nama);
const json = (x) => JSON.stringify(x);

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

daftar("(a) katalog: 21 transisi dan 13 animasi, metadata lengkap", () => {
  tegas(namaT.length === 21, `transisi ${namaT.length}`);
  tegas(namaA.length === 13, `animasi ${namaA.length}`);
  for (const k of jenisT) {
    tegas(k.makna && k.sumber && Array.isArray(k.cocok) && k.cocok.length, `metadata kurang: ${k.nama}`);
    tegas(["rendah", "sedang", "tinggi"].includes(k.risiko) && ["rendah", "sedang", "tinggi"].includes(k.biaya), `risiko/biaya ${k.nama}`);
  }
  tegas(jenisT.filter((k) => k.biaya === "tinggi").map((k) => k.nama).join() === "gangguan", "hanya gangguan berbiaya tinggi");
});

daftar("(b) transisi murni: pemanggilan berulang menghasilkan JSON identik, tanpa Date/Math.random", () => {
  for (const j of namaT) for (const f of [0, 7, 15, 29, 30, 44, 100]) {
    const o = { jenis: j, mulai: 10, durasi: 30, seed: 9, arah: "kiri" };
    tegas(json(T.transisi(f, o)) === json(T.transisi(f, o)), `tidak murni ${j}@${f}`);
  }
  // urutan pemanggilan tidak berpengaruh (acak-akses, seperti --dari dan --still)
  const o = { jenis: "gangguan", mulai: 0, durasi: 12, seed: 3 };
  const maju = [0, 3, 6, 9].map((f) => json(T.transisi(f, o)));
  const mundur = [9, 6, 3, 0].map((f) => json(T.transisi(f, o))).reverse();
  tegas(maju.join() === mundur.join(), "gangguan bergantung urutan pemanggilan");
  tegas(T.acak3(5, 10, 2) === T.acak3(5, 10, 2) && T.acak3(5, 10, 2) !== T.acak3(5, 11, 2), "acak3");
  // sumber modul tidak memakai Date.now / Math.random
  const sumber = Bun.file(join(akar, "scripts", "transisi.js"));
  return sumber.text().then((t) => {
    const kode = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    tegas(!/Date\.now|Math\.random|setTimeout|setInterval|requestAnimationFrame|performance\.now/.test(kode), "transisi.js memakai sumber non-deterministik");
  });
});

daftar("(c) batas t=0 dan t=1: awal bersih, akhir tanpa sisa transform/clip/filter/overlay", () => {
  for (const j of namaT) {
    const a = T.transisi(0, { jenis: j, mulai: 10, durasi: 30, seed: 9 });
    const z = T.transisi(100, { jenis: j, mulai: 10, durasi: 30, seed: 9 });
    tegas(a.keluar.display !== "none" && a.masuk.display === "none", `awal ${j}`);
    tegas(a.keluar.transform === "none" && a.keluar.clipPath === "none" && a.keluar.filter === "none" && a.overlay.length === 0, `awal keluar identitas ${j}`);
    tegas(z.masuk.display !== "none" && z.keluar.display === "none" && z.overlay.length === 0 && z.svg === null, `akhir ${j}`);
    tegas(z.masuk.transform === "none" && z.masuk.clipPath === "none" && z.masuk.filter === "none" && z.masuk.maskImage === "none" && z.masuk.opacity === 1, `akhir masuk identitas ${j}`);
    tegas(z.selesai && !z.aktif && !a.aktif, `penanda aktif/selesai ${j}`);
    // tepat satu frame di dalam jendela: aktif
    tegas(T.transisi(20, { jenis: j, mulai: 10, durasi: 30 }).aktif === (j !== "potong"), `aktif di tengah ${j}`);
  }
});

daftar("(d) animasi: awal tersembunyi, akhir tampil dan bersih, keluar, stagger, siklik", () => {
  for (const a of namaA) {
    const o = { jenis: a, mulai: 10, durasi: 20, arah: "bawah" };
    const s0 = T.animasi(0, o), s1 = T.animasi(60, o);
    tegas(typeof s0 === "object" && typeof s1 === "object", `animasi ${a}`);
    tegas(json(T.animasi(25, o)) === json(T.animasi(25, o)), `animasi tidak murni ${a}`);
    tegas(!s1.transform || s1.transform === "none", `sisa transform akhir ${a}: ${s1.transform}`);
    tegas(!s1.filter || s1.filter === "none", `sisa filter akhir ${a}`);
    tegas(!s1.clipPath || s1.clipPath === "none", `sisa clipPath akhir ${a}`);
  }
  tegas(T.animasi(0, { jenis: "pudar", mulai: 10 }).opacity === 0 && T.animasi(40, { jenis: "pudar", mulai: 10 }).opacity === 1, "pudar awal/akhir");
  tegas(T.animasi(90, { jenis: "pudar", mulai: 10, keluarMulai: 60, keluarDurasi: 10 }).opacity === 0, "keluar");
  tegas(T.animasi(12, { jenis: "pudar", mulai: 10, durasi: 10, indeks: 3, stagger: 5 }).opacity === 0, "stagger menunda");
  tegas(T.animasi(40, { jenis: "pudar", mulai: 10, durasi: 10, indeks: 3, stagger: 5 }).opacity === 1, "stagger selesai");
  tegas(T.animasi(0, { jenis: "mantul", mulai: 0, durasi: 20 }).opacity === 0, "mantul awal");
  const huruf = T.animasiTeks(30, "a b", { jenis: "pudar", mulai: 0, durasi: 10, stagger: 4 });
  tegas(huruf.length === 3 && huruf[1].spasi && huruf[2].gaya.opacity === 1, "animasiTeks (spasi tidak dihitung indeks)");
  tegas(T.animasiTeks(0, "halo dunia", { mode: "kata" }).filter((u) => !u.spasi).length === 2, "animasiTeks kata");
  // penekanan siklik: di luar jendela tanpa sisa
  tegas(T.animasi(100, { jenis: "denyut", mulai: 10, durasi: 20 }).transform === "none", "denyut di luar jendela");
  tegas(T.animasi(100, { jenis: "kilatSorot", mulai: 10, durasi: 20 }).boxShadow === "none", "kilatSorot di luar jendela");
});

daftar("(e) easing, teks, angka id-ID, ketik, jalur, kamera, paralaks, bersama", () => {
  for (const n of ["linear", "standar", "percepat", "perlambat", "ditekankan", "masukKeluar", "kuat", "pegas", "pegasLembut"]) {
    tegas(T.easing[n](0) === 0 && T.easing[n](1) === 1, `easing ${n} ujung`);
  }
  let prev = -1;
  for (let i = 0; i <= 100; i++) { const v = T.easing.standar(i / 100); tegas(v >= prev - 1e-9, "standar monoton"); prev = v; }
  let mx = 0;
  for (let i = 0; i <= 100; i++) mx = Math.max(mx, T.easing.pegas(i / 100));
  tegas(mx > 1.05 && mx < 1.2, `overshoot pegas ${mx}`);
  tegas(T.easing.bezier(0.2, 0, 0, 1)(0.5) === T.easing.standar(0.5), "bezier kustom = standar");
  tegas(T.angkaBergulir(1000, { dari: 0, ke: 12847, durasi: 30 }).teks === "12.847", "angka ribuan id-ID");
  tegas(T.angkaBergulir(1000, { dari: 0, ke: 3.5, durasi: 30, desimal: 1, akhiran: " %" }).teks === "3,5 %", "angka desimal id-ID");
  tegas(T.angkaBergulir(0, { dari: 5, ke: 10, durasi: 30 }).teks === "5", "angka awal");
  tegas(T.ketik(0, "halo", { mulai: 0 }).jumlah === 0 && T.ketik(1000, "halo", {}).teks === "halo", "ketik");
  const titik = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const j0 = T.jalur(0, { titik, durasi: 30 }), j1 = T.jalur(99, { titik, durasi: 30 });
  tegas(j0.x === 0 && Math.abs(j1.x - 30) < 0.01 && Math.abs(j0.panjang - 30) < 0.01, "jalur ujung dan panjang");
  let galat = false;
  try { T.jalur(0, { titik: [[0, 0], [1, 1]], durasi: 10 }); } catch { galat = true; }
  tegas(galat, "jalur menolak titik tidak sah");
  tegas(T.kamera(30, { durasi: 30, ke: { skala: 1.5 } }).peringatan.length === 1, "peringatan laju zoom");
  tegas(T.kamera(30, { durasi: 300, ke: { skala: 1.1 } }).peringatan.length === 0, "Ken Burns lembut tanpa peringatan");
  tegas(T.paralaks(30, { lapisan: [{ kedalaman: 1 }] })[0].transform !== "none", "paralaks standar");
  const b0 = T.bersama(0, { mulai: 0, durasi: 20, dari: { x: 0, y: 0, w: 100, h: 50, r: 4 }, ke: { x: 10, y: 20, w: 300, h: 200, r: 24 } });
  const b1 = T.bersama(50, { mulai: 0, durasi: 20, dari: { x: 0, y: 0, w: 100, h: 50, r: 4 }, ke: { x: 10, y: 20, w: 300, h: 200, r: 24 } });
  tegas(b0.kotak.width === "100px" && b1.kotak.width === "300px" && b1.kotak.borderRadius === "24px", "bersama ujung");
  tegas(b0.isiDari.opacity === 1 && b0.isiKe.display === "none" && b1.isiDari.display === "none" && b1.isiKe.opacity === 1, "bersama isi");
});

daftar("(f) registri kustom, komposisi berantai, easing kustom", () => {
  T.daftarTransisi("kustomTes", (pe) => ({ masuk: { opacity: pe, zIndex: 2 } }), { durMs: 300 });
  const h = T.transisi(20, { jenis: "kustomTes", mulai: 10, durasi: 20 });
  tegas(h.masuk.opacity > 0 && h.masuk.opacity < 1, "transisi kustom berjalan");
  tegas(T.katalog().some((k) => k.nama === "kustomTes" && k.kategori === "transisi"), "kustom muncul di katalog");
  T.daftarAnimasi("kustomAnim", (v) => ({ opacity: v }), { durMs: 200 });
  tegas(T.animasi(100, { jenis: "kustomAnim", mulai: 0 }).opacity === 1, "animasi kustom");
  let galat = false;
  try { T.transisi(5, { jenis: "tidakAda", mulai: 0, durasi: 10 }); } catch { galat = true; }
  tegas(galat, "jenis tidak dikenal harus galat");
  galat = false;
  try { T.daftarTransisi("", () => ({})); } catch { galat = true; }
  tegas(galat, "nama kosong harus galat");
  const rantai = T.transisi(20, { jenis: ["geser", "kebocoran"], mulai: 10, durasi: 30 });
  tegas(rantai.overlay.length === 1 && rantai.masuk.transform !== "none", "rantai geser+kebocoran");
  const ujung = T.transisi(100, { jenis: ["geser", "kebocoran"], mulai: 10, durasi: 30 });
  tegas(ujung.masuk.transform === "none" && ujung.overlay.length === 0, "rantai akhir bersih");
  const anak = T.transisi(20, { jenis: [{ jenis: "zoom" }, { jenis: "gangguan", seed: 3 }], mulai: 10, durasi: 30 });
  tegas(Array.isArray(anak.jenisEfektif) && anak.jenisEfektif.length === 2, "rantai dengan parameter per anak");
  const g = T.gabungGaya({ opacity: 0.5, transform: "scale(2)" }, { opacity: 0.5, transform: "translate(1px,1px)" });
  tegas(g.opacity === 0.25 && g.transform === "scale(2) translate(1px,1px)", "gabungGaya");
  // easing kustom: bezier, fungsi, nama
  tegas(T.transisi(20, { jenis: "pudar", mulai: 10, durasi: 20, easing: [0.4, 0, 0.2, 1] }).progresEase === T.transisi(20, { jenis: "pudar", mulai: 10, durasi: 20, easing: "masukKeluar" }).progresEase, "easing bezier = nama");
  tegas(T.transisi(20, { jenis: "pudar", mulai: 10, durasi: 20, easing: (t) => t }).progresEase === 0.5, "easing fungsi");
});

daftar("(g) kurangiGerak: tanpa jenis gerak besar atau berkilat (kecuali celup); kamera, paralaks, getar mati", () => {
  for (const j of namaT) {
    const h = T.transisi(20, { jenis: j, mulai: 10, durasi: 30, profil: "kurangiGerak" });
    const ef = Array.isArray(h.jenisEfektif) ? h.jenisEfektif : [h.jenisEfektif];
    for (const e of ef) {
      const m = jenisT.find((k) => k.nama === e);
      tegas(!m.gerakBesar && (!m.kilat || e === "celup"), `kurangiGerak ${j} -> ${e}`);
    }
    tegas(h.masuk.transform === "none" || h.masuk.transform === undefined || /^scale\(1\)$/.test(h.masuk.transform), `transform sisa pada kurangiGerak ${j}: ${h.masuk.transform}`);
  }
  tegas(T.transisi(20, { jenis: "geser", mulai: 10, durasi: 30, profil: "kurangiGerak" }).peringatan.length === 1, "peringatan penggantian");
  tegas(T.kamera(30, { durasi: 60, ke: { skala: 1.3 }, profil: "kurangiGerak" }).transform === "none", "kamera mati");
  tegas(T.paralaks(30, { lapisan: [{ kedalaman: 1 }], profil: "kurangiGerak" })[0].transform === "none", "paralaks mati");
  tegas(T.paralaks(30, { lapisan: [{ kedalaman: 1 }], profil: "lansia" })[0].transform === "none", "paralaks mati untuk lansia");
  tegas(T.animasi(20, { jenis: "getar", mulai: 10, durasi: 20, profil: "kurangiGerak" }).transform === "none", "getar mati");
  tegas(T.animasi(20, { jenis: "geser", mulai: 10, durasi: 20, profil: "kurangiGerak" }).transform === undefined, "geser diganti pudar");
  tegas(T.animasi(20, { jenis: "skala", mulai: 10, durasi: 20, profil: "kurangiGerak" }).transform === undefined, "skala diganti pudar");
  tegas(T.bersama(10, { mulai: 0, durasi: 20, dari: { x: 0, y: 0, w: 10, h: 10 }, ke: { x: 5, y: 5, w: 50, h: 50 }, profil: "kurangiGerak" }).kotak.width !== undefined, "bersama tetap jalan linear");
  // profil lansia/anak menghindari jenis tertentu dan memperpanjang durasi
  tegas(T.transisi(20, { jenis: "zoom", mulai: 10, durasi: 30, profil: "lansia" }).jenisEfektif === "pudar", "lansia menghindari zoom");
  tegas(T.durasiTransisi({ jenis: "pudar", durasi: 20, profil: "lansia" }) === 30, "lansia durasi 1,5x");
  tegas(T.durasiTransisi({ jenis: "pudar", durasi: 20 }) === 20, "standar durasi 1x");
});

daftar("(h) efek berat: mati bawaan untuk jenis video tanpa efekBerat; grain diam bawaan", () => {
  tegas(T.efekBerat("promo") && T.efekBerat("sosial") && !T.efekBerat("formal") && !T.efekBerat("edukasi"), "efekBerat per jenis");
  const f = T.transisi(20, { jenis: "gangguan", mulai: 10, durasi: 20, jenisVideo: "formal" });
  tegas(f.jenisEfektif === "pudar" && f.peringatan.length === 1 && /efek berat mati/.test(f.peringatan[0]), `gangguan pada formal: ${json(f.peringatan)}`);
  tegas(T.transisi(20, { jenis: "gangguan", mulai: 10, durasi: 20, jenisVideo: "promo" }).jenisEfektif === "gangguan", "gangguan pada promo");
  tegas(T.transisi(20, { jenis: "gangguan", mulai: 10, durasi: 20, jenisVideo: "edukasi", paksaEfekBerat: true }).jenisEfektif === "gangguan", "paksaEfekBerat");
  tegas(T.transisi(20, { jenis: "gangguan", mulai: 10, durasi: 20 }).jenisEfektif === "gangguan", "tanpa jenisVideo tidak diblokir");
  let galat = false;
  try { T.efekBerat("tidakAda"); } catch { galat = true; }
  tegas(galat, "jenis video tidak dikenal");
  // susunAdegan meneruskan jenisVideo
  const s = T.susunAdegan([{ durasi: 60 }, { durasi: 60, transisi: { jenis: "gangguan", durasi: 12 } }], { fps: 30, jenisVideo: "formal" });
  tegas(s.pada(s.peta[1].mulai + 3).transisi.jenisEfektif === "pudar", "susunAdegan meneruskan jenisVideo");
  // grain: kanvas tiruan
  const buat = () => { let data = null; return { width: 8, height: 4, ambil: () => data.slice(), getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (img) => { data = img.data; } }) }; };
  const g = (frame, o) => { const k = buat(); const r = T.grain(k, frame, o); return { piksel: json(Array.from(k.ambil())), hidup: r.hidup }; };
  tegas(g(3, {}).piksel === g(99, {}).piksel, "grain bawaan diam");
  tegas(g(3, { hidup: 1 }).piksel !== g(4, { hidup: 1 }).piksel && g(3, { hidup: 1 }).hidup, "grain hidup berubah tiap frame");
  tegas(g(3, { hidup: 1 }).piksel === g(3, { hidup: 1 }).piksel, "grain murni");
  tegas(g(3, { hidup: 1, tahan: 3 }).piksel === g(5, { hidup: 1, tahan: 3 }).piksel, "grain tahan");
  tegas(!g(3, { hidup: 1, jenisVideo: "formal" }).hidup && g(3, { hidup: 1, jenisVideo: "formal" }).piksel === g(9, { hidup: 1, jenisVideo: "formal" }).piksel, "grain hidup diturunkan pada formal");
  tegas(g(3, { hidup: 1, jenisVideo: "kreatif" }).hidup, "grain hidup pada kreatif");
});

daftar("(i) durasi minimum jenis berkilat dan susunAdegan", () => {
  tegas(T.durasiTransisi({ jenis: "kilat", durasi: 3 }) >= 12, "kilat durasi min");
  tegas(T.durasiTransisi({ jenis: "kebocoran", durasi: 3 }) >= 21, "kebocoran durasi min");
  tegas(T.durasiTransisi({ jenis: "gangguan", durasi: 3 }) >= 9, "gangguan durasi min");
  const s = T.susunAdegan([{ durasi: 60 }, { durasi: 60, transisi: { jenis: "pudar", durasi: 15 } }, { durasi: 60, transisi: { jenis: "potong" } }], { fps: 30 });
  tegas(s.total === 60 + 45 + 60, `total ${s.total}`);
  tegas(s.peta[1].tunggal === 45 && s.peta[0].tunggal === 45, `tunggal ${s.peta[0].tunggal},${s.peta[1].tunggal}`);
  tegas(s.pada(40).adegan[0].tampil && !s.pada(40).adegan[1].tampil, "susun 40");
  tegas(s.pada(52).adegan[0].tampil && s.pada(52).adegan[1].tampil, "susun tumpang-tindih");
  tegas(!s.pada(106).adegan[0].tampil && s.pada(106).adegan[2].tampil, "susun potong");
  // setiap frame tepat ada adegan yang tampil
  for (let f = 0; f < s.total; f++) tegas(s.pada(f).adegan.some((a) => a.tampil), `frame ${f} kosong`);
  // profil memperpanjang tumpang-tindih sehingga total berubah
  const lansia = T.susunAdegan([{ durasi: 60 }, { durasi: 60, transisi: { jenis: "pudar", durasi: 15 } }], { fps: 30, profil: "lansia" });
  tegas(lansia.total < 60 + 45, `lansia total ${lansia.total}`);
  // preset per jenis video
  tegas(T.presetJenisVideo("formal", "antarAdegan").jenis === "pudar" && T.presetJenisVideo("promo", "antarBagian", "lansia").profil === "lansia", "presetJenisVideo");
  for (const jv of ["formal", "edukasi", "kreatif", "promo", "produk", "panduan", "dokumenter", "sosial", "data", "testimoni", "psa", "internal", "acara"]) {
    for (const peran of ["antarAdegan", "antarBagian", "pembuka", "penutup"]) {
      const p = T.presetJenisVideo(jv, peran);
      tegas(namaT.includes(p.jenis), `preset ${jv}/${peran} jenis tidak dikenal: ${p.jenis}`);
    }
  }
});

daftar("(j) periksaKilatan tingkat rencana, termasuk kontrol negatif", () => {
  tegas(T.periksaKilatan([{ jenis: "celup", mulai: 0 }, { jenis: "celup", mulai: 40 }, { jenis: "celup", mulai: 80 }], 30).ok, "kilatan aman");
  const buruk = T.periksaKilatan([0, 8, 16, 24].map((m) => ({ jenis: "celup", mulai: m, durasi: 7 })), 30);
  tegas(!buruk.ok && buruk.galat.length === 1, "kontrol negatif harus galat");
  tegas(T.periksaKilatan([{ jenis: "pudar", mulai: 0 }, { jenis: "pudar", mulai: 4 }, { jenis: "geser", mulai: 8 }, { jenis: "dorong", mulai: 12 }], 30).ok, "transisi tanpa kilat tidak dihitung");
  // tiga kilatan dalam satu detik: lolos tetapi diberi peringatan tanpa margin
  const tiga = T.periksaKilatan([0, 9, 18].map((m) => ({ jenis: "celup", mulai: m, durasi: 7 })), 30);
  tegas(tiga.ok && tiga.peringatan.length >= 1, "tiga kilatan harus diberi peringatan");
  tegas(!T.periksaKilatan([{ jenis: ["kebocoran", "kilat"], mulai: 0 }, { jenis: ["kebocoran", "kilat"], mulai: 10 }], 30).ok, "jenis berantai dihitung");
  tegas(T.periksaKilatan([{ jenis: "gangguan", mulai: 0, intensitas: 3 }], 30).peringatan.length === 1, "peringatan intensitas gangguan");
  tegas(T.katalog().filter((k) => k.kategori === "transisi" && k.kilat > 0).map((k) => k.nama).sort().join() === "celup,kebocoran,kilat,tirai", "jenis berkilat");
});

// bagian galeri frame 600..760 memuat gangguan, kebocoran, kilat, tirai, dan celup
const RENTANG = ["--dari", "600", "--sampai", "760"];

daftar("(k) render galeri (frame 600..760: jenis berkilat) lalu periksa.mjs lolos", async () => {
  const mp4 = join(tmp, "galeri.mp4");
  const r = await renderKe(galeri, "--out", mp4, "--props-file", join(akar, "templates", "transisi-galeri", "props.json"), ...RENTANG);
  tegas(r.kode === 0, `render exit ${r.kode}: ${r.err}`);
  const p = await jalankan(["bun", periksaCli, mp4, "--json"]);
  tegas(p.kode === 0, `periksa exit ${p.kode}: ${p.out.slice(0, 400)}`);
  const hasil = JSON.parse(p.out);
  tegas(hasil.lolos === true, "periksa tidak lolos");
  const kilatan = hasil.pemeriksaan.filter((x) => /kilatan/i.test(x.id) || /Kilatan/.test(x.ringkas || ""));
  tegas(kilatan.length >= 1, "pemeriksaan kilatan tidak ditemukan");
});

daftar("(l) render profil kurangiGerak lolos periksa dan berbeda dari standar", async () => {
  const a = join(tmp, "kg.mp4"), b = join(tmp, "std.mp4");
  const sempit = ["--dari", "612", "--sampai", "650"];
  const ra = await renderKe(galeri, "--out", a, "--props", '{"profil":"kurangiGerak"}', ...sempit);
  const rb = await renderKe(galeri, "--out", b, "--props", '{"profil":"standar"}', ...sempit);
  tegas(ra.kode === 0 && rb.kode === 0, `render: ${ra.err} ${rb.err}`);
  tegas((await jalankan(["bun", periksaCli, a])).kode === 0, "periksa kurangiGerak");
  tegas(await framemd5(a) !== await framemd5(b), "kurangiGerak harus mengubah hasil render");
});

daftar("(m) kontrol negatif: enam dip putih tiap 8 frame GAGAL di periksa.mjs", async () => {
  const html = join(tmp, "kontrol-kilat.html");
  const rt = pathToFileURL(join(akar, "scripts", "runtime.js")).href;
  const tr = pathToFileURL(join(akar, "scripts", "transisi.js")).href;
  writeFileSync(html, `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>kontrol negatif kilatan</title>
<style>html,body{margin:0}#layar{position:relative;width:640px;height:360px;overflow:hidden;background:#222}#ov{position:absolute;inset:0;z-index:10}</style></head>
<body><div id="layar"><div id="ov"></div></div>
<script src="${rt}"></script><script src="${tr}"></script>
<script>
var Tr = window.Transisi, daftar = [0, 8, 16, 24, 32, 40].map(function (m) { return { jenis: "celup", mulai: m, durasi: 7, warna: "#fff", lebar: 640, tinggi: 360 }; });
defineVideo({ width: 640, height: 360, fps: 30, durationInFrames: 60, render: function (f) {
  var ov = [];
  daftar.forEach(function (d) { var h = Tr.transisi(f, d); if (h.aktif) ov = h.overlay; });
  Tr.terapkan({ overlay: ov, svg: null, wadah: null }, { overlay: document.getElementById("ov") });
} });
</script></body></html>`);
  const mp4 = join(tmp, "kontrol.mp4");
  const r = await renderKe(html, "--out", mp4);
  tegas(r.kode === 0, `render kontrol exit ${r.kode}: ${r.err}`);
  const p = await jalankan(["bun", periksaCli, mp4]);
  tegas(p.kode === 1 && /GAGAL/.test(p.out), `periksa harus GAGAL pada kontrol negatif (exit ${p.kode}): ${p.out.slice(0, 300)}`);
  // pemeriksa tingkat rencana sepakat
  tegas(!T.periksaKilatan([0, 8, 16, 24, 32, 40].map((m) => ({ jenis: "celup", mulai: m, durasi: 7 })), 30).ok, "periksaKilatan harus sepakat");
});

daftar("(n) determinisme galeri: dua render rentang gangguan menghasilkan framemd5 identik", async () => {
  const a = join(tmp, "det-a.mp4"), b = join(tmp, "det-b.mp4");
  const sempit = ["--dari", "612", "--sampai", "645"];
  const ra = await renderKe(galeri, "--out", a, ...sempit);
  const rb = await renderKe(galeri, "--out", b, ...sempit);
  tegas(ra.kode === 0 && rb.kode === 0, `render: ${ra.err} ${rb.err}`);
  const fa = await framemd5(a), fb = await framemd5(b);
  tegas(fa.split("\n").length === 34, `jumlah frame ${fa.split("\n").length}`);
  tegas(fa === fb, "framemd5 dua render berbeda");
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
