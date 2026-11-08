#!/usr/bin/env bun
/**
 * awvd / reframe.mjs — alat reframe 16:9 ke 9:16: validasi `reframe.json` dan saran titik fokus.
 *
 *   bun scripts/reframe.mjs periksa <reframe.json> [--durasi N] [--json]
 *   bun scripts/reframe.mjs saran <video> [--keluar 1080x1920] [--fps 30] [--out reframe.json]
 *
 * periksa: skema, urutan keyframe, fokus/zoom, teks sumber yang terpotong crop di setiap frame
 * (scripts/reframe.js, sumber tunggal geometri), dan teks keluaran (`teksKeluar`) terhadap area
 * aman 9:16 (areaAmanVertikal di runtime.js). Kode keluar 0 lolos, 2 tidak valid.
 *
 * saran (OPSIONAL): menyarankan titik fokus dari video lokal. Metodenya heuristik tanpa model:
 * ffmpeg menurunkan video ke 96 px keabuan pada 5 sampel per detik; bobot piksel = selisih
 * terhadap sampel sebelumnya (gerak) ditambah gradien lokal (detail); fokus = titik berat
 * bobot, dihaluskan median 5 sampel, lalu disederhanakan menjadi keyframe. Bukan deteksi wajah
 * dan bukan pelacakan objek: hasilnya SARAN yang wajib ditinjau manusia. Tanpa model, tanpa
 * dependensi baru, tanpa jaringan; satu-satunya alat luar adalah ffmpeg dan ffprobe, dan bila
 * tidak terpasang perintah gagal (kode 1) tanpa menulis apa pun (fail-closed).
 * Deterministik pada berkas dan versi ffmpeg yang sama.
 *
 * Karya asli repo ini. Tidak ada kode yang disalin dari proyek lain.
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const muat = createRequire(import.meta.url);
const RF = muat("./reframe.js");
const RT = muat("./runtime.js");

export const VERSI_REFRAME = 1;
/** Parameter heuristik saran; diekspor agar uji dan dokumen merujuk angka yang sama. */
export const PARAMETER_SARAN = Object.freeze({
  sampelPerDetik: 5,
  lebarAnalisis: 96,
  ambangGerak: 8, // selisih keabuan (0..255) di bawahnya dianggap derau
  bobotGerak: 4,
  ambangEnergi: 50, // jumlah bobot minimal; di bawahnya fokus = tengah
  jendelaMedian: 5,
  toleransiKeyframe: 0.04, // selisih fokus (pecahan lebar/tinggi) yang memicu keyframe baru
});

const bulat = (n, d = 3) => { const k = 10 ** d; const v = Math.round(n * k) / k; return v === 0 ? 0 : v; };

// ------------------------------------------------------------ periksa
/** Memeriksa objek reframe lengkap; hasil {ok, galat[], peringatan[]}. */
export function periksaBerkasReframe(data, { durasi } = {}) {
  const h = RF.periksaReframe(data, { durasi });
  const galat = [...h.galat];
  if (data && data.versi !== undefined && data.versi !== VERSI_REFRAME) galat.push(`versi ${data.versi} tidak didukung (harus ${VERSI_REFRAME})`);
  if (data && data.teksKeluar !== undefined && data.keluar && h.galat.every((g) => !/^keluar/.test(g))) {
    if (!Array.isArray(data.teksKeluar)) galat.push("teksKeluar harus larik {x, y, w, h}");
    else {
      try {
        const aman = RT.areaAmanVertikal(data.keluar.lebar, data.keluar.tinggi);
        const a = RF.periksaAreaAman(data.teksKeluar, aman);
        for (const i of a.luar) galat.push(`teksKeluar[${i}] di luar area aman 9:16 (${aman.x},${aman.y} ${aman.w}x${aman.h})`);
      } catch (e) {
        galat.push(e.message.replace(/^reframe: /, ""));
      }
    }
  }
  return { ok: galat.length === 0, galat, peringatan: h.peringatan };
}

