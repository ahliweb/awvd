#!/usr/bin/env bun
/**
 * uji-aset.mjs — uji fitur aset: validator manifest, pemeriksa SVG (termasuk SVG jahat),
 * resolusi, konversi sRGB, pemblokiran jaringan renderer, dan font stabil.
 * Semua fixture dibuat di folder sementara (ffmpeg lavfi, byte demi byte, atau tabel di berkas ini);
 * tidak ada aset pihak ketiga. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-aset.mjs [--hanya h]   # hanya uji yang namanya diawali "(h)"
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  bacaGambar, bangunAtribusi, bangunFontFace, bangunProps, bersihkanSvg, hitungResolusi, jalurDalam,
  MATRIKS_LISENSI, perluKonversiSrgb, periksaSvg, pindaiJaringan, sha256Berkas, uraiLisensiAset, validasiAset,
} from "./aset-lib.js";
import { konversiSrgb } from "./aset.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderMjs = join(akar, "scripts", "render.mjs");
const asetMjs = join(akar, "scripts", "aset.mjs");
const runtimeJs = join(akar, "scripts", "runtime.js");
const templat = join(akar, "templates", "aset-contoh");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-aset-"));
const hanyaIdx = process.argv.indexOf("--hanya");
const hanya = hanyaIdx > 0 ? `(${process.argv[hanyaIdx + 1]})` : null;
const j = (...p) => join(tmp, ...p);

// ----------------------------------------------------------------- utilitas
function tegas(kondisi, pesan) {
  if (!kondisi) throw new Error(pesan);
}
function memuat(teks, potongan, nama) {
  tegas(teks.includes(potongan), `${nama}: "${potongan}" tidak ada dalam:\n${teks}`);
}
async function jalankan(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}
async function ffmpeg(...a) {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a]);
  tegas(r.kode === 0, `ffmpeg gagal: ${r.err}`);
}
const bun = (...a) => jalankan(["bun", ...a]);
const salin = (o) => JSON.parse(JSON.stringify(o));
const tulisJson = (f, o) => writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);

/** Piksel RGB mentah (width x height x 3) dari berkas gambar apa pun lewat ffmpeg. */
async function pikselRgb(berkas) {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", berkas, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe", stderr: "pipe" });
  const buf = Buffer.from(await new Response(p.stdout).arrayBuffer());
  tegas((await p.exited) === 0, "ffmpeg gagal membaca piksel");
  return buf;
}

// ---- PNG, ICC, TTF yang disusun byte demi byte (PIL dan fonttools bukan dependensi) ----
const TABEL_CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = TABEL_CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunkPng(tipe, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(tipe, 4, "latin1"); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
function buatPng({ w, h, rgb, tambahan = [] }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const baris = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { baris[1 + x * 3] = rgb[0]; baris[2 + x * 3] = rgb[1]; baris[3 + x * 3] = rgb[2]; }
  const mentah = Buffer.concat(Array.from({ length: h }, () => baris));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunkPng("IHDR", ihdr),
    ...tambahan.map(([t, d]) => chunkPng(t, d)), chunkPng("IDAT", deflateSync(mentah)), chunkPng("IEND", Buffer.alloc(0)),
  ]);
}
const s15 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(v * 65536)); return b; };
function buatIcc({ primer, gamma = 2.19921875, deskripsi }) {
  const xyz = (v) => Buffer.concat([Buffer.from("XYZ \0\0\0\0", "latin1"), ...v.map(s15)]);
  const kurva = () => { const b = Buffer.alloc(14); b.write("curv", 0, "latin1"); b.writeUInt32BE(1, 8); b.writeUInt16BE(Math.round(gamma * 256), 12); return b; };
  const desc = Buffer.alloc(12 + deskripsi.length + 1 + 4 + 2 + 1 + 67);
  desc.write("desc", 0, "latin1"); desc.writeUInt32BE(deskripsi.length + 1, 8); desc.write(deskripsi, 12, "latin1");
  const hakCipta = Buffer.concat([Buffer.from("text\0\0\0\0", "latin1"), Buffer.from("uji\0", "latin1")]);
  const tag = [["cprt", hakCipta], ["desc", desc], ["wtpt", xyz([0.9642, 1, 0.8249])], ["rXYZ", xyz(primer.r)], ["gXYZ", xyz(primer.g)], ["bXYZ", xyz(primer.b)], ["rTRC", kurva()], ["gTRC", kurva()], ["bTRC", kurva()]];
  const mulai = 128 + 4 + tag.length * 12;
  let o = mulai; const tabel = Buffer.alloc(4 + tag.length * 12); tabel.writeUInt32BE(tag.length, 0);
  const isi = tag.map(([nama, d], i) => {
    const pad = Buffer.concat([d, Buffer.alloc((4 - (d.length % 4)) % 4)]);
    tabel.write(nama, 4 + i * 12, "latin1"); tabel.writeUInt32BE(o, 8 + i * 12); tabel.writeUInt32BE(d.length, 12 + i * 12); o += pad.length;
    return pad;
  });
  const kepala = Buffer.alloc(128);
  kepala.writeUInt32BE(o, 0); kepala.writeUInt32BE(0x02200000, 8); kepala.write("mntr", 12, "latin1"); kepala.write("RGB ", 16, "latin1"); kepala.write("XYZ ", 20, "latin1");
  kepala.write("acsp", 36, "latin1"); [0.9642, 1, 0.8249].forEach((v, i) => s15(v).copy(kepala, 68 + i * 4));
  return Buffer.concat([kepala, tabel, ...isi]);
}
const PRIMER_ADOBE = { r: [0.60974, 0.31111, 0.01947], g: [0.20528, 0.62567, 0.06087], b: [0.14919, 0.06322, 0.74457] };
const PRIMER_SRGB = { r: [0.4361, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971], b: [0.1431, 0.0606, 0.7141] };
const pngDenganIcc = (icc, rgb = [200, 100, 50], ukuran = 32) => buatPng({ w: ukuran, h: ukuran, rgb, tambahan: [["iCCP", Buffer.concat([Buffer.from("uji\0\0"), deflateSync(icc)])]] });

/** TrueType minimal: glyph 'H' berupa kotak dengan advance 1000/1000 em (lebar tetap, mudah diukur). */
function buatTtf() {
  const u16 = (...n) => { const b = Buffer.alloc(n.length * 2); n.forEach((v, i) => b.writeUInt16BE(v & 0xffff, i * 2)); return b; };
  const i16 = (...n) => { const b = Buffer.alloc(n.length * 2); n.forEach((v, i) => b.writeInt16BE(v, i * 2)); return b; };
  const u32 = (...n) => { const b = Buffer.alloc(n.length * 4); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
  const glifH = Buffer.concat([i16(1, 100, 0, 900, 700), u16(3, 0), Buffer.from([1, 1, 1, 1]), i16(100, 800, 0, -800), i16(0, 0, 700, 0)]);
  const glifPad = Buffer.concat([glifH, Buffer.alloc((4 - (glifH.length % 4)) % 4)]);
  const nama = ["UjiAwvd", "Regular", "UjiAwvd-1", "UjiAwvd Regular", "Version 1.0", "UjiAwvd-Regular"].map((s, i) => [i + 1, Buffer.from(s, "utf16le").swap16()]);
  let offNama = 0; const rekNama = nama.map(([id, b]) => { const r = u16(3, 1, 0x409, id, b.length, offNama); offNama += b.length; return r; });
  const cmap = Buffer.concat([u16(0, 1, 3, 1), u32(12), u16(4, 32, 0, 4, 4, 1, 0, 0x48, 0xffff, 0, 0x48, 0xffff, 1 - 0x48, 1, 0, 0)]);
  const tabel = {
    "OS/2": Buffer.concat([u16(0, 500, 400, 5, 0), i16(0, 0, 0, 0, 0, 0, 0, 0, 0, 0), u16(0), Buffer.alloc(10), u32(0, 0, 0, 0), Buffer.from("UJI "), u16(0x40, 0x48, 0x48), i16(800, -200, 0), u16(800, 200)]),
    cmap,
    glyf: glifPad,
    head: Buffer.concat([u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5), u16(3, 1000), Buffer.alloc(16), i16(100, 0, 900, 700), u16(0, 8, 2, 0, 0)]),
    hhea: Buffer.concat([u32(0x00010000), i16(800, -200, 0), u16(1000), i16(100, 100, 900, 1, 0, 0), Buffer.alloc(8), i16(0), u16(2)]),
    hmtx: Buffer.concat([u16(500), i16(0), u16(1000), i16(100)]),
    loca: u16(0, 0, glifPad.length / 2),
    maxp: Buffer.concat([u32(0x00010000), u16(2, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)]),
    name: Buffer.concat([u16(0, nama.length, 6 + nama.length * 12), ...rekNama, ...nama.map(([, b]) => b)]),
    post: Buffer.concat([u32(0x00030000, 0), i16(-100, 50), u32(0, 0, 0, 0, 0)]),
  };
  const tags = Object.keys(tabel).sort();
  const jumlah = (b) => { let s = 0; const p = Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); for (let i = 0; i < p.length; i += 4) s = (s + p.readUInt32BE(i)) >>> 0; return s; };
  let o = 12 + tags.length * 16; const rek = [], isi = [];
  for (const t of tags) {
    const b = tabel[t], pad = Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    const r = Buffer.alloc(16); r.write(t, 0, "latin1"); r.writeUInt32BE(jumlah(b), 4); r.writeUInt32BE(o, 8); r.writeUInt32BE(b.length, 12);
    rek.push(r); isi.push(pad); o += pad.length;
  }
  const kepala = Buffer.concat([u32(0x00010000), u16(tags.length, 128, 3, tags.length * 16 - 128)]);
  const font = Buffer.concat([kepala, ...rek, ...isi]);
  // checkSumAdjustment = 0xB1B0AFBA - jumlah seluruh berkas (head.checkSumAdjustment bernilai 0 saat dihitung)
  const offHead = 12 + tags.length * 16 + isi.slice(0, tags.indexOf("head")).reduce((s, b) => s + b.length, 0);
  font.writeUInt32BE((0xb1b0afba - jumlah(font)) >>> 0, offHead + 8);
  return font;
}

