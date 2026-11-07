#!/usr/bin/env bun
/**
 * uji-caption.mjs — uji mode dan posisi caption (runtime.js: rencanaCaption, keadaanCaption,
 * captionHtml, areaAmanVertikal) dan pengenalan kunci posisi di naskah.json (narasi-caption.mjs).
 * Bagian murni berjalan tanpa browser; bagian (m) dan (n) memakai templat narasi-contoh di
 * Chromium dan render.mjs (butuh ffmpeg dan Chromium, seperti uji renderer). Tanpa jaringan.
 * Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-caption.mjs
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODE_CAPTION, POSISI_CAPTION } from "./narasi-caption.mjs";
import { validasiNaskah } from "./narasi.mjs";
import { buatProps } from "../templates/narasi-contoh/buat-props.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const templat = join(akar, "templates", "narasi-contoh");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-caption-"));

// ---- runtime.js (UMD, butuh window sementara)
function muatRuntime() {
  const sebelum = globalThis.window;
  globalThis.window = { location: { search: "" } };
  try { return createRequire(import.meta.url)(join(akar, "scripts", "runtime.js")); } finally {
    if (sebelum === undefined) delete globalThis.window; else globalThis.window = sebelum;
  }
}
const R = muatRuntime();
const { rencanaCaption, keadaanCaption, captionHtml, areaAman, areaAmanVertikal, areaCaption, kontras, pilihTeksKontras, pecahBaris, parseVtt, acak } = R;

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) { if (!kondisi) throw new Error(pesan); }
function samaDengan(nyata, harapan, nama) {
  const a = JSON.stringify(nyata), b = JSON.stringify(harapan);
  tegas(a === b, `${nama}: dapat ${a}, harapan ${b}`);
}
function melempar(fn, pola, nama) {
  let pesan = null;
  try { fn(); } catch (e) { pesan = e.message; }
  tegas(pesan !== null, `${nama}: seharusnya melempar galat`);
  tegas(pola.test(pesan), `${nama}: pesan galat "${pesan}" tidak cocok ${pola}`);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const dalam = (k, a, eps = 0) => k.x >= a.x - eps && k.y >= a.y - eps && k.x + k.w <= a.x + a.w + eps && k.y + k.h <= a.y + a.h + eps;
const blendTerburuk = (latar, alfa) => [[0, 0, 0], [255, 255, 255]].map((b) => [0, 1, 2].map((i) => alfa * latar[i] + (1 - alfa) * b[i]));

/** Cue sintetis berurutan (frame bulat) dengan kata berstempel merata; teks 2..N kata acak. */
function cueSintetis({ fps = 30, n = 6, seed = "cap", maksKarakter = 42, baris = 2, penutur = null } = {}) {
  const r = acak(seed);
  const leksikon = ["meja", "kerja", "merapikan", "kabel", "belakang", "singkirkan", "barang", "tidak", "dipakai", "hari", "ini", "alat", "tulis", "wadah", "kelompokkan", "mudah", "tersangkut", "panduan", "singkat", "selamat", "datang"];
  const cues = [], kata = [];
  let t = 10;
  for (let i = 0; i < n; i++) {
    const jml = 3 + Math.floor(r() * 8);
    let teks = "";
    const kataCue = [];
    while (kataCue.length < jml) {
      const w = leksikon[Math.floor(r() * leksikon.length)];
      if ((teks + " " + w).trim().length > maksKarakter * baris - 24) break; // pasti muat: kata terpanjang 11 karakter
      kataCue.push(w);
      teks = kataCue.join(" ");
    }
    const dur = 45 + Math.floor(r() * 40);
    const dt = Math.floor(dur / kataCue.length);
    cues.push({ mulai: t / fps, akhir: (t + dur) / fps, teks, ...(penutur ? { penutur } : {}) });
    kataCue.forEach((w, k) => kata.push({ tampil: w, mulaiFrame: t + k * dt, akhirFrame: t + (k + 1) * dt, cue: i + 1, penutur: penutur ?? "narator" }));
    t += dur + 8;
  }
  return { cues, kata, akhirFrame: t };
}
const rencanaDasar = (o = {}) => {
  const s = cueSintetis(o.sintetis);
  return { s, r: rencanaCaption({ cues: s.cues, kata: s.kata, lebar: 1280, tinggi: 720, fps: 30, ...o.opsi }) };
};
const seluruhFrame = (r) => {
  const hasil = [];
  for (const c of r.cue) for (let f = c.mulaiFrame; f < c.akhirFrame; f++) hasil.push([c, f, keadaanCaption(r, f)]);
  return hasil;
};

const uji = [];
const tes = (nama, fn) => uji.push([nama, fn]);

// =========================================================== (a) dasar dan area
tes("(a) ekspor, daftar mode/posisi sama dengan skema naskah, area aman vertikal", () => {
  for (const k of ["areaAmanVertikal", "areaCaption", "rencanaCaption", "keadaanCaption", "captionHtml"]) tegas(typeof R[k] === "function", `${k} tidak diekspor`);
  samaDengan(rencanaCaption.mode, MODE_CAPTION, "mode runtime = skema naskah");
  samaDengan(rencanaCaption.posisi, POSISI_CAPTION, "posisi runtime = skema naskah");
  samaDengan(areaAmanVertikal(1080, 1920), { x: 65, y: 250, w: 895, h: 1190 }, "area vertikal 1080x1920");
  samaDengan(areaAmanVertikal(720, 1280), { x: 43, y: 167, w: 597, h: 793 }, "area vertikal 720x1280 (diskalakan)");
  samaDengan(areaCaption(1920, 1080), areaAman(1920, 1080).aksi, "lanskap memakai area aksi EBU R 95");
  samaDengan(areaCaption(1080, 1920), areaAmanVertikal(1080, 1920), "potret memakai area vertikal");
  for (const [w, h] of [[1080, 1920], [720, 1280], [2160, 3840]]) {
    tegas(dalam(areaAmanVertikal(w, h), areaAman(w, h).aksi), `area vertikal ${w}x${h} di dalam area aksi`);
  }
  melempar(() => areaAmanVertikal(0, 100), /lebar/, "lebar 0");
  melempar(() => rencanaCaption({ cues: [], lebar: 100, tinggi: 100 }), /fps/, "fps wajib");
  melempar(() => rencanaCaption({ cues: [], lebar: 100, tinggi: 100, fps: 30, mode: "ketik" }), /mode/, "mode tak dikenal");
  melempar(() => rencanaCaption({ cues: [], lebar: 100, tinggi: 100, fps: 30, posisi: "tengah" }), /posisi/, "posisi tak dikenal");
  melempar(() => rencanaCaption({ cues: [{ mulai: 0, akhir: 1, teks: "  " }], lebar: 1280, tinggi: 720, fps: 30 }), /tidak boleh kosong/, "cue kosong");
  melempar(() => rencanaCaption({ cues: [], lebar: 1280, tinggi: 720, fps: 30, area: { x: 0, y: 0, w: 2000, h: 10 } }), /area/, "area di luar bingkai");
  melempar(() => keadaanCaption({}, 0), /rencana/, "rencana salah");
});

