/**
 * awvd / render-cache.mjs — cache segmen render (flag `--cache-segmen` pada render.mjs).
 *
 * Yang disimpan: segmen video-saja (MPEG-TS) hasil pekerja render-segmen.mjs, satu folder per
 * segmen di `<cache>/<kunci-segmen>/` berisi `seg.ts` dan `meta.json`. Segmen dipakai ulang hanya
 * bila SELURUH kunci sama:
 *
 *   kunci segmen = sha256(kunci global + rentang segmen)
 *   kunci global = lingkungan render (versi Chromium, ffmpeg, libx264, playwright-core, hash kode
 *                  render-segmen.mjs dan render-sesi.mjs, font sistem, platform, TZ/LANG)
 *                  + URL komposisi + props persis seperti yang dilihat halaman
 *                  + width/height/fps/durationInFrames + --skala + --crf + --tangkap + ukuran segmen
 *
 * Berkas yang dimuat halaman TIDAK dienumerasi di probe (probe tidak melihat berkas yang dimuat
 * malas per frame, mis. frame klip). Setiap pekerja merekam sendiri semua permintaan `file:` yang
 * dibuat proses Chromium-nya selama hidupnya (muat halaman, pemanasan, semua frame; `context.on
 * ("request")` mencakup dokumen, skrip, CSS, font, gambar, media, fetch, iframe, worker, termasuk
 * yang gagal atau tidak ada), lalu menulis manifest berkas + sha256 ke `meta.json` entri. Entri
 * hanya sah bila setiap berkas di manifest masih berisi hal yang sama (dan berkas yang dulu tidak
 * ada masih tidak ada). Karena komposisi deterministik, eksekusi yang membaca isi berkas yang sama
 * membaca berkas yang sama dan menghasilkan piksel yang sama.
 *
 * Fail-safe: segmen tidak disimpan (render tetap jalan) bila ada hal yang tak bisa dijamin: berkas
 * berubah selama render, permintaan non-lokal, direktori, Web Worker, iframe/video/audio/object/embed.
 * Penulisan atomik (folder sementara lalu rename). Pemakaian memverifikasi ukuran dan sha256 salinan.
 * Karya asli repo ini.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Naik bila format entri atau komposisi kunci berubah (entri lama otomatis tidak terpakai). */
export const SKEMA_CACHE = 1;

const DIR_SKRIP = dirname(fileURLToPath(import.meta.url));
const BATAS_SEMENTARA_MS = 60 * 60 * 1000;

export const sha256Teks = (t) => new Bun.CryptoHasher("sha256").update(t).digest("hex");

export async function sha256Berkas(jalur) {
  const h = new Bun.CryptoHasher("sha256");
  for await (const bagian of Bun.file(jalur).stream()) h.update(bagian);
  return h.digest("hex");
}

const statBesar = (jalur) => statSync(jalur, { bigint: true, throwIfNoEntry: false });

// ------------------------------------------------------------------ pelacak berkas
/**
 * Pencatat berkas lokal yang diminta halaman (dipakai pekerja segmen). `catat(url)` dipanggil dari
 * `context.on("request")`; `tidakBisa(alasan)` menandai segmen tak boleh masuk cache; `tulis(f)`
 * menghitung sha256 setiap berkas dan menulis manifest JSON ke `f`.
 */
export function buatPelacak() {
  const berkas = new Map(); // jalur -> keadaan saat pertama diminta
  let alasan = null;
  return {
    berkas,
    catat(url) {
      let jalur;
      try {
        jalur = fileURLToPath(url);
      } catch {
        alasan ??= `URL file tidak terbaca: ${url}`;
        return;
      }
      if (berkas.has(jalur)) return;
      const st = statBesar(jalur);
      if (st && !st.isFile()) {
        alasan ??= `bukan berkas biasa (direktori?): ${jalur}`;
        return;
      }
      berkas.set(jalur, st ? { ada: true, ukuran: st.size, mtime: st.mtimeNs } : { ada: false });
    },
    tidakBisa(teks) {
      alasan ??= teks;
    },
    async tulis(f) {
      const daftar = [];
      if (!alasan) {
        for (const [jalur, awal] of [...berkas].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          const sebelum = statBesar(jalur);
          if (!awal.ada) {
            if (sebelum) { alasan = `berkas muncul selama render: ${jalur}`; break; }
            daftar.push({ jalur, ada: false });
            continue;
          }
          const sama = (st) => st && st.isFile() && st.size === awal.ukuran && st.mtimeNs === awal.mtime;
          if (!sama(sebelum)) { alasan = `berkas berubah selama render: ${jalur}`; break; }
          const sha256 = await sha256Berkas(jalur);
          if (!sama(statBesar(jalur))) { alasan = `berkas berubah selama render: ${jalur}`; break; }
          daftar.push({ jalur, ada: true, sha256 });
        }
      }
      writeFileSync(f, JSON.stringify({ ok: !alasan, alasan, berkas: alasan ? [] : daftar }));
    },
  };
}

