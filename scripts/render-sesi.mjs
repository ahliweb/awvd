/**
 * awvd / render-sesi.mjs — sesi browser bersama untuk render.mjs dan render-segmen.mjs.
 *
 * Satu sesi = satu proses Chromium headless + satu halaman komposisi: pemblokiran jaringan,
 * pemuatan eksplisit font dan gambar, penangkapan frame lewat CDP, dan pemanasan. Dipakai oleh
 * orkestrator (probe konfigurasi dan mode --still) dan oleh setiap pekerja segmen, sehingga
 * semua proses menangkap piksel dengan jalur kode yang sama.
 * Karya asli repo ini.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

export const BATAS_WAKTU_VIDEO_MS = 15000;
/** Jumlah frame pemanasan (dirender, ditangkap, dibuang) sebelum setiap segmen atau still. */
export const JUMLAH_PEMANASAN = 2;
/** Kualitas JPEG untuk --tangkap jpeg (deterministik di Chromium yang sama, lossy). */
export const KUALITAS_JPEG = 95;

const BATAS_DAFTAR_BLOKIR = 20;

// ---------------------------------------------------------------- URL komposisi
/** @throws {Error} dengan properti kode = 2 bila berkas komposisi tidak ada */
export function urlKomposisi(arg) {
  if (/^https?:\/\//i.test(arg) || /^file:\/\//i.test(arg)) return arg;
  const p = resolve(arg);
  if (!existsSync(p)) throw Object.assign(new Error(`komposisi tidak ditemukan: ${arg}`), { kode: 2 });
  return pathToFileURL(p).href;
}

export function hostAsal(arg) {
  if (!/^https?:\/\//i.test(arg)) return null;
  try { return new URL(arg).host; } catch { return null; }
}

function samaAsal(asalKomposisi, url) {
  if (!asalKomposisi) return false;
  try {
    const u = new URL(url);
    return /^(?:https?|wss?):$/.test(u.protocol) && u.host === asalKomposisi;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- jaringan
/**
 * Pencatat permintaan jaringan yang diblokir. Hanya skema lokal (file, data, about, blob) yang lolos
 * tanpa dicegat; selebihnya (http, https, ws, wss, ftp, ...) dicegat context.route / routeWebSocket,
 * dibatalkan, dan dicatat. Route saja tidak menutup WebSocket, jadi keduanya dipasang.
 */
export function buatJaring({ izinkan = false, asalKomposisi = null } = {}) {
  const diblokir = new Map(); // "METODE url" -> { metode, url, jenis }
  const jaring = {
    izinkan,
    asalKomposisi,
    diblokir,
    catat(metode, url, jenis) {
      const kunci = `${metode} ${url}`;
      if (!diblokir.has(kunci)) diblokir.set(kunci, { metode, url, jenis });
    },
    ada: () => !izinkan && diblokir.size > 0,
    pesan() {
      const daftar = [...diblokir.values()];
      const baris = daftar.slice(0, BATAS_DAFTAR_BLOKIR).map((d) => `  ${d.metode} ${d.url} (${d.jenis})`);
      if (daftar.length > BATAS_DAFTAR_BLOKIR) baris.push(`  ... dan ${daftar.length - BATAS_DAFTAR_BLOKIR} lainnya`);
      return `${daftar.length} permintaan jaringan diblokir (hanya file:, data:, about:, blob: yang diizinkan):\n${baris.join("\n")}\n` +
        "Pakai aset lokal yang tercatat (bun run aset); --izinkan-jaringan hanya untuk pratinjau, bukan rilis.";
    },
    periksa() {
      if (jaring.ada()) throw new JaringanDiblokir(jaring.pesan());
    },
  };
  return jaring;
}

export class JaringanDiblokir extends Error {
  constructor(pesan) {
    super(pesan);
    this.kode = 3;
  }
}

async function pasangPemblokiranJaringan(context, jaring) {
  await context.route(/^(?!(?:file|data|about|blob):)/i, (route) => {
    const req = route.request();
    if (samaAsal(jaring.asalKomposisi, req.url())) return route.continue();
    jaring.catat(req.method(), req.url(), req.resourceType());
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (ws) => {
    if (samaAsal(jaring.asalKomposisi, ws.url())) {
      ws.connectToServer();
      return;
    }
    jaring.catat("WS", ws.url(), "websocket");
    ws.close({ code: 1008, reason: "diblokir awvd" });
  });
}

/**
 * Ubah galat menjadi { kode, pesan } sesuai kontrak kode keluar: permintaan yang diblokir hampir selalu
 * penyebab utama (kode 3); galat lain hanya dampaknya.
 */
export function klasifikasiGalat(jaring, e) {
  if (jaring.ada()) {
    let pesan = `render.mjs: ${jaring.pesan()}`;
    if (!(e instanceof JaringanDiblokir)) pesan += `\ngalat yang menyertai: ${e.message}`;
    return { kode: 3, pesan };
  }
  return { kode: 1, pesan: `render.mjs: ${e.message}` };
}

// ------------------------------------------------------------------ filter video
/** Filter perkecil deterministik (swscale lanczos, pembulatan akurat) untuk skala < 1. */
export const filterPerkecil = (w, h) => `scale=${w}:${h}:flags=lanczos+accurate_rnd+full_chroma_int`;

// ------------------------------------------------------------------------ sesi
/**
 * Buka sesi: luncurkan Chromium, pasang pemblokiran jaringan, buka komposisi, tunggu window.video,
 * muat font dan gambar. Bila gagal di tengah jalan, browser ditutup sebelum galat dilempar.
 *
 * @param {object} p
 * @param {string} p.url URL komposisi (hasil urlKomposisi)
 * @param {object} p.props objek props (window.videoProps)
 * @param {string} p.exe jalur Chromium
 * @param {ReturnType<typeof buatJaring>} p.jaring
 * @param {number} p.skalaRaster faktor clip.scale (>= 1)
 * @param {"png"|"jpeg"} [p.tangkap]
 * @param {(s: string) => void} [p.log] penerima pesan halaman (bawaan console.error)
 * @param {{catat(url: string): void, tidakBisa(alasan: string): void}} [p.lacak] pelacak berkas untuk cache
 *   segmen (render-cache.mjs); hanya mendengarkan peristiwa jaringan, tidak mengubah halaman atau keluaran
 */
export async function bukaSesi({ url, props, exe, jaring, skalaRaster, tangkap = "png", log = (s) => console.error(s), lacak = null }) {
  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: [
      "--allow-file-access-from-files", // fetch()/font dari file:// bertetangga
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--hide-scrollbars",
    ],
  }).catch((e) => { throw new Error(`gagal meluncurkan browser (${exe}): ${e.message}`); });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    if (!jaring.izinkan) await pasangPemblokiranJaringan(context, jaring);
    if (lacak) {
      // semua permintaan konteks (dokumen, skrip, CSS, font, gambar, media, fetch, iframe, worker; juga
      // yang gagal) dicatat; skema lokal selain file: tak punya isi di disk yang perlu dilacak
      context.on("request", (r) => {
        const u = r.url();
        if (/^file:/i.test(u)) lacak.catat(u);
        else if (!/^(?:data|about|blob):/i.test(u)) lacak.tidakBisa(`permintaan non-lokal: ${u}`);
      });
      context.on("serviceworker", () => lacak.tidakBisa("service worker"));
    }
    const page = await context.newPage();
    if (lacak) {
      page.on("worker", (w) => lacak.tidakBisa(`Web Worker: ${w.url()}`));
      page.on("popup", () => lacak.tidakBisa("jendela popup"));
    }
    page.on("pageerror", (e) => log(`[halaman] galat: ${e.message}`));
    page.on("console", (m) => {
      // pemblokiran jaringan sudah dilaporkan lengkap di akhir; jangan dobel dengan galat sumber per permintaan
      if (m.type() === "error" && !(!jaring.izinkan && /ERR_BLOCKED_BY_CLIENT/.test(m.text()))) log(`[halaman] ${m.text()}`);
    });
    await page.addInitScript((p) => { window.videoProps = p; }, props);
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
      throw new Error(`gagal membuka ${url}: ${e.message}`);
    }

    try {
      await page.waitForFunction(
        () => window.video && typeof window.video.renderFrame === "function",
        null,
        { timeout: BATAS_WAKTU_VIDEO_MS },
      );
    } catch {
      throw new Error(
        `window.video tidak terdefinisi dalam ${BATAS_WAKTU_VIDEO_MS / 1000} detik. ` +
        "Pastikan komposisi memuat runtime.js dan memanggil defineVideo(...).",
      );
    }
    const cfg = await page.evaluate(() => {
      const v = window.video;
      return { width: v.width, height: v.height, fps: v.fps, durationInFrames: v.durationInFrames };
    });
    for (const k of ["width", "height", "fps", "durationInFrames"]) {
      if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) throw new Error(`window.video.${k} tidak valid: ${cfg[k]}`);
    }
    await page.setViewportSize({ width: cfg.width, height: cfg.height });

    // Muat eksplisit setiap @font-face sebelum frame pertama. `document.fonts.ready` saja tidak
    // memuat face yang belum dipakai DOM awal, sehingga elemen berfont yang dibuat di render()
    // bisa tertangkap dengan font cadangan lalu bergeser (uji lokal: lebar 168,6 px -> 189,8 px).
    const fontGagal = await page.evaluate(async () => {
      const muka = [...document.fonts];
      const hasil = await Promise.allSettled(muka.map((f) => f.load()));
      await document.fonts.ready;
      const gagalMuat = muka
        .filter((f, i) => hasil[i].status === "rejected" || f.status === "error")
        .map((f) => `${f.family} (bobot ${f.weight}, gaya ${f.style})`);
      // tunggu gambar siap
      const imgs = [...document.images];
      for (const v of document.querySelectorAll("video[poster]")) {
        const im = new Image();
        im.src = v.poster;
        imgs.push(im);
      }
      await Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((ok) => {
        im.addEventListener("load", ok, { once: true });
        im.addEventListener("error", ok, { once: true });
      }))));
      await Promise.all(imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
      return gagalMuat;
    });
    jaring.periksa(); // pesan "diblokir" lebih jelas daripada "gambar/font gagal dimuat"
    if (fontGagal.length) throw new Error(`font gagal dimuat: ${fontGagal.join(", ")}. Periksa url() di @font-face (berkas lokal, format didukung Chromium).`);
    const rusak = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.currentSrc || i.src));
    if (rusak.length) throw new Error(`gambar gagal dimuat: ${rusak.join(", ")}`);

    // Tangkap via CDP. PNG lossless (optimizeForSpeed mengurangi kompresi: lebih cepat, berkas lebih besar);
    // JPEG hanya untuk pratinjau draf (--tangkap jpeg).
    const cdp = await context.newCDPSession(page);
    const param = tangkap === "jpeg" ? { format: "jpeg", quality: KUALITAS_JPEG } : { format: "png", optimizeForSpeed: true };
    const ambil = async (n) => {
      await page.evaluate(async (f) => {
        await window.video.renderFrame(f);
        // jaring pengaman: face yang baru ditambahkan di dalam render() dimuat sebelum tangkapan
        const fs = document.fonts;
        if (fs.size) {
          const belum = [...fs].filter((x) => x.status === "unloaded" || x.status === "loading");
          if (belum.length) await Promise.allSettled(belum.map((x) => x.load()));
          if (fs.status === "loading") await fs.ready;
        }
      }, n);
      const { data } = await cdp.send("Page.captureScreenshot", {
        ...param,
        // skala >= 1 lewat clip.scale: layout tetap w x h, raster dibuat ulang tajam pada ukuran akhir
        clip: { x: 0, y: 0, width: cfg.width, height: cfg.height, scale: skalaRaster },
      });
      jaring.periksa();
      return Buffer.from(data, "base64");
    };

    // Dua tangkapan pertama sebuah proses Chromium dapat berbeda beberapa piksel dari frame yang sama
    // di tengah proses (efek awal-dingin rasterisasi). Pemanasan: render dan tangkap dua frame terdekat
    // sebelum `mulai` (dua frame pertama komposisi bila `mulai` < 2), lalu buang hasilnya.
    const hangatkan = async (mulai) => {
      const awal = Math.max(0, mulai - JUMLAH_PEMANASAN);
      for (let n = awal; n < awal + JUMLAH_PEMANASAN && n < cfg.durationInFrames; n++) await ambil(n);
    };

    return {
      cfg,
      versiBrowser: browser.version(),
      /** Elemen yang isinya tak terlacak lengkap lewat peristiwa jaringan; teks alasan atau null. */
      periksaDom: async () => {
        const n = await page.evaluate(() => document.querySelectorAll("iframe,frame,video,audio,object,embed").length);
        return n > 0 ? `${n} elemen iframe/video/audio/object/embed di halaman` : null;
      },
      ambil,
      hangatkan,
      jaring,
      /** Lewatkan satu putaran halaman: pastikan catatan permintaan frame terakhir sudah masuk. */
      sinkron: () => page.evaluate(() => 0),
      tutup: () => browser.close().catch(() => {}),
    };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