// ===================================================================== (b) kontras
tes("(b) kontras: teks dari pilihTeksKontras, lolos 4,5:1 di atas gambar hitam maupun putih; peringatan bila tidak", () => {
  for (const mode of MODE_CAPTION) {
    const { r } = rencanaDasar({ opsi: { mode } });
    tegas(r.warna.teks === pilihTeksKontras(r.warna.latar), `teks ${r.warna.teks} bukan pilihan pilihTeksKontras(${r.warna.latar})`);
    for (const e of blendTerburuk(R.luminansRelatif ? [0, 0, 0] : [0, 0, 0], r.warna.latarAlfa)) tegas(kontras(r.warna.teks, e) >= 4.5, `kontras teks ${mode}`);
    tegas(r.kontras.lolos && r.kontras.teks >= 4.5 && r.kontras.sorot >= 4.5, `kontras ${JSON.stringify(r.kontras)}`);
    tegas(kontras(r.warna.sorotTeks, r.warna.sorot) >= 4.5, "kontras teks sorot");
    samaDengan(r.peringatan, [], `tanpa peringatan (${mode})`);
  }
  // latar terang: teks hitam; latar transparan: tidak ada jaminan -> peringatan, lolos false
  const terang = rencanaDasar({ opsi: { latar: { warna: "#ffffff", alfa: 0.9 } } }).r;
  samaDengan(terang.warna.teks, "#000000", "teks hitam di latar putih");
  const transparan = rencanaDasar({ opsi: { latar: { warna: "#000000", alfa: 0 } } }).r;
  samaDengan(transparan.kontras.lolos, false, "latar transparan tak lolos");
  tegas(transparan.peringatan.some((p) => /kontras teks/.test(p)), "peringatan kontras latar transparan");
  const buruk = rencanaDasar({ opsi: { warnaTeks: "#777777", latar: { warna: "#ffffff", alfa: 1 } } }).r;
  tegas(!buruk.kontras.lolos && buruk.peringatan.some((p) => /kontras teks/.test(p)), "warna teks buruk diperingatkan");
  const sorotBuruk = rencanaDasar({ opsi: { mode: "sorot-kata", sorot: "#ffd400", sorotTeks: "#ffffff" } }).r;
  tegas(!sorotBuruk.kontras.lolos && sorotBuruk.peringatan.some((p) => /sorot/.test(p)), "sorot dengan teks putih diperingatkan");
  melempar(() => rencanaDasar({ opsi: { latar: { warna: "merah", alfa: 0.5 } } }), /warna/, "warna latar tak sah");
  melempar(() => rencanaDasar({ opsi: { latar: { alfa: 2 } } }), /alfa/, "alfa di luar 0..1");
});

// ===================================================================== (c) pop-on
tes("(c) pop-on: blok utuh tepat di [mulai, akhir), baris sama dengan pecahBaris, null di luar cue", () => {
  const { s, r } = rencanaDasar({ opsi: { mode: "pop-on" } });
  for (const [c, f, k] of seluruhFrame(r)) {
    const dari = s.cues[c.n - 1];
    const harap = pecahBaris(dari.teks, { maks: 42, baris: 2 });
    samaDengan(k.baris.map((b) => b.kata.map((x) => x.teks).join(" ")), [...harap], `baris cue ${c.n} frame ${f}`);
    tegas(k.baris.every((b) => b.kata.every((x) => x.terlihat === Array.from(x.teks).length && !x.sorot)), "semua karakter terlihat tanpa sorot");
    samaDengan(k.aktifKata, -1, "pop-on tanpa kata aktif");
  }
  const c1 = r.cue[0];
  samaDengan(keadaanCaption(r, c1.mulaiFrame - 1), null, "sebelum cue");
  samaDengan(keadaanCaption(r, c1.akhirFrame), null, "akhir cue eksklusif");
  tegas(keadaanCaption(r, c1.mulaiFrame) !== null && keadaanCaption(r, c1.akhirFrame - 1) !== null, "cue aktif di batas dalam");
  samaDengan(keadaanCaption(r, 0), null, "frame 0 sebelum cue pertama");
});

// ==================================================================== (d) roll-up
tes("(d) roll-up: tidak pernah lebih dari dua baris, baris naik tepat saat kata barisnya mulai, bergulir dari frame", () => {
  const cues = [{ mulai: 0.3, akhir: 4, teks: "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas duabelas tigabelas" }];
  const kata = cues[0].teks.split(" ").map((t, i) => ({ tampil: t, mulaiFrame: 9 + i * 8, akhirFrame: 9 + (i + 1) * 8, cue: 1 }));
  const r = rencanaCaption({ cues, kata, lebar: 1280, tinggi: 720, fps: 30, mode: "roll-up", maksKarakter: 20, maksBaris: 4 });
  samaDengan(r.cue[0].baris.length >= 3, true, "cue memuat >= 3 baris");
  const W = Math.min(2, r.cue[0].baris.length);
  samaDengan(r.cue[0].kotak.h, W * r.tinggiBaris + 2 * r.padY, "kotak setinggi jendela dua baris");
  let maksTampil = 0;
  const terlihatTeks = [];
  for (let f = r.cue[0].mulaiFrame; f < r.cue[0].akhirFrame; f++) {
    const k = keadaanCaption(r, f);
    maksTampil = Math.max(maksTampil, k.baris.length);
    tegas(k.baris.length >= 1 && k.baris.length <= 3, `jumlah baris ${k.baris.length} pada frame ${f}`);
    // yang terlihat penuh (opasitas 1) paling banyak dua baris; satu lagi hanya sedang masuk atau keluar
    tegas(k.baris.filter((b) => b.opasitas === 1).length <= 2, "lebih dari dua baris penuh");
    for (const b of k.baris) tegas(b.y > -r.tinggiBaris && b.y < W * r.tinggiBaris + 2 * r.padY + r.tinggiBaris, `y ${b.y} di luar jendela`);
    terlihatTeks.push(k.baris.map((b) => b.kata.map((x) => x.teks).join(" ")).join("|"));
  }
  tegas(maksTampil <= 3, "paling banyak dua baris stabil + satu bertransisi");
  // baris ke-j belum ada sebelum frame mulainya dan ada sejak frame itu
  for (const [j, b] of r.cue[0].baris.entries()) {
    const sebelum = b.mulaiFrame - 1 >= r.cue[0].mulaiFrame ? keadaanCaption(r, b.mulaiFrame - 1) : null;
    const teks = b.teks;
    if (sebelum) tegas(!sebelum.baris.some((x) => x.kata.map((y) => y.teks).join(" ") === teks), `baris ${j} muncul sebelum waktunya`);
    tegas(keadaanCaption(r, b.mulaiFrame).baris.some((x) => x.kata.map((y) => y.teks).join(" ") === teks), `baris ${j} belum muncul di frame mulainya`);
  }
  // gulir: baris yang sama naik (y menurun) hingga mencapai slot akhir, tidak pernah turun
  const baris2 = r.cue[0].baris[2];
  const y = [];
  for (let f = baris2.mulaiFrame; f < baris2.mulaiFrame + 8; f++) {
    const b = keadaanCaption(r, f).baris.find((x) => x.kata.map((z) => z.teks).join(" ") === r.cue[0].baris[1].teks);
    if (b) y.push(b.y);
  }
  tegas(y.length >= 3 && y.every((v, i) => i === 0 || v <= y[i - 1]) && y[0] > y[y.length - 1], `baris naik monoton: ${y}`);
  // cue yang muat dua baris: jendela dua baris, baris pertama tetap ada
  const dua = rencanaDasar({ opsi: { mode: "roll-up" } }).r;
  for (const [c, , k] of seluruhFrame(dua)) tegas(k.baris.length <= 2 && c.baris.length <= 2, "cue dua baris tak lebih dari dua baris");
});