// ----------------------------------------------------------------- lingkungan
async function jalankanTeks(cmd, biner = false) {
  let p;
  try {
    p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new Error(`${cmd[0]} tidak bisa dijalankan: ${e.message}`);
  }
  const [out, err, kode] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`${cmd[0]} gagal (exit ${kode}): ${err.trim().slice(0, 200)}`);
  return biner ? Buffer.from(out) : Buffer.from(out).toString("utf8");
}

/**
 * Kumpulkan semua hal di luar komposisi yang memengaruhi piksel dan byte segmen. Melempar Error
 * (dengan alasan) bila ada yang tak bisa dibaca: cache lebih baik mati daripada kuncinya tidak lengkap.
 */
export async function lingkunganCache({ versiBrowser }) {
  if (!versiBrowser) throw new Error("versi Chromium tidak diketahui");
  const ffmpeg = (await jalankanTeks(["ffmpeg", "-hide_banner", "-version"])).trim();
  const sei = await jalankanTeks(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=1:d=1",
    "-frames:v", "1", "-c:v", "libx264", "-f", "h264", "-"], true);
  const x264 = /x264 - core \d+ [\x20-\x7e]+/.exec(sei.toString("latin1"))?.[0];
  if (!x264) throw new Error("versi libx264 tidak terbaca dari keluaran ffmpeg");

  // font sistem: nama dan isi (ukuran + mtime) setiap berkas font yang dikenal fontconfig, dan
  // pemetaan keluarga generik yang dipakai Chromium
  const daftarFont = (await jalankanTeks(["fc-list", ":", "file"])).split("\n").map((l) => l.trim().replace(/:$/, "")).filter(Boolean).sort();
  if (daftarFont.length === 0) throw new Error("fc-list tidak menemukan font sistem");
  const fontStat = daftarFont.map((f) => {
    const st = statSync(f, { bigint: true, throwIfNoEntry: false });
    return `${f}|${st ? `${st.size}|${st.mtimeNs}` : "hilang"}`;
  });
  const generik = [];
  for (const nama of ["sans-serif", "serif", "monospace", "emoji", "system-ui"]) generik.push(await jalankanTeks(["fc-match", nama]));

  const rujukan = createRequire(import.meta.url);
  const playwright = rujukan("playwright-core/package.json").version;
  const pipeline = sha256Teks(["render-segmen.mjs", "render-sesi.mjs"].map((n) => readFileSync(join(DIR_SKRIP, n), "utf8")).join("\n\0\n"));

  return {
    skema: SKEMA_CACHE,
    pipeline,
    playwright,
    browser: versiBrowser,
    ffmpeg,
    x264,
    fontSistem: sha256Teks(fontStat.join("\n")),
    keluargaGenerik: generik.map((s) => s.trim()),
    platform: `${process.platform}-${process.arch}`,
    env: { TZ: process.env.TZ ?? null, LANG: process.env.LANG ?? null, LC_ALL: process.env.LC_ALL ?? null, LANGUAGE: process.env.LANGUAGE ?? null },
  };
}

/** Kunci global: sha256 dari lingkungan + masukan render. `props` adalah teks JSON persis yang dibaca halaman. */
export function kunciGlobal({ lingkungan, url, props, cfg, skala, crf, tangkap, ukuranSegmen }) {
  return sha256Teks(JSON.stringify({ lingkungan, url, props, cfg, skala, crf, tangkap, ukuranSegmen }));
}

// ---------------------------------------------------------------------- cache
/**
 * @param {object} p
 * @param {string} p.dir folder cache
 * @param {string} p.kunci kunci global (kunciGlobal)
 */
