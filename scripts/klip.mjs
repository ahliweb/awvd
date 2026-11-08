#!/usr/bin/env bun
/**
 * awvd / klip.mjs — video di dalam video: validasi manifest sumber, lalu ekstraksi
 * frame klip per nomor frame komposisi ke cache.
 *
 *   bun scripts/klip.mjs <sumber.json> --fps N [--out .cache/awvd/klip]
 *        [--gabung props.json] [--paksa] [--verifikasi] [--bersihkan] [--draf]
 *
 * Alur (semuanya sebelum Chromium diluncurkan; pelanggaran = kode keluar 2):
 *   1. Manifest divalidasi: lisensi yang mengizinkan penggunaan dengan menyebut sumber,
 *      atribusi lengkap, sha256 cocok, lisensiKeluaran untuk ShareAlike.
 *   2. ffprobe: tag matriks warna dan rentang (tak bertag = bt709), sumber HDR ditolak.
 *   3. ffmpeg mengekstrak frame JPEG/PNG pada fps komposisi, satu berkas per nomor
 *      frame, ke cache berkunci (hash berkas + fps + ukuran + rentang + matriks + efek + ...).
 *      Cache hit tidak mengekstrak ulang (--verifikasi: hit hanya bila hash frame cocok meta.json;
 *      --bersihkan: hapus folder cache lama yang tak dipakai manifest ini). Audio klip diekstrak ke audio.wav (tanpa efek).
 *      Efek klip (`klip[].efek`: stabilisasi, chroma key atau hapus latar lokal (segmentasi ORT)
 *      menjadi PNG beralfa, LUT .cube, koreksi warna) diterapkan sekali di tahap ini, bukan per
 *      frame di Chromium; registri efek: lihat EFEK di bawah. Efek yang butuh kemampuan build
 *      ffmpeg (stabil: vidstab) dicek sebelum ekstraksi dan gagal dengan pesan jelas (kode keluar 2).
 *      Efek hapusLatar butuh onnxruntime (AWVD_ORT) dan bobot model (AWVD_MODEL_DIR) yang
 *      diverifikasi sha256: dicek sebelum ffprobe/ffmpeg (fail-closed; 1 = lingkungan, 2 = validasi);
 *      ORT hanya dipanggil saat ekstraksi, render tidak pernah memanggil model (docs/segmentasi-latar.md).
 *   3b. Sumber berlisensi KUTIPAN-WAJAR atau berblok `kutipan` diperiksa kebijakan kutipan
 *      wajar (scripts/kutipan.mjs: batas durasi, proporsi, komentar aktif) dan gerbang hukum
 *      GH; gerbang belum disetujui = kode keluar 2, atau tanda draf dengan --draf.
 *   4. Menulis klip-props.json (daftar klip untuk props komposisi), atribusi.txt
 *      (format TASL), dan bila --gabung: props-gabungan.json.
 *
 * Elemen <video> tidak dipakai: komposisi menggambar frame ke-n klip sebagai fungsi
 * murni dari nomor frame (runtime.js: klipGambar, jalurFrameKlip, kreditKlip).
 * Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { barisRingkasan, dalamCakupan, periksaKutipan } from "./kutipan.mjs";
import {
  BATAS_PIKSEL, BATAS_SISI, GalatSegmentasi, VERSI_SEGMENTASI, buatSegmenter, cariBobot, muatRegistri, pastikanOrt,
  ukuranMasukan, verifikasiBobot,
} from "./segmentasi-lib.js";

const VERSI_SKEMA = 1;
const POLA_ID = /^[a-z0-9][a-z0-9_-]*$/;
const JENIS_FORMAT = ["jpg", "png"];
const TRANSFER_HDR = ["smpte2084", "arib-std-b67"];
// ffprobe color_space -> nilai in_color_matrix filter scale
const MATRIKS = {
  bt709: "bt709", bt470bg: "bt470", smpte170m: "smpte170m", smpte240m: "smpte240m", fcc: "fcc",
  bt2020nc: "bt2020", bt2020c: "bt2020",
};
const PIX_RGB = /^(rgb|bgr|gbr|argb|abgr|rgba|bgra|pal8|gray)/;

// ------------------------------------------------------------------- lisensi
/**
 * Mengurai kode lisensi. Diizinkan: CC-BY-x.y, CC-BY-SA-x.y, CC-BY-NC-x.y,
 * CC-BY-NC-SA-x.y, (varian ND dikenali agar bisa ditolak dengan pesan tepat),
 * CC0-1.0, PDM-1.0, STOK:<penyedia>, KUTIPAN-WAJAR (bukan lisensi: klaim pengecualian hak
 * cipta; wajib blok `kutipan` dan gerbang GH, lihat kutipan.mjs). Selain itu null.
 */
export function uraiLisensi(kode) {
  if (typeof kode !== "string") return null;
  let m = /^CC-BY((?:-NC)?(?:-SA)?(?:-ND)?)-(\d)\.(\d)$/.exec(kode);
  if (m) {
    return {
      jenis: "cc", nc: m[1].includes("-NC"), sa: m[1].includes("-SA"), nd: m[1].includes("-ND"),
      versi: [Number(m[2]), Number(m[3])],
    };
  }
  if (kode === "CC0-1.0") return { jenis: "cc0", nc: false, sa: false, nd: false };
  if (kode === "PDM-1.0") return { jenis: "pdm", nc: false, sa: false, nd: false };
  if (kode === "KUTIPAN-WAJAR") return { jenis: "kutipan", nc: false, sa: false, nd: false };
  m = /^STOK:(.+)$/.exec(kode);
  if (m && m[1].trim()) return { jenis: "stok", penyedia: m[1].trim(), nc: false, sa: false, nd: false };
  return null;
}

export function namaLisensi(kode) {
  const u = uraiLisensi(kode);
  if (!u) return String(kode ?? "");
  if (u.jenis === "cc") {
    return `CC BY${u.nc ? "-NC" : ""}${u.sa ? "-SA" : ""}${u.nd ? "-ND" : ""} ${u.versi[0]}.${u.versi[1]}`;
  }
  if (u.jenis === "cc0") return "CC0 1.0";
  if (u.jenis === "pdm") return "Public Domain Mark 1.0";
  if (u.jenis === "kutipan") return "KUTIPAN-WAJAR"; // sama dengan runtime.js (kode apa adanya)
  return `Lisensi stok ${u.penyedia}`;
}

function urlLisensiBawaan(kode, bukti) {
  const u = uraiLisensi(kode);
  if (!u) return "";
  if (u.jenis === "cc") {
    const unsur = ["by", u.nc ? "nc" : "", u.sa ? "sa" : "", u.nd ? "nd" : ""].filter(Boolean).join("-");
    return `https://creativecommons.org/licenses/${unsur}/${u.versi[0]}.${u.versi[1]}/`;
  }
  if (u.jenis === "cc0") return "https://creativecommons.org/publicdomain/zero/1.0/";
  if (u.jenis === "pdm") return "https://creativecommons.org/publicdomain/mark/1.0/";
  if (u.jenis === "kutipan") return "";
  return /^https?:\/\//i.test(bukti ?? "") ? bukti : "";
}

/** Baris atribusi TASL lengkap; harus sama dengan kreditKlip(klip, { ringkas: false }) di runtime.js. */
export function kreditLengkap(a) {
  let t = "";
  if (!a.tanpaJudul && a.judul) t = `"${a.judul}"`;
  if (!a.penciptaAnonim && a.pencipta) t += (t ? " oleh " : "") + a.pencipta;
  const perubahan = String(a.perubahan ?? "").replace(/[.\s]+$/, "");
  const b = [];
  if (t) b.push(t);
  b.push(`Sumber: ${a.sumberUrl}`);
  b.push(`Lisensi: ${namaLisensi(a.lisensi)}${a.urlLisensi ? ` (${a.urlLisensi})` : ""}`);
  if (perubahan) b.push(`Diubah: ${perubahan}`);
  return `${b.join(". ")}.`;
}

// ------------------------------------------------------------------------ efek
/**
 * Registri efek klip (`klip[].efek`, array; urutan array = urutan penerapan). Tiap jenis efek
 * mendaftarkan: `kunci` (kunci yang sah di manifest), `periksa(e, konteks)` -> pesan galat,
 * `kanonik(e, konteks)` -> objek kanonik untuk kunci cache (null bila efek netral, dibuang dari
 * rantai), dan `saring(kanonik, indeks)` -> { saring: string[] (filter ffmpeg), berkas: [{ nama,
 * sumber }] (berkas yang disalin ke folder kerja ffmpeg supaya jalur tak perlu di-escape) }.
 * `tahap` menentukan di rantai mana efek dipasang, dalam urutan TAHAP: "pra" (sebelum penskalaan,
 * pada frame sumber: stabilisasi), "alfa" (setelah penskalaan, menghasilkan kanal alfa: chroma
 * key; keluaran PNG beralfa) dan "warna" (setelah alfa, di RGB 8 bit; semua efek warna).
 * Kunci opsional entri: `maks` (jumlah maksimal efek jenis itu per klip), `alfa: true` (efek
 * menghasilkan alfa, jadi klip harus berformat PNG), `kemampuan(e, kemampuan)` -> { galat?, peringatan? }
 * (memeriksa kemampuan build ffmpeg yang dideteksi `deteksiKemampuan`, sebelum ekstraksi), dan
 * `saring` boleh mengembalikan `analisis` (filter pass pertama yang dijalankan sebelum ekstraksi,
 * dengan awalan rantai yang sama) dan `alfaDari` ({ berkas, argumen({ k, fps }), saring, kanonik }:
 * masukan tambahan ffmpeg yang menjadi kanal alfa lewat `alphamerge`; `berkas` ada di folder kerja,
 * `argumen` mengembalikan opsi masukan ffmpeg sebelum `-i`, `saring` adalah filter pada masukan itu;
 * berkas dibuat dulu oleh pembuatnya, kini hanya buatMaskBeku untuk hapusLatar, lalu rantai
 * berpindah ke -filter_complex).
 * Dua efek beralfa pada satu klip ditolak (satu sumber alfa). Menambah jenis efek = satu entri di EFEK; tahap baru = satu
 * entri di TAHAP dan satu slot di argsEkstrak.
 */