// =================================================================== (e) paint-on
tes("(e) paint-on: huruf muncul menurut stempel kata, monoton, label penutur penuh, tata letak tidak bergeser", () => {
  const cues = [{ mulai: 1, akhir: 3, teks: "[Pak Budi] Saya menata kabel di belakang meja." }];
  const kata = "Saya menata kabel di belakang meja.".split(" ").map((t, i) => ({ tampil: t, mulaiFrame: 30 + i * 10, akhirFrame: 30 + (i + 1) * 10, cue: 1 }));
  const r = rencanaCaption({ cues, kata, lebar: 1280, tinggi: 720, fps: 30, mode: "paint-on" });
  samaDengan(r.cue[0].kata.slice(0, 2).map((k) => k.label), [true, true], "label terdeteksi");
  const jejak = [];
  for (let f = 30; f < 90; f++) {
    const k = keadaanCaption(r, f);
    jejak.push(k.baris.flatMap((b) => b.kata.map((x) => x.terlihat)));
    for (const b of k.baris) for (const x of b.kata) {
      tegas(x.terlihat >= 0 && x.terlihat <= Array.from(x.teks).length, "terlihat di luar 0..panjang");
    }
  }
  // label selalu penuh
  tegas(jejak.every((v) => v[0] === 4 && v[1] === 5), "label [Pak Budi] selalu penuh");
  // monoton per kata
  for (let i = 0; i < jejak[0].length; i++) for (let t = 1; t < jejak.length; t++) tegas(jejak[t][i] >= jejak[t - 1][i], `kata ${i} menyusut pada langkah ${t}`);
  // kata "Saya" mulai di frame 30: sudah ada huruf, belum penuh; "menata" belum ada huruf sebelum frame 40
  const k30 = keadaanCaption(r, 30), k39 = keadaanCaption(r, 39), k40 = keadaanCaption(r, 40);
  const semuaKata = (k) => k.baris.flatMap((b) => b.kata);
  const saya30 = semuaKata(k30)[2], menata39 = semuaKata(k39)[3], menata40 = semuaKata(k40)[3];
  tegas(saya30.terlihat >= 1 && saya30.terlihat < 4, `huruf pertama Saya: ${saya30.terlihat}`);
  samaDengan(semuaKata(k39)[2].terlihat, 4, "Saya penuh di akhir jendelanya");
  samaDengan(menata39.terlihat, 0, "menata belum mulai");
  tegas(menata40.terlihat >= 1, "menata mulai di frame 40");
  // kotak dan jumlah baris tetap selama cue (tak ada loncatan tata letak)
  samaDengan(new Set(jejak.map((v) => v.length)).size, 1, "jumlah kata konstan");
  const kotak = new Set();
  for (let f = 30; f < 90; f++) kotak.add(JSON.stringify(keadaanCaption(r, f).kotak));
  samaDengan(kotak.size, 1, "kotak konstan");
  // HTML: karakter yang belum tampil menempati ruang (visibility:hidden), bukan dihapus
  const h = captionHtml(k30);
  tegas(/visibility:hidden/.test(h), "sisa karakter disembunyikan dengan visibility:hidden");
  tegas(h.replace(/<[^>]*>/g, "").includes("menata"), "teks lengkap tetap ada di DOM");
});

// ================================================================= (f) sorot-kata
tes("(f) sorot-kata: kalimat penuh selalu tampil, kata aktif maju monoton sesuai stempel", () => {
  const { s, r } = rencanaDasar({ opsi: { mode: "sorot-kata" } });
  for (const c of r.cue) {
    let prev = -1;
    for (let f = c.mulaiFrame; f < c.akhirFrame; f++) {
      const k = keadaanCaption(r, f);
      tegas(k.aktifKata >= prev, `kata aktif mundur di cue ${c.n} frame ${f}: ${prev} -> ${k.aktifKata}`);
      prev = k.aktifKata;
      const kataK = k.baris.flatMap((b) => b.kata);
      tegas(kataK.every((x) => x.terlihat === Array.from(x.teks).length), "kalimat penuh terlihat");
      samaDengan(kataK.filter((x) => x.sorot).length, k.aktifKata >= 0 ? 1 : 0, "tepat satu kata disorot");
      // kata aktif = kata terakhir yang sudah mulai
      const harap = c.kata.reduce((a, x, i) => (!x.label && x.mulaiFrame <= f ? i : a), -1);
      samaDengan(k.aktifKata, harap, `kata aktif cue ${c.n} frame ${f}`);
    }
    tegas(prev === c.kata.length - 1, `kata terakhir disorot di akhir cue ${c.n}`);
  }
  // label penutur tidak pernah disorot
  const r2 = rencanaCaption({ cues: [{ mulai: 0, akhir: 2, teks: "[Ani] Halo semua." }], kata: [{ tampil: "Halo", mulaiFrame: 0, akhirFrame: 20, cue: 1 }, { tampil: "semua.", mulaiFrame: 20, akhirFrame: 40, cue: 1 }], lebar: 1280, tinggi: 720, fps: 30, mode: "sorot-kata" });
  for (let f = 0; f < 60; f++) {
    const k = keadaanCaption(r2, f);
    const kt = k.baris.flatMap((b) => b.kata);
    tegas(!kt[0].sorot, "label tidak disorot");
  }
  samaDengan(keadaanCaption(r2, 0).aktifKata, 1, "kata nyata pertama (setelah label) aktif di frame 0");
  const html = captionHtml(keadaanCaption(r2, 25));
  samaDengan((html.match(/box-shadow/g) ?? []).length, 1, "satu span sorot di HTML");
});

// ================================================================= (g) satu-kata
tes("(g) satu-kata: tepat satu kata per frame, urutan benar, font besar, kata terpanjang muat", () => {
  const { s, r } = rencanaDasar({ opsi: { mode: "satu-kata" } });
  const rPop = rencanaDasar({ opsi: { mode: "pop-on" } }).r;
  tegas(r.ukuranFont > rPop.ukuranFont, `font satu-kata ${r.ukuranFont} lebih besar dari ${rPop.ukuranFont}`);
  for (const c of r.cue) {
    const dilihat = [];
    for (let f = c.mulaiFrame; f < c.akhirFrame; f++) {
      const k = keadaanCaption(r, f);
      samaDengan(k.baris.length, 1, "satu baris");
      samaDengan(k.baris[0].kata.length, 1, "satu kata");
      const idx = k.aktifKata;
      samaDengan(k.baris[0].kata[0].teks, c.kata[idx].teks, `kata cue ${c.n} frame ${f}`);
      if (dilihat[dilihat.length - 1] !== idx) dilihat.push(idx);
    }
    samaDengan(dilihat, c.kata.map((_, i) => i), `urutan kata cue ${c.n}`);
    samaDengan(c.kotak.h, r.tinggiBaris + 2 * r.padY, "kotak satu baris");
  }
  // label tidak ditampilkan; kata terpanjang muat: kotak <= area
  const r2 = rencanaCaption({ cues: [{ mulai: 0, akhir: 2, teks: "[Ani] mengelompokkan alat tulis sekarang juga" }], lebar: 1080, tinggi: 1920, fps: 30, mode: "satu-kata" });
  for (let f = 0; f < 60; f++) tegas(!/\[Ani\]|^\[|\]$/.test(keadaanCaption(r2, f).baris[0].kata[0].teks), "label tidak jadi kata tunggal");
  tegas(dalam(r2.cue[0].kotak, r2.area) && r2.peringatan.length === 0, `kotak satu-kata di area: ${JSON.stringify(r2.peringatan)}`);
  // laju cepat (kata < 150 ms) tidak ditolak: waktu tampil memang mengikuti stempel
  const cepat = rencanaCaption({ cues: [{ mulai: 0, akhir: 1, teks: "a b c d" }], lebar: 1280, tinggi: 720, fps: 30, mode: "satu-kata" });
  samaDengan(keadaanCaption(cepat, 29) !== null, true, "cue cepat tetap tampil");
});