// ------------------------------------------------------------ saran
/** Titik berat bobot satu sampel: `cur` dan `prev` keabuan (Uint8Array w*h); prev null = tanpa gerak. */
export function fokusSampel(prev, cur, w, h, P = PARAMETER_SARAN) {
  let total = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = x + 1 < w ? Math.abs(cur[i + 1] - cur[i]) : 0;
      const gy = y + 1 < h ? Math.abs(cur[i + w] - cur[i]) : 0;
      let b = gx + gy;
      if (prev) b += Math.max(0, Math.abs(cur[i] - prev[i]) - P.ambangGerak) * P.bobotGerak;
      total += b; sx += b * (x + 0.5); sy += b * (y + 0.5);
    }
  }
  if (total < P.ambangEnergi) return [0.5, 0.5];
  return [sx / total / w, sy / total / h];
}

const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };

/** Median geser per sumbu; tepi memakai jendela yang menyempit. */
export function haluskan(titik, jendela = PARAMETER_SARAN.jendelaMedian) {
  const m = jendela >> 1;
  return titik.map((_, i) => {
    const potong = titik.slice(Math.max(0, i - m), Math.min(titik.length, i + m + 1));
    return [median(potong.map((p) => p[0])), median(potong.map((p) => p[1]))];
  });
}

/** Titik fokus per sampel menjadi keyframe: keyframe baru bila fokus bergeser > toleransi dari keyframe terakhir. */
export function sederhanakan(titik, fps, P = PARAMETER_SARAN) {
  const frameDi = (i) => Math.round((i / P.sampelPerDetik) * fps);
  const hasil = [];
  const tambah = (i) => {
    const frame = frameDi(i);
    if (hasil.length && hasil[hasil.length - 1].frame >= frame) return; // frame harus naik tegas
    hasil.push({ frame, fokus: [bulat(titik[i][0]), bulat(titik[i][1])], easing: "linear" });
  };
  if (!titik.length) return hasil;
  tambah(0);
  let ref = titik[0];
  for (let i = 1; i < titik.length; i++) {
    if (Math.abs(titik[i][0] - ref[0]) > P.toleransiKeyframe || Math.abs(titik[i][1] - ref[1]) > P.toleransiKeyframe) {
      tambah(i - 1); // sudut sebelum perubahan: gerak baru mulai di sini, bukan dari keyframe lama
      tambah(i);
      ref = titik[i];
    }
  }
  return hasil;
}

async function jalankan(cmd) {
  let p;
  try {
    p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    throw new Error(`${cmd[0]} tidak dapat dijalankan (terpasang dan ada di PATH?): ${e.message}`);
  }
  const [out, err, kode] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`${cmd[0]} gagal (kode ${kode}): ${err.trim().split("\n").slice(-2).join(" ")}`);
  return new Uint8Array(out);
}