const TAHAP = ["pra", "alfa", "warna"];
const INTERPOLASI_LUT = ["nearest", "trilinear", "tetrahedral", "pyramid", "prism"];
const BATAS_EFEK = 16;
const POLA_HEX64 = /^[0-9a-f]{64}$/i;
const POLA_WARNA = /^#[0-9a-f]{6}$/i;
const POLA_MODEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAKS_HALUS_MASK = 32;
const BERKAS_MASK = "mask.gray"; // mask beku (gray 8 bit mentah, satu frame berurutan) di folder kerja ekstraksi
const METODE_KUNCI = ["rgb", "yuv"];
const MESIN_STABIL = ["otomatis", "vidstab", "deshake"];
const adaKunci = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const angkaDalam = (v, min, maks) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= maks;
const fmt = (x) => String(Number(x.toFixed(6)));

/**
 * Mengurai berkas LUT .cube (Adobe/Resolve) 3D. Fail-closed seperti ffmpeg: kata kunci tak
 * dikenal, 1D LUT, dan jumlah baris data yang salah ditolak. Mengembalikan { ukuran } atau { galat }.
 */
export function uraiCube(teks) {
  let ukuran = null, data = 0;
  for (const [i, mentah] of teks.split(/\r?\n/).entries()) {
    const baris = mentah.trim();
    if (baris === "" || baris.startsWith("#")) continue;
    const nomor = `baris ${i + 1}`;
    if (/^[-+.\d]/.test(baris)) {
      const bagian = baris.split(/\s+/);
      if (bagian.length !== 3 || bagian.some((x) => !Number.isFinite(Number(x)))) return { galat: `${nomor}: baris data harus tiga bilangan` };
      data++;
      continue;
    }
    const [kata, ...sisa] = baris.split(/\s+/);
    if (kata === "TITLE") continue;
    if (kata === "LUT_1D_SIZE") return { galat: "LUT 1D tidak didukung; pakai LUT 3D (LUT_3D_SIZE)" };
    if (kata === "LUT_3D_SIZE") {
      const n = Number(sisa[0]);
      if (sisa.length !== 1 || !Number.isInteger(n) || n < 2 || n > 256) return { galat: `${nomor}: LUT_3D_SIZE harus bilangan bulat 2..256` };
      if (ukuran !== null) return { galat: `${nomor}: LUT_3D_SIZE ganda` };
      ukuran = n;
      continue;
    }
    if (kata === "DOMAIN_MIN" || kata === "DOMAIN_MAX") {
      if (sisa.length !== 3 || sisa.some((x) => !Number.isFinite(Number(x)))) return { galat: `${nomor}: ${kata} harus tiga bilangan` };
      continue;
    }
    return { galat: `${nomor}: kata kunci "${kata}" tidak dikenal` };
  }
  if (ukuran === null) return { galat: "LUT_3D_SIZE tidak ditemukan" };
  if (data !== ukuran ** 3) return { galat: `LUT_3D_SIZE ${ukuran} butuh ${ukuran ** 3} baris data, berkas memuat ${data}` };
  return { ukuran };
}

const infoLut = new Map(); // jalur mutlak -> { galat } | { ukuran, sha256 } (satu proses, berkas dibaca sekali)
function bacaLut(jalur) {
  let r = infoLut.get(jalur);
  if (!r) {
    const isi = readFileSync(jalur);
    const u = uraiCube(isi.toString("utf8"));
    r = u.galat ? { galat: u.galat } : { ukuran: u.ukuran, sha256: createHash("sha256").update(isi).digest("hex") };
    infoLut.set(jalur, r);
  }
  return r;
}

function periksaTriplet(nilai, nama) {
  if (!Array.isArray(nilai) || nilai.length !== 3 || !nilai.every((x) => angkaDalam(x, -1, 1))) {
    return [`${nama} harus array [merah, hijau, biru] berisi tiga angka -1..1`];
  }
  return [];
}

// Matriks saturasi di ruang RGB ber-gamma: s*I + (1-s)*luma Rec.709 (s=0 = abu-abu murni, s=1 = netral).
const LUMA = [0.2126, 0.7152, 0.0722];
function mixerSaturasi(s) {
  const t = [];
  for (let b = 0; b < 3; b++) for (let k = 0; k < 3; k++) t.push(`${"rgb"[b]}${"rgb"[k]}=${fmt(LUMA[k] * (1 - s) + (b === k ? s : 0))}`);
  return `colorchannelmixer=${t.join(":")}`;
}

const FILTER_VIDSTAB = ["vidstabdetect", "vidstabtransform"];

/**
 * Kemampuan filter build ffmpeg: Set nama filter dari `ffmpeg -filters`. Dipakai efek yang
 * bergantung pada build (stabil: libvidstab). Dibaca sekali per proses, hanya bila perlu.
 */
export async function deteksiKemampuan() {
  const r = await jalankan(["ffmpeg", "-hide_banner", "-filters"]);
  if (r.kode !== 0) throw new Error(`ffmpeg -filters gagal (exit ${r.kode}): ${r.err.trim()}`);
  const nama = new Set();
  for (const baris of r.out.split("\n")) {
    // kolom bendera berbeda antarversi (ffmpeg 6: 3 karakter "T.C"; versi baru bisa lebih panjang)
    const m = /^\s*[A-Z.|]{2,6}\s+([A-Za-z0-9_]+)\s+\S*->\S*/.exec(baris);
    if (m) nama.add(m[1]);
  }
  return nama;
}

/**
 * Memilih mesin stabilisasi dari kemampuan build. `mesin`: "otomatis" (vidstab bila ada, cadangan
 * deshake), "vidstab", atau "deshake". Mengembalikan { mesin, cadangan? } atau { galat }.
 */
export function pilihMesinStabil(mesin, kemampuan) {
  const vidstab = FILTER_VIDSTAB.every((f) => kemampuan.has(f)), deshake = kemampuan.has("deshake");
  const tanpaVidstab = "filter vidstab (vidstabdetect dan vidstabtransform) tidak tersedia di build ffmpeg ini (libvidstab tidak ikut dikompilasi)";
  if (mesin === "vidstab") return vidstab ? { mesin } : { galat: `${tanpaVidstab}; pasang ffmpeg dengan libvidstab, atau pakai "mesin": "deshake" (atau "otomatis")` };
  if (mesin === "deshake") return deshake ? { mesin } : { galat: 'filter deshake tidak tersedia di build ffmpeg ini; pasang ffmpeg yang memuatnya, atau pakai "mesin": "vidstab"' };
  if (vidstab) return { mesin: "vidstab" };
  if (deshake) return { mesin: "deshake", cadangan: `${tanpaVidstab}; memakai deshake (hasil kurang halus dan "halus" diabaikan)` };
  return { galat: `stabilisasi tidak tersedia: ${tanpaVidstab} dan filter deshake juga tidak ada; pasang ffmpeg dengan libvidstab atau deshake` };
}