// ================================================================= (h) posisi
tes("(h) posisi bawah/atas/auto: kotak tetap selama cue, auto menghindari zona, peringatan bila tak ada tempat", () => {
  const s = cueSintetis({ n: 4 });
  const dasar = { cues: s.cues, kata: s.kata, lebar: 1280, tinggi: 720, fps: 30, mode: "pop-on" };
  const area = areaCaption(1280, 720);
  const bawah = rencanaCaption({ ...dasar, posisi: "bawah" });
  const atas = rencanaCaption({ ...dasar, posisi: "atas" });
  for (const c of bawah.cue) { samaDengan(c.posisi, "bawah", "posisi bawah"); samaDengan(c.kotak.y + c.kotak.h, area.y + area.h, "tepi bawah kotak = tepi bawah area"); }
  for (const c of atas.cue) { samaDengan(c.posisi, "atas", "posisi atas"); samaDengan(c.kotak.y, area.y, "tepi atas kotak = tepi atas area"); }
  // tengah horizontal
  for (const c of bawah.cue) tegas(Math.abs(c.kotak.x + c.kotak.w / 2 - (area.x + area.w / 2)) <= 0.5, "kotak di tengah area");
  // bawaan posisi = bawah
  samaDengan(rencanaCaption({ ...dasar }).cue.map((c) => c.posisi), bawah.cue.map((c) => c.posisi), "bawaan bawah");

  const [c1, c2, c3, c4] = s.cues.map((c) => [Math.round(c.mulai * 30), Math.round(c.akhir * 30)]);
  // zona bawah hanya melintasi cue 2 dan 3 (sampai eksklusif: berakhir tepat di awal cue 4)
  const zona = [{ area: "bawah", dari: c2[0] + 1, sampai: c4[0] }];
  const auto = rencanaCaption({ ...dasar, posisi: "auto", zona });
  samaDengan(auto.cue.map((c) => c.posisi), ["bawah", "atas", "atas", "bawah"], "auto: naik hanya selama zona");
  samaDengan(auto.peringatan, [], "auto tanpa peringatan");
  // keputusan per cue: kotak identik di setiap frame cue (tidak melompat di tengah cue)
  for (const c of auto.cue) {
    const set = new Set();
    for (let f = c.mulaiFrame; f < c.akhirFrame; f++) set.add(JSON.stringify(keadaanCaption(auto, f).kotak));
    samaDengan(set.size, 1, `kotak cue ${c.n} konstan`);
  }
  // zona atas: auto tetap di bawah; zona kotak persegi di sisi bawah mendorong ke atas
  samaDengan(rencanaCaption({ ...dasar, posisi: "auto", zona: [{ area: "atas", dari: 0 }] }).cue.map((c) => c.posisi), ["bawah", "bawah", "bawah", "bawah"], "zona atas tidak menggeser ke atas");
  const kotakBawahKiri = { x: area.x, y: area.y + area.h - 80, w: 300, h: 80 };
  const dgnKotak = rencanaCaption({ ...dasar, posisi: "auto", zona: [{ kotak: kotakBawahKiri }] });
  samaDengan(dgnKotak.cue.map((c) => c.posisi), ["atas", "atas", "atas", "atas"], "zona kotak yang beririsan menaikkan caption");
  const kotakJauh = { x: area.x, y: area.y + area.h - 80, w: 20, h: 80 }; // di luar kotak caption (kotak lebih sempit dan di tengah)
  samaDengan(rencanaCaption({ ...dasar, posisi: "auto", zona: [{ kotak: kotakJauh }] }).cue.map((c) => c.posisi), ["bawah", "bawah", "bawah", "bawah"], "zona kotak yang tak beririsan diabaikan");
  // bawah dan atas sama-sama tertutup: tetap bawah, dengan peringatan
  const kedua = rencanaCaption({ ...dasar, posisi: "auto", zona: [{ area: "bawah", dari: c1[0], sampai: c1[1] }, { area: "atas", dari: c1[0], sampai: c1[1] }] });
  samaDengan(kedua.cue[0].posisi, "bawah", "keduanya tertutup tetap bawah");
  tegas(kedua.peringatan.some((p) => /^cue 1:.*sama-sama tertutup/.test(p)), `peringatan: ${kedua.peringatan}`);
  // posisi tetap yang bertabrakan zona diperingatkan, bukan digeser diam-diam
  const tetap = rencanaCaption({ ...dasar, posisi: "bawah", zona: [{ area: "bawah", dari: 0 }] });
  tegas(tetap.peringatan.length === 4 && tetap.cue.every((c) => c.posisi === "bawah"), `peringatan posisi tetap: ${tetap.peringatan.length}`);
  melempar(() => rencanaCaption({ ...dasar, zona: [{ area: "kiri" }] }), /zona\[0\]/, "zona tak sah");
  melempar(() => rencanaCaption({ ...dasar, zona: [{ kotak: { x: 0, y: 0, w: 0, h: 5 } }] }), /kotak/, "kotak zona tak sah");
});

