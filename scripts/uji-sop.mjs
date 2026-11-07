#!/usr/bin/env bun
/**
 * uji-sop.mjs — uji fitur SOP (scripts/sop.mjs, scripts/sop-alir.js, templates/sop).
 * Tanpa dependensi tambahan. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-sop.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const sopCli = join(akar, "scripts", "sop.mjs");
const renderCli = join(akar, "scripts", "render.mjs");
const dirTemplate = join(akar, "templates", "sop");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-sop-"));

// runtime.js dan sop-alir.js adalah skrip browser; dimuat dengan window sementara
function muat(nama) {
  const sebelum = globalThis.window;
  globalThis.window = { location: { search: "" } };
  try {
    return createRequire(import.meta.url)(join(akar, "scripts", nama));
  } finally {
    if (sebelum === undefined) delete globalThis.window;
    else globalThis.window = sebelum;
  }
}
const runtime = muat("runtime.js");
const SopAlir = muat("sop-alir.js");
const sopModul = await import(sopCli);

function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const sop = (...args) => jalankan(["bun", sopCli, ...args]);

const dasar = JSON.parse(readFileSync(join(dirTemplate, "sop.json"), "utf8"));
const salin = () => structuredClone(dasar);
let nomorBerkas = 0;
function tulisSop(obj, nama) {
  const f = join(tmp, nama ?? `sop-${++nomorBerkas}.json`);
  writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj));
  return f;
}
async function hasilkan(obj, opsi = []) {
  const dir = join(tmp, `out-${++nomorBerkas}`);
  const r = await sop(tulisSop(obj), "--out", dir, ...opsi);
  return { ...r, dir };
}
const baca = (dir, f) => readFileSync(join(dir, f), "utf8");

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

// ------------------------------------------------------------- (a) validasi
const L = "prosedur[0].langkah";
const RUSAK = [
  ["identitas.nomor dihapus", (s) => { delete s.identitas.nomor; }, "identitas.nomor: wajib diisi"],
  ["tanggal mustahil", (s) => { s.identitas.tanggalEfektif = "2026-02-30"; }, 'identitas.tanggalEfektif: bukan tanggal yang valid (format YYYY-MM-DD): "2026-02-30"'],
  ["nomor langkah loncat", (s) => { s.prosedur[0].langkah[2].no = 5; }, `${L}[2].no: nomor langkah harus berurutan mulai 1: diharapkan 3, ditemukan 5`],
  ["nomor langkah duplikat", (s) => { s.prosedur[0].langkah[3].no = 3; }, `${L}[3].no: nomor langkah 3 duplikat`],
  ["pelaksana tak terdaftar", (s) => { s.prosedur[0].langkah[1].pelaksana = "siapa"; }, `${L}[1].pelaksana: "siapa" tidak terdaftar di pelaksana`],
  ["pelaksana duplikat", (s) => { s.pelaksana[1].id = "pemohon"; }, 'pelaksana[1].id: duplikat: "pemohon"'],
  ["langkah pertama bukan mulai", (s) => { s.prosedur[0].langkah[0].jenis = "proses"; }, `${L}[0].jenis: langkah pertama harus "mulai", ditemukan "proses"`],
  ["langkah terakhir bukan selesai", (s) => { s.prosedur[0].langkah[6].jenis = "proses"; }, `${L}[6].jenis: langkah terakhir harus "selesai", ditemukan "proses"`],
  ["keputusan tanpa ya", (s) => { delete s.prosedur[0].langkah[2].ya; }, `${L}[2].ya: wajib diisi untuk langkah keputusan`],
  ["tidak menuju langkah yang tak ada", (s) => { s.prosedur[0].langkah[2].tidak = 99; }, `${L}[2].tidak: menuju langkah 99 yang tidak ada (langkah 1..7)`],
  ["ya dan tidak sama", (s) => { s.prosedur[0].langkah[2].tidak = 4; }, `${L}[2].tidak: ya dan tidak tidak boleh menuju langkah yang sama`],
  ["non-keputusan punya ya", (s) => { s.prosedur[0].langkah[1].ya = 3; }, `${L}[1].ya: hanya boleh ada pada langkah keputusan (jenis "proses")`],
  ["waktu kosong", (s) => { s.prosedur[0].langkah[1].waktu = "   "; }, `${L}[1].waktu: tidak boleh kosong`],
  ["karakter kontrol", (s) => { s.prosedur[0].langkah[1].aktivitas = "baris satu\nbaris dua"; }, `${L}[1].aktivitas: mengandung karakter kontrol (U+000A)`],
  ["kunci tidak dikenal", (s) => { s.identitas.nomer = "x"; }, 'identitas: kunci tidak dikenal "nomer"'],
  ["langkah tak terjangkau", (s) => { s.prosedur[0].langkah[2].ya = 5; }, `${L}[3]: langkah 4 tidak terjangkau dari langkah 1`],
  ["dasarHukum kosong", (s) => { s.dasarHukum = []; }, "dasarHukum: minimal 1 butir"],
  ["NIK di teks", (s) => { s.dasarHukum[0] = "Surat atas nama pemohon NIK 3201234567890123"; }, "dasarHukum[0]: terindikasi data pribadi (NIK)"],
  ["NIP pejabat", (s) => { s.identitas.disahkanOleh.nip = "198001012005011001"; }, "identitas.disahkanOleh.nip: terindikasi data pribadi (NIP)"],
  ["NIP berspasi", (s) => { s.pengesahan.penandatangan[1].nip = "19730520 199303 1 008"; }, "pengesahan.penandatangan[1].nip: terindikasi data pribadi (NIP)"],
  ["nomor telepon", (s) => { s.prosedur[0].langkah[1].keterangan = "Hubungi 0812-3456-7890 bila perlu"; }, `${L}[1].keterangan: terindikasi data pribadi (nomor telepon)`],
  ["surel", (s) => { s.keterkaitan[0] = "Kirim ke budi.santoso@contoh.id"; }, "keterkaitan[0]: terindikasi data pribadi (surel)"],
  ["fiktif bukan boolean", (s) => { s.fiktif = "ya"; }, "(akar).fiktif: harus true atau false"],
  ["penandatangan tanpa jabatan", (s) => { delete s.pengesahan.penandatangan[0].jabatan; }, "pengesahan.penandatangan[0].jabatan: wajib diisi"],
];

daftar(`(a) validasi menolak ${RUSAK.length} sop.json rusak: exit 2, pesan dan jalur tepat, tanpa keluaran`, async () => {
  const hasil = await Promise.all(RUSAK.map(async ([nama, ubah, pesan]) => {
    const s = salin();
    ubah(s);
    const r = await hasilkan(s);
    return { nama, pesan, r };
  }));
  for (const { nama, pesan, r } of hasil) {
    tegas(r.kode === 2, `${nama}: exit ${r.kode}, harapan 2`);
    tegas(r.err.includes(`  - ${pesan}`), `${nama}: pesan tidak memuat "${pesan}":\n${r.err}`);
    tegas(!existsSync(join(r.dir, "sop.html")), `${nama}: sop.html tidak boleh dibuat dari data cacat`);
  }
  // beberapa galat sekaligus dilaporkan dengan hitungannya
  const s = salin();
  delete s.identitas.nomor;
  s.prosedur[0].langkah[1].waktu = "";
  const r = await hasilkan(s);
  tegas(r.kode === 2 && /\(2 galat\)/.test(r.err), `galat ganda: ${r.err}`);
  tegas(r.err.includes("identitas.nomor") && r.err.includes(`${L}[1].waktu`), `galat ganda tidak lengkap: ${r.err}`);
});

daftar("(b) argumen dan berkas salah -> exit 2", async () => {
  const kosong = await sop(tulisSop("{ bukan json"), "--out", join(tmp, "x1"));
  tegas(kosong.kode === 2 && /bukan JSON valid/.test(kosong.err), `JSON rusak: ${kosong.kode} ${kosong.err}`);
  const hilang = await sop(join(tmp, "tidak-ada.json"), "--out", join(tmp, "x2"));
  tegas(hilang.kode === 2 && /tidak ditemukan/.test(hilang.err), `berkas hilang: ${hilang.kode} ${hilang.err}`);
  const tanpaOut = await sop(join(dirTemplate, "sop.json"));
  tegas(tanpaOut.kode === 2 && /--out wajib/.test(tanpaOut.err), `tanpa --out: ${tanpaOut.kode} ${tanpaOut.err}`);
  const fps = await sop(join(dirTemplate, "sop.json"), "--out", join(tmp, "x3"), "--fps", "0");
  tegas(fps.kode === 2 && /--fps tidak valid/.test(fps.err), `fps 0: ${fps.kode} ${fps.err}`);
  const objek = await sop(tulisSop("[]"), "--out", join(tmp, "x4"));
  tegas(objek.kode === 2 && /harus berupa objek/.test(objek.err), `bukan objek: ${objek.kode} ${objek.err}`);
});

daftar("(b2) data pribadi diizinkan hanya bila bertanda fiktif; peringatan lunak tidak menghentikan; logo disematkan", async () => {
  const s = salin();
  s.identitas.disahkanOleh.nip = "198001012005011001";
  s.identitas.disahkanOleh.fiktif = true;
  const ok = await hasilkan(s);
  tegas(ok.kode === 0, `fiktif eksplisit seharusnya lolos: exit ${ok.kode} ${ok.err}`);
  tegas(baca(ok.dir, "sop.html").includes("NIP. 198001012005011001"), "NIP fiktif tidak tampil");
  const t = salin();
  t.fiktif = true;
  t.dasarHukum[1] = "Hubungi budi@contoh.id atau 081234567890";
  tegas((await hasilkan(t)).kode === 0, "fiktif tingkat akar seharusnya lolos");

  // kegiatan berawalan nama pelaksana -> peringatan, bukan galat; pelaksana tak terpakai -> peringatan
  const w = salin();
  w.prosedur[0].langkah[1].aktivitas = "Petugas Loket menerima berkas dan mencatat permohonan";
  w.pelaksana.push({ id: "cadangan", nama: "Pelaksana Cadangan" });
  const r = await hasilkan(w);
  tegas(r.kode === 0, `peringatan tidak boleh menghentikan: exit ${r.kode} ${r.err}`);
  tegas(r.err.includes(`peringatan: ${L}[1].aktivitas: kegiatan sebaiknya ditulis kata kerja aktif tanpa subjek`), `tanpa peringatan subjek: ${r.err}`);
  tegas(r.err.includes('peringatan: pelaksana[3]: "cadangan" tidak dipakai'), `tanpa peringatan pelaksana tak terpakai: ${r.err}`);
  const bersih = await hasilkan(dasar);
  tegas(!/peringatan/.test(bersih.err), `contoh tidak boleh memicu peringatan: ${bersih.err}`);

  // logo: berkas gambar relatif terhadap sop.json disematkan sebagai data URI
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(tmp, "logo.png"), png);
  const lg = salin();
  lg.identitas.logo = "logo.png";
  const berkasLogo = tulisSop(lg, "dengan-logo.json");
  const rl = await sop(berkasLogo, "--out", join(tmp, "out-logo"));
  tegas(rl.kode === 0, `logo: exit ${rl.kode} ${rl.err}`);
  tegas(baca(join(tmp, "out-logo"), "sop.html").includes("src=\"data:image/png;base64,"), "logo tidak disematkan");
  lg.identitas.logo = "tidak-ada.png";
  const rh = await sop(tulisSop(lg, "logo-hilang.json"), "--out", join(tmp, "out-logo2"));
  tegas(rh.kode === 2 && /identitas\.logo: berkas tidak ditemukan/.test(rh.err), `logo hilang: ${rh.kode} ${rh.err}`);
});

daftar("(b3) urutan kolom pelaksana mengikuti sekuen kegiatan, bukan urutan larik pelaksana", async () => {
  const s = salin();
  s.pelaksana.reverse(); // larik terbalik: tata letak harus tetap sama
  const r = await hasilkan(s);
  tegas(r.kode === 0, `exit ${r.kode}: ${r.err}`);
  const p = JSON.parse(baca(r.dir, "video-props.json"));
  tegas(p.prosedur[0].pelaksana.map((x) => x.id).join() === "pemohon,petugas,kasi", `urutan lajur: ${p.prosedur[0].pelaksana.map((x) => x.id)}`);
  tegas(p.prosedur[0].langkah[0].lajur === 0, "langkah pertama harus di lajur paling kiri");
  const html = baca(r.dir, "sop.html");
  const kepala = [...html.matchAll(/<th class="pel" scope="col">([^<]*)<\/th>/g)].map((m) => m[1]).join();
  tegas(kepala === "Pemohon,Petugas Loket,Kepala Seksi", `kolom dokumen: ${kepala}`);
});

daftar("(b4) --langkah-per-halaman: halaman dipecah, segilima penghubung bernomor huruf di akhir dan awal halaman", async () => {
  const r = await hasilkan(dasar, ["--langkah-per-halaman", "4"]);
  tegas(r.kode === 0, `exit ${r.kode}: ${r.err}`);
  const html = baca(r.dir, "sop.html");
  tegas((html.match(/id="prosedur-1(-\d+)?"/g) || []).length === 2, "harus 2 halaman prosedur");
  tegas(html.includes("(halaman 1 dari 2)") && html.includes("(halaman 2 dari 2)"), "judul halaman lanjutan tidak ada");
  tegas(html.includes("Lanjut ke langkah 5 (A)") && html.includes("Sambungan dari langkah 4 (A)"), "penghubung A tidak ada");
  tegas(html.includes('aria-label="Penghubung antar halaman A"'), "segilima penghubung tidak ada");
  tegas((html.match(/<tr class="baris"/g) || []).length === 7, "baris langkah harus tetap 7");
  tegas(!html.includes("Sambungan dari langkah 1"), "tanpa sambungan salah");
  // bawaan 10 langkah per halaman -> satu halaman, tanpa penghubung
  const satu = baca((await hasilkan(dasar)).dir, "sop.html");
  tegas(!satu.includes("Penghubung antar halaman"), "prosedur 7 langkah tidak boleh memakai penghubung");
  const buruk = await sop(join(dirTemplate, "sop.json"), "--out", join(tmp, "x5"), "--langkah-per-halaman", "1");
  tegas(buruk.kode === 2, `--langkah-per-halaman 1 harus exit 2, dapat ${buruk.kode}`);
});

// ----------------------------------------------------------- (c) sop.html
daftar("(c) sop.html: semua langkah, struktur SOP AP, teks di-escape", async () => {
  const r = await hasilkan(dasar);
  tegas(r.kode === 0, `exit ${r.kode}: ${r.err}`);
  const html = baca(r.dir, "sop.html");
  tegas(html.startsWith("<!doctype html>") && html.includes('<html lang="id">'), "bukan HTML5 lang=id");
  tegas(/@page\s*\{\s*size:\s*A4 landscape/.test(html), "tanpa @page A4 landscape");
  const nBaris = (html.match(/<tr class="baris"/g) || []).length;
  tegas(nBaris === 7, `baris langkah ${nBaris}, harapan 7`);
  for (const l of dasar.prosedur[0].langkah) {
    for (const k of ["aktivitas", "kelengkapan", "output"]) {
      tegas(html.includes(l[k].replace(/&/g, "&amp;")), `langkah ${l.no}: ${k} tidak ada di sop.html`);
    }
  }
  for (const t of ["Kegiatan", "Mutu Baku", "Kelengkapan", "Waktu", "Output", "Keterangan", "Dasar Hukum",
    "Kualifikasi Pelaksana", "Keterkaitan", "Peralatan/Perlengkapan", "Peringatan", "Pencatatan dan Pendataan",
    "Nomor SOP", "Tanggal Pembuatan", "Tanggal Revisi", "Tanggal Efektif", "Disahkan oleh", "Nama SOP", "NIP.",
    "Lembar Penetapan dan Pengesahan"]) {
    tegas(html.includes(t), `bagian "${t}" tidak ada`);
  }
  for (const p of dasar.pelaksana) tegas(html.includes(`>${p.nama}<`), `kolom pelaksana ${p.nama} tidak ada`);
  tegas(html.includes("<polygon") && html.includes("<polyline"), "simbol atau garis alir SVG tidak ada");
  tegas(html.includes(">Ya<") && html.includes(">Tidak<"), "label cabang Ya/Tidak tidak ada");
  tegas(!/<script/i.test(html), "dokumen tidak boleh memuat skrip");
  tegas(html.includes("7 November 2026") && html.includes("2 November 2026"), "format tanggal Indonesia salah");

  // escape: tidak ada markup mentah dari data
  const s = salin();
  s.identitas.judul = `<script>alert(1)</script> & "kutip" 'apos'`;
  s.prosedur[0].langkah[1].aktivitas = `Memeriksa <img src=x onerror=alert(1)> dan A&B`;
  s.pelaksana[2].nama = `Kepala <b>Seksi</b>`;
  const e = await hasilkan(s);
  tegas(e.kode === 0, `exit ${e.kode}: ${e.err}`);
  const h2 = baca(e.dir, "sop.html");
  tegas(!/<script/i.test(h2) && !/<img/i.test(h2) && !h2.includes("<b>Seksi"), "markup dari data lolos tanpa escape");
  tegas(h2.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;kutip&quot; &#39;apos&#39;"), "judul tidak di-escape benar");
  tegas(h2.includes("Memeriksa &lt;img src=x onerror=alert(1)&gt; dan A&amp;B"), "aktivitas tidak di-escape benar");
});

// ---------------------------------------------------------- (d) video-props
const reKarakter = (t) => Array.from(t).length;
const ukuranBeberapa = () => [5, 6, 11, 16].map((n) => sopModul.ukuranSegmen(n));
daftar("(d) video-props.json: jadwal konsisten, narasi otomatis, deterministik, sinkron dengan templates/sop/props.json", async () => {
  const r = await hasilkan(dasar);
  tegas(r.kode === 0, `exit ${r.kode}: ${r.err}`);
  const teks = baca(r.dir, "video-props.json");
  const p = JSON.parse(teks);
  tegas(p.fps === 30 && p.cps === 17 && p.wpm === 140 && p.jedaSegmen === 2, `bawaan fps/cps/wpm/jedaSegmen ${p.fps}/${p.cps}/${p.wpm}/${p.jedaSegmen}`);
  const jumlah = p.adegan.reduce((n, a) => n + a.durasi, 0);
  tegas(p.durationInFrames === jumlah, `durationInFrames ${p.durationInFrames} != jumlah adegan ${jumlah}`);
  let kursor = 0;
  for (const a of p.adegan) {
    tegas(a.mulai === kursor, `adegan ${a.jenis} mulai ${a.mulai}, harapan ${kursor}`);
    tegas(Number.isInteger(a.durasi) && a.durasi > 0, `durasi tidak bulat positif: ${a.durasi}`);
    // durasi >= waktu baca narasi pada cps (+ jeda), dan langkah minimal 2 detik
    const narasiRapi = a.narasi.replace(/\s+/g, " ").trim();
    const baca_ = (reKarakter(narasiRapi) / p.cps) * p.fps;
    tegas(a.durasi >= Math.ceil(baca_ - 1e-9), `adegan ${a.jenis}: durasi ${a.durasi} < waktu baca ${baca_.toFixed(1)}`);
    const bicara = (narasiRapi.split(" ").length * 60 / p.wpm) * p.fps;
    tegas(a.durasi >= Math.ceil(bicara - 1e-9), `adegan ${a.jenis}: durasi ${a.durasi} < waktu narasi ${bicara.toFixed(1)} (wpm ${p.wpm})`);
    if (a.jenis === "langkah") tegas(a.durasi >= 2 * p.fps, `langkah ${a.no}: durasi ${a.durasi} < 2 detik`);
    kursor += a.durasi;
  }
  const urutan = p.adegan.map((a) => a.jenis).join(",");
  tegas(urutan === "judul,dasarHukum,prosedur,langkah,langkah,langkah,langkah,langkah,langkah,langkah,penutup", `urutan adegan: ${urutan}`);
  const dh = p.adegan[1];
  tegas(dh.butir.length === 3 && dh.lainnya === 1, `dasar hukum: ${dh.butir.length} butir, lainnya ${dh.lainnya}`);
  tegas(p.adegan.filter((a) => a.jenis === "langkah").length === 7, "jumlah adegan langkah");
  tegas(p.adegan.at(-1).prosedur[0].jumlahLangkah === 7, "ringkasan penutup");

  // segmen (subtugas) 3-5 aksi: 7 langkah -> 4 + 3; jeda antar subtugas pada langkah penutup segmen
  const ls = p.adegan.filter((a) => a.jenis === "langkah");
  tegas(ls.map((a) => a.segmen).join() === "1,1,1,1,2,2,2" && ls.every((a) => a.jumlahSegmen === 2), `segmen: ${ls.map((a) => a.segmen)}`);
  const lebar = await hasilkan(dasar, ["--jeda-segmen", "5", "--wpm", "120"]);
  tegas(lebar.kode === 0, `exit ${lebar.kode}: ${lebar.err}`);
  const pl = JSON.parse(baca(lebar.dir, "video-props.json"));
  tegas(pl.wpm === 120 && pl.jedaSegmen === 5, "opsi --wpm/--jeda-segmen tidak masuk props");
  const lss = pl.adegan.filter((a) => a.jenis === "langkah");
  tegas(lss[3].durasi >= ls[3].durasi + 3 * 30 - 1, `jeda 5 s pada langkah 4: ${lss[3].durasi} vs ${ls[3].durasi}`);
  tegas(lss.length === 7 && lss[6].segmen === 2, "segmen berubah karena opsi lain");
  for (const bad of [["--wpm", "10"], ["--jeda-segmen", "1"], ["--jeda-segmen", "9"]]) {
    const x = await sop(join(dirTemplate, "sop.json"), "--out", join(tmp, "x6"), ...bad);
    tegas(x.kode === 2, `${bad.join(" ")} harus exit 2, dapat ${x.kode}`);
  }
  tegas(JSON.stringify(ukuranBeberapa()) === "[[5],[3,3],[4,4,3],[4,4,4,4]]", `ukuranSegmen: ${JSON.stringify(ukuranBeberapa())}`);

  // narasi otomatis
  const nar = (no) => p.adegan.find((a) => a.jenis === "langkah" && a.no === no).narasi;
  tegas(nar(1) === "Pemohon mengajukan permohonan Surat Keterangan Contoh ke loket layanan. Hasilnya: berkas permohonan.", `narasi 1: ${nar(1)}`);
  tegas(nar(3) === "Petugas Loket memeriksa: Apakah berkas permohonan sudah lengkap? Jika ya, lanjut ke langkah 4; jika tidak, kembali ke langkah 1.", `narasi 3: ${nar(3)}`);
  // narasi eksplisit dipakai apa adanya
  const s = salin();
  s.prosedur[0].langkah[1].narasi = "  Narasi   khusus buatan penulis.  ";
  const e = await hasilkan(s);
  const pe = JSON.parse(baca(e.dir, "video-props.json"));
  tegas(pe.adegan.find((a) => a.jenis === "langkah" && a.no === 2).narasi === "Narasi khusus buatan penulis.", "narasi eksplisit tidak dipakai");

  // deterministik dan sinkron dengan props template
  const lagi = await hasilkan(dasar);
  tegas(baca(lagi.dir, "video-props.json") === teks, "dua kali hasilkan -> video-props.json berbeda");
  const tersimpan = readFileSync(join(dirTemplate, "props.json"), "utf8");
  tegas(tersimpan === teks, "templates/sop/props.json tidak sinkron dengan keluaran generator; jalankan: bun scripts/sop.mjs templates/sop/sop.json --out <dir> lalu salin video-props.json");
});

// -------------------------------------------------------------- (e) caption
function periksaCaption(vttTeks, props, fps, cps, nama, wpm = 140) {
  const cues = runtime.parseVtt(vttTeks);
  tegas(cues.length === props.caption.length && cues.length > 0, `${nama}: ${cues.length} cue di VTT, ${props.caption.length} di props`);
  let akhirSebelum = -1;
  cues.forEach((c, i) => {
    const baris = c.teks.split("\n");
    tegas(baris.length <= 2, `${nama}: cue ${i + 1} punya ${baris.length} baris`);
    for (const b of baris) tegas(reKarakter(b) <= 42, `${nama}: cue ${i + 1} baris ${reKarakter(b)} > 42 karakter: "${b}"`);
    // waktu dibulatkan ke frame (VTT berpresisi milidetik)
    const m = c.mulai * fps, a = c.akhir * fps;
    tegas(Math.abs(m - Math.round(m)) < 0.05 && Math.abs(a - Math.round(a)) < 0.05, `${nama}: cue ${i + 1} tidak pada batas frame (${m}, ${a})`);
    const d = (Math.round(a) - Math.round(m)) / fps;
    tegas(d >= 5 / 6 - 1e-9 && d <= 7 + 1e-9, `${nama}: cue ${i + 1} durasi ${d.toFixed(3)} s di luar 5/6..7 s`);
    const laju = reKarakter(c.teks.replace(/\s+/g, " ")) / d;
    tegas(laju <= cps + 1e-9, `${nama}: cue ${i + 1} ${laju.toFixed(2)} cps > ${cps}`);
    const kata = c.teks.replace(/\s+/g, " ").split(" ").length;
    tegas(d >= (kata * 60) / wpm - 1e-9, `${nama}: cue ${i + 1} ${kata} kata dalam ${d.toFixed(2)} s, di bawah laju narasi ${wpm} kata/menit`);
    tegas(Math.round(m) / fps >= akhirSebelum - 1e-9, `${nama}: cue ${i + 1} tumpang tindih dengan sebelumnya`);
    akhirSebelum = Math.round(a) / fps;
  });
  // tidak ada teks yang hilang: gabungan cue = gabungan narasi semua adegan
  const gabung = (arr) => arr.join(" ").replace(/\s+/g, " ").trim();
  tegas(gabung(cues.map((c) => c.teks)) === gabung(props.adegan.map((a) => a.narasi)), `${nama}: teks cue tidak sama dengan gabungan narasi`);
  // caption tidak melewati akhir video dan setiap adegan memuat cue-nya sendiri
  tegas(cues.at(-1).akhir <= props.durationInFrames / fps + 1e-9, `${nama}: cue melewati akhir video`);
}

daftar("(e) caption.vtt: <=42 karakter, <=2 baris, cps, durasi 5/6-7 s, batas frame, tanpa tumpang tindih, teks utuh", async () => {
  const r = await hasilkan(dasar);
  const p = JSON.parse(baca(r.dir, "video-props.json"));
  tegas(baca(r.dir, "caption.vtt").startsWith("WEBVTT\n\n"), "tanpa header WEBVTT");
  periksaCaption(baca(r.dir, "caption.vtt"), p, 30, 17, "bawaan");

  // narasi sangat panjang (harus dipecah) dengan fps dan cps lain
  const s = salin();
  s.prosedur[0].langkah[1].narasi =
    "Petugas menerima berkas permohonan dari pemohon, memeriksa kesesuaian identitas, mencatat nomor register pada buku, " +
    "lalu memberi tahu pemohon bahwa permohonan akan diproses dalam waktu yang telah ditetapkan. Setelah itu petugas menempelkan " +
    "label register pada map berkas dan meletakkannya pada rak berkas masuk untuk diteruskan. Berkas dengan kelengkapan khusus diberi tanda tersendiri.";
  s.prosedur[0].langkah[3].narasi = "Pendek.";
  const e = await hasilkan(s, ["--fps", "24", "--cps", "14"]);
  tegas(e.kode === 0, `exit ${e.kode}: ${e.err}`);
  const pe = JSON.parse(baca(e.dir, "video-props.json"));
  tegas(pe.fps === 24 && pe.cps === 14, `fps/cps ${pe.fps}/${pe.cps}`);
  tegas(pe.durationInFrames === pe.adegan.reduce((n, a) => n + a.durasi, 0), "durasi total tidak sama dengan jumlah adegan (24 fps)");
  periksaCaption(baca(e.dir, "caption.vtt"), pe, 24, 14, "24fps/14cps");
  const e2 = await hasilkan(s, ["--wpm", "100"]);
  periksaCaption(baca(e2.dir, "caption.vtt"), JSON.parse(baca(e2.dir, "video-props.json")), 30, 17, "100wpm", 100);
  const panjang = pe.caption.filter((c) => c.teks.length > 0);
  tegas(panjang.length > p.caption.length - 2, "narasi panjang seharusnya menambah cue");
});

// ----------------------------------------------------------------- (f) PDF
daftar("(f) --pdf: PDF valid, >= 2 halaman, tata letak sesuai rencana", async () => {
  const r = await hasilkan(dasar, ["--pdf"]);
  tegas(r.kode === 0, `exit ${r.kode}: ${r.err}`);
  tegas(!/peringatan/.test(r.err), `peringatan tata letak: ${r.err}`);
  const bin = readFileSync(join(r.dir, "sop.pdf"));
  tegas(bin.subarray(0, 5).toString("latin1") === "%PDF-", "bukan berkas PDF (tanpa %PDF-)");
  tegas(bin.subarray(-1024).toString("latin1").includes("%%EOF"), "PDF terpotong (tanpa %%EOF)");
  const halaman = (bin.toString("latin1").match(/\/Type\s*\/Page(?![a-z])/g) || []).length;
  tegas(halaman >= 2, `PDF hanya ${halaman} halaman`);
  tegas(halaman === 3, `PDF ${halaman} halaman, harapan 3 (identitas, prosedur, pengesahan)`);
  // PDF bertag, berbahasa Indonesia, berjudul (bukan klaim PDF/UA)
  const teksPdf = bin.toString("latin1");
  tegas(teksPdf.includes("/StructTreeRoot") && teksPdf.includes("/MarkInfo"), "PDF tidak bertag");
  tegas(teksPdf.includes("/Lang (id)"), "PDF tanpa /Lang (id)");
  tegas(/\/Title \(Layanan Permohonan Surat Keterangan Contoh - SOP\/CONTOH\/001\/2026\)/.test(teksPdf), "PDF tanpa /Title");
  // tata letak tetap sesuai rencana saat prosedur dipecah dan saat teks panjang
  const s = salin();
  s.prosedur[0].langkah[1].keterangan = "Catatan panjang agar baris menjadi lebih tinggi daripada biasanya, ".repeat(3).trim();
  s.prosedur[0].langkah[4].kelengkapan = "Berkas permohonan lengkap beserta lampiran pendukung yang disyaratkan dan buku register layanan";
  const b = await hasilkan(s, ["--pdf", "--langkah-per-halaman", "5"]);
  tegas(b.kode === 0 && !/peringatan/.test(b.err), `PDF terpecah: exit ${b.kode} ${b.err}`);
});

// ---------------------------------------------------------------- (g) router
daftar("(g) sop-alir: garis sumbu-sejajar, ujung tepat di simbol, cabang tidak menumpuk, potongan per baris utuh", () => {
  const p = JSON.parse(readFileSync(join(dirTemplate, "props.json"), "utf8"));
  const langkah = p.prosedur[0].langkah;
  const W = 26, simW = 18, tinggi = langkah.map((l) => (l.jenis === "keputusan" ? 17 : 13));
  const tops = [];
  tinggi.reduce((a, h, i) => { tops[i] = a; return a + h; }, 0);
  const setengah = langkah.map((l) => ({ mulai: 3.5, selesai: 3.5, proses: 4.5, keputusan: 6.5 }[l.jenis]));
  const rute = SopAlir.rute({ langkah, lajurLebar: W, simLebar: simW, tops, tinggi, setengah, satuan: 1 });
  const nEdge = langkah.reduce((n, l) => n + (l.jenis === "selesai" ? 0 : l.jenis === "keputusan" ? 2 : 1), 0);
  tegas(rute.length === nEdge, `${rute.length} garis, harapan ${nEdge}`);
  const dekat = (a, b) => Math.abs(a - b) < 1e-9;
  for (const e of rute) {
    for (let i = 1; i < e.titik.length; i++) {
      const [a, b] = [e.titik[i - 1], e.titik[i]];
      tegas(dekat(a[0], b[0]) || dekat(a[1], b[1]), `garis ${e.dari + 1}->${e.ke + 1} tidak sumbu-sejajar`);
    }
    const akhir = e.titik.at(-1);
    tegas(dekat(akhir[0], e.kepala.x) && dekat(akhir[1], e.kepala.y), `garis ${e.dari + 1}->${e.ke + 1}: ujung bukan ujung panah`);
    // ujung panah menyentuh simbol tujuan: atas (arah bawah) atau sisi samping (tinggi pusat)
    const j = e.ke, cx = (langkah[j].lajur + 0.5) * W, cy = tops[j] + tinggi[j] / 2;
    if (e.kepala.arah === "bawah") tegas(dekat(e.kepala.x, cx) && dekat(e.kepala.y, cy - setengah[j]), `panah ${e.dari + 1}->${j + 1} tidak di tepi atas`);
    else tegas(dekat(e.kepala.y, cy) && dekat(Math.abs(e.kepala.x - cx), simW / 2), `panah ${e.dari + 1}->${j + 1} tidak di sisi simbol`);
    // awal garis menyentuh simbol sumber
    const i = e.dari, sx = (langkah[i].lajur + 0.5) * W, sy = tops[i] + tinggi[i] / 2;
    const awal = e.titik[0];
    const disisi = dekat(awal[1], sy) && dekat(Math.abs(awal[0] - sx), simW / 2);
    const dibawah = dekat(awal[0], sx) && dekat(awal[1], sy + setengah[i]);
    tegas(disisi || dibawah, `garis ${i + 1}->${j + 1} tidak berawal di tepi simbol sumber`);
  }
  for (let i = 0; i < langkah.length; i++) {
    const keluar = rute.filter((e) => e.dari === i);
    if (keluar.length === 2) {
      const [a, b] = keluar.map((e) => e.titik[0].join(","));
      tegas(a !== b, `keputusan ${i + 1}: dua garis keluar dari titik yang sama`);
    }
  }
  const tidak = rute.find((e) => e.label === "Tidak");
  tegas(tidak && tidak.ke === 0 && tidak.titik.length === 4, "garis 'Tidak' ke langkah 1 harus lewat saluran (4 titik)");
  // potongan per baris: total panjang sama, semua y di dalam baris
  for (const e of rute) {
    const per = SopAlir.potongBaris(e.titik, tops, tinggi, 0);
    let total = 0;
    for (const [r, daftarPoly] of Object.entries(per)) {
      for (const poly of daftarPoly) {
        total += SopAlir.panjang(poly);
        for (const [, y] of poly) tegas(y >= -1e-9 && y <= tinggi[r] + 1e-9, `potongan di luar baris ${r}: y=${y}`);
      }
    }
    tegas(Math.abs(total - SopAlir.panjang(e.titik)) < 1e-6, `garis ${e.dari + 1}->${e.ke + 1}: panjang potongan ${total} != ${SopAlir.panjang(e.titik)}`);
  }
});

// -------------------------------------------------------- (h) template video
function ukuranPng(buf) {
  tegas(buf.subarray(1, 4).toString("latin1") === "PNG", "bukan PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}
daftar("(h) render --still templates/sop: 1280x720, beda antar adegan, dua render frame sama identik, props kosong tidak gagal", async () => {
  const p = JSON.parse(readFileSync(join(dirTemplate, "props.json"), "utf8"));
  const propsFile = join(dirTemplate, "props.json");
  const adegan = (jenis, no) => p.adegan.find((a) => a.jenis === jenis && (no === undefined || a.no === no));
  const tengah = (a) => a.mulai + Math.min(60, Math.floor(a.durasi / 2));
  const frameJudul = tengah(adegan("judul"));
  const frameKeputusan = tengah(adegan("langkah", 3));
  const framePenutup = tengah(adegan("penutup"));
  const still = (f, nama, props = ["--props-file", propsFile]) =>
    jalankan(["bun", renderCli, join(dirTemplate, "index.html"), ...props, "--out", join(tmp, nama), "--still", String(f)]);
  const [a, b, c, d, kosong] = await Promise.all([
    still(frameJudul, "judul.png"), still(frameKeputusan, "keputusan.png"), still(framePenutup, "penutup.png"),
    still(frameKeputusan, "keputusan2.png"), still(0, "kosong.png", ["--props", "{}"]),
  ]);
  for (const [nama, r] of [["judul", a], ["keputusan", b], ["penutup", c], ["keputusan (ulang)", d], ["props kosong", kosong]]) {
    tegas(r.kode === 0, `${nama}: render exit ${r.kode}: ${r.err}`);
    tegas(!/\[halaman\]/.test(r.err), `${nama}: galat halaman: ${r.err}`);
  }
  const png = (n) => readFileSync(join(tmp, n));
  for (const n of ["judul.png", "keputusan.png", "penutup.png"]) {
    const [w, h] = ukuranPng(png(n));
    tegas(w === 1280 && h === 720, `${n}: ${w}x${h}`);
    tegas(png(n).length > 20 * 1024, `${n}: terlalu kecil (${png(n).length} B), kemungkinan kosong`);
  }
  const hash = (n) => new Bun.CryptoHasher("sha256").update(png(n)).digest("hex");
  tegas(new Set([hash("judul.png"), hash("keputusan.png"), hash("penutup.png")]).size === 3, "still adegan berbeda seharusnya berbeda");
  tegas(hash("keputusan.png") === hash("keputusan2.png"), "dua render frame yang sama menghasilkan PNG berbeda (tidak deterministik)");
  tegas(png("kosong.png").length > 5 * 1024, "props kosong: layar petunjuk tidak muncul");
});

const t0 = Date.now();
let gagal = 0;
try {
  for (const [nama, fn] of uji) {
    const t = Date.now();
    let baris;
    try {
      await fn();
      baris = `LOLOS  ${nama} (${((Date.now() - t) / 1000).toFixed(1)} s)`;
    } catch (e) {
      gagal++;
      baris = `GAGAL  ${nama}: ${e.message}`;
    }
    console.log(baris);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${uji.length - gagal}/${uji.length} lolos, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(gagal ? 1 : 0);