// ----------------------------------------------------------------- fixture SVG
const SVG_AWAL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40">';
const svg = (isi, awal = SVG_AWAL) => `${awal}${isi}</svg>`;
const SVG_BERSIH = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Logo fiktif, buatan sendiri -->\n${svg('<title>Logo</title><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0b5fa5"/><stop offset="1" stop-color="#1e9bd7"/></linearGradient></defs><rect width="40" height="40" rx="8" fill="url(#g)"/><path d="M12 28 L20 10 L28 28 Z" fill="#fff"/>', SVG_AWAL.replace(">", ' xmlns:xlink="http://www.w3.org/1999/xlink">'))}`;
const SVG_INKSCAPE = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 100 100" width="100" height="100" inkscape:version="1.3"><sodipodi:namedview id="nv" pagecolor="#fff"/><metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata><g inkscape:label="Layer 1" id="l1"><text x="10" y="50" font-family="Arial">Teks</text><circle cx="50" cy="50" r="20" fill="#e00"/></g></svg>';
// nama -> isi; semuanya harus ditolak oleh periksaSvg
const SVG_JAHAT = {
  "script": svg("<script>fetch('http://evil.example/x')</script><rect width=\"10\" height=\"10\"/>"),
  "onload-onclick": svg('<rect width="10" height="10" onload="alert(1)" ONCLICK="alert(2)"/>'),
  "image-http": svg('<image href="http://evil.example/p.png" width="10" height="10"/>'),
  "image-xlink-https": svg('<image xlink:href="https://evil.example/p.png" width="10" height="10"/>', SVG_AWAL.replace(">", ' xmlns:xlink="http://www.w3.org/1999/xlink">')),
  "image-data-svg": svg('<image href="data:image/svg+xml;base64,PHN2Zy8+" width="5" height="5"/>'),
  "use-eksternal": svg('<use href="http://evil.example/a.svg#x"/>'),
  "javascript-href-a": svg('<a href="javascript:alert(1)"><rect width="5" height="5"/></a>'),
  "javascript-entitas": svg('<use href="&#106;avascript:alert(1)"/>'),
  "foreignObject": svg('<foreignObject width="50" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><img src="http://evil.example/t.png"/></div></foreignObject>'),
  "namespace-xhtml": svg('<g xmlns="http://www.w3.org/1999/xhtml"><rect width="5" height="5"/></g>'),
  "prefix-script": svg('<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>'),
  "smil-animate": svg('<rect width="5" height="5"><animate attributeName="x" from="0" to="50" dur="2s" repeatCount="indefinite"/></rect>'),
  "css-animasi": svg("<style>rect{animation:g 1s infinite}@keyframes g{to{opacity:0}}</style><rect width=\"5\" height=\"5\"/>"),
  "css-import": svg("<style>@import url(http://evil.example/a.css); rect{fill:red}</style><rect width=\"5\" height=\"5\"/>"),
  "css-escape-url": svg('<rect width="5" height="5" style="background:\\75 rl(http://evil.example/z)"/>'),
  "style-url-eksternal": svg('<rect width="5" height="5" style="fill:url(https://evil.example/f.svg#a)"/>'),
  "xml-stylesheet": `<?xml-stylesheet href="http://evil.example/s.css" type="text/css"?>${svg('<rect width="5" height="5"/>')}`,
  "xxe": `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg("<text>&x;</text>")}`,
  "atribut-tanpa-kutip": svg('<rect width=5 height="5"/>'),
  "tanpa-xmlns": '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>',
  // tambahan ketika menulis ulang pemeriksa (lolos di prototipe atau belum diuji)
  "entitas-numerik-di-style": svg('<style>rect{fill:&#117;rl(http://evil.example/x)}</style><rect width="5" height="5"/>'),
  "image-set": svg('<rect width="5" height="5" style="fill:red;background:image-set(&quot;http://evil.example/x.png&quot; 1x)"/>'),
  "cdata-import": svg("<style><![CDATA[@import 'http://evil.example/a.css';]]></style><rect width=\"5\" height=\"5\"/>"),
  "font-face": svg('<style>@font-face{font-family:x;src:url(http://evil.example/f.woff2)}</style>'),
  "filter-url-relatif": svg('<rect width="5" height="5" filter="url(luar.svg#f)"/>'),
  "xml-base": svg('<rect width="5" height="5" xml:base="http://evil.example/"/>'),
  "use-melingkar": svg('<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>'),
  "entitas-tak-dikenal": svg("<text>&nbsp;</text>"),
  "atribut-ganda": svg('<rect width="5" width="6" height="5"/>'),
  "pi-di-tengah": svg('<?php echo 1 ?><rect width="5" height="5"/>'),
  "dua-akar": `${svg("")}${svg("")}`,
  "tag-tak-seimbang": svg("<g><rect/></svg>"),
};
// ledakan <use>: sepuluh use per tingkat, enam tingkat
SVG_JAHAT["use-ledakan"] = svg(`<defs><g id="t0"><rect width="1" height="1"/></g>${[1, 2, 3, 4, 5, 6].map((n) => `<g id="t${n}">${`<use href="#t${n - 1}"/>`.repeat(10)}</g>`).join("")}</defs><use href="#t6"/>`);

// ----------------------------------------------------------------- manifest dasar
const HASH_NOL = "0".repeat(64);
async function bangunProyek(dir) {
  mkdirSync(join(dir, "aset"), { recursive: true });
  writeFileSync(join(dir, "aset", "logo.svg"), SVG_BERSIH.replace(/<!--[\s\S]*?-->\n/, ""));
  writeFileSync(join(dir, "aset", "ikon.svg"), svg('<title>Ikon</title><circle cx="20" cy="20" r="10" fill="none" stroke="#000"/>'));
  await ffmpeg("-f", "lavfi", "-i", "color=c=0x3366cc:s=1200x800:d=1", "-frames:v", "1", join(dir, "aset", "foto.png"));
  writeFileSync(join(dir, "aset", "judul.ttf"), buatTtf());
  writeFileSync(join(dir, "aset", "OFL.txt"), "Teks lisensi uji (bukan lisensi nyata).\n");
  writeFileSync(join(dir, "aset", "foto.lisensi.txt"), "Tangkapan halaman lisensi uji.\n");
  await ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(dir, "aset", "nada.wav"));
  const h = async (f) => sha256Berkas(join(dir, "aset", f));
  const tasl = { pencipta: "Penulis Uji", sumberUrl: "https://example.org/uji", tanggalAkses: "2026-11-07" };
  return {
    skema: 1,
    proyek: { tujuan: "komersial", jenisVideo: "edukasi" },
    aset: [
      {
        id: "logo-uji", jenis: "logo", berkas: "aset/logo.svg", sha256: await h("logo.svg"), judul: "Logo uji", pencipta: "Proyek uji",
        lisensi: "MILIK-SENDIRI", perubahan: "tidak ada", teksAlternatif: "Logo uji", ai: { status: "tidak" },
        merek: { kategori: "milik-sendiri", pemilik: "Proyek uji", aturan: { ukuranMinPx: 48, clearSpace: { nilai: 0.5, satuan: "tinggi" }, warnaDiizinkan: ["#0b5fa5"], larangan: ["distorsi"] } },
        izin: { jenis: "milik-sendiri" }, tampil: { lebar: 120, tinggi: 40, fit: "contain" },
      },
      {
        id: "ikon-uji", jenis: "ikon", berkas: "aset/ikon.svg", sha256: await h("ikon.svg"), judul: "Ikon uji", ...tasl,
        lisensi: "MIT", hakCipta: "Copyright (c) Penulis Uji", berkasLisensi: "aset/OFL.txt", perubahan: "tidak ada", ikon: { keluarga: "uji", gaya: "outline" },
      },
      {
        id: "foto-uji", jenis: "gambar", berkas: "aset/foto.png", sha256: await h("foto.png"), judul: "Foto uji", ...tasl,
        lisensi: "STOK:pexels", bukti: "aset/foto.lisensi.txt", perubahan: "tidak ada", atribusiTampil: "akhir", teksAlternatif: "Latar biru polos",
        orang: { ada: false }, ai: { status: "tidak" }, fokus: { x: 0.5, y: 0.4 }, tampil: { lebar: 640, tinggi: 360, fit: "cover", zoomMaks: 1 },
      },
      {
        id: "font-uji", jenis: "font", berkas: "aset/judul.ttf", sha256: await h("judul.ttf"), judul: "Font uji", ...tasl,
        lisensi: "OFL-1.1", hakCipta: "Copyright 2026 Penulis Uji", berkasLisensi: "aset/OFL.txt", perubahan: "tidak ada",
        font: { famili: "Uji Awvd", bobot: 400, gaya: "normal", reservedFontName: "Uji Awvd", dimodifikasi: false, dijualTerpisah: false },
      },
      {
        id: "musik-uji", jenis: "audio", berkas: "aset/nada.wav", sha256: await h("nada.wav"), judul: "Nada uji", ...tasl,
        lisensi: "CC-BY-4.0", perubahan: "tidak ada", ai: { status: "tidak" }, audio: { peran: "musik" },
      },
    ],
  };
}

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }
let dasar, dirProyek;
async function proyekDasar() {
  if (!dasar) { dirProyek = j("proyek"); dasar = await bangunProyek(dirProyek); }
  return salin(dasar);
}
async function periksaDengan(ubah, opsi) {
  const m = await proyekDasar();
  await ubah(m);
  return validasiAset(m, dirProyek, opsi);
}
const entri = (m, id) => m.aset.find((a) => a.id === id);
const semua = (r) => [...r.galat, ...r.peringatan].join("\n");

// =============================================================== (a) validator
daftar("(a) validator: manifest dasar lolos; matriks lisensi, hash, jalur, TASL, bukti, OFL, orang, AI, merek, ShareAlike", async () => {
  const dasarOk = await periksaDengan(() => {});
  tegas(dasarOk.galat.length === 0, `manifest dasar seharusnya lolos:\n${dasarOk.galat.join("\n")}`);
  tegas(Object.keys(dasarOk.aset).length === 5 && dasarOk.aset["foto-uji"].rasioResolusi === 1.875, "info aset / rasio resolusi tidak sesuai");
  tegas(dasarOk.aset["logo-uji"].rasio === 3 && dasarOk.aset["musik-uji"].durasi > 0.9, "rasio svg atau durasi audio tidak terbaca");
  // peringatan nyata pada dasar: ikon berlisensi MIT memakai OFL.txt sebagai berkasLisensi tidak diperiksa isinya; tidak ada peringatan lain
  tegas(!dasarOk.peringatan.some((p) => /tidak dikenal/.test(p)), `bidang tak dikenal pada dasar: ${dasarOk.peringatan}`);

  const kasus = [
    ["skema salah", (m) => { m.skema = 2; }, "skema harus 1"],
    ["proyek tanpa tujuan", (m) => { delete m.proyek.tujuan; }, "proyek.tujuan"],
    ["id ganda", (m) => { entri(m, "ikon-uji").id = "logo-uji"; }, "id ganda"],
    ["jenis lottie", (m) => { entri(m, "ikon-uji").jenis = "lottie"; }, "lottie belum didukung"],
    ["jenis tak dikenal", (m) => { entri(m, "ikon-uji").jenis = "video"; }, "jenis wajib salah satu"],
    ["lisensi kosong", (m) => { entri(m, "foto-uji").lisensi = ""; }, "lisensi kosong ditolak"],
    ["lisensi tak dikenal (GPL)", (m) => { entri(m, "foto-uji").lisensi = "GPL-3.0"; }, "tidak dikenal"],
    ["lisensi ND", (m) => { entri(m, "foto-uji").lisensi = "CC-BY-ND-4.0"; }, "(ND) ditolak"],
    ["lisensi NC pada proyek komersial", (m) => { entri(m, "foto-uji").lisensi = "CC-BY-NC-4.0"; }, "(NC) ditolak untuk proyek komersial"],
    ["logo berlisensi CC-BY (di luar matriks logo)", (m) => { const l = entri(m, "logo-uji"); l.lisensi = "CC-BY-4.0"; l.atribusiTampil = "akhir"; }, "tidak diizinkan untuk jenis logo"],
    ["STOK tanpa bukti", (m) => { delete entri(m, "foto-uji").bukti; }, "wajib disertai \"bukti\""],
    ["bukti tidak ada", (m) => { entri(m, "foto-uji").bukti = "aset/hilang.txt"; }, "bukti:"],
    ["hash salah", (m) => { entri(m, "foto-uji").sha256 = HASH_NOL; }, "hash tidak cocok"],
    ["hash bukan hex", (m) => { entri(m, "foto-uji").sha256 = "xyz"; }, "sha256\" wajib"],
    ["berkas hilang", (m) => { entri(m, "foto-uji").berkas = "aset/tidak-ada.png"; }, "berkas tidak ditemukan"],
    ["berkas dengan ..", (m) => { entri(m, "foto-uji").berkas = "aset/../proyek/aset/foto.png"; }, "tidak boleh memuat"],
    ["berkas mutlak", (m) => { entri(m, "foto-uji").berkas = "/etc/hostname"; }, "harus berbentuk aset/"],
    ["berkas URL http", (m) => { entri(m, "foto-uji").berkas = "http://evil.example/a.png"; }, "harus berbentuk aset/"],
    ["berkas di luar aset/", (m) => { entri(m, "foto-uji").berkas = "bukti.png"; }, "harus berbentuk aset/"],
    ["judul/pencipta/sumber kosong", (m) => { const f = entri(m, "foto-uji"); f.judul = ""; f.pencipta = ""; delete f.sumberUrl; }, "\"judul\" wajib"],
    ["sumberUrl bukan http", (m) => { entri(m, "foto-uji").sumberUrl = "ftp://x"; }, "sumberUrl bukan URL http(s)"],
    ["tanggal tidak sah", (m) => { entri(m, "foto-uji").tanggalAkses = "2026-13-45"; }, "tanggalAkses"],
    ["perubahan kosong", (m) => { entri(m, "foto-uji").perubahan = ""; }, "\"perubahan\" wajib"],
    ["placeholder [isi]", (m) => { entri(m, "foto-uji").judul = "[isi]"; }, "belum diisi"],
    ["CC-BY tanpa atribusi tampil", (m) => { entri(m, "musik-uji").atribusiTampil = "tidak"; }, "mewajibkan atribusi"],
    ["MIT tanpa hakCipta/berkasLisensi", (m) => { const i = entri(m, "ikon-uji"); delete i.hakCipta; delete i.berkasLisensi; }, "wajib \"hakCipta\""],
    ["teksAlternatif hilang", (m) => { delete entri(m, "foto-uji").teksAlternatif; }, "teksAlternatif"],
    ["font OFL dijualTerpisah", (m) => { entri(m, "font-uji").font.dijualTerpisah = true; }, "dijualTerpisah"],
    ["font RFN dimodifikasi tanpa izin", (m) => { entri(m, "font-uji").font.dimodifikasi = true; }, "Reserved Font Name"],
    ["font famili/bobot ganda", async (m) => { const f = salin(entri(m, "font-uji")); f.id = "font-dua"; m.aset.push(f); }, "kombinasi famili/bobot/gaya sama"],
    ["font bukan font", async (m) => { const f = entri(m, "font-uji"); writeFileSync(join(dirProyek, "aset", "palsu.ttf"), "bukan font"); f.berkas = "aset/palsu.ttf"; f.sha256 = await sha256Berkas(join(dirProyek, "aset", "palsu.ttf")); }, "bukan font"],
    ["foto orang tanpa release", (m) => { entri(m, "foto-uji").orang = { ada: true }; }, "modelRelease"],
    ["foto anak tanpa persetujuan hukum", (m) => { entri(m, "foto-uji").orang = { ada: true, anak: true }; entri(m, "foto-uji").izin = { jenis: "izin-tertulis" }; }, "persetujuanHukum"],
    ["AI dihasilkan tanpa alat", (m) => { entri(m, "foto-uji").ai = { status: "dihasilkan" }; }, "ai.alat wajib"],
    ["AI dibantu tanpa kontribusi manusia", (m) => { entri(m, "foto-uji").ai = { status: "dibantu" }; }, "kontribusiManusia"],
    ["AI status tak sah", (m) => { entri(m, "foto-uji").ai = { status: "mungkin" }; }, "ai.status wajib"],
    ["logo pihak lain tanpa izin", (m) => { entri(m, "logo-uji").merek = { kategori: "merek-pihak-lain", pemilik: "Perusahaan X" }; }, "IZIN-TERTULIS"],
    ["logo instansi tanpa persetujuan hukum", (m) => { const l = entri(m, "logo-uji"); l.merek = { kategori: "instansi-pemerintah", pemilik: "Dinas X" }; l.lisensi = "IZIN-TERTULIS:Dinas X"; l.bukti = "aset/foto.lisensi.txt"; l.sumberUrl = "https://example.org/x"; l.tanggalAkses = "2026-11-07"; l.izin = { jenis: "izin-tertulis" }; }, "persetujuanHukum"],
    ["lambang negara dengan rasio menyimpang", (m) => { const l = entri(m, "logo-uji"); l.merek = { kategori: "lambang-negara", pemilik: "Negara", rasio: 1 }; l.lisensi = "IZIN-TERTULIS:Pemerintah"; l.bukti = "aset/foto.lisensi.txt"; l.sumberUrl = "https://example.org/x"; l.tanggalAkses = "2026-11-07"; l.izin = { jenis: "izin-tertulis", persetujuanHukum: "memo-1" }; }, "distorsi"],
    ["logo di bawah ukuran minimum", (m) => { entri(m, "logo-uji").tampil = { lebar: 30, tinggi: 10, fit: "contain" }; }, "di bawah ukuran minimum"],
    ["resolusi kurang (upscale)", (m) => { entri(m, "foto-uji").tampil = { lebar: 1920, tinggi: 1080, fit: "cover" }; }, "resolusi kurang"],
    ["tampil hilang pada raster", (m) => { delete entri(m, "foto-uji").tampil; }, "tampil wajib"],
    ["fokus di luar 0..1", (m) => { entri(m, "foto-uji").fokus = { x: 2, y: 0 }; }, "fokus harus"],
    ["ShareAlike tanpa lisensiKeluaran", (m) => { entri(m, "foto-uji").lisensi = "CC-BY-SA-4.0"; entri(m, "foto-uji").atribusiTampil = "akhir"; }, "lisensiKeluaran wajib"],
    ["video formal tanpa logo berizin", (m) => { m.proyek.jenisVideo = "formal"; entri(m, "logo-uji").merek = { kategori: "merek-pihak-lain", pemilik: "X" }; }, "formal"],
    ["jenis svg dengan berkas raster", (m) => { entri(m, "foto-uji").jenis = "svg"; }, "wajib berkas .svg"],
    ["gambar memakai berkas svg", (m) => { const f = entri(m, "foto-uji"); f.berkas = "aset/ikon.svg"; f.sha256 = entri(m, "ikon-uji").sha256; }, "dicatat sebagai jenis"],
    ["SVG berisi skrip", async (m) => { const f = entri(m, "ikon-uji"); writeFileSync(join(dirProyek, "aset", "jahat.svg"), SVG_JAHAT.script); f.berkas = "aset/jahat.svg"; f.sha256 = await sha256Berkas(join(dirProyek, "aset", "jahat.svg")); }, "skrip dilarang"],
    ["GIF beranimasi", async (m) => { const f = entri(m, "foto-uji"); await ffmpeg("-f", "lavfi", "-i", "testsrc=s=64x64:d=1:r=5", join(dirProyek, "aset", "anim.gif")); f.berkas = "aset/anim.gif"; f.sha256 = await sha256Berkas(join(dirProyek, "aset", "anim.gif")); }, "GIF ditolak"],
  ];
  for (const [nama, ubah, harapan] of kasus) {
    const r = await periksaDengan(ubah);
    tegas(r.galat.some((g) => g.includes(harapan)), `kasus "${nama}": galat dengan "${harapan}" tidak muncul. Galat:\n${r.galat.join("\n") || "(tidak ada)"}`);
  }
  // kasus kecil: peringatan, bukan galat
  const tidakLazim = await periksaDengan((m) => { entri(m, "foto-uji").lisensi = "MIT"; entri(m, "foto-uji").hakCipta = "x"; entri(m, "foto-uji").berkasLisensi = "aset/OFL.txt"; delete entri(m, "foto-uji").bukti; });
  tegas(tidakLazim.galat.length === 0 && tidakLazim.peringatan.some((p) => /tidak lazim/.test(p)), `MIT pada foto harus peringatan:\n${semua(tidakLazim)}`);
  const bidangAsing = await periksaDengan((m) => { entri(m, "foto-uji").sha265 = "x"; });
  tegas(bidangAsing.peringatan.some((p) => /sha265/.test(p)), "bidang salah ketik harus diperingatkan");
  const nonkom = await periksaDengan((m) => { m.proyek.tujuan = "nonkomersial"; entri(m, "foto-uji").lisensi = "CC-BY-NC-4.0"; delete entri(m, "foto-uji").bukti; });
  tegas(nonkom.galat.length === 0, `CC-BY-NC pada proyek nonkomersial harus lolos:\n${nonkom.galat}`);
  // ShareAlike dengan lisensiKeluaran kompatibel lolos
  const sa = await periksaDengan((m) => { entri(m, "foto-uji").lisensi = "CC-BY-SA-4.0"; delete entri(m, "foto-uji").bukti; m.proyek.lisensiKeluaran = "CC-BY-SA-4.0"; });
  tegas(sa.galat.length === 0, `ShareAlike kompatibel harus lolos:\n${sa.galat}`);
  // simlink yang keluar dari aset/ ditolak
  writeFileSync(j("luar.png"), readFileSync(join(dirProyek, "aset", "foto.png")));
  symlinkSync(j("luar.png"), join(dirProyek, "aset", "tautan.png"));
  const simlink = await periksaDengan((m) => { const f = entri(m, "foto-uji"); f.berkas = "aset/tautan.png"; });
  tegas(simlink.galat.some((g) => /simlink/.test(g)), `simlink keluar harus ditolak:\n${simlink.galat}`);
  // uraian lisensi dan matriks
  tegas(uraiLisensiAset("CC-BY-NC-SA-4.0").kunci === "CC-BY-SA" && uraiLisensiAset("IZIN-TERTULIS: ") === null, "uraiLisensiAset");
  tegas(Object.keys(MATRIKS_LISENSI).join() === "gambar,svg,logo,ikon,font,audio", "matriks lisensi memuat enam jenis");
  tegas(jalurDalam(dirProyek, "aset/foto.png").jalur && jalurDalam(dirProyek, "file:///etc/passwd").galat, "jalurDalam");
});

// =============================================================== (b) SVG
daftar("(b) SVG: logo bersih dan ekspor editor lolos; semua SVG jahat ditolak dan keluaran bersihkan aman; fuzz ber-seed", async () => {
  const bersih = periksaSvg(SVG_BERSIH);
  tegas(bersih.galat.length === 0 && bersih.rasio === 3, `logo bersih seharusnya lolos: ${bersih.galat}`);
  const ink = periksaSvg(SVG_INKSCAPE);
  tegas(ink.galat.length === 0 && ink.peringatan.some((p) => /dibuang bersih/.test(p)) && ink.peringatan.some((p) => /<text>/.test(p)), `ekspor editor: ${ink.galat} ${ink.peringatan}`);
  const inkBersih = bersihkanSvg(SVG_INKSCAPE);
  tegas(inkBersih.svg && !/inkscape|sodipodi|metadata/.test(inkBersih.svg) && periksaSvg(inkBersih.svg).peringatan.every((p) => !/dibuang bersih/.test(p)), "bersihkan harus membuang metadata editor");
  const berbahaya = /<script|onload|onclick|evil\.example|foreignObject|<animate|@import|@font-face|javascript:|DOCTYPE/i;
  for (const [nama, isi] of Object.entries(SVG_JAHAT)) {
    const r = periksaSvg(isi);
    tegas(r.galat.length > 0, `SVG jahat "${nama}" seharusnya ditolak`);
    const b = bersihkanSvg(isi);
    if (b.svg !== null) {
      tegas(periksaSvg(b.svg).galat.length === 0, `"${nama}": keluaran bersihkan masih bergalat`);
      tegas(!berbahaya.test(b.svg), `"${nama}": keluaran bersihkan masih memuat konstruk berbahaya:\n${b.svg}`);
    } else tegas(b.galat.length > 0, `"${nama}": penolakan tanpa alasan`);
  }
  // yang struktural tak diperbaiki; elemen/atribut berbahaya dibuang
  for (const nama of ["xxe", "xml-stylesheet", "atribut-tanpa-kutip", "use-ledakan", "use-melingkar"]) tegas(bersihkanSvg(SVG_JAHAT[nama]).svg === null, `"${nama}" harus ditolak oleh bersihkan`);
  const sk = bersihkanSvg(SVG_JAHAT.script);
  tegas(sk.svg && sk.svg.includes("<rect") && !sk.svg.includes("script") && sk.dibuang.length > 0, "bersihkan script harus membuang skrip dan menyisakan bentuk");
  const tx = bersihkanSvg(SVG_JAHAT["tanpa-xmlns"]);
  tegas(tx.svg && periksaSvg(tx.svg).galat.length === 0, "bersihkan menambahkan xmlns yang hilang");
  // batas ukuran
  tegas(periksaSvg(svg(`<path d="${"M0 0".repeat(300_000)}"/>`)).galat.some((g) => /ukuran >/.test(g)), "SVG > 1 MB harus ditolak");
  tegas(periksaSvg(svg("<g>".repeat(70) + "</g>".repeat(70))).galat.some((g) => /kedalaman >/.test(g)), "kedalaman > 64 harus ditolak");
  tegas(periksaSvg(svg("<rect/>".repeat(20_001))).galat.some((g) => /elemen >/.test(g)), "elemen > 20000 harus ditolak");
  // fuzz ber-seed: payload disisipkan ke posisi acak; keluaran bersihkan atau penolakan, tak pernah memuat payload aktif
  let seed = 12345;
  const acak = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const payload = ["<script>x</script>", ' onload="x"', '<image href="http://e/x"/>', "&xxe;", "<!DOCTYPE a>", '<use href="//e/x"/>', "<style>@import 'x';</style>", "<animate/>"];
  const logo = SVG_BERSIH;
  let lolosDenganPayload = 0;
  for (let i = 0; i < 400; i++) {
    const p = payload[Math.floor(acak() * payload.length)], pos = Math.floor(acak() * logo.length);
    const t = logo.slice(0, pos) + p + logo.slice(pos);
    const b = bersihkanSvg(t);
    // teks antar-elemen bukan atribut atau elemen (tidak dirender), jadi hanya tag yang diperiksa
    if (b.svg !== null) tegas(periksaSvg(b.svg).galat.length === 0 && !/<script|onload=|http:\/\/e\/|<!DOCTYPE|<animate/.test(b.svg.replace(/>[^<]*</g, "><")), `fuzz #${i}: keluaran masih berbahaya: ${JSON.stringify(t.slice(Math.max(0, pos - 20), pos + p.length + 10))}`);
    if (periksaSvg(t).galat.length === 0) lolosDenganPayload++;
  }
  // mutasi yang lolos periksaSvg hanya boleh payload yang berada di dalam komentar atau teks (data karakter, tak dirender)
  tegas(lolosDenganPayload < 400, "fuzz: seharusnya sebagian besar mutasi ditolak");
});