const EFEK = {
  /**
   * Stabilisasi: vidstab (dua pass: vidstabdetect lalu vidstabtransform) bila build ffmpeg
   * memilikinya, cadangan deshake (satu pass). Dipasang sebelum penskalaan (pada frame sumber
   * setelah `fps`), supaya gerak diperkirakan dan dikoreksi pada resolusi penuh.
   */
  stabil: {
    tahap: "pra",
    maks: 1,
    kunci: ["jenis", "mesin", "goyangan", "halus"],
    periksa(e) {
      const g = [];
      if (e.mesin !== undefined && !MESIN_STABIL.includes(e.mesin)) g.push(`"mesin" harus salah satu dari ${MESIN_STABIL.join(", ")} (bawaan otomatis)`);
      if (e.goyangan !== undefined && !(Number.isInteger(e.goyangan) && e.goyangan >= 1 && e.goyangan <= 10)) g.push('"goyangan" harus bilangan bulat 1..10 (bawaan 5)');
      if (e.halus !== undefined && !(Number.isInteger(e.halus) && e.halus >= 1 && e.halus <= 100)) g.push('"halus" harus bilangan bulat 1..100 (jumlah frame di tiap sisi; bawaan 15)');
      if (e.mesin === "deshake" && e.halus !== undefined) g.push('"halus" hanya berlaku untuk mesin vidstab');
      return g;
    },
    kemampuan(e, kemampuan) {
      const p = pilihMesinStabil(e.mesin ?? "otomatis", kemampuan);
      return p.galat ? { galat: p.galat } : p.cadangan ? { peringatan: p.cadangan } : {};
    },
    kanonik(e, { kemampuan }) {
      if (!kemampuan) throw new Error("efek stabil butuh kemampuan ffmpeg (deteksiKemampuan) untuk memilih mesin");
      const p = pilihMesinStabil(e.mesin ?? "otomatis", kemampuan);
      if (p.galat) throw new Error(p.galat);
      const c = { jenis: "stabil", mesin: p.mesin, goyangan: e.goyangan ?? 5 };
      if (p.mesin === "vidstab") c.halus = e.halus ?? 15;
      return c;
    },
    saring(c) {
      if (c.mesin === "vidstab") {
        // jejak gerak ditulis pass pertama ke berkas relatif di folder kerja ekstraksi (dihapus sesudahnya)
        return {
          analisis: [`vidstabdetect=shakiness=${c.goyangan}:accuracy=15:result=stabil.trf`],
          saring: [`vidstabtransform=input=stabil.trf:smoothing=${c.halus}`], berkas: [],
        };
      }
      // deshake: rx dan ry harus kelipatan 16 (maksimal 64); goyangan 1..10 -> 16, 32, 48, 64 piksel
      const rx = 16 * Math.min(4, Math.ceil(c.goyangan / 2.5));
      return { saring: [`deshake=rx=${rx}:ry=${rx}`], berkas: [] };
    },
  },

  /**
   * Chroma key: warna latar menjadi transparan (kanal alfa), keluaran PNG beralfa. Dipasang
   * setelah penskalaan dan sebelum efek warna, jadi `warna` kunci mengacu ke warna sumber, bukan
   * hasil koreksi. `rgb` memakai colorkey (jarak di RGB); `yuv` memakai chromakey (jarak pada
   * kroma saja, lebih tahan terhadap perbedaan terang latar), dan hanya mengambil kanal alfanya
   * sehingga RGB subjek tidak berubah oleh konversi YUV.
   */
  kunciWarna: {
    tahap: "alfa",
    maks: 1,
    alfa: true,
    kunci: ["jenis", "warna", "toleransi", "halus", "metode"],
    periksa(e) {
      const g = [];
      if (typeof e.warna !== "string" || !POLA_WARNA.test(e.warna)) g.push('"warna" (warna latar, #rrggbb) wajib');
      if (e.toleransi !== undefined && !angkaDalam(e.toleransi, 0.01, 1)) g.push('"toleransi" harus angka 0.01..1 (bawaan 0.3)');
      if (e.halus !== undefined && !angkaDalam(e.halus, 0, 1)) g.push('"halus" harus angka 0..1 (kelembutan tepi; bawaan 0.1)');
      if (e.metode !== undefined && !METODE_KUNCI.includes(e.metode)) g.push(`"metode" harus salah satu dari ${METODE_KUNCI.join(", ")} (bawaan rgb)`);
      return g;
    },
    kanonik(e) {
      return { jenis: "kunciWarna", warna: e.warna.toLowerCase(), toleransi: e.toleransi ?? 0.3, halus: e.halus ?? 0.1, metode: e.metode ?? "rgb" };
    },
    saring(c) {
      const warna = `0x${c.warna.slice(1)}`, opsi = `color=${warna}:similarity=${fmt(c.toleransi)}:blend=${fmt(c.halus)}`;
      if (c.metode === "rgb") return { saring: ["format=rgba", `colorkey=${opsi}`], berkas: [] };
      // alfa dari salinan YUV 4:4:4, digabung kembali ke RGB asli
      return {
        saring: ["format=rgba", "split[a][b];[a]format=yuva444p", `chromakey=${opsi}`, "alphaextract[m];[b][m]alphamerge"],
        berkas: [],
      };
    },
  },

  /**
   * Hapus latar tanpa layar warna: segmentasi orang LOKAL (onnxruntime lewat scripts/segmentasi-lib.js,
   * model registri bersha256) membekukan mask per frame saat ekstraksi, lalu `alphamerge` memasangnya
   * sebagai kanal alfa; keluaran PNG RGBA seperti kunciWarna. Render tidak pernah memanggil model.
   * Model berjalan pada frame ukuran klip (setelah `pra` dan penskalaan, sama dengan frame yang
   * di-cache), jadi mask dan warna berasal dari piksel yang sama. Urutan mask: model, ambang (smoothstep),
   * EMA temporal (di segmentasi-lib), lalu `halus` (feather: boxblur pada mask). Kunci cache memuat
   * parameter kanonik, sha256 bobot, versi ORT, dan versi pra/pasca-proses.
   */
  hapusLatar: {
    tahap: "alfa",
    maks: 1,
    alfa: true,
    kunci: ["jenis", "model", "ukuranInput", "halus", "ambang", "ema"],
    periksa(e, { klip }) {
      const g = [];
      if (typeof e.model !== "string" || !POLA_MODEL.test(e.model)) g.push('"model" (id model segmentasi di registri, mis. "modnet" atau "selfie") wajib');
      if (e.ukuranInput !== undefined) {
        const u = e.ukuranInput, bulat = (x) => Number.isInteger(x) && x > 0;
        if (!(bulat(u) || (Array.isArray(u) && u.length === 2 && u.every(bulat)))) g.push('"ukuranInput" harus bilangan bulat positif (sisi panjang) atau [lebar, tinggi]; rentang dan kelipatan mengikuti model');
      }
      if (e.halus !== undefined && !(Number.isInteger(e.halus) && e.halus >= 0 && e.halus <= MAKS_HALUS_MASK)) g.push(`"halus" harus bilangan bulat 0..${MAKS_HALUS_MASK} (radius feather tepi mask dalam piksel klip; bawaan 0)`);
      if (e.ambang !== undefined) {
        const a = e.ambang;
        if (!(Array.isArray(a) && a.length === 2 && a.every((x) => angkaDalam(x, 0, 1)) && a[0] < a[1])) g.push('"ambang" harus [rendah, tinggi] dengan 0 <= rendah < tinggi <= 1');
      }
      if (e.ema !== undefined && !(angkaDalam(e.ema, 0, 1) && e.ema > 0)) g.push('"ema" harus angka di atas 0 dan paling besar 1 (bobot frame baru; bawaan 1 = tanpa pelicinan)');
      if (klip && bulatPositif(klip.lebar) && bulatPositif(klip.tinggi)) {
        if (klip.lebar > BATAS_SISI || klip.tinggi > BATAS_SISI || klip.lebar * klip.tinggi > BATAS_PIKSEL) {
          g.push(`ukuran klip ${klip.lebar}x${klip.tinggi} melebihi batas segmentasi (maks ${BATAS_SISI} per sisi dan ${BATAS_PIKSEL} piksel)`);
        }
        if (Number.isInteger(e.halus) && e.halus > 0 && e.halus * 2 > Math.min(klip.lebar, klip.tinggi)) {
          g.push(`"halus" ${e.halus} terlalu besar untuk klip ${klip.lebar}x${klip.tinggi} (maks setengah sisi terpendek)`);
        }
      }
      return g;
    },
    kanonik(e, { klip, segmentasi }) {
      const s = segmentasi?.get(e.model);
      if (!s) throw new Error(`efek hapusLatar butuh info segmentasi untuk model "${e.model}" (siapkanSegmentasi) untuk kunci cache`);
      return {
        jenis: "hapusLatar", model: e.model, ukuranInput: ukuranMasukan(s.spec, klip.lebar, klip.tinggi, e.ukuranInput ?? null),
        halus: e.halus ?? 0, ambang: e.ambang ?? null, ema: e.ema ?? 1,
        sha256: s.info.sha256, versiOrt: s.info.versiOrt, versiSegmentasi: VERSI_SEGMENTASI, spek: kunciCache({ masukan: s.spec.masukan, keluaran: s.spec.keluaran ?? null }),
      };
    },
    saring(c) {
      // saring (rantai utama) kosong: kanal alfa datang dari masukan kedua yang dibuat buatMaskBeku
      const mask = ["format=gray"];
      if (c.halus > 0) mask.push(`boxblur=luma_radius=${c.halus}:luma_power=2`);
      const argumen = ({ k, fps }) => ["-f", "rawvideo", "-pixel_format", "gray", "-video_size", `${k.lebar}x${k.tinggi}`, "-framerate", String(fps)];
      return { saring: [], berkas: [], alfaDari: { berkas: BERKAS_MASK, argumen, saring: mask, kanonik: c } };
    },
  },

  /** LUT 3D .cube lewat lut3d. */
  lut: {
    tahap: "warna",
    kunci: ["jenis", "berkas", "sha256", "interpolasi"],
    periksa(e, { dirManifest }) {
      const g = [];
      if (!adaTeks(e.berkas)) return ['"berkas" (jalur .cube) wajib'];
      if (extname(e.berkas).toLowerCase() !== ".cube") g.push(`"berkas" harus berekstensi .cube: ${e.berkas}`);
      if (e.sha256 !== undefined && !(typeof e.sha256 === "string" && POLA_HEX64.test(e.sha256))) g.push('"sha256" harus 64 digit heksadesimal');
      if (e.interpolasi !== undefined && !INTERPOLASI_LUT.includes(e.interpolasi)) g.push(`"interpolasi" harus salah satu dari ${INTERPOLASI_LUT.join(", ")}`);
      if (g.length) return g;
      const jalur = mutlak(dirManifest, e.berkas);
      if (!existsSync(jalur) || !statSync(jalur).isFile()) return [`berkas LUT tidak ditemukan: ${e.berkas}`];
      const r = bacaLut(jalur);
      if (r.galat) return [`LUT ${e.berkas} tidak valid: ${r.galat}`];
      if (e.sha256 !== undefined && r.sha256 !== e.sha256.toLowerCase()) {
        return [`hash LUT tidak cocok: sha256 ${e.berkas} adalah ${r.sha256}, manifest menulis ${e.sha256.toLowerCase()}`];
      }
      return [];
    },
    kanonik(e, { dirManifest }) {
      const jalur = mutlak(dirManifest, e.berkas);
      return { jenis: "lut", sha256: bacaLut(jalur).sha256, interpolasi: e.interpolasi ?? "tetrahedral", jalur };
    },
    saring(c, i) {
      const nama = `lut${i}.cube`;
      return { saring: [`lut3d=file=${nama}:interp=${c.interpolasi}`], berkas: [{ nama, sumber: c.jalur }] };
    },
  },

  /** Kecerahan, kontras, saturasi, gamma; matematika RGB 8 bit (lutrgb dan colorchannelmixer). */
  warna: {
    tahap: "warna",
    kunci: ["jenis", "kecerahan", "kontras", "saturasi", "gamma"],
    periksa(e) {
      const g = [];
      if (e.kecerahan !== undefined && !angkaDalam(e.kecerahan, -1, 1)) g.push('"kecerahan" harus angka -1..1 (bawaan 0)');
      if (e.kontras !== undefined && !angkaDalam(e.kontras, 0, 4)) g.push('"kontras" harus angka 0..4 (bawaan 1)');
      if (e.saturasi !== undefined && !angkaDalam(e.saturasi, 0, 4)) g.push('"saturasi" harus angka 0..4 (bawaan 1; 0 = abu-abu)');
      if (e.gamma !== undefined && !angkaDalam(e.gamma, 0.1, 10)) g.push('"gamma" harus angka 0.1..10 (bawaan 1; >1 mencerahkan tengah)');
      if (e.kecerahan === undefined && e.kontras === undefined && e.saturasi === undefined && e.gamma === undefined) {
        g.push('efek "warna" butuh sedikitnya satu dari kecerahan, kontras, saturasi, gamma');
      }
      return g;
    },
    kanonik(e) {
      const c = { jenis: "warna", kecerahan: e.kecerahan ?? 0, kontras: e.kontras ?? 1, saturasi: e.saturasi ?? 1, gamma: e.gamma ?? 1 };
      return c.kecerahan === 0 && c.kontras === 1 && c.saturasi === 1 && c.gamma === 1 ? null : c;
    },
    saring(c) {
      const saring = [];
      if (c.kecerahan !== 0 || c.kontras !== 1 || c.gamma !== 1) {
        // gamma, lalu kontras terhadap abu-abu tengah, lalu kecerahan; nilai dijepit ke 0..1
        let x = "val/maxval";
        if (c.gamma !== 1) x = `pow(${x},${fmt(1 / c.gamma)})`;
        if (c.kontras !== 1) x = `(${x}-0.5)*${fmt(c.kontras)}+0.5`;
        if (c.kecerahan !== 0) x = `${x}+${fmt(c.kecerahan)}`;
        const ekspresi = `'clip(${x},0,1)*maxval'`;
        saring.push(`lutrgb=r=${ekspresi}:g=${ekspresi}:b=${ekspresi}`);
      }
      if (c.saturasi !== 1) saring.push(mixerSaturasi(c.saturasi));
      return { saring, berkas: [] };
    },
  },

  /** Keseimbangan warna bayangan/tengah/sorotan lewat colorbalance. */
  keseimbangan: {
    tahap: "warna",
    kunci: ["jenis", "bayangan", "tengah", "sorotan", "jagaTerang"],
    periksa(e) {
      const g = [];
      for (const k of ["bayangan", "tengah", "sorotan"]) if (e[k] !== undefined) g.push(...periksaTriplet(e[k], `"${k}"`));
      if (e.jagaTerang !== undefined && typeof e.jagaTerang !== "boolean") g.push('"jagaTerang" harus true atau false');
      if (e.bayangan === undefined && e.tengah === undefined && e.sorotan === undefined) {
        g.push('efek "keseimbangan" butuh sedikitnya satu dari bayangan, tengah, sorotan');
      }
      return g;
    },
    kanonik(e) {
      const c = {
        jenis: "keseimbangan", bayangan: e.bayangan ?? [0, 0, 0], tengah: e.tengah ?? [0, 0, 0],
        sorotan: e.sorotan ?? [0, 0, 0], jagaTerang: e.jagaTerang === true,
      };
      return [...c.bayangan, ...c.tengah, ...c.sorotan].every((x) => x === 0) ? null : c;
    },
    saring(c) {
      const t = [];
      for (const [kunci, awal] of [["bayangan", "s"], ["tengah", "m"], ["sorotan", "h"]]) {
        c[kunci].forEach((x, i) => { if (x !== 0) t.push(`${"rgb"[i]}${awal}=${fmt(x)}`); });
      }
      if (c.jagaTerang) t.push("pl=1");
      return { saring: [`colorbalance=${t.join(":")}`], berkas: [] };
    },
  },
};