/** Saran reframe dari video lokal. Melempar galat bila ffmpeg/ffprobe tidak ada atau berkas tak terbaca. */
export async function sarankanReframe(berkas, { keluar = { lebar: 1080, tinggi: 1920 }, fps = 30 } = {}) {
  const P = PARAMETER_SARAN;
  const probe = JSON.parse(new TextDecoder().decode(await jalankan([
    "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", berkas,
  ])));
  const s = probe.streams && probe.streams[0];
  if (!s || !(s.width > 0) || !(s.height > 0)) throw new Error("berkas tidak memuat trek video yang terbaca");
  const w = P.lebarAnalisis;
  const h = Math.max(2, 2 * Math.round((w * s.height) / s.width / 2));
  const mentah = await jalankan([
    "ffmpeg", "-v", "error", "-nostdin", "-i", berkas, "-an",
    "-vf", `fps=${P.sampelPerDetik},scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-",
  ]);
  const ukuranSampel = w * h, n = Math.floor(mentah.length / ukuranSampel);
  if (n < 1) throw new Error("tidak ada frame yang berhasil didekode");
  const kasar = [];
  for (let i = 0; i < n; i++) {
    const cur = mentah.subarray(i * ukuranSampel, (i + 1) * ukuranSampel);
    const prev = i ? mentah.subarray((i - 1) * ukuranSampel, i * ukuranSampel) : null;
    kasar.push(fokusSampel(prev, cur, w, h));
  }
  const keyframe = sederhanakan(haluskan(kasar), fps);
  const peringatan = [
    "saran heuristik (gerak dan detail), bukan deteksi wajah atau pelacakan objek: wajib ditinjau manusia sebelum dipakai.",
  ];
  if (RF.periksaReframe({ sumber: { lebar: s.width, tinggi: s.height }, keluar, keyframe }).peringatan.length) {
    peringatan.push("sumber dan keluar berasio sama: reframe tidak memotong apa pun.");
  }
  return {
    versi: VERSI_REFRAME,
    sumber: { lebar: s.width, tinggi: s.height },
    keluar,
    fps,
    keyframe,
    saran: { metode: "gerak-dan-detail", sampelPerDetik: P.sampelPerDetik, jumlahSampel: n },
    peringatan,
  };
}

// -------------------------------------------------------------------- CLI
function gagal(pesan, kode = 1) {
  console.error(`reframe: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun scripts/reframe.mjs periksa <reframe.json> [--durasi N] [--json]
  bun scripts/reframe.mjs saran <video> [--keluar 1080x1920] [--fps 30] [--out reframe.json]
periksa  validasi skema, teks sumber yang terpotong crop, dan teksKeluar terhadap area aman 9:16
         (kode keluar 0 lolos, 2 tidak valid); --durasi N: jumlah frame komposisi; --json: keluaran JSON
saran    OPSIONAL: saran titik fokus dari video lokal (heuristik gerak dan detail; butuh ffmpeg dan
         ffprobe; tanpa model). Hasilnya wajib ditinjau manusia. Kode keluar 1 bila alat tidak ada.
Dokumen: docs/reframe.md`;

function bacaUkuran(teks) {
  const m = /^(\d+)x(\d+)$/.exec(teks);
  if (!m || +m[1] < 1 || +m[2] < 1) gagal(`--keluar harus LEBARxTINGGI (mis. 1080x1920): ${teks}`, 2);
  return { lebar: +m[1], tinggi: +m[2] };
}

async function utama() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        durasi: { type: "string" },
        json: { type: "boolean" },
        keluar: { type: "string", default: "1080x1920" },
        fps: { type: "string", default: "30" },
        out: { type: "string", default: "reframe.json" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const { values: o, positionals: [sub, masukan, ...lebih] } = args;
  if (o.help || !sub) { console.log(PETUNJUK); return; }
  if (!masukan || lebih.length) gagal(`harus tepat satu berkas masukan.\n${PETUNJUK}`, 2);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(masukan)) gagal(`"${masukan}" adalah URL; hanya berkas lokal yang diterima.`, 2);
  const berkas = resolve(masukan);
  if (!existsSync(berkas) || !statSync(berkas).isFile()) gagal(`berkas tidak ditemukan: ${masukan}`, 2);

  if (sub === "periksa") {
    let data;
    try { data = JSON.parse(readFileSync(berkas, "utf8")); } catch (e) { gagal(`bukan JSON valid: ${e.message}`, 2); }
    let durasi;
    if (o.durasi !== undefined) {
      durasi = Number(o.durasi);
      if (!Number.isInteger(durasi) || durasi < 1) gagal("--durasi harus bilangan bulat >= 1.", 2);
    }
    const h = periksaBerkasReframe(data, { durasi });
    if (o.json) console.log(JSON.stringify(h, null, 2));
    else {
      for (const g of h.galat) console.error(`galat: ${g}`);
      for (const w of h.peringatan) console.error(`peringatan: ${w}`);
      console.log(h.ok ? `reframe valid (${data.keyframe.length} keyframe)` : `reframe TIDAK valid (${h.galat.length} galat)`);
    }
    process.exit(h.ok ? 0 : 2);
  }
  if (sub === "saran") {
    const fps = Number(o.fps);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) gagal("--fps harus angka > 0 dan <= 240.", 2);
    const keluar = bacaUkuran(o.keluar);
    let hasil;
    try { hasil = await sarankanReframe(berkas, { keluar, fps }); } catch (e) { gagal(e.message, 1); }
    const tujuan = resolve(o.out);
    mkdirSync(dirname(tujuan), { recursive: true });
    writeFileSync(tujuan, `${JSON.stringify(hasil, null, 2)}\n`);
    for (const w of hasil.peringatan) console.error(`peringatan: ${w}`);
    console.log(`${hasil.keyframe.length} keyframe saran dari ${hasil.saran.jumlahSampel} sampel -> ${o.out}`);
    return;
  }
  gagal(`subperintah tidak dikenal: ${sub}\n${PETUNJUK}`, 2);
}

if (import.meta.main) await utama();