daftar("(c) SVG hasil bersihkan dimuat di Chromium (inline dan <img>): 0 permintaan jaringan, 0 skrip jalan", async () => {
  const { chromium } = await import("playwright-core");
  const { cariBrowser } = await import("./browser.js");
  const browser = await chromium.launch({ executablePath: cariBrowser(), headless: true, args: ["--force-color-profile=srgb"] });
  try {
    const context = await browser.newContext();
    const diminta = [];
    await context.route(/^(?!(?:data|about|blob):)/i, (r) => { diminta.push(r.request().url()); return r.abort(); });
    const page = await context.newPage();
    const konsol = [];
    page.on("console", (m) => konsol.push(m.text()));
    page.on("pageerror", (e) => konsol.push(e.message));
    let dimuat = 0;
    for (const isi of [SVG_BERSIH, SVG_INKSCAPE, ...Object.values(SVG_JAHAT)]) {
      const b = bersihkanSvg(isi);
      if (!b.svg) continue;
      dimuat++;
      const inline = b.svg.replace(/^<\?xml[^>]*\?>\s*/, "");
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(b.svg).toString("base64")}`;
      await page.setContent(`<body><script>window.dijalankan = 0</script>${inline}<img src="${dataUrl}"></body>`);
      await page.waitForTimeout(30);
      tegas(await page.evaluate(() => window.dijalankan === 0), "skrip jalan");
    }
    tegas(dimuat >= 20, `terlalu sedikit SVG dimuat: ${dimuat}`);
    tegas(diminta.length === 0, `permintaan jaringan dari SVG bersih: ${diminta.join(", ")}`);
    tegas(konsol.length === 0, `pesan konsol dari SVG bersih: ${konsol.slice(0, 3).join(" | ")}`);
  } finally {
    await browser.close();
  }
});

// =============================================================== (d) gambar
daftar("(d) gambar: resolusi (contain/cover/skala/zoom), header PNG/JPEG/WebP, ICC, EXIF, animasi", async () => {
  const dekat = (a, b, nama) => tegas(Math.abs(a - b) < 0.01, `${nama}: dapat ${a}, harapan ${b}`);
  dekat(hitungResolusi({ lebar: 64, tinggi: 64 }, { lebar: 100, tinggi: 100, fit: "contain" }, 2).rasio, 0.32, "logo 64px @2x");
  dekat(hitungResolusi({ lebar: 1200, tinggi: 800 }, { lebar: 640, tinggi: 360, fit: "cover" }, 2).rasio, 0.9375, "foto cover @2x");
  dekat(hitungResolusi({ lebar: 1200, tinggi: 800 }, { lebar: 640, tinggi: 360, fit: "cover" }, 1).rasio, 1.875, "foto cover @1x");
  dekat(hitungResolusi({ lebar: 4000, tinggi: 3000 }, { lebar: 640, tinggi: 360, fit: "cover", zoomMaks: 1.15 }, 2).rasio, 2.717, "foto 4000x3000 zoom");
  dekat(hitungResolusi({ lebar: 1000, tinggi: 500 }, { lebar: 500, tinggi: 500, fit: "contain" }, 1).rasio, 2, "contain");
  dekat(hitungResolusi({ lebar: 1000, tinggi: 500 }, { lebar: 500, tinggi: 500, fit: "fill" }, 1).rasio, 1, "fill memakai sumbu terburuk");

  const adobe = bacaGambar(pngDenganIcc(buatIcc({ primer: PRIMER_ADOBE, deskripsi: "Adobe RGB uji" })));
  tegas(adobe.format === "png" && adobe.icc?.sah && adobe.icc.primerSrgb === false && adobe.icc.ruang === "RGB" && adobe.icc.deskripsi === "Adobe RGB uji", `ICC Adobe: ${JSON.stringify(adobe.icc)}`);
  tegas(perluKonversiSrgb(adobe).length === 1, "Adobe RGB harus butuh konversi");
  const srgb = bacaGambar(pngDenganIcc(buatIcc({ primer: PRIMER_SRGB, deskripsi: "sRGB uji" })));
  tegas(srgb.icc.primerSrgb === true && perluKonversiSrgb(srgb).length === 0, "profil primer sRGB tidak boleh butuh konversi");
  tegas(bacaGambar(buatPng({ w: 8, h: 8, rgb: [1, 2, 3] })).icc === null, "PNG tanpa profil");
  const apng = bacaGambar(buatPng({ w: 8, h: 8, rgb: [1, 2, 3], tambahan: [["acTL", Buffer.alloc(8)]] }));
  tegas(apng.animasi === true, "APNG harus terdeteksi animasi");
  const webpAnim = Buffer.concat([Buffer.from("RIFF"), Buffer.from([30, 0, 0, 0]), Buffer.from("WEBPVP8X"), Buffer.from([10, 0, 0, 0, 0x02, 0, 0, 0, 7, 0, 0, 7, 0, 0])]);
  tegas(bacaGambar(webpAnim).animasi === true && bacaGambar(webpAnim).lebar === 8, "WebP animasi harus terdeteksi");
  tegas(bacaGambar(Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1")).format === "gif", "GIF terdeteksi");
  tegas(bacaGambar(Buffer.from("bukan gambar sama sekali")).format === "tak-dikenal", "bukan gambar");
  tegas(bacaGambar(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 0xff)])).format !== undefined, "PNG terpotong tak boleh melempar");

  // JPEG ber-EXIF orientasi 6 disusun dengan menyisipkan APP1 setelah SOI
  const jpg = j("asli.jpg");
  await ffmpeg("-f", "lavfi", "-i", "color=c=red:s=150x200:d=1", "-f", "lavfi", "-i", "color=c=blue:s=150x200:d=1", "-filter_complex", "hstack", "-frames:v", "1", jpg);
  const exif = Buffer.concat([Buffer.from("Exif\0\0MM\0*\0\0\0\b", "latin1"), Buffer.from([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0])]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  const asli = readFileSync(jpg);
  writeFileSync(j("ori6.jpg"), Buffer.concat([asli.subarray(0, 2), app1, asli.subarray(2)]));
  const h = bacaGambar(readFileSync(j("ori6.jpg")));
  tegas(h.format === "jpeg" && h.orientasi === 6 && h.lebar === 300 && h.tinggi === 200, `JPEG EXIF: ${JSON.stringify(h)}`);
  tegas(perluKonversiSrgb(h).some((a) => /orientasi EXIF 6/.test(a)), "orientasi 6 harus butuh konversi");

  // lewat validator: orientasi ≠ 1 = galat; resolusi dihitung dari dimensi setelah orientasi
  const dir = j("proyek-gambar"); mkdirSync(join(dir, "aset"), { recursive: true });
  copyFileSync(j("ori6.jpg"), join(dir, "aset", "ori.jpg"));
  const m = { skema: 1, proyek: { tujuan: "nonkomersial" }, aset: [{ id: "ori", jenis: "gambar", berkas: "aset/ori.jpg", sha256: await sha256Berkas(join(dir, "aset", "ori.jpg")), judul: "Ori", pencipta: "Uji", lisensi: "MILIK-SENDIRI", perubahan: "tidak ada", teksAlternatif: "x", ai: { status: "tidak" }, orang: { ada: false }, tampil: { lebar: 100, tinggi: 150, fit: "contain" } }] };
  const r = await validasiAset(m, dir);
  tegas(r.galat.some((g) => /EXIF orientasi 6/.test(g)), `orientasi harus galat:\n${r.galat}`);
  tegas(r.aset.ori.lebar === 200 && r.aset.ori.tinggi === 300, "dimensi efektif harus ditukar (200x300)");
  // Adobe RGB: peringatan, bukan galat
  copyFileSync(j("proyek-gambar", "aset", "ori.jpg"), j("proyek-gambar", "aset", "ori2.jpg"));
  writeFileSync(join(dir, "aset", "adobe.png"), pngDenganIcc(buatIcc({ primer: PRIMER_ADOBE, deskripsi: "Adobe RGB uji" }), [200, 100, 50], 256));
  const m2 = { ...m, aset: [{ ...m.aset[0], id: "adobe", berkas: "aset/adobe.png", sha256: await sha256Berkas(join(dir, "aset", "adobe.png")), tampil: { lebar: 100, tinggi: 100, fit: "contain" } }] };
  const r2 = await validasiAset(m2, dir);
  tegas(r2.galat.length === 0 && r2.peringatan.some((p) => /bukan sRGB/.test(p)), `Adobe RGB harus peringatan:\n${semua(r2)}`);
});

// =============================================================== (e) sRGB lewat Chromium
daftar("(e) konversi sRGB: Adobe RGB (200,100,50) menjadi sekitar (227,100,42); deterministik; orientasi EXIF dipanggang", async () => {
  const masuk = pngDenganIcc(buatIcc({ primer: PRIMER_ADOBE, deskripsi: "Adobe RGB uji" }), [200, 100, 50], 32);
  const a = await konversiSrgb(masuk, "image/png");
  const b = await konversiSrgb(masuk, "image/png");
  tegas(Buffer.compare(a, b) === 0, "konversi dua kali harus menghasilkan byte identik (mesin dan build Chromium yang sama)");
  writeFileSync(j("konversi.png"), a);
  const ph = bacaGambar(a);
  tegas(ph.format === "png" && ph.icc === null && ph.lebar === 32, `keluaran konversi: ${JSON.stringify(ph)}`);
  const px = await pikselRgb(j("konversi.png"));
  const [r, g, bl] = [px[0], px[1], px[2]];
  // toleransi +-3: build Chromium berbeda dapat menggeser beberapa nilai
  tegas(Math.abs(r - 227) <= 3 && Math.abs(g - 100) <= 3 && Math.abs(bl - 42) <= 3, `piksel hasil konversi (${r},${g},${bl}), harapan sekitar (227,100,42)`);
  // tanpa profil dianggap sRGB: nilai tetap
  const polos = await konversiSrgb(buatPng({ w: 16, h: 16, rgb: [200, 100, 50] }), "image/png");
  writeFileSync(j("polos.png"), polos);
  const pp = await pikselRgb(j("polos.png"));
  tegas(Math.abs(pp[0] - 200) <= 1 && Math.abs(pp[1] - 100) <= 1 && Math.abs(pp[2] - 50) <= 1, `tanpa profil harus tetap (200,100,50): (${pp[0]},${pp[1]},${pp[2]})`);
  // orientasi 6: 300x200 (kiri merah, kanan biru) menjadi 200x300 dengan merah di atas
  const o6 = await konversiSrgb(readFileSync(j("ori6.jpg")), "image/jpeg");
  writeFileSync(j("ori6-hasil.png"), o6);
  const ph6 = bacaGambar(o6);
  tegas(ph6.lebar === 200 && ph6.tinggi === 300, `dimensi setelah orientasi: ${ph6.lebar}x${ph6.tinggi}`);
  const p6 = await pikselRgb(j("ori6-hasil.png"));
  const di = (x, y) => [p6[(y * 200 + x) * 3], p6[(y * 200 + x) * 3 + 1], p6[(y * 200 + x) * 3 + 2]];
  tegas(di(100, 50)[0] > 200 && di(100, 50)[2] < 60, `bagian atas harus merah: ${di(100, 50)}`);
  tegas(di(100, 250)[2] > 200 && di(100, 250)[0] < 60, `bagian bawah harus biru: ${di(100, 250)}`);
});

// =============================================================== (f) CLI
daftar("(f) CLI: tambah (SVG dibersihkan, kerangka [isi] gagal periksa), isi manifest, periksa menulis keluaran, impor, --ketat, --gabung", async () => {
  const dir = j("cli"); mkdirSync(dir, { recursive: true });
  const sumber = j("sumber"); mkdirSync(sumber, { recursive: true });
  writeFileSync(join(sumber, "logo.svg"), svg("<script>x</script><rect width=\"40\" height=\"40\"/>"));
  const manifest = join(dir, "aset.json");
  const t = await bun(asetMjs, "tambah", "logo", join(sumber, "logo.svg"), "--manifest", manifest, "--id", "logo-cli", "--tanggal", "2026-11-07");
  tegas(t.kode === 0, `tambah: exit ${t.kode} ${t.err}`);
  tegas(/dibersihkan sanitasi SVG/.test(t.out), `catatan pembersihan tidak ada: ${t.out}`);
  const disimpan = readFileSync(join(dir, "aset", "logo-cli.svg"), "utf8");
  tegas(!disimpan.includes("script") && disimpan.includes("<rect"), "SVG tersimpan harus bersih");
  tegas(periksaSvg(disimpan).galat.length === 0, "SVG tersimpan harus lolos periksa");
  const m0 = JSON.parse(readFileSync(manifest, "utf8"));
  tegas(m0.aset[0].sha256 === (await sha256Berkas(join(dir, "aset", "logo-cli.svg"))), "sha256 harus hash berkas setelah bersih");
  const dua = await bun(asetMjs, "tambah", "logo", join(sumber, "logo.svg"), "--manifest", manifest, "--id", "logo-cli");
  tegas(dua.kode === 2 && /sudah ada/.test(dua.err), `id ganda harus exit 2: ${dua.kode} ${dua.err}`);
  // SVG rusak ditolak sebelum disalin
  writeFileSync(join(sumber, "xxe.svg"), SVG_JAHAT.xxe);
  const x = await bun(asetMjs, "tambah", "svg", join(sumber, "xxe.svg"), "--manifest", manifest);
  tegas(x.kode === 2 && /SVG ditolak/.test(x.err) && !existsSync(join(dir, "aset", "xxe.svg")), `XXE harus ditolak: ${x.err}`);
  // gambar beranimasi ditolak
  await ffmpeg("-f", "lavfi", "-i", "testsrc=s=64x64:d=1:r=5", join(sumber, "anim.gif"));
  const gif = await bun(asetMjs, "tambah", "gambar", join(sumber, "anim.gif"), "--manifest", manifest);
  tegas(gif.kode === 2 && !existsSync(join(dir, "aset", "anim.gif")), `GIF harus ditolak: ${gif.kode} ${gif.err}`);
  // kerangka belum diisi: periksa gagal (exit 2) dan tidak menulis keluaran
  const keluar = j("cli-keluar");
  const p0 = await bun(asetMjs, "periksa", manifest, "--out", keluar);
  tegas(p0.kode === 2 && /belum diisi/.test(p0.out) && !existsSync(join(keluar, "aset-props.json")), `kerangka harus gagal: ${p0.kode}\n${p0.out}`);
  // isi manifest lengkap
  m0.proyek = { tujuan: "komersial" };
  Object.assign(m0.aset[0], { judul: "Logo CLI", pencipta: "Penguji", sumberUrl: "https://example.org/logo", lisensi: "MILIK-SENDIRI", perubahan: "tidak ada", teksAlternatif: "Logo CLI", ai: { status: "tidak" }, merek: { kategori: "milik-sendiri", pemilik: "Penguji" }, izin: { jenis: "milik-sendiri" } });
  delete m0.aset[0].bukti;
  tulisJson(manifest, m0);
  const p1 = await bun(asetMjs, "periksa", manifest, "--out", keluar, "--json");
  tegas(p1.kode === 0, `periksa: exit ${p1.kode}\n${p1.out}${p1.err}`);
  const lap = JSON.parse(p1.out);
  tegas(lap.lolos === true && lap.aset["logo-cli"].rasio === 3, "laporan --json");
  const props = JSON.parse(readFileSync(join(keluar, "aset-props.json"), "utf8"));
  tegas(props.skema === 1 && props.aset["logo-cli"].jalur === "aset/logo-cli.svg" && props.aset["logo-cli"].atribusi.kredit.includes("Logo CLI"), "aset-props.json");
  tegas(readFileSync(join(keluar, "atribusi.txt"), "utf8").includes("Atribusi:") && existsSync(join(keluar, "font-face.css")), "atribusi.txt dan font-face.css");
  // --ketat mengubah peringatan menjadi gagal
  m0.aset[0].catatan = "ok"; m0.aset[0].tidakDikenal = 1; tulisJson(manifest, m0);
  const k = await bun(asetMjs, "periksa", manifest, "--out", keluar, "--ketat");
  tegas(k.kode === 2 && /--ketat/.test(k.out), `--ketat harus gagal pada peringatan: ${k.kode}\n${k.out}`);
  const nonKetat = await bun(asetMjs, "periksa", manifest, "--out", keluar);
  tegas(nonKetat.kode === 0, `tanpa --ketat harus lolos: ${nonKetat.out}`);
  // --gabung
  writeFileSync(j("dasar.json"), JSON.stringify({ judul: "Halo" }));
  const g = await bun(asetMjs, "periksa", manifest, "--out", keluar, "--gabung", j("dasar.json"));
  const gab = JSON.parse(readFileSync(join(keluar, "props-gabungan.json"), "utf8"));
  tegas(g.kode === 0 && gab.judul === "Halo" && gab.aset["logo-cli"], `--gabung: ${g.out}`);
  writeFileSync(j("dasar-aset.json"), JSON.stringify({ aset: 1 }));
  tegas((await bun(asetMjs, "periksa", manifest, "--gabung", j("dasar-aset.json"))).kode === 2, "--gabung berkunci aset harus exit 2");
  // pemindaian komposisi: hotlink dan aset tak terdaftar menjadi peringatan
  writeFileSync(j("komposisi.html"), '<img src="https://cdn.example/x.png"><img src="aset/tidak-terdaftar.png"><svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const kp = await bun(asetMjs, "periksa", manifest, "--out", keluar, "--komposisi", j("komposisi.html"));
  tegas(/cdn\.example/.test(kp.out) && /tidak-terdaftar/.test(kp.out) && !/w3\.org/.test(kp.out), `pemindaian komposisi:\n${kp.out}`);
  tegas(pindaiJaringan('<link href="//cdn.x/a.css"> url(//f.x/b.woff2)', "c").length === 2, "pindaiJaringan //host");
  // impor dari daftar: salin, isi hash, gabung ke manifest, lalu periksa
  const daftarImpor = j("daftar-impor.json");
  writeFileSync(join(sumber, "ikon.svg"), svg('<circle cx="20" cy="20" r="10"/>'));
  tulisJson(daftarImpor, { aset: [{ id: "ikon-impor", jenis: "ikon", sumberBerkas: "sumber/ikon.svg", judul: "Ikon", pencipta: "Penguji", sumberUrl: "https://example.org/i", tanggalAkses: "2026-11-07", lisensi: "CC0-1.0", perubahan: "tidak ada" }] });
  const im = await bun(asetMjs, "impor", daftarImpor, "--manifest", manifest);
  tegas(im.kode === 0 && /LOLOS/.test(im.out), `impor: exit ${im.kode}\n${im.out}${im.err}`);
  tegas(existsSync(join(dir, "aset", "ikon-impor.svg")) && JSON.parse(readFileSync(manifest, "utf8")).aset.length === 2, "impor harus menyalin berkas dan menambah entri");
  // argumen salah
  tegas((await bun(asetMjs, "tambah", "video", join(sumber, "logo.svg"), "--manifest", manifest)).kode === 2, "jenis salah harus exit 2");
  tegas((await bun(asetMjs, "periksa", j("tidak-ada.json"))).kode === 2, "manifest hilang harus exit 2");
  tegas((await bun(asetMjs, "bukan-perintah")).kode === 2, "perintah salah harus exit 2");
});

// =============================================================== (g) render tanpa jaringan
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
function komposisi(badan, skrip = "", { runtime = runtimeJs, lebar = 160, tinggi = 90, frame = 6 } = {}) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0">${badan}<script src="${runtime}"></script><script>${skrip}\ndefineVideo({ width: ${lebar}, height: ${tinggi}, fps: 10, durationInFrames: ${frame}, render(f) { ${"/*RENDER*/"} } });</script>`;
}
const render = (...a) => bun(renderMjs, ...a);

daftar("(g) render memblokir jaringan: hotlink img/fetch/beacon/WebSocket gagal (exit 3, 0 permintaan sampai server); file:// lolos; --izinkan-jaringan; asal sendiri diizinkan", async () => {
  const hits = [];
  const server = Bun.serve({ port: 0, fetch(req) { hits.push(new URL(req.url).pathname); return new Response(PNG_1PX, { headers: { "content-type": "image/png" } }); } });
  const port = server.port;
  try {
    // hotlink: img, fetch, sendBeacon, WebSocket
    const html = j("hotlink.html");
    writeFileSync(html, komposisi(`<img src="http://127.0.0.1:${port}/a.png">`, `fetch("http://127.0.0.1:${port}/f").catch(()=>{}); navigator.sendBeacon("http://127.0.0.1:${port}/b","x"); try { new WebSocket("ws://127.0.0.1:${port}/ws") } catch (e) {}`).replace("/*RENDER*/", ""));
    const r = await render(html, "--out", j("hotlink.png"), "--still", "0");
    tegas(r.kode === 3, `hotlink harus exit 3, dapat ${r.kode}: ${r.err}`);
    for (const p of ["/a.png", "/f", "/b", "/ws"]) memuat(r.err, `127.0.0.1:${port}${p}`, "daftar URL yang diblokir");
    memuat(r.err, "4 permintaan jaringan diblokir", "ringkasan");
    tegas(hits.length === 0, `server menerima permintaan walau diblokir: ${hits}`);
    tegas(!existsSync(j("hotlink.png")), "still tak boleh ditulis bila diblokir");
    // file:// dan data: lolos
    await ffmpeg("-f", "lavfi", "-i", "color=c=red:s=16x16:d=1", "-frames:v", "1", j("lokal.png"));
    const lokal = j("lokal.html");
    writeFileSync(lokal, komposisi('<img src="lokal.png"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">').replace("/*RENDER*/", ""));
    const l = await render(lokal, "--out", j("lokal-out.png"), "--still", "0");
    tegas(l.kode === 0 && hits.length === 0, `file:// dan data: harus lolos: ${l.kode} ${l.err}`);
    // pemblokiran terjadi di tengah video (frame 3): keluaran setengah jadi dibuang
    const tengah = j("tengah.html");
    writeFileSync(tengah, komposisi("", "", { frame: 8 }).replace("/*RENDER*/", `if (f === 3) fetch("http://127.0.0.1:${port}/tengah").catch(() => {});`));
    const t = await render(tengah, "--out", j("tengah.mp4"));
    tegas(t.kode === 3 && /\/tengah/.test(t.err), `fetch di frame 3 harus exit 3: ${t.kode} ${t.err}`);
    tegas(!existsSync(j("tengah.mp4")), "keluaran setengah jadi harus dihapus");
    tegas(hits.length === 0, `server menerima permintaan: ${hits}`);
    // --izinkan-jaringan mematikan pemblokiran, dengan peringatan
    const iz = await render(html, "--out", j("izin.png"), "--still", "0", "--izinkan-jaringan");
    tegas(iz.kode === 0 && /--izinkan-jaringan aktif/.test(iz.err), `--izinkan-jaringan: ${iz.kode} ${iz.err}`);
    tegas(["/a.png", "/f", "/b"].every((p) => hits.includes(p)), `permintaan harus sampai server: ${hits}`);
    // komposisi yang dibuka lewat http hanya boleh meminta asalnya sendiri
    hits.length = 0;
    const asing = Bun.serve({ port: 0, fetch() { hits.push("ASING"); return new Response(PNG_1PX, { headers: { "content-type": "image/png" } }); } });
    const sama = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/runtime.js") return new Response(Bun.file(runtimeJs), { headers: { "content-type": "text/javascript" } });
        if (p === "/c.html") return new Response(komposisi('<img src="/gambar.png">', "", { runtime: "/runtime.js" }).replace("/*RENDER*/", ""), { headers: { "content-type": "text/html" } });
        if (p === "/d.html") return new Response(komposisi(`<img src="/gambar.png"><img src="http://127.0.0.1:${asing.port}/x.png">`, "", { runtime: "/runtime.js" }).replace("/*RENDER*/", ""), { headers: { "content-type": "text/html" } });
        hits.push(`SAMA${p}`);
        return new Response(PNG_1PX, { headers: { "content-type": "image/png" } });
      },
    });
    try {
      const s = await render(`http://127.0.0.1:${sama.port}/c.html`, "--out", j("sama.png"), "--still", "0");
      tegas(s.kode === 0 && hits.includes("SAMA/gambar.png"), `asal sendiri harus diizinkan: ${s.kode} ${s.err}`);
      const a = await render(`http://127.0.0.1:${sama.port}/d.html`, "--out", j("asing.png"), "--still", "0");
      tegas(a.kode === 3 && a.err.includes(`127.0.0.1:${asing.port}/x.png`) && !hits.includes("ASING"), `asal lain harus diblokir: ${a.kode} ${a.err}`);
    } finally {
      sama.stop(true); asing.stop(true);
    }
  } finally {
    server.stop(true);
  }
});