export function buatCache({ dir, kunci }) {
  const memoHash = new Map(); // "jalur\0ukuran\0mtime" -> sha256 (selama satu render)
  const kunciSegmen = (seg) => sha256Teks(`${kunci}|${seg.dari}|${seg.sampai}`).slice(0, 32);
  const dirEntri = (seg) => join(dir, kunciSegmen(seg));

  async function berkasCocok(berkas) {
    for (const b of berkas) {
      if (!b || typeof b.jalur !== "string" || typeof b.ada !== "boolean" || (b.ada && typeof b.sha256 !== "string")) return "manifest berkas tidak sah";
      const st = statBesar(b.jalur);
      if (!b.ada) {
        if (st) return `berkas yang dulu tidak ada kini ada: ${b.jalur}`;
        continue;
      }
      if (!st || !st.isFile()) return `berkas hilang: ${b.jalur}`;
      const m = `${b.jalur}\0${st.size}\0${st.mtimeNs}`;
      let h = memoHash.get(m);
      if (!h) { h = await sha256Berkas(b.jalur); memoHash.set(m, h); }
      if (h !== b.sha256) return `isi berubah: ${b.jalur}`;
    }
    return null;
  }

  return {
    dir,
    kunciSegmen,
    /**
     * Cari segmen di cache; bila sah, salin ke `seg.ts` dan verifikasi salinannya.
     * @returns {Promise<{hit: boolean, alasan?: "baru"|"berubah"|"rusak", detail?: string}>}
     */
    async cari(seg) {
      const d = dirEntri(seg);
      const fMeta = join(d, "meta.json");
      if (!existsSync(d)) return { hit: false, alasan: "baru" };
      let meta;
      try {
        meta = JSON.parse(readFileSync(fMeta, "utf8"));
      } catch (e) {
        return { hit: false, alasan: "rusak", detail: `meta.json tidak terbaca: ${e.message}` };
      }
      if (!meta || meta.skema !== SKEMA_CACHE || meta.kunci !== kunci || meta.dari !== seg.dari || meta.sampai !== seg.sampai ||
        meta.frame !== seg.sampai - seg.dari + 1 || typeof meta.sha256 !== "string" || !Number.isInteger(meta.ukuran) || !Array.isArray(meta.berkas)) {
        return { hit: false, alasan: "rusak", detail: "meta.json tidak cocok dengan kunci atau rentang" };
      }
      const alasanBeda = await berkasCocok(meta.berkas);
      if (alasanBeda) return { hit: false, alasan: "berubah", detail: alasanBeda };
      try {
        copyFileSync(join(d, "seg.ts"), seg.ts);
        if (statSync(seg.ts).size !== meta.ukuran || (await sha256Berkas(seg.ts)) !== meta.sha256) throw new Error("ukuran atau sha256 salinan tidak cocok");
      } catch (e) {
        rmSync(seg.ts, { force: true });
        return { hit: false, alasan: "rusak", detail: `seg.ts: ${e.message}` };
      }
      try { const n = new Date(); utimesSync(fMeta, n, n); } catch {} // penanda pemakaian terakhir (pangkas LRU)
      return { hit: true };
    },
    /**
     * Simpan segmen hasil pekerja (seg.ts) beserta manifest berkas dari pelacak (`fDeps`).
     * @returns {Promise<{disimpan: boolean, alasan?: string}>}
     */
    async simpan(seg, fDeps) {
      let deps;
      try {
        deps = JSON.parse(readFileSync(fDeps, "utf8"));
      } catch (e) {
        return { disimpan: false, alasan: `manifest berkas tidak terbaca: ${e.message}` };
      }
      if (!deps.ok) return { disimpan: false, alasan: deps.alasan ?? "tidak bisa dilacak" };
      mkdirSync(dir, { recursive: true });
      const sementara = join(dir, `.tmp-${crypto.randomUUID()}`);
      mkdirSync(sementara);
      try {
        copyFileSync(seg.ts, join(sementara, "seg.ts"));
        const ukuran = statSync(join(sementara, "seg.ts")).size;
        const sha256 = await sha256Berkas(join(sementara, "seg.ts"));
        writeFileSync(join(sementara, "meta.json"), JSON.stringify({
          skema: SKEMA_CACHE, kunci, dari: seg.dari, sampai: seg.sampai, frame: seg.sampai - seg.dari + 1, ukuran, sha256, berkas: deps.berkas,
        }));
        const tujuan = dirEntri(seg);
        rmSync(tujuan, { recursive: true, force: true });
        try {
          renameSync(sementara, tujuan);
        } catch (e) {
          if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e;
          rmSync(sementara, { recursive: true, force: true }); // render lain menulis entri yang sama lebih dulu
        }
      } catch (e) {
        rmSync(sementara, { recursive: true, force: true });
        return { disimpan: false, alasan: e.message };
      }
      return { disimpan: true };
    },
    hapus(seg) {
      rmSync(dirEntri(seg), { recursive: true, force: true });
    },
    /** Pangkas entri terlama (LRU menurut mtime meta.json) hingga total <= maksByte; entri `lindungi` tidak dihapus. */
    pangkas(maksByte, lindungi) {
      const hasil = { dihapus: 0, byte: 0 };
      if (!existsSync(dir)) return hasil;
      const entri = [];
      let total = 0;
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const jalur = join(dir, d.name);
        if (d.name.startsWith(".tmp-")) {
          const st = statSync(jalur, { throwIfNoEntry: false });
          if (st && Date.now() - st.mtimeMs > BATAS_SEMENTARA_MS) rmSync(jalur, { recursive: true, force: true });
          continue;
        }
        let ukuran = 0;
        let waktu = 0;
        try {
          for (const f of readdirSync(jalur)) ukuran += statSync(join(jalur, f)).size;
          waktu = statSync(join(jalur, "meta.json")).mtimeMs;
        } catch {}
        entri.push({ nama: d.name, jalur, ukuran, waktu });
        total += ukuran;
      }
      entri.sort((a, b) => a.waktu - b.waktu);
      for (const e of entri) {
        if (total <= maksByte) break;
        if (lindungi.has(e.nama)) continue;
        rmSync(e.jalur, { recursive: true, force: true });
        total -= e.ukuran;
        hasil.dihapus++;
        hasil.byte += e.ukuran;
      }
      return hasil;
    },
  };
}