/**
 * Pesan galat untuk `klip[].efek` (tanpa ffmpeg; berkas LUT dibaca dan diurai). `klip` (opsional)
 * memberi ukuran klip untuk efek yang membutuhkannya (hapusLatar).
 */
export function periksaEfek(efek, dirManifest, klip = null) {
  if (!Array.isArray(efek)) return ['"efek" harus array objek'];
  const galat = [];
  let efekAlfa = null; // { i, jenis } efek beralfa pertama: dua sumber alfa ditolak
  if (efek.length > BATAS_EFEK) galat.push(`"efek" maksimal ${BATAS_EFEK} butir (dapat ${efek.length})`);
  const hitung = {};
  for (const [i, e] of efek.entries()) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) { galat.push(`efek[${i}]: harus objek`); continue; }
    const def = adaKunci(EFEK, e.jenis) ? EFEK[e.jenis] : null;
    if (!def) { galat.push(`efek[${i}]: jenis ${JSON.stringify(e.jenis)} tidak dikenal; yang ada: ${Object.keys(EFEK).join(", ")}`); continue; }
    const nama = `efek[${i}] (${e.jenis})`;
    hitung[e.jenis] = (hitung[e.jenis] ?? 0) + 1;
    if (def.maks && hitung[e.jenis] > def.maks) { galat.push(`${nama}: maksimal ${def.maks} efek ${e.jenis} per klip`); continue; }
    if (def.alfa) {
      if (efekAlfa) { galat.push(`${nama}: tidak boleh digabung dengan efek[${efekAlfa.i}] (${efekAlfa.jenis}): keduanya menghasilkan kanal alfa, dan satu klip hanya boleh punya satu sumber alfa`); continue; }
      efekAlfa = { i, jenis: e.jenis };
    }
    const asing = Object.keys(e).filter((k) => !def.kunci.includes(k));
    if (asing.length) { galat.push(`${nama}: kunci tidak dikenal: ${asing.join(", ")} (sah: ${def.kunci.join(", ")})`); continue; }
    for (const p of def.periksa(e, { dirManifest, klip })) galat.push(`${nama}: ${p}`);
  }
  return galat;
}

/** Apakah ada klip yang memakai efek yang bergantung pada kemampuan build ffmpeg. */
export function perluKemampuan(manifest) {
  return (manifest.klip ?? []).some((k) => (k.efek ?? []).some((e) => EFEK[e.jenis]?.kemampuan));
}

/**
 * Memeriksa efek yang bergantung pada build ffmpeg terhadap `kemampuan` (Set dari
 * deteksiKemampuan) untuk manifest yang sudah lolos validasi. Mengembalikan { galat[], peringatan[] }.
 */
export function periksaKemampuanEfek(manifest, kemampuan) {
  const galat = [], peringatan = [];
  for (const k of manifest.klip ?? []) {
    for (const [i, e] of (k.efek ?? []).entries()) {
      const def = EFEK[e.jenis];
      if (!def?.kemampuan) continue;
      const r = def.kemampuan(e, kemampuan);
      if (r.galat) galat.push(`klip "${k.id}": efek[${i}] (${e.jenis}): ${r.galat}`);
      if (r.peringatan) peringatan.push(`klip "${k.id}": efek[${i}] (${e.jenis}): ${r.peringatan}`);
    }
  }
  return { galat, peringatan };
}

/** Format berkas frame klip: PNG bila ada efek beralfa (chroma key) dan format tak ditulis; bila tidak, jpg. */
export function formatKlip(k) {
  return k.format ?? ((k.efek ?? []).some((e) => EFEK[e.jenis]?.alfa) ? "png" : "jpg");
}

/**
 * Efek klip yang sudah lolos periksaEfek -> { kanonik[] (untuk kunci cache), pra[], alfa[], warna[]
 * (filter per tahap), analisis[] (filter pass pertama), berkas[], alfaDari (masukan alfa tambahan
 * atau null) }. Efek netral dibuang; urutan antar-tahap mengikuti TAHAP, dalam tahap mengikuti array.
 * `kemampuan` (Set dari deteksiKemampuan) wajib bila ada efek yang bergantung pada build ffmpeg
 * (stabil). `konteks` { klip, segmentasi } wajib bila ada hapusLatar: `segmentasi` = Map id model ->
 * { spec, info } dari siapkanSegmentasi (sha256 bobot dan versi ORT masuk kunci cache).
 */
export function rakitEfek(efek, dirManifest, kemampuan, konteks = {}) {
  const hasil = { kanonik: [], pra: [], alfa: [], warna: [], analisis: [], berkas: [], alfaDari: null };
  const urut = (efek ?? []).map((e, i) => ({ e, i })).sort((a, b) => TAHAP.indexOf(EFEK[a.e.jenis].tahap) - TAHAP.indexOf(EFEK[b.e.jenis].tahap) || a.i - b.i);
  for (const { e } of urut) {
    const def = EFEK[e.jenis];
    const c = def.kanonik(e, { dirManifest, kemampuan, ...konteks });
    if (!c) continue;
    const { saring, berkas, analisis, alfaDari } = def.saring(c, hasil.berkas.length);
    hasil[def.tahap].push(...saring);
    hasil.analisis.push(...(analisis ?? []));
    hasil.berkas.push(...berkas);
    if (alfaDari) hasil.alfaDari = alfaDari;
    const { jalur, ...bersih } = c; // jalur mutlak tidak ikut kunci cache; isinya diwakili sha256
    hasil.kanonik.push(bersih);
  }
  return hasil;
}

/** Apakah ada klip yang memakai efek hapusLatar (butuh ORT dan bobot model). */
export function adaHapusLatar(manifest) {
  return (manifest.klip ?? []).some((k) => Array.isArray(k.efek) && k.efek.some((e) => e?.jenis === "hapusLatar"));
}

/**
 * Menyiapkan segmentasi untuk manifest yang sudah lolos validasi skema, SEBELUM ffprobe/ffmpeg:
 * registri model (bawaan + AWVD_REGISTRI_SEGMENTASI), model dikenal, parameter yang bergantung model
 * (ukuranInput), ORT termuat (AWVD_ORT), dan bobot (AWVD_MODEL_DIR) cocok ukuran dan sha256 (model
 * registri: fail-closed). Mengembalikan { info: Map id -> { spec, info }, galat[] (kode keluar 2),
 * peringatan[] }, atau melempar GalatSegmentasi (`keluar` 1 = lingkungan, 2 = validasi). Tanpa efek
 * hapusLatar: kosong, tanpa menyentuh registri maupun ORT.
 */
export function siapkanSegmentasi(manifest, env = process.env) {
  const info = new Map(), galat = [], peringatan = [];
  const dipakai = new Set();
  for (const k of manifest.klip ?? []) for (const e of Array.isArray(k.efek) ? k.efek : []) if (e?.jenis === "hapusLatar") dipakai.add(e.model);
  if (dipakai.size === 0) return { info, galat, peringatan };
  const reg = muatRegistri({ env });
  peringatan.push(...reg.peringatan);
  for (const id of dipakai) {
    if (!reg.model[id]) galat.push(`efek hapusLatar: model "${id}" tidak dikenal; yang tersedia: ${Object.keys(reg.model).join(", ")}`);
  }
  for (const k of manifest.klip) {
    for (const [i, e] of (Array.isArray(k.efek) ? k.efek : []).entries()) {
      const spec = e?.jenis === "hapusLatar" ? reg.model[e.model] : null;
      if (!spec) continue;
      try { ukuranMasukan(spec, k.lebar, k.tinggi, e.ukuranInput ?? null); } catch (x) {
        if (!(x instanceof GalatSegmentasi)) throw x;
        galat.push(`klip "${k.id}": efek[${i}] (hapusLatar): ${x.message}`);
      }
    }
  }
  if (galat.length) return { info, galat, peringatan };
  const { versi } = pastikanOrt(env);
  for (const id of dipakai) {
    const spec = reg.model[id];
    const bobot = verifikasiBobot(id, spec, cariBobot(id, spec, { env }), { peringatan });
    info.set(id, {
      spec,
      info: {
        model: id, nama: spec.nama, sha256: bobot.sha256, ukuranByte: bobot.ukuranByte, kustom: spec.kustom === true,
        lisensiKode: spec.lisensiKode, lisensiBobot: spec.lisensiBobot, versiOrt: versi, versiSegmentasi: VERSI_SEGMENTASI, lokal: true,
      },
    });
  }
  return { info, galat, peringatan };
}