// =============================================================== (h) font stabil
async function lebarMerah(png, y) {
  const px = await pikselRgb(png);
  const w = 400;
  let n = 0;
  for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; if (px[o] > 200 && px[o + 1] < 60 && px[o + 2] < 60) n++; }
  return n;
}
daftar("(h) font stabil: @font-face statis termuat sebelum frame pertama (ukuran teks yang diukur di render() benar), FontFace yang ditambahkan di render() termuat sebelum tangkapan, font hilang = galat jelas", async () => {
  writeFileSync(j("font.ttf"), buatTtf());
  const kotak = (id, famili) => `const s = document.createElement("span"); s.id = "${id}"; s.textContent = "HHH"; s.style.cssText = 'position:absolute;left:10px;top:${id === "a" ? 10 : 70}px;line-height:30px;background:#f00;color:transparent;font:40px/30px "${famili}", serif'; document.body.append(s);`;
  const gaya = '<style>@font-face{font-family:"UjiStatis";src:url(font.ttf) format("truetype")}</style>';
  // (A) @font-face statis yang baru dipakai oleh elemen yang dibuat di render(); lebar teks diukur segera
  //     (komposisi yang menata tata letak dari ukuran teks), lalu kotak kedua digambar selebar ukuran itu
  const a = j("font-a.html");
  writeFileSync(a, komposisi(gaya, "", { lebar: 400, tinggi: 120, frame: 8 }).replace("/*RENDER*/", `if (!document.getElementById("a")) { ${kotak("a", "UjiStatis")} const k = document.createElement("div"); k.style.cssText = "position:absolute;left:10px;top:70px;height:20px;background:#f00;width:" + document.getElementById("a").getBoundingClientRect().width + "px"; document.body.append(k); }`));
  // (B) FontFace ditambahkan di dalam render() tanpa ditunggu
  const b = j("font-b.html");
  writeFileSync(b, komposisi("", "", { lebar: 400, tinggi: 120, frame: 8 }).replace("/*RENDER*/", `if (!window.__f) { window.__f = new FontFace("UjiDinamis", "url(font.ttf)"); document.fonts.add(window.__f); ${kotak("a", "UjiDinamis")} }`));
  for (const [nama, berkas] of [["A", a], ["B", b]]) {
    const png0 = j(`font-${nama}-0.png`), png5 = j(`font-${nama}-5.png`);
    for (const [png, f] of [[png0, "0"], [png5, "5"]]) {
      const r = await render(berkas, "--out", png, "--still", f);
      tegas(r.kode === 0, `font ${nama} frame ${f}: exit ${r.kode} ${r.err}`);
    }
    const w0 = await lebarMerah(png0, 25), w5 = await lebarMerah(png5, 25);
    if (nama === "A") tegas(await lebarMerah(png0, 80) === 120, `skenario A: lebar yang diukur di render() = ${await lebarMerah(png0, 80)} px, harapan 120 (font belum termuat saat diukur)`);
    // tiga glyph 'H' ber-advance 1000/1000 em pada 40 px = 120 px; font cadangan serif jauh lebih sempit
    tegas(Math.abs(w0 - 120) <= 1, `skenario ${nama} frame 0: lebar ${w0} px, harapan 120 (font cadangan terpakai?)`);
    tegas(w0 === w5, `skenario ${nama}: frame 0 (${w0}) dan frame 5 (${w5}) harus identik`);
  }
  // @font-face yang gagal dimuat = galat jelas, bukan font cadangan diam-diam
  const rusak = j("font-rusak.html");
  writeFileSync(rusak, komposisi('<style>@font-face{font-family:"Hilang";src:url(tidak-ada.ttf)}</style><span style="font-family:Hilang">x</span>').replace("/*RENDER*/", ""));
  const rr = await render(rusak, "--out", j("font-rusak.png"), "--still", "0");
  tegas(rr.kode === 1 && /font gagal dimuat: Hilang/.test(rr.err), `font hilang harus exit 1 dengan pesan jelas: ${rr.kode} ${rr.err}`);
});

