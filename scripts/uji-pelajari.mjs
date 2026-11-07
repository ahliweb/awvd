#!/usr/bin/env bun
/**
 * uji-pelajari.mjs — uji `pelajari.mjs` (statistik gaya), validator kebijakan kutipan
 * (`kutipan.mjs`, dipanggil `klip.mjs` dan `audio.mjs`), gerbang hukum GH, dan templat
 * `templates/reaction`. Semua video dan audio uji dibuat ffmpeg lavfi di folder sementara
 * atau berasal dari templat buatan sendiri; tidak ada aset pihak ketiga dan tidak ada
 * video platform. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-pelajari.mjs
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bangunMarkdown, labelTempo, paletDominan, statistikAdegan } from "./pelajari.mjs";
import {
  KEBIJAKAN_BAWAAN, hashGerbang, kebijakanEfektif, periksaAudioKutipan, periksaKutipan, statusGerbang,
} from "./kutipan.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const pelajariMjs = join(akar, "scripts", "pelajari.mjs");
const klipMjs = join(akar, "scripts", "klip.mjs");
const audioMjs = join(akar, "scripts", "audio.mjs");
const kutipanMjs = join(akar, "scripts", "kutipan.mjs");
const renderMjs = join(akar, "scripts", "render.mjs");
const templat = join(akar, "templates", "reaction");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-pelajari-"));

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function dekat(nyata, harapan, eps, nama) {
  tegas(typeof nyata === "number" && Math.abs(nyata - harapan) <= eps, `${nama}: dapat ${nyata}, harapan ${harapan} (+-${eps})`);
}
function samaDengan(nyata, harapan, nama) {
  tegas(nyata === harapan, `${nama}: dapat ${JSON.stringify(nyata)}, harapan ${JSON.stringify(harapan)}`);
}
function memuat(teks, potongan, nama) {
  tegas(teks.includes(potongan), `${nama}: "${potongan}" tidak ada dalam:\n${teks}`);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
const bun = (...a) => jalankan(["bun", ...a]);
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
}
const j = (...p) => join(tmp, ...p);
const tulisJson = (berkas, obj) => writeFileSync(berkas, JSON.stringify(obj, null, 2));
const salin = (o) => JSON.parse(JSON.stringify(o));

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

// ------------------------------------------------------ bahan: klip sintetis
// 8 detik, 320x180, 25 fps: gelap 0-2 s, terang 2-5 s, gelap 5-8 s (potong tepat di 2,0 dan 5,0)
let bahanJanji;
function bahan() {
  bahanJanji ??= (async () => {
    const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k"];
    await ffmpeg("-f", "lavfi", "-i",
      "color=c=0x14203c:s=320x180:r=25:d=8,drawbox=x=0:y=0:w=iw:h=ih:color=0xe8dcc0:t=fill:enable='between(t,2,5)',drawbox=x='mod(t*40,260)':y=60:w=50:h=50:color=0xf59f00:t=fill",
      "-f", "lavfi", "-i", "sine=f=500:d=8:sample_rate=48000", ...enc, j("tiga-adegan.mkv"));
    await ffmpeg("-f", "lavfi", "-i", "color=c=0x14203c:s=320x180:r=25:d=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", j("tanpa-audio.mkv"));
    return true;
  })();
  return bahanJanji;
}

// ------------------------------------------------------------ pelajari: murni
daftar("pelajari (unit): statistikAdegan, labelTempo, paletDominan", () => {
  const s = statistikAdegan([2, 5], 8);
  samaDengan(s.jumlahAdegan, 3, "jumlah adegan");
  samaDengan(JSON.stringify(s.durasiAdeganDetik), "[2,3,3]", "durasi adegan");
  samaDengan(s.rataRata, 2.67, "rata-rata");
  samaDengan(s.median, 3, "median");
  samaDengan(s.potongPerMenit, 15, "potong per menit");
  samaDengan(s.kurvaRitme.reduce((a, b) => a + b, 0), 2, "jumlah potong di kurva");
  samaDengan(statistikAdegan([], 10).jumlahAdegan, 1, "tanpa potong = satu adegan");
  samaDengan(statistikAdegan([0, 10, 12], 10).jumlahAdegan, 1, "potong di luar rentang diabaikan");
  samaDengan([labelTempo(1.5), labelTempo(3), labelTempo(8), labelTempo(0)].join(), "cepat,sedang,lambat,tidak-terukur", "label tempo");
  const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 170, 255]);
  const p = paletDominan(px);
  samaDengan(p[0].hex, "#ff0000", "warna dominan");
  samaDengan(p[0].persen, 75, "persen dominan");
  samaDengan(p[1].hex, "#00aaff", "warna kedua");
});

// ------------------------------------------------------------ pelajari: CLI
daftar("pelajari: klip sintetis tiga adegan -> profil JSON + Markdown, tanpa kebocoran isi", async () => {
  await bahan();
  const json = j("profil.json"), md = j("profil.md");
  const r = await bun(pelajariMjs, j("tiga-adegan.mkv"), "--sumber-sah", "milik-sendiri", "--tanggal", "2026-11-07", "--out", json, "--out", md);
  samaDengan(r.kode, 0, `pelajari exit (${r.err})`);
  const p = JSON.parse(readFileSync(json, "utf8"));
  samaDengan(p.versi, 1, "versi skema");
  samaDengan(p.sumber.caraPerolehan, "milik-sendiri", "cara perolehan dicatat");
  samaDengan(p.sumber.tanggalAnalisis, "2026-11-07", "tanggal dari argumen");
  tegas(/^[0-9a-f]{64}$/.test(p.sumber.sha256), "sha256");
  dekat(p.teknis.durasiDetik, 8, 0.2, "durasi");
  samaDengan(`${p.teknis.lebar}x${p.teknis.tinggi}`, "320x180", "dimensi");
  samaDengan(p.teknis.rasio, "16:9", "rasio");
  samaDengan(p.teknis.fps, 25, "fps");
  samaDengan(p.potong.jumlahAdegan, 3, "jumlah adegan terdeteksi");
  const d = p.potong.durasiAdeganDetik;
  dekat(d[0], 2, 0.1, "adegan 1");
  dekat(d[1], 3, 0.1, "adegan 2");
  dekat(d[2], 3, 0.25, "adegan 3");
  samaDengan(p.struktur.potongDiTigaDetikPertama, 1, "potong di 3 detik pertama");
  tegas(p.audio && typeof p.audio.I === "number" && p.audio.I < 0 && p.audio.I > -40, `kenyaringan terukur: ${JSON.stringify(p.audio)}`);
  tegas(p.audio.proporsiSenyap < 0.1, "tidak senyap");
  tegas(p.visual.paletDominan.length >= 2 && /^#[0-9a-f]{6}$/.test(p.visual.paletDominan[0].hex), "palet dominan");
  // tanpa kebocoran isi: hanya angka agregat, tidak ada nama berkas, jalur, frame, atau teks sumber
  const teks = readFileSync(json, "utf8");
  for (const terlarang of ["tiga-adegan", tmp, "transkrip", "ocr", "naskah"]) {
    tegas(!teks.toLowerCase().includes(terlarang.toLowerCase()), `profil JSON tidak boleh memuat "${terlarang}"`);
  }
  const kunci = (x) => (x !== null && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => [k, ...kunci(v)]) : []);
  for (const k of kunci(p)) tegas(!/frame|bingkai|gambar|audioData|teks|transkrip/i.test(k), `kunci profil "${k}" mengisyaratkan isi sumber`);
  tegas(!readFileSync(md, "utf8").includes("tiga-adegan"), "Markdown tidak boleh memuat nama berkas");
  const mdTeks = readFileSync(md, "utf8");
  memuat(mdTeks, "## Dilarang disalin", "bagian dilarang disalin");
  memuat(mdTeks, "## Cek orisinalitas oleh manusia", "cek orisinalitas");
  memuat(mdTeks, "Ritme potongan", "bagian ritme");
  samaDengan(mdTeks, bangunMarkdown(p), "Markdown = bangunMarkdown(profil)");
  tegas(statSync(json).size < 5000, "profil harus ringkas (angka agregat)");
});

daftar("pelajari: deterministik (dua run identik) dan stdout Markdown/JSON", async () => {
  await bahan();
  const a = await bun(pelajariMjs, j("tiga-adegan.mkv"), "--sumber-sah", "izin-tertulis", "--json");
  const b = await bun(pelajariMjs, j("tiga-adegan.mkv"), "--sumber-sah", "izin-tertulis", "--json");
  samaDengan(a.kode, 0, `run a (${a.err})`);
  samaDengan(a.out, b.out, "JSON dua run identik");
  samaDengan(JSON.parse(a.out).sumber.tanggalAnalisis, null, "tanpa --tanggal: null (tanpa jam sistem)");
  const m = await bun(pelajariMjs, j("tiga-adegan.mkv"), "--sumber-sah", "lisensi-terbuka");
  memuat(m.out, "# Profil gaya video (statistik)", "Markdown ke stdout");
});

daftar("pelajari: video tanpa audio dan satu adegan", async () => {
  await bahan();
  const r = await bun(pelajariMjs, j("tanpa-audio.mkv"), "--sumber-sah", "milik-sendiri", "--json");
  samaDengan(r.kode, 0, `exit (${r.err})`);
  const p = JSON.parse(r.out);
  samaDengan(p.audio, null, "tanpa audio");
  samaDengan(p.teknis.adaAudio, false, "adaAudio");
  samaDengan(p.potong.jumlahAdegan, 1, "satu adegan");
  tegas(p.peringatan.some((x) => x.includes("sedikit adegan")), "peringatan sampel kecil");
});

daftar("pelajari: penolakan (unduh platform, URL, tanpa flag, nilai asing, berkas hilang) exit 2", async () => {
  await bahan();
  const v = j("tiga-adegan.mkv");
  let r = await bun(pelajariMjs, v, "--sumber-sah", "unduh-platform");
  samaDengan(r.kode, 2, "unduh-platform");
  memuat(r.err, "ditolak", "pesan unduh-platform");
  for (const nilai of ["rekam-layar-platform", "rip-stream"]) samaDengan((await bun(pelajariMjs, v, "--sumber-sah", nilai)).kode, 2, nilai);
  samaDengan((await bun(pelajariMjs, v, "--sumber-sah", "terserah")).kode, 2, "nilai asing");
  r = await bun(pelajariMjs, v);
  samaDengan(r.kode, 2, "tanpa --sumber-sah");
  memuat(r.err, "--sumber-sah wajib", "pesan wajib");
  r = await bun(pelajariMjs, "https://contoh.example/video", "--sumber-sah", "milik-sendiri");
  samaDengan(r.kode, 2, "URL");
  memuat(r.err, "tidak menyediakan pengunduh", "pesan URL");
  samaDengan((await bun(pelajariMjs, j("tidak-ada.mp4"), "--sumber-sah", "milik-sendiri")).kode, 2, "berkas hilang");
  samaDengan((await bun(pelajariMjs, v, "--sumber-sah", "milik-sendiri", "--ambang-cut", "0")).kode, 2, "ambang 0");
  samaDengan((await bun(pelajariMjs, v, "--sumber-sah", "milik-sendiri", "--tanggal", "2026-13-40")).kode, 2, "tanggal tidak sah");
  samaDengan((await bun(pelajariMjs, v, "--sumber-sah", "milik-sendiri", "--out", j("x.txt"))).kode, 2, "ekstensi out");
  tegas(!existsSync(j("x.txt")), "tidak menulis berkas saat ditolak");
});

daftar("kebijakan: tidak ada pengunduh platform, perekam layar, atau pemintas DRM di scripts/ dan package.json", () => {
  const terlarang = ["yt-dlp", "youtube-dl", "youtube_dl", "you-get", "gallery-dl", "ytdl", "cobalt.tools", "streamlink", "ffmpeg-protocol-hls-drm", "widevine"];
  const berkas = readdirSync(join(akar, "scripts")).filter((f) => /\.(m?js)$/.test(f) && f !== "uji-pelajari.mjs").map((f) => join(akar, "scripts", f));
  berkas.push(join(akar, "package.json"));
  for (const b of berkas) {
    const isi = readFileSync(b, "utf8").toLowerCase();
    for (const t of terlarang) tegas(!isi.includes(t), `${b} menyebut "${t}"`);
  }
  // pelajari.mjs tidak membuka jaringan
  const p = readFileSync(pelajariMjs, "utf8");
  tegas(!/\bfetch\s*\(|node:https?|node:net|WebSocket|Bun\.serve/.test(p), "pelajari.mjs tidak boleh membuka jaringan");
});

// ------------------------------------------------------- validator: murni
// manifest sintetis: satu sumber panjang, satu klip kutipan; ubah() menyesuaikan
function dasar(ubah) {
  const m = {
    proyek: {
      tujuan: "nonkomersial", durasiVideoDetik: 100,
      komentar: [{ mulai: 0, akhir: 100, jenis: "narasi" }],
    },
    sumber: [{
      id: "s1", berkas: "tidak-dibaca.mkv", lisensi: "CC0-1.0",
      kutipan: { tujuan: "ulasan", isiAudio: "ucapan", menyasarKarya: true, bukanBagianKhas: true, perubahanMakna: false },
    }],
    klip: [{ id: "k1", sumber: "s1", lebar: 320, tinggi: 180, dari: 0, panjang: 10, mulaiVideo: 5 }],
  };
  ubah?.(m);
  return m;
}
const cek = (m, dur = { s1: 600 }) => periksaKutipan(m, tmp, dur);
const galatMemuat = (r, teks, nama) => memuat(r.galat.join("\n"), teks, nama);
const lolos = (r, nama) => tegas(r.galat.length === 0, `${nama}: seharusnya lolos, galat:\n${r.galat.join("\n")}`);

daftar("kutipan: bawaan kebijakan = angka yang disetujui pemilik", () => {
  samaDengan(JSON.stringify(KEBIJAKAN_BAWAAN), JSON.stringify({
    klipMaksDetik: 15, sumberMaksDetik: 45, sumberMaksPersen: 15, videoMaksPersen: 25, komentarMinPersen: 90, musikDibahasMaksDetik: 10,
  }), "angka bawaan");
  tegas(Object.isFrozen(KEBIJAKAN_BAWAAN), "bawaan beku");
  lolos(cek(dasar()), "dasar");
  samaDengan(cek(dasar()).ringkasan.persenVideo, 10, "persen video dasar");
  // sumber tanpa blok kutipan dan bukan KUTIPAN-WAJAR: di luar cakupan
  const m = dasar((x) => { delete x.sumber[0].kutipan; });
  samaDengan(cek(m).ringkasan, null, "di luar cakupan");
});

daftar("kutipan: batas 15 detik per klip (lolos 15,0; gagal 15,5; peringatan di atas 10)", () => {
  const dgn = (panjang) => dasar((m) => { m.klip[0].panjang = panjang; m.proyek.durasiVideoDetik = 200; m.proyek.komentar = [{ mulai: 0, akhir: 200, jenis: "narasi" }]; });
  lolos(cek(dgn(15)), "15 s");
  const g = cek(dgn(15.5));
  galatMemuat(g, "melebihi batas 15 s per klip", "15,5 s");
  tegas(cek(dgn(12)).peringatan.some((x) => x.includes("di atas 10 s")), "peringatan di atas 10 s");
  tegas(!cek(dgn(8)).peringatan.some((x) => x.includes("di atas 10 s")), "tanpa peringatan di 8 s");
});

daftar("kutipan: total per sumber (45 s atau 15% durasi sumber, yang lebih kecil)", () => {
  const banyak = (n, panjang) => (m) => {
    m.proyek.durasiVideoDetik = 1000;
    m.proyek.komentar = [{ mulai: 0, akhir: 1000, jenis: "narasi" }];
    m.klip = Array.from({ length: n }, (_, i) => ({ id: `k${i + 1}`, sumber: "s1", lebar: 320, tinggi: 180, dari: i * 20, panjang, mulaiVideo: i * 30 }));
  };
  lolos(cek(dasar(banyak(3, 15)), { s1: 600 }), "45 s dari 600 s (batas 45)");
  galatMemuat(cek(dasar(banyak(4, 11.5)), { s1: 600 }), "melebihi batas 45.00 s", "46 s dari 600 s");
  lolos(cek(dasar(banyak(2, 7.5)), { s1: 100 }), "15 s dari 100 s (batas 15%)");
  galatMemuat(cek(dasar(banyak(2, 7.75)), { s1: 100 }), "melebihi batas 15.00 s", "15,5 s dari 100 s");
  // sumber pendek: 15% dari 20 s = 3 s
  galatMemuat(cek(dasar(banyak(1, 4)), { s1: 20 }), "melebihi batas 3.00 s", "4 s dari 20 s");
  // panjang tak melewati sisa durasi sumber
  const m = dasar((x) => { x.klip[0].dari = 595; x.klip[0].panjang = 10; x.proyek.durasiVideoDetik = 200; x.proyek.komentar = [{ mulai: 0, akhir: 200, jenis: "narasi" }]; });
  dekat(cek(m, { s1: 600 }).ringkasan.totalKutipanDetik, 5, 1e-9, "dipotong ke sisa durasi sumber");
});

daftar("kutipan: total kutipan <= 25% durasi video baru", () => {
  const dgn = (panjang, durVideo) => dasar((m) => {
    m.klip[0].panjang = panjang; m.proyek.durasiVideoDetik = durVideo; m.proyek.komentar = [{ mulai: 0, akhir: durVideo, jenis: "narasi" }];
  });
  lolos(cek(dgn(10, 40)), "10 s dari 40 s = 25%");
  galatMemuat(cek(dgn(10.5, 40)), "melebihi batas 25%", "10,5 s dari 40 s");
  galatMemuat(cek(dasar((m) => { delete m.proyek.durasiVideoDetik; })), "proyek.durasiVideoDetik wajib", "durasi video wajib");
});

daftar("kutipan: komentar aktif >= 90% durasi kutipan (agregat) dan minimal satu per klip", () => {
  const dgn = (akhirKomentar) => dasar((m) => { m.klip[0].panjang = 10; m.proyek.komentar = [{ mulai: 5, akhir: akhirKomentar, jenis: "narasi" }]; });
  lolos(cek(dgn(14)), "9 s dari 10 s = 90%");
  galatMemuat(cek(dgn(13.9)), "komentar atau narasi asli aktif 89.00%", "8,9 s dari 10 s");
  // komentar yang tumpang tindih tidak dihitung dua kali
  const m = dasar((x) => { x.proyek.komentar = [{ mulai: 5, akhir: 10, jenis: "narasi" }, { mulai: 5, akhir: 10, jenis: "caption" }, { mulai: 9, akhir: 15, jenis: "anotasi" }]; });
  dekat(cek(m).ringkasan.persenKomentar, 100, 1e-9, "gabungan interval");
  // klip tanpa komentar sama sekali
  const dua = dasar((x) => {
    x.klip = [{ id: "k1", sumber: "s1", lebar: 1, tinggi: 1, dari: 0, panjang: 10, mulaiVideo: 5 }, { id: "k2", sumber: "s1", lebar: 1, tinggi: 1, dari: 20, panjang: 1, mulaiVideo: 60 }];
    x.proyek.komentar = [{ mulai: 0, akhir: 20, jenis: "narasi" }];
  });
  galatMemuat(cek(dua), 'klip "k2": tidak ada komentar aktif', "klip tanpa komentar");
  galatMemuat(cek(dasar((x) => { delete x.proyek.komentar; })), "proyek.komentar wajib", "komentar wajib");
  galatMemuat(cek(dasar((x) => { delete x.klip[0].mulaiVideo; })), "mulaiVideo", "mulaiVideo wajib");
  galatMemuat(cek(dasar((x) => { x.proyek.komentar = [{ mulai: 0, akhir: 5, jenis: "gosip" }]; })), "jenis harus salah satu", "jenis komentar");
  galatMemuat(cek(dasar((x) => { x.klip[0].mulaiVideo = 95; })), "melewati durasi video", "klip melewati akhir video");
});

daftar("kutipan: tujuan, isi blok, kutipan beruntun, orang dikenali", () => {
  galatMemuat(cek(dasar((m) => { m.sumber[0].kutipan.tujuan = "promosi"; })), 'kutipan.tujuan "promosi" ditolak', "tujuan promosi");
  lolos(cek(dasar((m) => { m.sumber[0].kutipan.tujuan = "berita-aktual"; })), "berita-aktual");
  galatMemuat(cek(dasar((m) => { m.sumber[0].kutipan.menyasarKarya = false; })), "menyasarKarya harus true", "menyasarKarya");
  galatMemuat(cek(dasar((m) => { m.sumber[0].kutipan.bukanBagianKhas = false; })), "bukanBagianKhas harus true", "bagian khas");
  galatMemuat(cek(dasar((m) => { m.sumber[0].kutipan.perubahanMakna = true; })), "perubahanMakna harus false", "perubahan makna");
  galatMemuat(cek(dasar((m) => { m.sumber[0].kutipan.orangDikenali = true; })), "orangDikenali true wajib izinPotret", "orang dikenali tanpa izin");
  lolos(cek(dasar((m) => { m.sumber[0].kutipan.orangDikenali = true; m.sumber[0].kutipan.izinPotret = "tertulis-ada"; })), "orang dikenali dengan izin");
  galatMemuat(cek(dasar((m) => { m.sumber[0].kutipan.orangDikenali = true; m.sumber[0].kutipan.izinPotret = "tertulis-ada"; m.sumber[0].kutipan.sintetis = true; })), "deepfake dilarang", "sintetis pada orang dikenali");
  galatMemuat(cek(dasar((m) => { m.sumber[0].kutipan.isiAudio = "bising"; })), "isiAudio", "isiAudio tidak dikenal");
  // dua klip bersambung 8 + 8 = 16 s tanpa jeda
  const bersambung = dasar((m) => {
    m.klip = [{ id: "k1", sumber: "s1", lebar: 1, tinggi: 1, dari: 0, panjang: 8, mulaiVideo: 5 }, { id: "k2", sumber: "s1", lebar: 1, tinggi: 1, dari: 30, panjang: 8, mulaiVideo: 13 }];
  });
  galatMemuat(cek(bersambung), "bersambung 16.00 s tanpa jeda", "kutipan beruntun");
  bersambung.klip[1].mulaiVideo = 15;
  lolos(cek(bersambung), "dengan jeda 2 s");
});

daftar("kutipan: kebijakan hanya boleh diperketat; pelonggaran butuh catatan izin tertulis", () => {
  const dgn = (ov) => dasar((m) => { m.proyek.kebijakanKutipan = ov; m.klip[0].panjang = 12; });
  // perketat: klip maks 8 s -> klip 12 s gagal
  galatMemuat(cek(dgn({ klipMaksDetik: 8 })), "melebihi batas 8 s per klip", "diperketat");
  // longgarkan tanpa catatan
  galatMemuat(cek(dgn({ klipMaksDetik: 20 })), "melonggarkan bawaan 15 tanpa", "dilonggarkan tanpa catatan");
  galatMemuat(cek(dgn({ komentarMinPersen: 50 })), "melonggarkan bawaan 90", "komentar dilonggarkan tanpa catatan");
  // dengan catatan: lolos dengan peringatan
  const r = cek(dgn({ klipMaksDetik: 20, catatanIzinTertulis: "izin tertulis pemegang hak, berkas izin-2026-01.pdf" }));
  lolos(r, "dilonggarkan dengan catatan");
  tegas(r.peringatan.some((x) => x.includes("dilonggarkan dengan catatan izin tertulis")), "peringatan pelonggaran");
  galatMemuat(cek(dgn({ klipMakDetik: 5 })), "kunci tidak dikenal", "kunci salah ketik");
  galatMemuat(cek(dgn({ klipMaksDetik: -1 })), "harus angka > 0", "angka negatif");
  // kebijakanEfektif murni
  samaDengan(kebijakanEfektif({}).kebijakan.videoMaksPersen, 25, "bawaan tanpa override");
  samaDengan(kebijakanEfektif({ kebijakanKutipan: { videoMaksPersen: 20 } }).kebijakan.videoMaksPersen, 20, "diperketat");
});

daftar("kutipan: KUTIPAN-WAJAR: cara perolehan, iklan, komersial, blok kutipan wajib", () => {
  const wajar = (ubah) => dasar((m) => {
    m.sumber[0].lisensi = "KUTIPAN-WAJAR";
    m.sumber[0].caraPerolehan = "izin-tertulis";
    m.sumber[0].tanggalAkses = "2026-11-07";
    ubah?.(m);
  });
  lolos(cek(wajar()), "KUTIPAN-WAJAR sah");
  for (const c of ["unduh-platform", "rekam-layar-platform", "rip-stream"]) {
    galatMemuat(cek(wajar((m) => { m.sumber[0].caraPerolehan = c; })), `caraPerolehan "${c}" ditolak`, c);
  }
  galatMemuat(cek(wajar((m) => { delete m.sumber[0].caraPerolehan; })), "caraPerolehan wajib salah satu dari", "cara perolehan kosong");
  galatMemuat(cek(wajar((m) => { m.sumber[0].caraPerolehan = "dari-teman"; })), "caraPerolehan wajib salah satu dari", "cara perolehan asing");
  galatMemuat(cek(wajar((m) => { m.sumber[0].caraPerolehan = "berkas-sah-pengguna"; })), "wajib disertai \"buktiPerolehan\"", "berkas-sah-pengguna tanpa bukti");
  galatMemuat(cek(wajar((m) => { delete m.sumber[0].tanggalAkses; })), "tanggalAkses", "tanggal akses");
  galatMemuat(cek(wajar((m) => { delete m.sumber[0].kutipan; })), 'wajib punya blok "kutipan"', "blok kutipan wajib");
  galatMemuat(cek(wajar((m) => { m.proyek.iklan = true; })), "ditolak mutlak untuk iklan", "iklan");
  galatMemuat(cek(wajar((m) => { m.proyek.tujuan = "komersial"; })), "komersial", "komersial tanpa GH");
});

// ---------------------------------------------------------- gerbang hukum GH
function manifestGh(ubah) {
  const m = dasar((x) => {
    x.sumber[0].lisensi = "KUTIPAN-WAJAR";
    x.sumber[0].caraPerolehan = "izin-tertulis";
    x.sumber[0].tanggalAkses = "2026-11-07";
  });
  ubah?.(m);
  return m;
}
daftar("GH (unit): menunggu/ tanpa status ditolak, disetujui bila hash cocok, perubahan membatalkan", () => {
  writeFileSync(j("memo-hukum.md"), "Memo peninjau fiktif untuk uji.\n");
  const m = manifestGh();
  samaDengan(statusGerbang(dasar(), tmp).perlu, false, "tanpa KUTIPAN-WAJAR tidak perlu GH");
  let s = statusGerbang(m, tmp);
  tegas(s.perlu && !s.disetujui && s.pesan.includes("belum ada"), `tanpa gerbang: ${s.pesan}`);
  m.proyek.gerbangHukum = { status: "menunggu" };
  s = statusGerbang(m, tmp);
  tegas(!s.disetujui && s.pesan.includes("belum disetujui"), `menunggu: ${s.pesan}`);
  m.proyek.gerbangHukum = { status: "disetujui", oleh: "KP", tanggal: "2026-11-07", berkas: "memo-hukum.md", hash: "0".repeat(64) };
  s = statusGerbang(m, tmp);
  tegas(!s.disetujui && s.pesan.includes("hash tidak cocok"), `hash salah: ${s.pesan}`);
  const h = hashGerbang(m, tmp);
  tegas(/^[0-9a-f]{64}$/.test(h.hash), "hash gerbang");
  m.proyek.gerbangHukum.hash = h.hash;
  s = statusGerbang(m, tmp);
  tegas(s.disetujui, `hash benar: ${s.pesan}`);
  // hash deterministik dan tidak bergantung pada urutan kunci atau isi gerbangHukum itu sendiri
  const m2 = salin(m);
  m2.proyek.gerbangHukum.oleh = "orang lain";
  samaDengan(hashGerbang(m2, tmp).hash, h.hash, "hash tidak memuat gerbangHukum");
  // mengubah manifest membatalkan persetujuan
  const ubah = salin(m);
  ubah.klip[0].panjang = 9;
  tegas(!statusGerbang(ubah, tmp).disetujui, "perubahan klip membatalkan GH");
  // mengubah memo membatalkan persetujuan
  writeFileSync(j("memo-hukum.md"), "Memo peninjau fiktif untuk uji, diubah.\n");
  tegas(!statusGerbang(m, tmp).disetujui, "perubahan memo membatalkan GH");
  // data tidak lengkap
  m.proyek.gerbangHukum = { status: "disetujui", oleh: "", tanggal: "kemarin", berkas: "memo-hukum.md", hash: "x" };
  s = statusGerbang(m, tmp);
  tegas(!s.disetujui && s.pesan.includes("tidak lengkap"), `tidak lengkap: ${s.pesan}`);
  // komersial dengan GH disetujui tetap butuh komersialDitinjau dan catatan
  const kom = manifestGh((x) => { x.proyek.tujuan = "komersial"; });
  writeFileSync(j("memo-hukum.md"), "Memo fiktif.\n");
  kom.proyek.gerbangHukum = { status: "disetujui", oleh: "KP", tanggal: "2026-11-07", berkas: "memo-hukum.md" };
  galatMemuat(cek(kom), "komersial", "komersial tanpa komersialDitinjau");
  kom.proyek.gerbangHukum.komersialDitinjau = true;
  kom.proyek.gerbangHukum.catatan = "ditinjau; sumber milik sendiri dan diizinkan";
  lolos(cek(kom), "komersial dengan komersialDitinjau dan catatan");
});

// ------------------------------------------------------------ audio kutipan
daftar("audio kutipan (unit): musik wajib bisu; ucapan boleh; musik dibahas maks 10 s", () => {
  const props = [
    { id: "m", kutipan: { isiAudio: "musik", musikDibahas: false } },
    { id: "d", kutipan: { isiAudio: "musik", musikDibahas: true } },
    { id: "u", kutipan: { isiAudio: "ucapan", musikDibahas: false } },
    { id: "x" },
  ];
  const r = (id, mode, mulai, akhir) => periksaAudioKutipan([{ id, mode, mulai, akhir }], props, 30);
  tegas(r("m", "bisu", 0, 900).galat.length === 0, "musik bisu boleh");
  memuat(r("m", "campur", 0, 90).galat.join(), 'harus mode "bisu"', "musik campur");
  memuat(r("m", "bergantian", 0, 90).galat.join(), 'harus mode "bisu"', "musik bergantian");
  tegas(r("d", "bergantian", 0, 300).galat.length === 0, "musik dibahas 10 s boleh");
  memuat(r("d", "bergantian", 0, 301).galat.join(), "maksimum 10 s", "musik dibahas 10,03 s");
  tegas(r("u", "campur", 0, 450).galat.length === 0, "ucapan campur boleh");
  tegas(r("u", "bergantian", 0, 450).galat.length === 0, "ucapan bergantian boleh");
  tegas(r("x", "campur", 0, 450).galat.length === 0, "klip di luar cakupan tak terpengaruh");
});

// ---------------------------------------------------- klip.mjs dan audio.mjs (CLI)
const sumberAsli = JSON.parse(readFileSync(join(templat, "sumber.json"), "utf8"));
// manifest variant di folder sementara; berkas sumber memakai jalur absolut ke templat
function variantManifest(ubah) {
  const m = salin(sumberAsli);
  for (const s of m.sumber) s.berkas = join(templat, s.berkas);
  ubah?.(m);
  return m;
}
let nomorKlip = 0;
async function klipDari(ubah, ekstra = []) {
  const berkas = j(`var-${++nomorKlip}.json`);
  const m = variantManifest(ubah);
  tulisJson(berkas, m);
  const out = j(`out-var-${nomorKlip}`);
  const r = await bun(klipMjs, berkas, "--fps", "30", "--out", out, "--gabung", join(templat, "props.json"), ...ekstra);
  return { ...r, out, berkas, manifest: m };
}
const jadiWajar = (m) => {
  m.sumber[0].lisensi = "KUTIPAN-WAJAR";
  m.sumber[0].caraPerolehan = "milik-sendiri";
  m.sumber[0].tanggalAkses = "2026-11-07";
};

daftar("klip.mjs: pelanggaran angka kutipan ditolak exit 2 sebelum ekstraksi (draf tidak melewatkannya)", async () => {
  // klip 16 s dari sumber 64 s (juga melebihi 15% sumber)
  let r = await klipDari((m) => { m.klip[0].panjang = 16; });
  samaDengan(r.kode, 2, `klip 16 s exit (${r.err})`);
  memuat(r.err, "kebijakan kutipan wajar dilanggar", "judul penolakan");
  memuat(r.err, "melebihi batas 15 s per klip", "klip");
  tegas(!existsSync(join(r.out, "klip-props.json")), "tidak ada keluaran saat ditolak");
  // draf tidak melewatkan pelanggaran angka
  r = await klipDari((m) => { jadiWajar(m); m.klip[0].panjang = 16; }, ["--draf"]);
  samaDengan(r.kode, 2, "draf tidak melewatkan pelanggaran angka");
  // proporsi video 25%: 48 s -> tambah durasi klip menjadi > 12 s total
  r = await klipDari((m) => { m.proyek.durasiVideoDetik = 40; });
  samaDengan(r.kode, 2, "11 s dari 40 s = 27,5%");
  memuat(r.err, "melebihi batas 25%", "proporsi video");
  // komentar < 90%
  r = await klipDari((m) => { m.proyek.komentar = m.proyek.komentar.filter((c) => c.jenis === "narasi" && c.mulai >= 8); });
  samaDengan(r.kode, 2, "komentar kurang");
  memuat(r.err, "komentar", "komentar");
  // cara perolehan unduhan platform
  r = await klipDari((m) => { jadiWajar(m); m.sumber[0].caraPerolehan = "unduh-platform"; }, ["--draf"]);
  samaDengan(r.kode, 2, "unduh-platform");
  memuat(r.err, 'caraPerolehan "unduh-platform" ditolak', "pesan");
});

daftar("klip.mjs: gerbang GH: tanpa persetujuan ditolak, --draf bertanda draf, disetujui lolos, perubahan membatalkan", async () => {
  // 1. tanpa GH: render final ditolak
  let r = await klipDari(jadiWajar);
  samaDengan(r.kode, 2, `tanpa GH exit (${r.err})`);
  memuat(r.err, "render final ditolak", "pesan GH");
  tegas(!existsSync(join(r.out, "klip-props.json")), "tidak ada keluaran tanpa GH");
  // 2. --draf: lolos, props bertanda draf
  r = await klipDari(jadiWajar, ["--draf"]);
  samaDengan(r.kode, 0, `draf exit (${r.err})`);
  memuat(r.err, "DRAF", "peringatan draf");
  samaDengan(JSON.parse(readFileSync(join(r.out, "klip-props.json"), "utf8")).draf, true, "klip-props.draf");
  samaDengan(JSON.parse(readFileSync(join(r.out, "props-gabungan.json"), "utf8")).draf, true, "props-gabungan.draf");
  memuat(readFileSync(join(r.out, "atribusi.txt"), "utf8"), "DRAF:", "atribusi.txt bertanda draf");
  memuat(readFileSync(join(r.out, "atribusi.txt"), "utf8"), "KUTIPAN-WAJAR bukan lisensi", "catatan KUTIPAN-WAJAR");
  // 3. persetujuan sah: memo + hash dari `kutipan.mjs hash`
  writeFileSync(j("memo-gh.md"), "Memo peninjau fiktif: tujuan ulasan; empat faktor ditimbang.\n");
  const ubahSah = (m) => {
    jadiWajar(m);
    m.proyek.gerbangHukum = { status: "disetujui", oleh: "KP", tanggal: "2026-11-07", berkas: j("memo-gh.md") };
  };
  const berkas = j("manifest-gh.json");
  const m = variantManifest(ubahSah);
  tulisJson(berkas, m);
  const h = await bun(kutipanMjs, "hash", berkas);
  samaDengan(h.kode, 0, `hash exit (${h.err})`);
  const hash = h.out.trim();
  tegas(/^[0-9a-f]{64}$/.test(hash), "hash gerbang dari CLI");
  m.proyek.gerbangHukum.hash = hash;
  tulisJson(berkas, m);
  const out = j("out-gh");
  r = await bun(klipMjs, berkas, "--fps", "30", "--out", out, "--gabung", join(templat, "props.json"));
  samaDengan(r.kode, 0, `disetujui exit (${r.err})`);
  memuat(r.out, "GH disetujui oleh KP pada 2026-11-07", "pesan GH disetujui");
  const props = JSON.parse(readFileSync(join(out, "klip-props.json"), "utf8"));
  tegas(props.draf === undefined, "disetujui: tanpa tanda draf");
  samaDengan(props.klip[0].kutipan.isiAudio, "ucapan", "klip-props memuat kutipan.isiAudio");
  samaDengan(props.klip[1].kutipan.isiAudio, "musik", "klip-props kutipan musik");
  // periksa lewat kutipan.mjs periksa
  r = await bun(kutipanMjs, "periksa", berkas);
  samaDengan(r.kode, 0, `kutipan periksa exit (${r.err})`);
  memuat(r.out, "kutipan: 3 klip, 11.00 s = 22.92% dari video 48.00 s", "ringkasan");
  // 4. mengubah manifest setelah persetujuan membatalkannya
  m.klip[2].panjang = 2.9;
  tulisJson(berkas, m);
  r = await bun(klipMjs, berkas, "--fps", "30", "--out", out);
  samaDengan(r.kode, 2, "perubahan setelah GH ditolak");
  memuat(r.err, "hash tidak cocok", "pesan hash");
  r = await bun(klipMjs, berkas, "--fps", "30", "--out", out, "--draf");
  samaDengan(r.kode, 0, "tetapi --draf tetap bisa");
});

daftar("kutipan.mjs: periksa melaporkan pelanggaran exit 2; argumen salah exit 2", async () => {
  const berkas = j("kutipan-lebih.json");
  tulisJson(berkas, variantManifest((m) => { m.klip[0].panjang = 16; }));
  let r = await bun(kutipanMjs, "periksa", berkas);
  samaDengan(r.kode, 2, "pelanggaran");
  memuat(r.err, "melebihi batas 15 s per klip", "pesan");
  samaDengan((await bun(kutipanMjs, "periksa")).kode, 2, "tanpa berkas");
  samaDengan((await bun(kutipanMjs, "ngawur", berkas)).kode, 2, "perintah asing");
  samaDengan((await bun(kutipanMjs, "hash", berkas)).kode, 2, "hash tanpa gerbangHukum.berkas");
});

daftar("audio.mjs: musik sumber kutipan mode campur ditolak; bisu lolos", async () => {
  // bahan: klip-props dari templat
  const out = j("out-aud");
  let r = await bun(klipMjs, join(templat, "sumber.json"), "--fps", "30", "--out", out, "--gabung", join(templat, "props.json"));
  samaDengan(r.kode, 0, `klip templat (${r.err})`);
  r = await bun(join(templat, "buat-audio.mjs"), j("audio-contoh"));
  samaDengan(r.kode, 0, `buat-audio (${r.err})`);
  const rencana = JSON.parse(readFileSync(join(templat, "rencana-audio.json"), "utf8"));
  for (const n of rencana.narasi) n.berkas = j("audio-contoh", n.berkas.split("/").pop());
  rencana.musik.berkas = j("audio-contoh", "musik.wav");
  tulisJson(j("rencana-ok.json"), rencana);
  r = await bun(audioMjs, j("rencana-ok.json"), "--fps", "30", "--klip-props", join(out, "klip-props.json"), "--out", j("ok.wav"));
  samaDengan(r.kode, 0, `rencana templat (${r.err})`);
  const salah = salin(rencana);
  salah.klip.find((k) => k.id === "k2").mode = "campur";
  tulisJson(j("rencana-musik-campur.json"), salah);
  r = await bun(audioMjs, j("rencana-musik-campur.json"), "--fps", "30", "--klip-props", join(out, "klip-props.json"), "--out", j("x.wav"));
  samaDengan(r.kode, 2, "musik sumber kutipan dicampur");
  memuat(r.err, 'klip "k2": audio sumber kutipan berisi musik dan harus mode "bisu"', "pesan audio kutipan");
  tegas(!existsSync(j("x.wav")), "tidak ada audio dirakit saat ditolak");
  // tanpa --klip-props, audio.mjs tidak tahu isi kutipan (aturan berlaku pada alur klip.mjs -> audio.mjs)
});

// ------------------------------------------------------------ templat reaction
daftar("templat reaction: berkas lengkap, hash aset, ASET.md, KUTIPAN-WAJAR.md, konsistensi jadwal", async () => {
  for (const f of ["index.html", "props.json", "sumber.json", "rencana-audio.json", "buat-audio.mjs", "ASET.md", "KUTIPAN-WAJAR.md", "aset/karya-fiktif-1.mkv", "aset/karya-fiktif-2.mkv"]) {
    tegas(existsSync(join(templat, f)), `templat reaction kehilangan ${f}`);
  }
  tegas(statSync(join(templat, "aset", "karya-fiktif-1.mkv")).size < 300000, "klip templat kecil");
  const aset = readFileSync(join(templat, "ASET.md"), "utf8");
  const props = JSON.parse(readFileSync(join(templat, "props.json"), "utf8"));
  const rencana = JSON.parse(readFileSync(join(templat, "rencana-audio.json"), "utf8"));
  for (const s of sumberAsli.sumber) {
    memuat(aset, s.berkas.split("/").pop(), "ASET.md memuat klip");
    tegas(["CC0-1.0", "CC-BY-4.0"].includes(s.lisensi), `lisensi sumber templat harus CC0/CC BY milik proyek: ${s.lisensi}`);
    samaDengan(s.pencipta, "Proyek awvd", "pencipta sumber templat");
  }
  const kw = readFileSync(join(templat, "KUTIPAN-WAJAR.md"), "utf8");
  for (const h of ["## Metadata", "## Tujuan dan analisis transformatif", "## Angka kutipan", "## Gerbang hukum GH", "## Changelog", "bukan nasihat hukum"]) memuat(kw, h, "KUTIPAN-WAJAR.md");
  // jadwal klip: manifest (mulaiVideo + panjang) = rencana audio = props.jadwal (frame 30 fps)
  for (const k of sumberAsli.klip) {
    const mulai = Math.round(k.mulaiVideo * 30), akhir = Math.round((k.mulaiVideo + k.panjang) * 30);
    const ra = rencana.klip.find((x) => x.id === k.id), pj = props.jadwal.klip.find((x) => x.id === k.id);
    samaDengan(`${ra.mulai}..${ra.akhir}`, `${mulai}..${akhir}`, `rencana audio ${k.id}`);
    samaDengan(`${pj.mulai}..${pj.akhir}`, `${mulai}..${akhir}`, `props.jadwal ${k.id}`);
    samaDengan(pj.mode, ra.mode, `mode ${k.id}`);
  }
  samaDengan(rencana.durasiFrame, sumberAsli.proyek.durasiVideoDetik * 30, "durasi frame = durasi video");
  // setiap komentar di props tercatat di manifest sebagai caption/anotasi dengan rentang sama
  for (const c of props.komentar) {
    tegas(sumberAsli.proyek.komentar.some((x) => x.mulai === c.mulai && x.akhir === c.akhir && x.jenis === (c.jenis ?? "caption")), `komentar ${c.mulai}..${c.akhir} tidak tercatat di sumber.json`);
  }
  // komentar mendominasi: total teks komentar tampil jauh lebih lama daripada kutipan
  const detikKomentar = props.komentar.reduce((t, c) => t + (c.akhir - c.mulai), 0);
  const detikKutipan = sumberAsli.klip.reduce((t, k) => t + k.panjang, 0);
  tegas(detikKomentar > 3 * detikKutipan, `komentar (${detikKomentar} s) harus mendominasi kutipan (${detikKutipan} s)`);
  // validator pada manifest templat dengan durasi sumber 64 s
  const r = periksaKutipan(sumberAsli, templat, { "karya-1": 64.06, "karya-2": 64.06 });
  lolos(r, "templat reaction");
  dekat(r.ringkasan.persenKomentar, 100, 1e-9, "komentar templat");
});

daftar("templat reaction: pipeline klip -> audio -> render, dua render identik, tanda draf", async () => {
  const out = j("out-reaksi");
  let r = await bun(klipMjs, join(templat, "sumber.json"), "--fps", "30", "--out", out, "--gabung", join(templat, "props.json"));
  samaDengan(r.kode, 0, `klip (${r.err})`);
  memuat(r.out, "kutipan: 3 klip, 11.00 s", "ringkasan kutipan");
  const klipProps = JSON.parse(readFileSync(join(out, "klip-props.json"), "utf8"));
  samaDengan(klipProps.klip.length, 3, "tiga klip");
  samaDengan(klipProps.klip.map((k) => k.jumlah).join(), "120,120,90", "jumlah frame per klip (30 fps)");
  // cache hit pada run kedua
  r = await bun(klipMjs, join(templat, "sumber.json"), "--fps", "30", "--out", out, "--gabung", join(templat, "props.json"));
  memuat(r.out, "cache hit", "cache hit");
  // audio: durasi 48 s
  r = await bun(join(templat, "buat-audio.mjs"), j("audio-reaksi"));
  samaDengan(r.kode, 0, `buat-audio (${r.err})`);
  const rencana = JSON.parse(readFileSync(join(templat, "rencana-audio.json"), "utf8"));
  for (const n of rencana.narasi) n.berkas = j("audio-reaksi", n.berkas.split("/").pop());
  rencana.musik.berkas = j("audio-reaksi", "musik.wav");
  tulisJson(j("rencana-reaksi.json"), rencana);
  r = await bun(audioMjs, j("rencana-reaksi.json"), "--fps", "30", "--klip-props", join(out, "klip-props.json"), "--out", j("reaksi.wav"));
  samaDengan(r.kode, 0, `audio (${r.err})`);
  memuat(r.out, "klip k3 (bergantian; musik dibisukan)", "tabel: bergantian");
  memuat(r.out, "narasi n2 + klip k1 (campur; klip -12 dB)", "tabel: campur");
  memuat(r.out, "klip bisu (tidak dimasukkan): k2", "tabel: bisu");
  // render still pada klip aktif dan kredit; dua render rentang identik
  const props = join(out, "props-gabungan.json");
  for (const f of [150, 450, 1380]) {
    r = await bun(renderMjs, join(templat, "index.html"), "--props-file", props, "--still", String(f), "--out", j(`reaksi-${f}.png`));
    samaDengan(r.kode, 0, `still ${f} (${r.err})`);
    tegas(statSync(j(`reaksi-${f}.png`)).size > 30000, `still ${f} tampak kosong`);
  }
  const md5Frame = async (berkas) => (await jalankan(["ffmpeg", "-v", "error", "-i", berkas, "-f", "framemd5", "-"])).out
    .split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim()).join("\n");
  for (const n of ["a", "b"]) {
    r = await bun(renderMjs, join(templat, "index.html"), "--props-file", props, "--dari", "112", "--sampai", "127", "--out", j(`det-${n}.mp4`));
    samaDengan(r.kode, 0, `render determinisme ${n} (${r.err})`);
  }
  samaDengan(await md5Frame(j("det-a.mp4")), await md5Frame(j("det-b.mp4")), "frame dua render templat reaction identik");
  // tanda draf: props dari klip.mjs --draf (sumber KUTIPAN-WAJAR tanpa GH) menampilkan pita DRAF
  const d = await klipDari(jadiWajar, ["--draf"]);
  samaDengan(d.kode, 0, `draf (${d.err})`);
  r = await bun(renderMjs, join(templat, "index.html"), "--props-file", join(d.out, "props-gabungan.json"), "--still", "150", "--out", j("reaksi-draf-150.png"));
  samaDengan(r.kode, 0, `still draf (${r.err})`);
  tegas(!Buffer.from(readFileSync(j("reaksi-draf-150.png"))).equals(readFileSync(j("reaksi-150.png"))), "still draf harus berbeda dari still final (pita DRAF)");
  // tanpa props klip, render gagal dengan pesan jelas
  r = await bun(renderMjs, join(templat, "index.html"), "--still", "150", "--out", j("tanpa-props.png"));
  samaDengan(r.kode, 1, "tanpa props klip render gagal");
  memuat(r.err, "props tidak lengkap", "pesan props kurang");
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
console.log(`\n${uji.length - gagalCount}/${uji.length} uji pelajari lolos (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(gagalCount ? 1 : 0);