// ---------------------------------------------------------------- validasi
const adaTeks = (v) => typeof v === "string" && v.trim() !== "";
const bulatPositif = (v) => Number.isInteger(v) && v > 0;
function urlHttp(v) {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
const mutlak = (dir, p) => (isAbsolute(p) ? p : resolve(dir, p));

export function sha256Berkas(berkas) {
  return new Promise((selesai, gagalKe) => {
    const h = createHash("sha256");
    createReadStream(berkas).on("data", (d) => h.update(d)).on("end", () => selesai(h.digest("hex"))).on("error", gagalKe);
  });
}

/**
 * Validasi manifest tanpa ffprobe/ffmpeg. Mengembalikan { galat[], peringatan[], hash }
 * dengan hash = { idSumber: sha256 nyata }. Semua pelanggaran dikumpulkan sekaligus.
 */
export async function validasiManifest(manifest, dirManifest) {
  const galat = [], peringatan = [], hash = {};
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { galat: ["manifest harus objek JSON"], peringatan, hash };
  }
  const proyek = manifest.proyek;
  let komersial = true;
  if (proyek === null || typeof proyek !== "object" || Array.isArray(proyek)) {
    galat.push('proyek: objek { "tujuan": "komersial"|"nonkomersial", "lisensiKeluaran"? } wajib ada');
  } else if (proyek.tujuan !== "komersial" && proyek.tujuan !== "nonkomersial") {
    galat.push(`proyek.tujuan wajib "komersial" atau "nonkomersial" (dapat ${JSON.stringify(proyek.tujuan)})`);
  } else {
    komersial = proyek.tujuan === "komersial";
  }
  const lisensiKeluaran = proyek && typeof proyek === "object" ? proyek.lisensiKeluaran : undefined;

  const sumber = Array.isArray(manifest.sumber) ? manifest.sumber : null;
  if (!sumber || sumber.length === 0) galat.push("sumber: array tidak kosong wajib ada");
  const idSumber = new Set();
  const lisensiSA = []; // { id, lisensi, u }
  for (const [i, s] of (sumber ?? []).entries()) {
    const nama = s && typeof s === "object" && adaTeks(s.id) ? `sumber "${s.id}"` : `sumber[${i}]`;
    const g = (pesan) => galat.push(`${nama}: ${pesan}`);
    if (s === null || typeof s !== "object" || Array.isArray(s)) { g("harus objek"); continue; }
    if (!adaTeks(s.id) || !POLA_ID.test(s.id)) g("id wajib (huruf kecil, angka, - atau _)");
    else if (idSumber.has(s.id)) g("id ganda");
    else idSumber.add(s.id);

    // lisensi
    if (!adaTeks(s.lisensi)) {
      g("lisensi kosong ditolak; isi CC-BY-x.y, CC-BY-SA-x.y, CC0-1.0, PDM-1.0, atau STOK:<penyedia>");
    } else {
      const u = uraiLisensi(s.lisensi);
      if (!u) {
        g(`lisensi "${s.lisensi}" tidak dikenal; yang diizinkan: CC-BY-x.y, CC-BY-SA-x.y, CC0-1.0, PDM-1.0, STOK:<penyedia>, KUTIPAN-WAJAR (blok kutipan + gerbang GH) (CC-BY-NC-* hanya bila tujuan nonkomersial)`);
      } else if (u.nd) {
        g(`lisensi ${s.lisensi} (ND) ditolak: ND tidak mengizinkan adaptasi, dan frame klip dibuat ulang (di-resample, dipotong, ditimpa elemen komposisi)`);
      } else if (u.nc && komersial) {
        g(`lisensi ${s.lisensi} (NC) ditolak untuk proyek komersial; ubah proyek.tujuan menjadi "nonkomersial" bila memang tidak komersial`);
      } else {
        if (u.jenis === "stok" && !adaTeks(s.bukti)) {
          g(`lisensi ${s.lisensi} wajib disertai "bukti" (berkas atau URL lisensi tertulis dari penyedia)`);
        }
        if (u.sa) lisensiSA.push({ id: s.id, lisensi: s.lisensi, u });
      }
    }

    // atribusi
    if (!adaTeks(s.judul) && s.tanpaJudul !== true) g('atribusi kosong: "judul" wajib (atau tanpaJudul: true bila memang tidak ada)');
    if (!adaTeks(s.pencipta) && s.penciptaAnonim !== true) g('atribusi kosong: "pencipta" wajib (atau penciptaAnonim: true bila pencipta anonim)');
    if (!adaTeks(s.sumberUrl)) g('atribusi kosong: "sumberUrl" wajib');
    else if (!urlHttp(s.sumberUrl)) g(`sumberUrl bukan URL http(s) yang valid: ${s.sumberUrl}`);
    if (!adaTeks(s.perubahan)) g('"perubahan" wajib (pernyataan modifikasi; mis. "dipotong 00:12-00:20; diperkecil; dibuat ulang per frame")');
    if (adaTeks(s.bukti) && !/^https?:\/\//i.test(s.bukti) && !existsSync(mutlak(dirManifest, s.bukti))) {
      g(`bukti tidak ditemukan: ${s.bukti}`);
    }

    // berkas + hash
    if (!adaTeks(s.berkas)) {
      g('"berkas" wajib');
    } else {
      const p = mutlak(dirManifest, s.berkas);
      if (!existsSync(p) || !statSync(p).isFile()) g(`berkas tidak ditemukan: ${s.berkas}`);
      else if (typeof s.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(s.sha256)) g('"sha256" wajib (64 digit heksadesimal)');
      else {
        const nyata = await sha256Berkas(p);
        hash[s.id] = nyata;
        if (nyata !== s.sha256.toLowerCase()) g(`hash tidak cocok: sha256 ${s.berkas} adalah ${nyata}, manifest menulis ${s.sha256.toLowerCase()}`);
      }
    }
  }

  // ShareAlike: keluaran harus dilisensikan SA kompatibel (konservatif: klip yang
  // di-resample, dipotong, dan ditimpa elemen komposisi diperlakukan sebagai Adapted Material).
  if (lisensiSA.length) {
    const daftar = lisensiSA.map((x) => `"${x.id}" (${x.lisensi})`).join(", ");
    const adaNcSa = lisensiSA.some((x) => x.u.nc);
    const adaBySa = lisensiSA.some((x) => !x.u.nc);
    if (adaNcSa && adaBySa) {
      galat.push(`ShareAlike tidak kompatibel: sumber ${daftar} mencampur BY-SA dan BY-NC-SA, tidak ada satu lisensi keluaran yang memenuhi keduanya`);
    } else {
      const perlu = adaNcSa ? "CC-BY-NC-SA" : "CC-BY-SA";
      const versiMin = lisensiSA.reduce((a, x) => (x.u.versi[0] * 100 + x.u.versi[1] > a ? x.u.versi[0] * 100 + x.u.versi[1] : a), 0);
      const m = adaTeks(lisensiKeluaran) ? new RegExp(`^${perlu}-(\\d)\\.(\\d)$`).exec(lisensiKeluaran) : null;
      if (!adaTeks(lisensiKeluaran)) {
        galat.push(`proyek.lisensiKeluaran wajib diisi ${perlu}-x.y (versi >= sumber) karena ada sumber ShareAlike: ${daftar}`);
      } else if (!m) {
        galat.push(`proyek.lisensiKeluaran "${lisensiKeluaran}" tidak kompatibel dengan ShareAlike sumber ${daftar}; pakai ${perlu}-x.y`);
      } else if (Number(m[1]) * 100 + Number(m[2]) < versiMin) {
        galat.push(`proyek.lisensiKeluaran "${lisensiKeluaran}" lebih lama daripada versi lisensi sumber ShareAlike ${daftar}`);
      }
    }
  }

  // klip
  const klip = Array.isArray(manifest.klip) ? manifest.klip : null;
  if (!klip || klip.length === 0) galat.push("klip: array tidak kosong wajib ada (id, sumber, lebar, tinggi, dari, panjang)");
  const idKlip = new Set(), dipakai = new Set();
  for (const [i, k] of (klip ?? []).entries()) {
    const nama = k && typeof k === "object" && adaTeks(k.id) ? `klip "${k.id}"` : `klip[${i}]`;
    const g = (pesan) => galat.push(`${nama}: ${pesan}`);
    if (k === null || typeof k !== "object" || Array.isArray(k)) { g("harus objek"); continue; }
    if (!adaTeks(k.id) || !POLA_ID.test(k.id)) g("id wajib (huruf kecil, angka, - atau _)");
    else if (idKlip.has(k.id)) g("id ganda");
    else idKlip.add(k.id);
    if (!adaTeks(k.sumber) || !idSumber.has(k.sumber)) g(`sumber "${k.sumber}" tidak ada di daftar sumber`);
    else dipakai.add(k.sumber);
    if (!bulatPositif(k.lebar) || !bulatPositif(k.tinggi)) g("lebar dan tinggi wajib bilangan bulat positif (ukuran tampil x skala render)");
    if (k.dari !== undefined && !(typeof k.dari === "number" && k.dari >= 0)) g("dari (detik) harus angka >= 0");
    if (k.panjang !== undefined && !(typeof k.panjang === "number" && k.panjang > 0)) g("panjang (detik) harus angka > 0");
    if (k.format !== undefined && !JENIS_FORMAT.includes(k.format)) g(`format harus salah satu dari ${JENIS_FORMAT.join(", ")}`);
    if (k.kualitas !== undefined && !(Number.isInteger(k.kualitas) && k.kualitas >= 1 && k.kualitas <= 31)) g("kualitas (q:v JPEG, 1 terbaik) harus bilangan bulat 1..31");
    if (k.efek !== undefined) {
      for (const pesan of periksaEfek(k.efek, dirManifest, k)) g(pesan);
      if (k.format === "jpg" && Array.isArray(k.efek)) {
        for (const [i, e] of k.efek.entries()) {
          if (e && EFEK[e.jenis]?.alfa) g(`efek[${i}] (${e.jenis}): menghasilkan kanal alfa, tetapi format "jpg" tidak mendukung alfa; pakai "format": "png" atau hapus "format" (otomatis png)`);
        }
      }
    }
  }
  for (const id of idSumber) if (!dipakai.has(id) && klip && klip.length) peringatan.push(`sumber "${id}" tidak dipakai klip mana pun`);
  return { galat, peringatan, hash };
}

// --------------------------------------------------------------- ffprobe/ffmpeg
async function jalankan(cmd, cwd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...(cwd ? { cwd } : {}) });
  const [out, err, kode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, kode };
}

async function versiFfmpeg() {
  const r = await jalankan(["ffmpeg", "-version"]);
  const m = /ffmpeg version (\S+)/.exec(r.out);
  return m ? m[1] : "tidak-diketahui";
}