tes("(h2) dekat-penutur: pusat kotak di jangkar, dijepit ke area, jangkar per penutur dan waktu, jatuh ke bawah tanpa jangkar", () => {
  const s = cueSintetis({ n: 3, penutur: "ani" });
  const dasar = { cues: s.cues, kata: s.kata, lebar: 1280, tinggi: 720, fps: 30, mode: "pop-on", posisi: "dekat-penutur" };
  const area = areaCaption(1280, 720);
  const r = rencanaCaption({ ...dasar, jangkar: { x: 640, y: 360 } });
  for (const c of r.cue) {
    samaDengan(c.posisi, "dekat-penutur", "posisi");
    tegas(Math.abs(c.kotak.x + c.kotak.w / 2 - 640) <= 0.5 && Math.abs(c.kotak.y + c.kotak.h / 2 - 360) <= 0.5, `pusat kotak ${JSON.stringify(c.kotak)}`);
  }
  samaDengan(r.peringatan, [], "tanpa peringatan");
  // titik ekstrem dijepit ke area aman
  for (const [x, y] of [[0, 0], [1280, 720], [0, 720], [1280, 0], [-500, 9999]]) {
    const e = rencanaCaption({ ...dasar, jangkar: { x, y } });
    for (const c of e.cue) tegas(dalam(c.kotak, area), `jangkar (${x},${y}) keluar area: ${JSON.stringify(c.kotak)}`);
  }
  const pojok = rencanaCaption({ ...dasar, jangkar: { x: 0, y: 0 } }).cue[0].kotak;
  samaDengan([pojok.x, pojok.y], [area.x, area.y], "jangkar (0,0) -> pojok area");
  // jangkar per penutur dan per rentang waktu
  const dua = cueSintetis({ n: 2, penutur: "ani" });
  const kataB = dua.kata.map((k, i) => (k.cue === 2 ? { ...k, penutur: "budi" } : k));
  const cuesB = dua.cues.map((c, i) => (i === 1 ? { ...c, penutur: "budi" } : c));
  const rp = rencanaCaption({ cues: cuesB, kata: kataB, lebar: 1280, tinggi: 720, fps: 30, posisi: "dekat-penutur", jangkar: [{ x: 300, y: 300, penutur: "ani" }, { x: 900, y: 500, penutur: "budi" }] });
  const jepitPusat = (x, w) => Math.min(Math.max(x, area.x + w / 2), area.x + area.w - w / 2); // pusat yang layak
  const px = (c) => c.kotak.x + c.kotak.w / 2;
  tegas(Math.abs(px(rp.cue[0]) - jepitPusat(300, rp.cue[0].kotak.w)) <= 0.5 && Math.abs(px(rp.cue[1]) - jepitPusat(900, rp.cue[1].kotak.w)) <= 0.5, `jangkar per penutur: ${px(rp.cue[0])}, ${px(rp.cue[1])}`);
  tegas(px(rp.cue[0]) < px(rp.cue[1]), "penutur kiri di kiri penutur kanan");
  const waktu = rencanaCaption({ ...dasar, jangkar: [{ x: 300, y: 300, dari: 0, sampai: 100 }, { x: 900, y: 500, dari: 100 }] });
  // cue mulai di frame 10 (< 100): jangkar pertama; cue berikutnya mulai >= 100: jangkar kedua
  tegas(Math.abs(px(waktu.cue[0]) - jepitPusat(300, waktu.cue[0].kotak.w)) <= 0.5, "jangkar menurut waktu awal cue (1)");
  const terakhir = waktu.cue[waktu.cue.length - 1];
  tegas(terakhir.mulaiFrame >= 100 && Math.abs(px(terakhir) - jepitPusat(900, terakhir.kotak.w)) <= 0.5 && Math.abs(terakhir.kotak.y + terakhir.kotak.h / 2 - 500) <= 0.5, "jangkar menurut waktu awal cue (2)");
  // tanpa jangkar yang cocok: jatuh ke bawah dengan peringatan
  const tanpa = rencanaCaption({ ...dasar });
  samaDengan(tanpa.cue.map((c) => c.posisi), ["bawah", "bawah", "bawah"], "tanpa jangkar jatuh ke bawah");
  tegas(tanpa.peringatan.length === 3 && /dekat-penutur tanpa jangkar/.test(tanpa.peringatan[0]), "peringatan tanpa jangkar");
  const salahPenutur = rencanaCaption({ ...dasar, jangkar: [{ x: 1, y: 1, penutur: "orang-lain" }] });
  samaDengan(salahPenutur.cue[0].posisi, "bawah", "jangkar penutur lain tidak dipakai");
  melempar(() => rencanaCaption({ ...dasar, jangkar: { x: "a", y: 1 } }), /jangkar\[0\]/, "jangkar tak sah");
  // zona beririsan dengan kotak dekat-penutur diperingatkan
  const bentrok = rencanaCaption({ ...dasar, jangkar: { x: 640, y: 360 }, zona: [{ kotak: { x: 500, y: 300, w: 300, h: 100 } }] });
  tegas(bentrok.peringatan.some((p) => /dekat-penutur beririsan/.test(p)), "peringatan zona di kotak dekat-penutur");
});

// ==================================================================== (i) area aman
tes("(i) semua mode dan posisi: kotak caption di dalam area aman pada 16:9 dan 9:16 (beberapa resolusi), kontras lolos", () => {
  const ukuran = [[1920, 1080], [1280, 720], [3840, 2160], [1080, 1920], [720, 1280], [2160, 3840]];
  let kombinasi = 0, kotakDiperiksa = 0;
  for (const [w, h] of ukuran) {
    const area = areaCaption(w, h);
    tegas(dalam(area, areaAman(w, h).aksi), `area caption ${w}x${h} di dalam area aksi EBU R 95`);
    const potret = h > w;
    const s = cueSintetis({ seed: `u${w}`, n: 8, maksKarakter: potret ? 28 : 42 });
    for (const mode of MODE_CAPTION) for (const posisi of POSISI_CAPTION) {
      const r = rencanaCaption({
        cues: s.cues, kata: s.kata, lebar: w, tinggi: h, fps: 30, mode, posisi,
        zona: [{ area: "bawah", dari: 0, sampai: 200 }, { kotak: { x: Math.round(w * 0.1), y: Math.round(h * 0.8), w: Math.round(w * 0.3), h: Math.round(h * 0.1) }, dari: 150 }],
        jangkar: [{ x: w * 0.5, y: h * 0.45 }],
      });
      kombinasi++;
      samaDengan(r.peringatan.filter((p) => !/zona|dekat-penutur beririsan/.test(p)), [], `peringatan tak terduga ${w}x${h} ${mode} ${posisi}`);
      tegas(r.kontras.lolos, `kontras ${w}x${h} ${mode}`);
      for (const c of r.cue) {
        kotakDiperiksa++;
        tegas(dalam(c.kotak, r.area), `${w}x${h} ${mode}/${posisi} cue ${c.n}: kotak ${JSON.stringify(c.kotak)} di luar area ${JSON.stringify(r.area)}`);
        tegas(dalam(c.kotak, areaAman(w, h).aksi), "kotak di luar area aksi EBU R 95");
        if (potret) tegas(dalam(c.kotak, areaAmanVertikal(w, h)), "kotak di luar area aman vertikal");
      }
      tegas(r.ukuranFont >= Math.min(r.ukuranFontMin, 1), "ukuran font positif");
      tegas(r.ukuranFont >= r.ukuranFontMin, `${w}x${h} ${mode}: font ${r.ukuranFont} < minimum ukuranTeks ${r.ukuranFontMin}`);
    }
  }
  tegas(kombinasi === ukuran.length * 20 && kotakDiperiksa > 500, `cakupan ${kombinasi} kombinasi, ${kotakDiperiksa} kotak`);
  // bingkai persegi (di luar cakupan 16:9 dan 9:16): kotak tetap di area; font di bawah minimum diperingatkan
  const persegi = cueSintetis({ seed: "persegi", n: 3 });
  const rp = rencanaCaption({ cues: persegi.cues, kata: persegi.kata, lebar: 1080, tinggi: 1080, fps: 30 });
  tegas(rp.cue.every((c) => dalam(c.kotak, rp.area)) && rp.peringatan.some((p) => /di bawah minimum ukuranTeks/.test(p)), `persegi: ${rp.peringatan}`);
  // teks yang tak muat: peringatan, bukan pelanggaran diam-diam; rencana tetap jadi
  const panjang = rencanaCaption({ cues: [{ mulai: 0, akhir: 3, teks: "kata ".repeat(40).trim() }], lebar: 1080, tinggi: 1920, fps: 30 });
  tegas(panjang.peringatan.some((p) => /tidak muat/.test(p)), "teks terlalu panjang diperingatkan");
  // area kecil: font dibatasi lebar (baris 42 karakter selalu muat di area)
  const sempit = rencanaCaption({ cues: [{ mulai: 0, akhir: 2, teks: "contoh teks yang cukup panjang untuk satu baris penuh dan lebih" }], lebar: 1280, tinggi: 720, fps: 30, area: { x: 400, y: 100, w: 480, h: 400 } });
  tegas(dalam(sempit.cue[0].kotak, sempit.area), "kotak di dalam area sempit kustom");
  tegas(sempit.ukuranFont < sempit.ukuranFontMin && sempit.peringatan.some((p) => /di bawah minimum ukuranTeks/.test(p)), `font dibatasi lebar dan diperingatkan: ${sempit.peringatan}`);
  // ukuranFont eksplisit yang terlalu besar dikurangi dengan peringatan
  const besar = rencanaCaption({ cues: [{ mulai: 0, akhir: 2, teks: "halo" }], lebar: 1280, tinggi: 720, fps: 30, ukuranFont: 500 });
  tegas(besar.ukuranFont < 500 && besar.peringatan.some((p) => /dikurangi/.test(p)), "ukuranFont terlalu besar dikurangi");
});