// =============================================================== (i) templat dan keluaran
daftar("(i) templat aset-contoh: periksa lolos, ASET.md memuat setiap id, render dua kali identik, keluaran font-face dan atribusi", async () => {
  const manifest = join(templat, "aset.json");
  const keluar = j("templat-keluar");
  const p = await bun(asetMjs, "periksa", manifest, "--out", keluar, "--ketat", "--komposisi", join(templat, "index.html"));
  tegas(p.kode === 0, `templat harus lolos termasuk --ketat: exit ${p.kode}\n${p.out}${p.err}`);
  const m = JSON.parse(readFileSync(manifest, "utf8"));
  const asetMd = readFileSync(join(templat, "ASET.md"), "utf8");
  for (const a of m.aset) memuat(asetMd, `\`${a.id}\``, "ASET.md");
  tegas(m.aset.every((a) => ["MILIK-SENDIRI", "CC0-1.0"].includes(a.lisensi)), "templat tidak boleh memuat aset pihak ketiga");
  const f1 = j("templat-1.mp4"), f2 = j("templat-2.mp4");
  for (const f of [f1, f2]) { const r = await render(join(templat, "index.html"), "--out", f, "--sampai", "14"); tegas(r.kode === 0, `render templat: ${r.err}`); }
  const md5 = async (f) => (await jalankan(["ffmpeg", "-v", "error", "-i", f, "-f", "framemd5", "-"])).out.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim()).join("\n");
  const [x, y] = [await md5(f1), await md5(f2)];
  tegas(x.split("\n").length === 15 && x === y, "dua render templat beraset harus identik per frame");
  // font-face dan atribusi dari proyek dasar (font, CC-BY, STOK, MIT)
  const m2 = await proyekDasar();
  const r = await validasiAset(m2, dirProyek);
  const css = bangunFontFace(r.aset, dirProyek, j("css-keluar"));
  memuat(css, 'font-family: "Uji Awvd"', "font-face.css"); memuat(css, 'format("truetype")', "font-face.css"); memuat(css, "font-display: block", "font-face.css");
  memuat(css, "../proyek/aset/judul.ttf", "jalur url() relatif ke css");
  const atribusi = bangunAtribusi(r.aset);
  memuat(atribusi, "[akhir]", "atribusi.txt"); memuat(atribusi, "Nada uji", "atribusi.txt"); memuat(atribusi, "CC BY 4.0", "atribusi.txt");
  memuat(atribusi, "Copyright (c) Penulis Uji", "pemberitahuan MIT"); memuat(atribusi, "Copyright 2026 Penulis Uji", "pemberitahuan OFL");
  const props = bangunProps(r.aset);
  tegas(props.aset["font-uji"].font.format === "ttf" && props.aset["foto-uji"].fokus.y === 0.4 && props.aset["foto-uji"].atribusi.kredit.includes("Foto uji"), "aset-props memuat font, fokus, dan kredit");
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