/** ffprobe sumber: dimensi tampil, tag warna, durasi, ada audio. */
export async function probeSumber(berkas) {
  const r = await jalankan(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", berkas]);
  if (r.kode !== 0) throw new Error(`ffprobe gagal untuk ${berkas}: ${r.err.trim()}`);
  const j = JSON.parse(r.out);
  const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) return { galat: "tidak ada trek video" };
  const rot = Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0);
  const putar = Math.abs(rot) % 180 === 90;
  const sar = /^(\d+):(\d+)$/.exec(v.sample_aspect_ratio ?? "");
  const sarNilai = sar && Number(sar[1]) > 0 && Number(sar[2]) > 0 ? Number(sar[1]) / Number(sar[2]) : 1;
  let lebar = Number(v.width) * sarNilai, tinggi = Number(v.height);
  if (putar) [lebar, tinggi] = [tinggi, lebar];
  const durasi = Number(v.duration ?? j.format?.duration);
  return {
    lebar, tinggi, sar: sarNilai, durasi: Number.isFinite(durasi) ? durasi : undefined,
    colorSpace: v.color_space, colorRange: v.color_range, colorTransfer: v.color_transfer,
    pixFmt: v.pix_fmt ?? "",
    adaAudio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/** Matriks dan rentang untuk ekstraksi. Tak bertag = bt709 (cara Chromium mendekode video tak bertag). */
function matriksRentang(info) {
  if (PIX_RGB.test(info.pixFmt)) return { matriks: "rgb", rentang: "pc" };
  const cs = info.colorSpace;
  let matriks = "bt709";
  if (cs && cs !== "unknown" && cs !== "unspecified" && cs !== "rgb") {
    matriks = MATRIKS[cs];
    if (!matriks) return { galat: `matriks warna "${cs}" tidak didukung` };
  }
  const cr = info.colorRange;
  const rentang = cr === "pc" || cr === "jpeg" ? "pc" : cr === "tv" || cr === "mpeg" ? "tv" : info.pixFmt.startsWith("yuvj") ? "pc" : "tv";
  return { matriks, rentang };
}

/** Awal rantai ekstraksi dan analisis: fps lalu koreksi SAR (sama persis di pass analisis stabilisasi). */
function rantaiAwal({ fps, info }) {
  const rantai = [`fps=${fps}`];
  if (Math.abs(info.sar - 1) > 1e-6) rantai.push("scale=trunc(iw*sar):ih", "setsar=1");
  return rantai;
}

/** Pass pertama (analisis gerak vidstab): hanya menulis berkas jejak di folder kerja, tanpa keluaran frame. */
function argsAnalisis({ berkas, fps, k, info, efek }) {
  const a = ["-hide_banner", "-loglevel", "error", "-y"];
  if (k.dari) a.push("-ss", String(k.dari));
  a.push("-i", berkas);
  if (k.panjang) a.push("-t", String(k.panjang));
  a.push("-an", "-sn", "-vf", [...rantaiAwal({ fps, info }), ...efek.analisis].join(","), "-f", "null", "-");
  return a;
}

/** Rantai dasar ekstraksi sampai frame ukuran klip dalam rgb24: fps, SAR, tahap "pra", skala + matriks warna. */
function rantaiDasar({ fps, k, info, m, efek }) {
  const rantai = [...rantaiAwal({ fps, info }), ...efek.pra]; // tahap "pra": pada frame sumber
  let skala = `scale=${k.lebar}:${k.tinggi}:flags=bicubic`;
  if (m.matriks !== "rgb") skala += `:in_color_matrix=${m.matriks}:in_range=${m.rentang}:out_range=full`;
  rantai.push(skala, "format=rgb24");
  return rantai;
}

/**
 * Pass pembuat mask beku (hapusLatar): frame yang sama dengan yang akan di-cache (rantaiDasar) keluar
 * sebagai rgb24 mentah ke pipa; Bun membacanya per frame untuk ORT (buatMaskBeku).
 */
function argsMask({ berkas, fps, k, info, m, efek }) {
  const a = ["-hide_banner", "-loglevel", "error", "-y"];
  if (k.dari) a.push("-ss", String(k.dari));
  a.push("-i", berkas);
  if (k.panjang) a.push("-t", String(k.panjang));
  a.push("-an", "-sn", "-vf", rantaiDasar({ fps, k, info, m, efek }).join(","), "-fflags", "+bitexact", "-flags", "+bitexact", "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
  return a;
}

function argsEkstrak({ berkas, dir, fps, k, info, m, efek }) {
  const format = formatKlip(k);
  const rantai = rantaiDasar({ fps, k, info, m, efek });
  // efek tahap "alfa": menghasilkan kanal alfa (RGBA); tahap berikutnya membawa alfa (gbrap) bila ada
  const alfaDari = efek.alfaDari, alfa = efek.alfa.length > 0 || alfaDari !== null;
  if (efek.alfa.length) rantai.push(...efek.alfa, "format=rgba");
  // efek tahap "warna": di RGB planar 8 bit (konversi rgb24 <-> gbrp tanpa kehilangan; alfa tak disentuh)
  const warna = efek.warna.length ? [alfa ? "format=gbrap" : "format=gbrp", ...efek.warna, alfa ? "format=rgba" : "format=rgb24"] : [];
  const a = ["-hide_banner", "-loglevel", "error", "-y"];
  if (k.dari) a.push("-ss", String(k.dari));
  a.push("-i", berkas);
  // alfa dari masukan kedua (mask beku): rantai pindah ke -filter_complex; alphamerge memasang mask sebagai alfa
  if (alfaDari) a.push(...alfaDari.argumen({ k, fps }), "-i", alfaDari.berkas);
  if (k.panjang) a.push("-t", String(k.panjang));
  if (alfaDari) {
    const gabung = ["alphamerge", ...warna, "format=rgba"].join(",");
    a.push("-an", "-sn", "-filter_complex", `[0:v]${[...rantai, "format=rgba"].join(",")}[c];[1:v]${alfaDari.saring.join(",")}[m];[c][m]${gabung}[v]`, "-map", "[v]");
  } else {
    a.push("-an", "-sn", "-vf", [...rantai, ...warna].join(","));
  }
  a.push("-fflags", "+bitexact", "-flags", "+bitexact");
  if (format === "jpg") a.push("-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-q:v", String(k.kualitas ?? 2));
  else a.push("-c:v", "png", "-pix_fmt", alfa ? "rgba" : "rgb24");
  a.push("-start_number", "0", join(dir, `%06d.${format}`));
  return a;
}

function argsAudio({ berkas, tujuan, k }) {
  const a = ["-hide_banner", "-loglevel", "error", "-y"];
  if (k.dari) a.push("-ss", String(k.dari));
  a.push("-i", berkas);
  if (k.panjang) a.push("-t", String(k.panjang));
  a.push("-vn", "-sn", "-map", "0:a:0", "-ar", "48000", "-c:a", "pcm_s16le",
    "-fflags", "+bitexact", "-flags", "+bitexact", "-map_metadata", "-1", tujuan);
  return a;
}

function kunciCache(params) {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
}

function berkasFrame(dir, format) {
  const pola = new RegExp(`^\\d{6}\\.${format}$`);
  return readdirSync(dir).filter((f) => pola.test(f)).sort();
}

function cacheSah(dir, format) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    if (meta.skema !== VERSI_SKEMA || !(meta.jumlah >= 1)) return null;
    if (berkasFrame(dir, format).length !== meta.jumlah) return null;
    if (meta.audio && !existsSync(join(dir, meta.audio))) return null;
    return meta;
  } catch {
    return null;
  }
}

async function hashFrame(dir, daftar) {
  const h = createHash("sha256");
  for (const f of daftar) h.update(`${f}:${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}\n`);
  return h.digest("hex");
}

/**
 * Membekukan mask hapusLatar: ffmpeg mendekode frame ukuran klip (rgb24 mentah) ke pipa, ORT
 * (segmentasi-lib: model, ambang, EMA) memberi mask 8 bit per frame secara berurutan dari satu proses,
 * dan mask ditulis berurutan ke `mask.gray` di folder kerja. Mengembalikan jumlah frame. Segmenter
 * selalu ditutup; ffmpeg dihentikan bila galat. Galat segmentasi dilempar apa adanya (kode keluar).
 */
async function buatMaskBeku({ berkas, tmp, fps, k, info, m, efek, c, env }) {
  const byteFrame = k.lebar * k.tinggi * 3;
  const seg = await buatSegmenter({ model: c.model, env, ukuranInput: c.ukuranInput, ambang: c.ambang, ema: c.ema });
  let fd = null, p = null, n = 0;
  try {
    // bobot dan ORT harus sama dengan yang dicatat di kunci cache (preflight vs pembuatan sesi)
    if (seg.info.sha256 !== c.sha256 || seg.info.versiOrt !== c.versiOrt) {
      throw new Error(`bobot atau onnxruntime berubah sejak pemeriksaan awal untuk klip "${k.id}" (sha256 ${seg.info.sha256} vs ${c.sha256}; ORT ${seg.info.versiOrt} vs ${c.versiOrt})`);
    }
    fd = openSync(join(tmp, BERKAS_MASK), "w");
    p = Bun.spawn(["ffmpeg", ...argsMask({ berkas, fps, k, info, m, efek })], { stdout: "pipe", stderr: "pipe", cwd: tmp });
    const errTeks = new Response(p.stderr).text();
    const frame = new Uint8Array(byteFrame);
    let isi = 0;
    for await (const potongan of p.stdout) {
      let o = 0;
      while (o < potongan.length) {
        const ambil = Math.min(byteFrame - isi, potongan.length - o);
        frame.set(potongan.subarray(o, o + ambil), isi);
        isi += ambil;
        o += ambil;
        if (isi < byteFrame) continue;
        const mask = await seg.segmentasi(frame, k.lebar, k.tinggi); // berurutan: EMA bergantung frame sebelumnya
        if (writeSync(fd, mask, 0, mask.length) !== mask.length) throw new Error(`mask klip "${k.id}" tidak tertulis penuh (disk penuh?)`);
        n++;
        isi = 0;
      }
    }
    if (isi !== 0) throw new Error(`ffmpeg memberi frame terpotong untuk klip "${k.id}" (${isi} dari ${byteFrame} byte)`);
    const kode = await p.exited;
    const err = await errTeks;
    if (kode !== 0) throw new Error(`ffmpeg gagal mendekode frame klip "${k.id}" untuk segmentasi (exit ${kode}):\n${err.trim()}`);
    if (n === 0) throw new Error(`klip "${k.id}": tidak ada frame untuk disegmentasi (dari=${k.dari ?? 0}, panjang=${k.panjang ?? "sampai akhir"})`);
    return n;
  } catch (e) {
    if (p && p.exitCode === null) p.kill();
    throw e;
  } finally {
    if (fd !== null) closeSync(fd);
    await seg.tutup();
  }
}