// ============================================================ (j) determinisme dan JSON
tes("(j) deterministik: rencana dan keadaan identik, rencana serialisasi JSON memberi keadaan sama, tanpa waktu atau acak", () => {
  for (const mode of MODE_CAPTION) {
    const a = rencanaDasar({ opsi: { mode, posisi: "auto", zona: [{ area: "bawah", dari: 0, sampai: 300 }] } }).r;
    const b = rencanaDasar({ opsi: { mode, posisi: "auto", zona: [{ area: "bawah", dari: 0, sampai: 300 }] } }).r;
    samaDengan(a, b, `rencana ${mode} dua kali`);
    const dariJson = JSON.parse(JSON.stringify(a));
    const jejakA = [], jejakB = [];
    for (let f = 0; f < 400; f += 3) { jejakA.push(keadaanCaption(a, f)); jejakB.push(keadaanCaption(dariJson, f)); }
    samaDengan(jejakA, jejakB, `keadaan ${mode} dari rencana JSON`);
    // urutan frame tak berpengaruh (tanpa keadaan tersembunyi)
    const acakUrut = [];
    for (let f = 399; f >= 0; f -= 3) acakUrut.unshift(keadaanCaption(a, f));
    samaDengan(acakUrut.length, jejakA.length, "jumlah sama");
    samaDengan(JSON.stringify(acakUrut).length, JSON.stringify(jejakA).length, `${mode}: keadaan tak bergantung urutan pemanggilan`);
    for (let f = 0; f < 400; f += 25) samaDengan(captionHtml(keadaanCaption(a, f)), captionHtml(keadaanCaption(dariJson, f)), `html ${mode} frame ${f}`);
  }
  // runtime.js tidak memanggil Date.now, Math.random, atau timer di bagian caption
  const sumber = readFileSync(join(akar, "scripts", "runtime.js"), "utf8");
  const awal = sumber.indexOf("caption: mode dan posisi"), akhir = sumber.indexOf("video di dalam video");
  const bagian = sumber.slice(awal, akhir).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // tanpa komentar
  tegas(awal > 0 && akhir > awal, "bagian caption ditemukan");
  tegas(!/Date\.now|new Date|Math\.random|setTimeout|setInterval|requestAnimationFrame|performance\.now/.test(bagian), "bagian caption memakai sumber waktu atau acak terlarang");
});

// ======================================================================= (k) HTML
tes("(k) captionHtml: escape, tanpa animasi/transisi CSS, null untuk tanpa cue, struktur per mode", () => {
  samaDengan(captionHtml(null), "", "tanpa keadaan");
  const r = rencanaCaption({ cues: [{ mulai: 0, akhir: 2, teks: "<b>tebal</b> & \"kutip\" <script>x</script>" }], lebar: 1280, tinggi: 720, fps: 30, mode: "sorot-kata" });
  const h = captionHtml(keadaanCaption(r, 10));
  tegas(!/<script|<b>/.test(h), "tag dari teks tidak lolos");
  tegas(/&lt;b&gt;tebal&lt;\/b&gt;/.test(h) && /&amp;/.test(h) && /&quot;kutip&quot;/.test(h), "karakter khusus di-escape");
  for (const mode of MODE_CAPTION) {
    const { r: rr } = rencanaDasar({ opsi: { mode } });
    const html = captionHtml(keadaanCaption(rr, rr.cue[0].mulaiFrame + 20));
    tegas(html.startsWith(`<div data-caption="${mode}"`), `elemen akar ${mode}`);
    tegas(!/transition|animation|@keyframes|<style|<script/i.test(html), `${mode}: tanpa animasi atau transisi CSS`);
    tegas(/position:absolute/.test(html) && /left:\d+px;top:\d+px;width:\d+px;height:\d+px/.test(html), "koordinat bingkai eksplisit");
  }
  const roll = rencanaDasar({ opsi: { mode: "roll-up" } }).r;
  tegas(/clip-path:inset\(0 -100vw 0 -100vw\)/.test(captionHtml(keadaanCaption(roll, roll.cue[0].mulaiFrame))), "roll-up memotong keluar vertikal saja");
  tegas(!/clip-path/.test(captionHtml(keadaanCaption(rencanaDasar({ opsi: { mode: "pop-on" } }).r, 20))), "pop-on tanpa clip-path");
  // gaya kustom
  const g = captionHtml(keadaanCaption(roll, roll.cue[0].mulaiFrame), { fontFamily: "Georgia", bobot: 700, radius: 3, bayangan: false });
  tegas(/font-family:Georgia/.test(g) && /font-weight:700/.test(g) && /border-radius:3px/.test(g) && !/text-shadow:0 1px/.test(g), "gaya kustom");
});

// ================================================================ (l) skema naskah
tes("(l) naskah.json mengenali caption.mode/posisi, zonaCaption, jangkarPenutur; menolak nilai salah; meneruskan ke kata.json", async () => {
  // WAV contoh tidak ikut git; buat dulu ke .cache seperti dirujuk naskah (idempoten)
  const ba = await jalankan(["bun", join(templat, "buat-audio.mjs"), join(akar, ".cache", "awvd", "narasi-contoh")]);
  tegas(ba.kode === 0, `buat-audio: ${ba.err}`);
  const dasar = JSON.parse(await Bun.file(join(templat, "naskah.json")).text());
  const cek = (ubah) => { const n = JSON.parse(JSON.stringify(dasar)); ubah(n); return validasiNaskah(n, templat); };
  const ok = cek(() => {});
  samaDengan(ok.galat, [], "naskah contoh sah");
  samaDengan(ok.peringatan, [], "naskah contoh tanpa peringatan (kunci dikenal)");
  samaDengan(ok.naskah.tampil, { mode: "pop-on", posisi: "auto" }, "tampil naskah");
  samaDengan(ok.naskah.adegan[1].tampil, { zonaCaption: [{ area: "bawah", dari: 0, sampai: null }], jangkarPenutur: { x: 794, y: 331 } }, "tampil adegan a2");
  for (const [ubah, pola, nama] of [
    [(n) => { n.caption.mode = "ketik"; }, /caption\.mode harus salah satu dari/, "mode salah"],
    [(n) => { n.caption.posisi = "tengah"; }, /caption\.posisi harus salah satu dari/, "posisi naskah salah"],
    [(n) => { n.adegan[0].posisi = 3; }, /adegan "a1": posisi harus/, "posisi adegan salah"],
    [(n) => { n.adegan[0].zonaCaption = "bawah"; }, /zonaCaption harus daftar/, "zona bukan daftar"],
    [(n) => { n.adegan[0].zonaCaption = [{ area: "kiri" }]; }, /area harus "bawah" atau "atas"/, "zona area salah"],
    [(n) => { n.adegan[0].zonaCaption = [{ area: "atas", dari: -1 }]; }, /dari harus bilangan bulat >= 0/, "zona dari negatif"],
    [(n) => { n.adegan[0].zonaCaption = [{ area: "atas", dari: 10, sampai: 10 }]; }, /sampai harus bilangan bulat > dari/, "zona sampai <= dari"],
    [(n) => { n.adegan[0].jangkarPenutur = { x: "a", y: 1 }; }, /jangkarPenutur harus \{ x, y \}/, "jangkar bukan angka"],
    [(n) => { n.adegan[0].jangkarPenutur = { x: 5000, y: 10 }; }, /di luar ukuran 1280x720/, "jangkar di luar ukuran"],
  ]) {
    const v = cek(ubah);
    tegas(v.naskah === null && v.galat.some((x) => pola.test(x)), `${nama}: ${JSON.stringify(v.galat)}`);
  }
  // peringatan: posisi bawah + zona bawah; dekat-penutur tanpa jangkar; kunci tak dikenal di zona
  const w1 = cek((n) => { n.caption.posisi = "bawah"; });
  tegas(w1.naskah && w1.peringatan.some((x) => /adegan "a2": posisi "bawah" tetapi zonaCaption menandai area bawah/.test(x)), `peringatan bawah+zona: ${w1.peringatan}`);
  const w2 = cek((n) => { n.caption.posisi = "dekat-penutur"; });
  tegas(w2.peringatan.some((x) => /adegan "a1": posisi "dekat-penutur" tanpa jangkarPenutur/.test(x)) && !w2.peringatan.some((x) => /adegan "a2".*tanpa jangkarPenutur/.test(x)), `peringatan dekat-penutur: ${w2.peringatan}`);
  const w3 = cek((n) => { n.adegan[1].zonaCaption[0].warna = "merah"; });
  tegas(w3.naskah && w3.peringatan.some((x) => /kunci "warna" tidak dikenal/.test(x)), "kunci tak dikenal di zona");
  // kunci tingkat naskah tetap tak dikenal (zonaCaption hanya sah di adegan)
  tegas(cek((n) => { n.zonaCaption = []; }).peringatan.some((x) => /naskah: kunci "zonaCaption" tidak dikenal/.test(x)), "zonaCaption di tingkat naskah tetap tak dikenal");
  // kata.json: zona dalam frame absolut, dipotong di akhir adegan; kunci hanya ada bila diberikan
  const props = await buatProps({ ukuran: "lanskap" });
  samaDengan(props.kata.caption, { mode: "pop-on", posisi: "auto" }, "kata.json memuat caption");
  const [a1, a2] = props.kata.adegan;
  samaDengan(Object.keys(a1).sort(), ["durasiFrame", "id", "mulaiFrame"], "a1 tanpa kunci tampil");
  samaDengan(a2.zonaCaption, [{ area: "bawah", dari: a2.mulaiFrame, sampai: a2.mulaiFrame + a2.durasiFrame }], "zona a2 absolut");
  samaDengan(a2.jangkarPenutur, { x: Math.round(1280 * 0.62), y: Math.round(720 * 0.46) }, "jangkar a2");
  const n2 = JSON.parse(JSON.stringify(dasar)); n2.adegan[1].zonaCaption = [{ area: "atas", dari: 30, sampai: 5000 }];
  const v2 = validasiNaskah(n2, templat);
  const { buatNarasi } = await import("./narasi.mjs");
  const h2 = await buatNarasi(v2.naskah);
  const b2 = h2.kata.adegan[1];
  samaDengan(b2.zonaCaption, [{ area: "atas", dari: b2.mulaiFrame + 30, sampai: b2.mulaiFrame + b2.durasiFrame }], "zona dipotong di akhir adegan");
  // naskah tanpa kunci baru: kata.json tidak berubah bentuk (tanpa kunci caption)
  const n3 = JSON.parse(JSON.stringify(dasar)); delete n3.caption.mode; delete n3.caption.posisi; for (const a of n3.adegan) { delete a.zonaCaption; delete a.jangkarPenutur; }
  const h3 = await buatNarasi(validasiNaskah(n3, templat).naskah);
  tegas(!("caption" in h3.kata) && h3.kata.adegan.every((a) => Object.keys(a).length === 3), "kata.json tanpa kunci tampil bila naskah tak memberikannya");
});