/**
 * Ekstrak satu klip ke cache (atau cache hit). Mengembalikan { dir, kunci, meta, hit, rusak }.
 * `verifikasi`: cache hit hanya sah bila hash seluruh frame cocok dengan meta.framesSha256; bila tidak
 * (frame terpotong, berubah, atau hilang diganti) cache dibuang dan diekstrak ulang (`rusak: true`).
 */
async function ekstrakKlip({ k, sumber, berkas, sha256, info, m, fps, keluar, paksa, verifikasi = false, versi, dirManifest, kemampuan, segmentasi, env = process.env }) {
  const format = formatKlip(k);
  const efek = rakitEfek(k.efek, dirManifest, kemampuan, { klip: k, segmentasi });
  const params = {
    skema: VERSI_SKEMA, sha256, fps, lebar: k.lebar, tinggi: k.tinggi, dari: k.dari ?? 0,
    panjang: k.panjang ?? null, matriks: m.matriks, rentang: m.rentang, format,
    kualitas: format === "jpg" ? (k.kualitas ?? 2) : null, ffmpeg: versi,
    ...(efek.kanonik.length ? { efek: efek.kanonik } : {}), // kunci lama tak berubah untuk klip tanpa efek
  };
  const kunci = kunciCache(params);
  const dir = join(keluar, kunci);
  let rusak = false;
  if (!paksa) {
    const meta = cacheSah(dir, format);
    if (meta) {
      if (!verifikasi || (await hashFrame(dir, berkasFrame(dir, format))) === meta.framesSha256) return { dir, kunci, meta, hit: true, rusak: false };
      rusak = true;
    }
  }
  const tmp = join(keluar, `.tmp-${kunci}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const b of efek.berkas) copyFileSync(b.sumber, join(tmp, b.nama)); // ffmpeg berjalan di tmp: nama berkas aman tanpa escape
  if (efek.analisis.length) {
    const ra = await jalankan(["ffmpeg", ...argsAnalisis({ berkas, fps, k, info, efek })], tmp);
    if (ra.kode !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`ffmpeg gagal menganalisis gerak klip "${k.id}" (exit ${ra.kode}):\n${ra.err.trim()}`);
    }
  }
  let jumlahMask = null;
  if (efek.alfaDari) {
    try {
      jumlahMask = await buatMaskBeku({ berkas, tmp, fps, k, info, m, efek, c: efek.alfaDari.kanonik, env });
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  const r = await jalankan(["ffmpeg", ...argsEkstrak({ berkas, dir: tmp, fps, k, info, m, efek })], tmp);
  for (const b of efek.berkas) rmSync(join(tmp, b.nama), { force: true });
  rmSync(join(tmp, "stabil.trf"), { force: true });
  rmSync(join(tmp, BERKAS_MASK), { force: true }); // mask beku sudah menjadi alfa di frame PNG; tidak ikut cache
  if (r.kode !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`ffmpeg gagal mengekstrak frame klip "${k.id}" (exit ${r.kode}):\n${r.err.trim()}`);
  }
  const daftar = berkasFrame(tmp, format);
  if (daftar.length === 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`klip "${k.id}": tidak ada frame hasil ekstraksi (dari=${k.dari ?? 0}, panjang=${k.panjang ?? "sampai akhir"}); periksa rentang`);
  }
  if (jumlahMask !== null && jumlahMask !== daftar.length) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`klip "${k.id}": jumlah frame mask (${jumlahMask}) tidak sama dengan frame hasil (${daftar.length}); mask dan frame tidak sinkron, tidak ada yang di-cache`);
  }
  let audio = null;
  if (info.adaAudio) {
    const ra = await jalankan(["ffmpeg", ...argsAudio({ berkas, tujuan: join(tmp, "audio.wav"), k })]);
    if (ra.kode !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`ffmpeg gagal mengekstrak audio klip "${k.id}" (exit ${ra.kode}):\n${ra.err.trim()}`);
    }
    audio = "audio.wav";
  }
  // laporan segmentasi (hapusLatar): model, sha256 bobot, versi ORT, dan lisensi yang dideklarasikan registri
  const seg = efek.alfaDari ? segmentasi.get(efek.alfaDari.kanonik.model).info : null;
  const meta = {
    skema: VERSI_SKEMA, ...params, sumber, jumlah: daftar.length, ekstensi: format, digit: 6, audio,
    ...(seg ? { segmentasi: { model: seg.model, nama: seg.nama, sha256: seg.sha256, versiOrt: seg.versiOrt, lisensiKode: seg.lisensiKode, lisensiBobot: seg.lisensiBobot, kustom: seg.kustom, lokal: true, versiSegmentasi: seg.versiSegmentasi, frameMask: jumlahMask } } : {}),
    framesSha256: await hashFrame(tmp, daftar),
  };
  writeFileSync(join(tmp, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return { dir, kunci, meta, hit: false, rusak };
}

function prosesHidup(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // ada tetapi milik pengguna lain
  }
}

function ukuranFolder(dir) {
  let n = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) n += f.isFile() ? statSync(join(dir, f.name)).size : 0;
  return n;
}

/**
 * Pangkas cache di `keluar` (hanya dipanggil dengan --bersihkan, sesudah semua klip berhasil): hapus folder
 * kunci (16 heks, memuat meta.json) yang tidak dipakai klip manifest ini, dan sisa `.tmp-<kunci>-<pid>`
 * milik proses yang sudah mati. Folder lain, termasuk berkas keluaran, tidak disentuh.
 */
export function bersihkanCache(keluar, dipakai) {
  const r = { folder: 0, sementara: 0, byte: 0 };
  for (const e of readdirSync(keluar, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(keluar, e.name);
    const tmp = /^\.tmp-[0-9a-f]{16}-(\d+)$/.exec(e.name);
    if (tmp) {
      if (prosesHidup(Number(tmp[1]))) continue;
      r.byte += ukuranFolder(dir);
      r.sementara++;
    } else if (/^[0-9a-f]{16}$/.test(e.name) && !dipakai.has(e.name) && existsSync(join(dir, "meta.json"))) {
      r.byte += ukuranFolder(dir);
      r.folder++;
    } else continue;
    rmSync(dir, { recursive: true, force: true });
  }
  return r;
}

// ------------------------------------------------------------------------ CLI
function gagal(pesan, kode = 1) {
  console.error(`klip.mjs: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun scripts/klip.mjs <sumber.json> --fps N [--out .cache/awvd/klip] [--gabung props.json] [--paksa] [--verifikasi] [--bersihkan] [--draf]
--verifikasi: cache hit hanya dipakai bila hash seluruh frame cocok dengan meta.json (cache rusak diekstrak ulang).
--bersihkan: setelah berhasil, hapus folder cache lama yang tidak dipakai manifest ini dan sisa .tmp proses mati.
Keluaran di --out: klip-props.json, atribusi.txt, <kunci>/ (frame + audio.wav + meta.json),
dan props-gabungan.json bila --gabung. klip[].efek (stabil, kunciWarna, hapusLatar, lut, warna, keseimbangan) diterapkan saat ekstraksi.
hapusLatar butuh AWVD_ORT (paket onnxruntime-node) dan AWVD_MODEL_DIR (bobot bersha256); tanpa itu kode keluar 1, sha256 atau skema salah kode keluar 2 (docs/segmentasi-latar.md). Kode keluar 2 untuk manifest/argumen tidak valid.
--draf: izinkan sumber KUTIPAN-WAJAR yang gerbang hukum GH-nya belum disetujui; props memuat
"draf": true (komposisi wajib menampilkan tanda draf). Pelanggaran angka kutipan tidak bisa dilewati.`;

async function utama() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        fps: { type: "string" },
        out: { type: "string", default: ".cache/awvd/klip" },
        gabung: { type: "string" },
        paksa: { type: "boolean", default: false },
        verifikasi: { type: "boolean", default: false },
        bersihkan: { type: "boolean", default: false },
        draf: { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const { values: o, positionals } = args;
  if (o.help) {
    console.log(PETUNJUK);
    return;
  }
  if (positionals.length !== 1) gagal(`harus tepat satu manifest.\n${PETUNJUK}`, 2);
  const fps = Number(o.fps);
  if (o.fps === undefined || !Number.isFinite(fps) || fps <= 0) gagal(`--fps wajib angka positif.\n${PETUNJUK}`, 2);
  const berkasManifest = resolve(positionals[0]);
  if (!existsSync(berkasManifest)) gagal(`manifest tidak ditemukan: ${positionals[0]}`, 2);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(berkasManifest, "utf8"));
  } catch (e) {
    gagal(`manifest bukan JSON valid: ${e.message}`, 2);
  }
  let dasar = null;
  if (o.gabung) {
    try {
      dasar = JSON.parse(readFileSync(o.gabung, "utf8"));
    } catch (e) {
      gagal(`--gabung bukan JSON valid atau tidak terbaca: ${e.message}`, 2);
    }
    if (dasar === null || typeof dasar !== "object" || Array.isArray(dasar)) gagal("--gabung harus objek JSON", 2);
    if ("klip" in dasar) gagal('props dasar (--gabung) tidak boleh memuat kunci "klip"; kunci itu diisi dari manifest', 2);
  }
  const dirManifest = dirname(berkasManifest);

  // 1. validasi manifest (lisensi, atribusi, hash)
  const v = await validasiManifest(manifest, dirManifest);
  for (const p of v.peringatan) console.error(`peringatan: ${p}`);
  if (v.galat.length) {
    console.error(`klip.mjs: manifest ditolak (${v.galat.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
    for (const g of v.galat) console.error(`  - ${g}`);
    process.exit(2);
  }

  // 1b. hapusLatar: model, ORT, dan bobot (sha256) diperiksa sebelum ffprobe/ffmpeg; fail-closed
  let segmentasi = new Map();
  try {
    const sg = siapkanSegmentasi(manifest);
    for (const p of sg.peringatan) console.error(`peringatan: ${p}`);
    if (sg.galat.length) {
      console.error(`klip.mjs: efek hapusLatar ditolak (${sg.galat.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
      for (const g of sg.galat) console.error(`  - ${g}`);
      process.exit(2);
    }
    segmentasi = sg.info;
  } catch (e) {
    if (!(e instanceof GalatSegmentasi)) throw e;
    gagal(`efek hapusLatar tidak bisa dijalankan; tidak ada ekstraksi dan tidak ada render:\n${e.message}`, e.keluar);
  }

  // 2. ffprobe: HDR, matriks warna, rentang
  const sumberPerId = new Map(manifest.sumber.map((s) => [s.id, s]));
  const infoSumber = new Map();
  const galatMedia = [];
  for (const k of manifest.klip) {
    if (infoSumber.has(k.sumber)) continue;
    const s = sumberPerId.get(k.sumber);
    const berkas = mutlak(dirManifest, s.berkas);
    let info;
    try {
      info = await probeSumber(berkas);
    } catch (e) {
      galatMedia.push(`sumber "${s.id}": ${e.message}`);
      continue;
    }
    if (info.galat) { galatMedia.push(`sumber "${s.id}": ${info.galat}`); continue; }
    if (TRANSFER_HDR.includes(info.colorTransfer)) {
      galatMedia.push(`sumber "${s.id}": sumber HDR (${info.colorTransfer}) tidak didukung; tonemap ke SDR BT.709 lebih dulu`);
      continue;
    }
    const m = matriksRentang(info);
    if (m.galat) { galatMedia.push(`sumber "${s.id}": ${m.galat}`); continue; }
    infoSumber.set(k.sumber, { info, m });
  }
  for (const k of manifest.klip) {
    const x = infoSumber.get(k.sumber);
    if (!x) continue;
    if (x.info.durasi !== undefined && (k.dari ?? 0) >= x.info.durasi) {
      galatMedia.push(`klip "${k.id}": dari=${k.dari} melewati durasi sumber (${x.info.durasi.toFixed(2)} s)`);
    }
    const asal = x.info.lebar / x.info.tinggi, tujuan = k.lebar / k.tinggi;
    if (Math.abs(asal / tujuan - 1) > 0.01) {
      console.error(`peringatan: klip "${k.id}": rasio ${k.lebar}x${k.tinggi} berbeda dari sumber (${x.info.lebar.toFixed(0)}x${x.info.tinggi.toFixed(0)}); gambar akan melar`);
    }
  }
  if (galatMedia.length) {
    console.error(`klip.mjs: sumber ditolak (${galatMedia.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
    for (const g of galatMedia) console.error(`  - ${g}`);
    process.exit(2);
  }

  // 2b. kebijakan kutipan wajar + gerbang hukum GH (butuh durasi sumber dari ffprobe)
  const durasiSumber = {};
  for (const [id, x] of infoSumber) if (x.info.durasi !== undefined) durasiSumber[id] = x.info.durasi;
  const kutipan = periksaKutipan(manifest, dirManifest, durasiSumber);
  for (const p of kutipan.peringatan) console.error(`peringatan: ${p}`);
  if (kutipan.galat.length) {
    console.error(`klip.mjs: kebijakan kutipan wajar dilanggar (${kutipan.galat.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
    for (const g of kutipan.galat) console.error(`  - ${g}`);
    process.exit(2);
  }
  if (kutipan.ringkasan) console.log(barisRingkasan(kutipan));
  let draf = false;
  if (kutipan.gerbang.perlu && !kutipan.gerbang.disetujui) {
    if (!o.draf) {
      console.error(`klip.mjs: render final ditolak: ${kutipan.gerbang.pesan}`);
      console.error("  Dapatkan persetujuan peninjau hukum (memo ber-hash, lihat docs/pelajari-reaction.md), atau jalankan dengan --draf untuk hasil bertanda draf (bukan untuk publikasi).");
      process.exit(2);
    }
    draf = true;
    console.error(`peringatan: DRAF: ${kutipan.gerbang.pesan}; props memuat "draf": true dan hasil tidak boleh dipublikasikan`);
  } else if (kutipan.gerbang.perlu) {
    console.log(kutipan.gerbang.pesan);
  }

  // 2c. efek yang bergantung pada build ffmpeg (stabil: vidstab) dicek sebelum ekstraksi
  let kemampuan = null;
  if (perluKemampuan(manifest)) {
    try {
      kemampuan = await deteksiKemampuan();
    } catch (e) {
      gagal(e.message);
    }
    const kk = periksaKemampuanEfek(manifest, kemampuan);
    for (const p of kk.peringatan) console.error(`peringatan: ${p}`);
    if (kk.galat.length) {
      console.error(`klip.mjs: efek tidak bisa dijalankan oleh ffmpeg ini (${kk.galat.length} pelanggaran); tidak ada ekstraksi dan tidak ada render:`);
      for (const g of kk.galat) console.error(`  - ${g}`);
      process.exit(2);
    }
  }

  // 3. ekstraksi ke cache
  const keluar = resolve(o.out);
  try {
    mkdirSync(keluar, { recursive: true });
  } catch (e) {
    gagal(`tidak bisa membuat folder keluaran ${o.out}: ${e.message}`, 2);
  }
  const versi = await versiFfmpeg();
  const akar = pathToFileURL(keluar).href.replace(/\/+$/, "");
  const props = [];
  const statistik = { hit: 0, ekstraksi: 0, rusak: 0 };
  for (const k of manifest.klip) {
    const s = sumberPerId.get(k.sumber);
    const { info, m } = infoSumber.get(k.sumber);
    let hasil;
    try {
      hasil = await ekstrakKlip({
        k, sumber: s.id, berkas: mutlak(dirManifest, s.berkas), sha256: v.hash[s.id], info, m, fps, keluar, paksa: o.paksa, verifikasi: o.verifikasi, versi, dirManifest, kemampuan, segmentasi,
      });
    } catch (e) {
      gagal(e.message, e instanceof GalatSegmentasi ? e.keluar : 1);
    }
    const { meta, kunci, hit, rusak } = hasil;
    statistik[hit ? "hit" : "ekstraksi"]++;
    if (rusak) statistik.rusak++;
    console.log(`klip "${k.id}": ${hit ? "cache hit" : rusak ? "ekstraksi (cache rusak)" : "ekstraksi"} ${meta.jumlah} frame ${k.lebar}x${k.tinggi} @ ${fps} fps (matriks ${m.matriks}, rentang ${m.rentang}${meta.efek ? `, efek ${meta.efek.map((x) => (x.jenis === "stabil" ? `stabil(${x.mesin})` : x.jenis === "hapusLatar" ? `hapusLatar(${x.model})` : x.jenis)).join("+")}` : ""}) -> ${kunci}`);
    if (meta.segmentasi) console.log(`  segmentasi lokal: ${meta.segmentasi.nama}, sha256 ${meta.segmentasi.sha256.slice(0, 16)}, ORT ${meta.segmentasi.versiOrt}, lisensi bobot ${meta.segmentasi.lisensiBobot}${hit ? "" : `, ${meta.segmentasi.frameMask} mask dibekukan`}`);
    props.push({
      id: k.id, sumber: s.id, akar, folder: kunci, ekstensi: meta.ekstensi, digit: meta.digit,
      jumlah: meta.jumlah, fps, lebar: k.lebar, tinggi: k.tinggi,
      audio: meta.audio ? `${kunci}/${meta.audio}` : null,
      atribusi: {
        judul: s.judul ?? "", tanpaJudul: s.tanpaJudul === true,
        pencipta: s.pencipta ?? "", penciptaAnonim: s.penciptaAnonim === true,
        sumberUrl: s.sumberUrl, lisensi: s.lisensi,
        urlLisensi: s.urlLisensi || urlLisensiBawaan(s.lisensi, s.bukti),
        perubahan: s.perubahan,
      },
      ...(dalamCakupan(s) ? { kutipan: { isiAudio: s.kutipan?.isiAudio ?? "musik", musikDibahas: s.kutipan?.musikDibahas === true } } : {}),
    });
  }

  console.log(`cache: ${statistik.hit} hit, ${statistik.ekstraksi} ekstraksi${statistik.rusak ? ` (${statistik.rusak} cache rusak)` : ""}`);

  // 4. keluaran: klip-props.json, atribusi.txt, props-gabungan.json
  writeFileSync(join(keluar, "klip-props.json"), `${JSON.stringify({ klip: props, ...(draf ? { draf: true } : {}) }, null, 2)}\n`);
  const urut = [];
  for (const p of props) if (!urut.some((x) => x.sumber === p.sumber)) urut.push({ sumber: p.sumber, atribusi: p.atribusi, klip: [] });
  for (const p of props) urut.find((x) => x.sumber === p.sumber).klip.push(p.id);
  const baris = ["ATRIBUSI KLIP TERTANAM (format TASL: Title, Author, Source, License)", ""];
  if (draf) baris.unshift("DRAF: gerbang hukum GH belum disetujui; bukan untuk publikasi.", "");
  urut.forEach((x, i) => {
    baris.push(`${i + 1}. ${kreditLengkap(x.atribusi)}`, `   Dipakai di klip: ${x.klip.join(", ")}`);
  });
  const keluaranSA = manifest.proyek.lisensiKeluaran;
  if (adaTeks(keluaranSA)) baris.push("", `Lisensi keluaran video: ${namaLisensi(keluaranSA)}`);
  if (props.some((x) => x.atribusi.lisensi === "KUTIPAN-WAJAR")) {
    baris.push("", "KUTIPAN-WAJAR bukan lisensi: klip dikutip sebagai kritik, ulasan, atau pendidikan dengan menyebut sumber; hak cipta tetap pada pencipta.");
  }
  writeFileSync(join(keluar, "atribusi.txt"), `${baris.join("\n")}\n`);
  if (dasar) writeFileSync(join(keluar, "props-gabungan.json"), `${JSON.stringify({ ...dasar, klip: props, ...(draf ? { draf: true } : {}) }, null, 2)}\n`);
  if (o.bersihkan) {
    const r = bersihkanCache(keluar, new Set(props.map((p) => p.folder)));
    console.log(`bersih: ${r.folder} folder cache lama dan ${r.sementara} sisa sementara dihapus (${(r.byte / 1048576).toFixed(1)} MB)`);
  }
  console.log(`selesai: ${props.length} klip -> ${join(keluar, "klip-props.json")}${dasar ? `, ${join(keluar, "props-gabungan.json")}` : ""}`);
}

if (import.meta.main) await utama();