// ================================================== (m) templat di Chromium (DOM nyata)
tes("(m) templat narasi-contoh di Chromium: semua mode dan posisi, 16:9 dan 9:16, caption dan teksnya di dalam area aman dan kotak", async () => {
  const { chromium } = await import("playwright-core");
  const { cariBrowser } = await import("./browser.js");
  const browser = await chromium.launch({ executablePath: cariBrowser(), headless: true, args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  let diperiksa = 0;
  try {
    const url = pathToFileURL(join(templat, "index.html")).href;
    for (const ukuran of ["lanskap", "potret"]) {
      const props = await buatProps({ ukuran });
      const page = await browser.newPage({ viewport: { width: props.lebar, height: props.tinggi } });
      const konsol = [];
      page.on("pageerror", (e) => konsol.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") konsol.push(m.text()); });
      for (const mode of MODE_CAPTION) for (const posisi of POSISI_CAPTION) {
        await page.goto(`${url}?props=${encodeURIComponent(JSON.stringify({ ...props, mode, posisi, label: false }))}`);
        const rencana = await page.evaluate(() => window.rencanaDemo);
        // a1 tak punya jangkar: dekat-penutur jatuh ke bawah dengan peringatan (disengaja); selain itu tanpa peringatan
        samaDengan(rencana.peringatan.filter((p) => !/zona|dekat-penutur/.test(p)), [], `${ukuran} ${mode}/${posisi}: peringatan rencana`);
        const frames = [];
        for (const c of rencana.cue) frames.push(c.mulaiFrame, c.mulaiFrame + Math.floor((c.akhirFrame - c.mulaiFrame) / 2), c.akhirFrame - 1);
        for (const f of frames) {
          const ukur = await page.evaluate(async (frame) => {
            await window.video.renderFrame(frame);
            const rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
            const akar = document.querySelector("[data-caption]");
            if (!akar) return null;
            return { kotak: rect(akar), mode: akar.dataset.caption, baris: [...akar.children].map(rect), kata: [...akar.querySelectorAll("span")].filter((s) => !s.querySelector("span")).map(rect), teks: akar.textContent };
          }, f);
          tegas(ukur !== null, `${ukuran} ${mode}/${posisi} frame ${f}: tidak ada caption`);
          samaDengan(ukur.mode, mode, "mode di DOM");
          diperiksa++;
          const area = rencana.area, eps = 0.6;
          tegas(dalam(ukur.kotak, area, eps), `${ukuran} ${mode}/${posisi} f${f}: kotak DOM ${JSON.stringify(ukur.kotak)} di luar area ${JSON.stringify(area)}`);
          const cueIni = rencana.cue.find((c) => c.mulaiFrame <= f && f < c.akhirFrame);
          samaDengan([ukur.kotak.x, ukur.kotak.y, ukur.kotak.w, ukur.kotak.h].map(Math.round), [cueIni.kotak.x, cueIni.kotak.y, cueIni.kotak.w, cueIni.kotak.h], `kotak DOM = rencana (${mode} f${f})`);
          for (const b of ukur.baris) tegas(b.w <= ukur.kotak.w + eps && b.x >= ukur.kotak.x - eps && b.x + b.w <= ukur.kotak.x + ukur.kotak.w + eps, `${ukuran} ${mode}/${posisi} f${f}: baris ${JSON.stringify(b)} keluar kotak ${JSON.stringify(ukur.kotak)}`);
          for (const k0 of ukur.kata) {
            // roll-up: baris yang masuk atau keluar dipotong clip-path di tepi kotak; yang terlihat hanya irisannya
            const k = mode === "roll-up" ? { ...k0, y: Math.max(k0.y, ukur.kotak.y), h: Math.min(k0.y + k0.h, ukur.kotak.y + ukur.kotak.h) - Math.max(k0.y, ukur.kotak.y) } : k0;
            tegas(dalam(k, area, eps), `${ukuran} ${mode}/${posisi} f${f}: kata ${JSON.stringify(k0)} di luar area`);
          }
          if (mode !== "roll-up") for (const b of ukur.baris) tegas(b.y >= ukur.kotak.y - eps && b.y + b.h <= ukur.kotak.y + ukur.kotak.h + eps, `${mode}: baris di luar kotak secara vertikal`);
        }
      }
      // auto: a2 (zona bawah) di atas, a1 di bawah
      await page.goto(`${url}?props=${encodeURIComponent(JSON.stringify({ ...props, mode: "pop-on", posisi: "auto", label: false }))}`);
      const rencanaAuto = await page.evaluate(() => window.rencanaDemo);
      const a2Mulai = props.kata.adegan[1].mulaiFrame;
      for (const c of rencanaAuto.cue) samaDengan(c.posisi, c.mulaiFrame >= a2Mulai ? "atas" : "bawah", `${ukuran} auto cue ${c.n}`);
      samaDengan(konsol, [], `${ukuran}: galat halaman`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  tegas(diperiksa >= 2 * 20 * 15, `cakupan DOM ${diperiksa}`);
});

tes("(m2) lebarKarakter: teks lebih lebar dari taksiran 0,6 em melewati kotak, taksiran yang sesuai menjaganya di dalam area (Chromium)", async () => {
  const { chromium } = await import("playwright-core");
  const { cariBrowser } = await import("./browser.js");
  const browser = await chromium.launch({ executablePath: cariBrowser(), headless: true, args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const ukur = async (lebarKarakter) => {
      const r = rencanaCaption({ cues: [{ mulai: 0, akhir: 2, teks: "m".repeat(42) }], lebar: 1280, tinggi: 720, fps: 30, lebarKarakter });
      await page.setContent(`<body style="margin:0"><div style="position:relative;width:1280px;height:720px">${captionHtml(keadaanCaption(r, 5))}</div></body>`);
      const dom = await page.evaluate(() => { const a = document.querySelector("[data-caption]"), b = a.firstElementChild.getBoundingClientRect(); return { x: b.left, w: b.width }; });
      return { r, dom };
    };
    // lebar huruf "m" diukur dari font yang benar-benar dipakai (berbeda antarmesin, mis. Noto Sans vs DejaVu Sans)
    const r0 = rencanaCaption({ cues: [{ mulai: 0, akhir: 2, teks: "m" }], lebar: 1280, tinggi: 720, fps: 30 });
    await page.setContent(`<body style="margin:0"><div style="position:relative;width:1280px;height:720px">${captionHtml(keadaanCaption(r0, 5))}</div></body>`);
    const rasio = await page.evaluate(() => { const el = document.querySelector("[data-caption]").firstElementChild; const cs = getComputedStyle(el); const c = document.createElement("canvas").getContext("2d"); c.font = `${cs.fontWeight} 100px ${cs.fontFamily}`; return c.measureText("m").width / 100; });
    const bawaan = await ukur(undefined), lebar = await ukur(Math.max(rasio + 0.03, 0.61));
    tegas(bawaan.dom.w > bawaan.r.cue[0].kotak.w, "dengan taksiran 0,6 em deretan huruf lebar melebihi kotak (itulah mengapa ada opsi lebarKarakter)");
    const k = lebar.r.cue[0].kotak;
    tegas(lebar.dom.w <= k.w + 0.5 && lebar.dom.x >= lebar.r.area.x - 0.5 && lebar.dom.x + lebar.dom.w <= lebar.r.area.x + lebar.r.area.w + 0.5, `lebarKarakter ${rasio.toFixed(3)}+0,03: baris ${JSON.stringify(lebar.dom)} kotak ${JSON.stringify(k)}`);
    tegas(lebar.r.ukuranFont < bawaan.r.ukuranFont, "taksiran lebih lebar menurunkan ukuran font");
    melempar(() => rencanaCaption({ cues: [], lebar: 1280, tinggi: 720, fps: 30, lebarKarakter: 0 }), /lebarKarakter/, "lebarKarakter 0");
  } finally {
    await browser.close();
  }
});

// ====================================================== (n) render nyata dan determinisme
tes("(n) render.mjs: still sorot-kata 16:9 dan 9:16 berukuran benar dan identik di dua render; video rentang pop-on 16:9", async () => {
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  const probe = async (f) => {
    const r = await jalankan(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-of", "json", f]);
    tegas(r.kode === 0, `ffprobe: ${r.err}`);
    return JSON.parse(r.out).streams.find((s) => s.codec_type === "video");
  };
  for (const [ukuran, w, h, frame] of [["lanskap", 1280, 720, 60], ["potret", 1080, 1920, 450]]) {
    const props = await buatProps({ ukuran, mode: "sorot-kata", posisi: "auto" });
    await Bun.write(join(tmp, `props-${ukuran}.json`), JSON.stringify(props));
    const png = [join(tmp, `${ukuran}-a.png`), join(tmp, `${ukuran}-b.png`)];
    for (const p of png) {
      const r = await jalankan(["bun", join(akar, "scripts", "render.mjs"), join(templat, "index.html"), "--props-file", join(tmp, `props-${ukuran}.json`), "--still", String(frame), "--out", p]);
      tegas(r.kode === 0, `render still ${ukuran} exit ${r.kode}: ${r.err}`);
    }
    const v = await probe(png[0]);
    tegas(v.width === w && v.height === h, `still ${ukuran}: ${v.width}x${v.height}`);
    tegas(hash(await Bun.file(png[0]).bytes()) === hash(await Bun.file(png[1]).bytes()), `still ${ukuran} tidak deterministik`);
  }
  const props = await buatProps({ ukuran: "lanskap", mode: "paint-on", posisi: "bawah" });
  await Bun.write(join(tmp, "props-video.json"), JSON.stringify(props));
  const mp4 = join(tmp, "caption.mp4");
  const r = await jalankan(["bun", join(akar, "scripts", "render.mjs"), join(templat, "index.html"), "--props-file", join(tmp, "props-video.json"), "--dari", "9", "--sampai", "38", "--out", mp4]);
  tegas(r.kode === 0, `render video exit ${r.kode}: ${r.err}`);
  const v = await probe(mp4);
  tegas(v.nb_read_frames === "30" && v.width === 1280 && v.height === 720, `video ${v.nb_read_frames} frame ${v.width}x${v.height}`);
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
console.log(`\n${uji.length - gagalCount}/${uji.length} uji caption lolos (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(gagalCount ? 1 : 0);
