#!/usr/bin/env bun
/**
 * uji-penyunting.mjs — uji penyunting pratinjau lokal (scripts/penyunting.mjs dan scripts/penyunting/):
 * CLI dan kode keluar, pengerasan server (token, Host, Origin, rute daftar putih, tautan simbolik, CSP),
 * kesesuaian daftar track dengan Timeline.rencana, scrubber dan navigasi papan ketik, nama aksesibel
 * (pohon aksesibilitas CDP), frame pratinjau identik piksel dengan `render.mjs --still`, timeline yang
 * ditolak validator, tanpa permintaan jaringan non-lokal dan tanpa galat konsol, kontras token warna,
 * dan tampilan 320 px; penyuntingan dan ekspor (#55): model murni (pindah, ubah durasi, potong, urungkan; properti
 * acak ber-seed), pengerasan rute POST, ekspor atomik yang hanya bila validator lolos, alur E2E hanya dengan papan
 * ketik, seret, urungkan, dan frame pratinjau setelah sunting sama dengan `render.mjs --still` dari hasil ekspor. Fixture: templates/timeline-contoh disalin ke folder sementara (data fiktif).
 * Browser lewat playwright-core dan cariBrowser (scripts/browser.js), tanpa dependensi baru.
 * Butuh Chromium dan ffmpeg. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-penyunting.mjs [--hanya h]   # hanya uji yang namanya diawali "(h)"
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { cariBrowser } from "./browser.js";
import { muatKonteks, periksaTimeline } from "./timeline.mjs";
import { bagianTetap, tulisAtomik } from "./penyunting.mjs";

const akar = join(dirname(fileURLToPath(import.meta.url)), "..");
const penyuntingMjs = join(akar, "scripts", "penyunting.mjs");
const renderMjs = join(akar, "scripts", "render.mjs");
const siapkanMjs = join(akar, "templates", "timeline", "siapkan.mjs");
const indexTemplat = join(akar, "templates", "timeline", "index.html");
const templatContoh = join(akar, "templates", "timeline-contoh");
const dirHalaman = join(akar, "scripts", "penyunting");
const tmp = mkdtempSync(join(tmpdir(), "awvd-uji-penyunting-"));
const hanyaIdx = process.argv.indexOf("--hanya");
const hanya = hanyaIdx > 0 ? `(${process.argv[hanyaIdx + 1]})` : null;
const j = (...p) => join(tmp, ...p);
const muat = createRequire(import.meta.url);
const RT = muat("./runtime.js");
const TL = muat("./timeline.js");
const PY = muat("./penyunting/penyunting.js");
const MD = muat("./penyunting/model.js");

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
const tulisJson = (f, o) => writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);
const bacaJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const salin = (o) => JSON.parse(JSON.stringify(o));
async function md5Gambar(file) {
  const r = await jalankan(["ffmpeg", "-v", "error", "-i", file, "-f", "md5", "-"]);
  tegas(r.kode === 0, `ffmpeg md5 gagal: ${r.err}`);
  return r.out.trim();
}

// ------------------------------------------------------------------ proses penyunting
const POLA_URL = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{32})/;
/** Menjalankan CLI penyunting dan menunggu URL tercetak. */
async function mulaiPenyunting(timeline, ...tambahan) {
  const cache = tambahan.includes("--cache") ? [] : ["--cache", j("cache")];
  const proc = Bun.spawn(["bun", penyuntingMjs, timeline, "--port", "0", ...cache, ...tambahan], { stdout: "pipe", stderr: "pipe" });
  let out = "", err = "";
  const baca = async (s, tambah) => { for await (const c of s) tambah(Buffer.from(c).toString("utf8")); };
  baca(proc.stdout, (t) => { out += t; });
  baca(proc.stderr, (t) => { err += t; });
  const batas = Date.now() + 90000;
  let m = null;
  while (!(m = POLA_URL.exec(out)) && proc.exitCode === null && Date.now() < batas) await Bun.sleep(50);
  tegas(m, `URL penyunting tidak tercetak (exit ${proc.exitCode}):\n${out}${err}`);
  const s = {
    proc, port: Number(m[1]), token: m[2], url: m[0], base: `http://127.0.0.1:${m[1]}`, get out() { return out; }, get err() { return err; },
    async henti() {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(5000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      return proc.exited;
    },
  };
  return s;
}

/** Permintaan HTTP mentah (tanpa normalisasi klien): untuk Host, Origin, dan jalur yang akan dinormalisasi fetch. */
function mentah(port, baris, badan = "") {
  return new Promise((ok, tolak) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1", port,
      socket: {
        open(s) { s.write(`${baris.join("\r\n")}\r\n\r\n${badan}`); },
        data(_s, d) { buf += Buffer.from(d).toString("latin1"); },
        close() { ok({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1]), mentah: buf }); },
        error(_s, e) { tolak(e); },
        connectError(_s, e) { tolak(e); },
      },
    }).catch(tolak);
  });
}
const dapat = (s, path, { headers = {}, method = "GET", tanpaToken = false } = {}) =>
  fetch(`${s.base}${path}`, { method, headers: { ...(tanpaToken ? {} : { "X-Awvd-Token": s.token }), ...headers }, redirect: "manual" });

// ------------------------------------------------------------------ fixture
const dirDasar = j("dasar");
cpSync(templatContoh, dirDasar, { recursive: true });
const berkasDasar = join(dirDasar, "timeline.json");
const tl = bacaJson(berkasDasar);
const rencana = TL.rencana(tl);
const FRAME_UJI = [82, 147, 260, 350, 390, 420, 449]; // dalam transisi pudarMelalui, dalam transisi celup, tepi butir (pip-beku mulai), tanpa kanvas klip, awal kredit, teks kredit penuh, frame terakhir

const uji = [];
function daftar(nama, fn) { uji.push([nama, fn]); }

let utama = null; // sesi penyunting bersama untuk uji browser
let browser = null, ctx = null, page = null;
const galatKonsol = [], galatHalaman = [], permintaanAsing = [];
const BROWSER_ARGS = ["--allow-file-access-from-files", "--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars"];

async function pastikanUtama() {
  if (utama) return;
  utama = await mulaiPenyunting(berkasDasar);
  browser = await chromium.launch({ executablePath: cariBrowser(), headless: true, args: BROWSER_ARGS });
  ctx = await browser.newContext({ viewport: { width: 1920, height: 1300 }, deviceScaleFactor: 1 });
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(`${utama.base}/`)) return route.continue();
    permintaanAsing.push(u);
    return route.abort("blockedbyclient");
  });
  page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") galatKonsol.push(m.text()); });
  page.on("pageerror", (e) => galatHalaman.push(e.message));
  await page.goto(utama.url);
  await tungguFrame(0);
}
const tungguFrame = (n) => page.waitForSelector(`#komposisi[data-frame-tampil="${n}"]`, { timeout: 30000 });
async function keFrame(n) {
  await page.fill("#frame-angka", String(n));
  await page.press("#frame-angka", "Enter");
  await tungguFrame(n);
}
const frameKini = () => page.evaluate(() => Number(document.getElementById("scrubber").value));
const aktif = () => page.evaluate(() => {
  const a = document.activeElement;
  return { id: a.id, role: a.getAttribute("role"), dataId: a.getAttribute("data-id"), track: a.getAttribute("data-track"), tag: a.tagName };
});

// =============================================================== (a) CLI dan kode keluar
daftar("(a) CLI: URL 127.0.0.1 berisi token 128 bit, kode keluar argumen salah, berhenti bersih", async () => {
  const s = await mulaiPenyunting(berkasDasar);
  try {
    tegas(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/.test(s.url), `format URL ${s.url}`);
    tegas(s.port > 0, "port acak harus > 0");
    tegas(/7 track, 11 butir, 450 frame @ 30 fps/.test(s.out) && /validator: lolos/.test(s.out), `ringkasan CLI: ${s.out}`);
    const r = await dapat(s, "/api/sesi");
    tegas(r.status === 200, `GET /api/sesi ${r.status}`);
    // hanya 127.0.0.1: tidak ada soket di alamat lain (Linux: /proc/net/tcp; selain itu: alamat antarmuka non-loopback ditolak)
    if (existsSync("/proc/net/tcp")) {
      const hex = s.port.toString(16).toUpperCase().padStart(4, "0");
      const baris = readFileSync("/proc/net/tcp", "utf8").split("\n").filter((l) => l.includes(`:${hex} `) && /\s0A\s/.test(l));
      tegas(baris.length > 0, `soket mendengar port ${s.port} tidak ditemukan di /proc/net/tcp`);
      tegas(baris.every((l) => l.trim().split(/\s+/)[1] === `0100007F:${hex}`), `harus hanya 127.0.0.1: ${baris.join(" | ")}`);
    }
    const luar = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (luar) {
      let tersambung = true;
      try { await fetch(`http://${luar.address}:${s.port}/?token=${s.token}`, { signal: AbortSignal.timeout(3000) }); } catch { tersambung = false; }
      tegas(!tersambung, `server menjawab di alamat non-loopback ${luar.address}`);
    }
  } finally {
    const kode = await s.henti();
    tegas(kode === 0, `SIGTERM harus berhenti dengan kode 0, dapat ${kode}`);
  }
  const salah = await bun(penyuntingMjs, j("tidak-ada.json"));
  tegas(salah.kode === 2 && salah.err.includes("tidak ditemukan"), `berkas hilang: exit ${salah.kode} ${salah.err}`);
  writeFileSync(j("rusak.json"), "{ bukan json");
  const rusak = await bun(penyuntingMjs, j("rusak.json"));
  tegas(rusak.kode === 2 && rusak.err.includes("bukan JSON valid"), `JSON rusak: exit ${rusak.kode} ${rusak.err}`);
  const tanpaArg = await bun(penyuntingMjs);
  tegas(tanpaArg.kode === 2, `tanpa argumen: exit ${tanpaArg.kode}`);
  const portBurukCmd = await bun(penyuntingMjs, berkasDasar, "--port", "70000");
  tegas(portBurukCmd.kode === 2 && portBurukCmd.err.includes("--port tidak valid"), `port buruk: exit ${portBurukCmd.kode} ${portBurukCmd.err}`);
  const bantuan = await bun(penyuntingMjs, "--help");
  tegas(bantuan.kode === 0 && bantuan.out.includes("Pemakaian"), "--help");
});

// =============================================================== (b) pengerasan server
daftar("(b) server menolak: tanpa token, Host/Origin/Sec-Fetch-Site asing, metode selain GET, rute di luar daftar putih", async () => {
  await pastikanUtama();
  const s = utama;
  const rute = ["/", "/api/sesi", "/komposisi.html", "/__props.js", "/penyunting.js", "/penyunting.css", "/scripts/runtime.js", "/media/aset/aset/logo-contoh.svg"];
  for (const r of rute) {
    const a = await dapat(s, r, { tanpaToken: true });
    tegas(a.status === 403, `${r} tanpa token harus 403, dapat ${a.status}`);
    const b = await dapat(s, r, { tanpaToken: true, headers: { "X-Awvd-Token": "0".repeat(32) } });
    tegas(b.status === 403, `${r} token salah harus 403, dapat ${b.status}`);
    const c = await dapat(s, r);
    tegas(c.status === 200, `${r} dengan token harus 200, dapat ${c.status}`);
  }
  const lewatQuery = await fetch(`${s.base}/api/sesi?token=${s.token}`);
  tegas(lewatQuery.status === 200, `token lewat query: ${lewatQuery.status}`);
  const awal = await fetch(s.url);
  const cookie = /awvd_token=([0-9a-f]{32}); Path=\/; HttpOnly; SameSite=Strict/.exec(awal.headers.get("set-cookie") ?? "");
  tegas(cookie && cookie[1] === s.token, `cookie sesi: ${awal.headers.get("set-cookie")}`);
  const viaCookie = await fetch(`${s.base}/scripts/runtime.js`, { headers: { Cookie: `awvd_token=${s.token}` } });
  tegas(viaCookie.status === 200, `subsumber lewat cookie: ${viaCookie.status}`);

  const gk = (host, ekstra = []) => ["GET /api/sesi HTTP/1.1", `Host: ${host}`, `X-Awvd-Token: ${s.token}`, "Connection: close", ...ekstra];
  tegas((await mentah(s.port, gk("evil.example"))).status === 403, "Host asing harus 403");
  tegas((await mentah(s.port, gk(`evil.example:${s.port}`))).status === 403, "Host asing dengan port harus 403");
  tegas((await mentah(s.port, gk(`127.0.0.1:${s.port + 1}`))).status === 403, "port Host salah harus 403");
  tegas((await mentah(s.port, gk(`localhost:${s.port}`))).status === 200, "localhost:port harus 200");
  tegas((await mentah(s.port, gk(`127.0.0.1:${s.port}`, ["Origin: http://evil.example"]))).status === 403, "Origin asing harus 403");
  tegas((await mentah(s.port, gk(`127.0.0.1:${s.port}`, [`Origin: http://127.0.0.1:${s.port}`]))).status === 200, "Origin sama harus 200");
  tegas((await mentah(s.port, gk(`127.0.0.1:${s.port}`, ["Sec-Fetch-Site: cross-site"]))).status === 403, "Sec-Fetch-Site cross-site harus 403");
  tegas((await mentah(s.port, gk(`127.0.0.1:${s.port}`, ["Sec-Fetch-Site: same-origin"]))).status === 200, "Sec-Fetch-Site same-origin harus 200");

  for (const metode of ["POST", "PUT", "DELETE", "PATCH"]) {
    const a = await dapat(s, "/api/sesi", { method: metode, tanpaToken: true });
    tegas(a.status === 403, `${metode} tanpa token harus 403, dapat ${a.status}`);
    const b = await dapat(s, "/api/sesi", { method: metode });
    tegas(b.status === 405 && b.headers.get("allow") === "GET", `${metode} dengan token harus 405, dapat ${b.status}`);
  }
  for (const r of ["/tidak-ada", "/api", "/media", "/media/klip", "/media/klip/", "/media/aset", "/scripts", "/scripts/timeline.mjs", "/scripts/render.mjs",
    "/scripts/penyunting.mjs", "/package.json", "/templates/timeline/index.html", "/index.html", "/.git/config", "/penyunting"]) {
    const a = await dapat(s, r);
    tegas(a.status === 404, `${r} harus 404 (luar daftar putih), dapat ${a.status}`);
  }
});

daftar("(c) media: .. dan tautan simbolik keluar folder ditolak (404), hanya berkas yang disebut props yang dilayani", async () => {
  await pastikanUtama();
  const s = utama;
  const props = JSON.parse((await (await dapat(s, "/__props.js")).text()).replace(/^window\.videoProps = /, "").replace(/;\s*$/, ""));
  const folder = props.klip[0].folder;
  tegas(props.klip.every((k) => k.akar === "/media/klip") && props.akarAset === "/media/aset", `props memakai rute media: ${props.klip[0].akar} ${props.akarAset}`);
  tegas(!JSON.stringify(props).includes("file://"), "props tidak boleh memuat file://");
  const frames = readdirSync(j("cache", "klip", folder)).filter((f) => /^\d+\.(jpg|png)$/.test(f)).sort();
  tegas(frames.length > 0, "frame klip hasil ekstraksi tidak ditemukan");
  const sah = await dapat(s, `/media/klip/${folder}/${frames[0]}`);
  tegas(sah.status === 200 && /^image\//.test(sah.headers.get("content-type")), `frame klip sah: ${sah.status}`);
  tegas(sah.headers.get("content-security-policy").includes("sandbox"), "media harus ber-CSP sandbox");
  tegas(sah.headers.get("x-content-type-options") === "nosniff", "nosniff");
  const aset = Object.values(props.aset).find((e) => e.jenis === "logo");
  const sahAset = await dapat(s, `/media/aset/${aset.jalur}`);
  tegas(sahAset.status === 200 && sahAset.headers.get("content-type") === "image/svg+xml", `aset logo sah: ${sahAset.status}`);

  const jahat = [
    `/media/klip/%2e%2e/%2e%2e/etc/passwd`, `/media/klip/${folder}/..%2f..%2f..%2fetc%2fpasswd`, `/media/klip/${folder}/%2e%2e%2f%2e%2e%2fsumber.json`,
    `/media/klip/${folder}/..%5c..%5cx.jpg`, `/media/klip/${folder}/${frames[0]}%00.png`, `/media/klip/${folder}/atribusi.txt`, "/media/klip/folder-tak-ada/000000.jpg",
    `/media/klip/${folder}/`, `/media/klip/${folder}`, "/media/aset/..%2f..%2fpackage.json", "/media/aset/%2e%2e/%2e%2e/package.json", "/media/aset/timeline.json",
    "/media/aset/sumber.json", "/media/aset/aset/klip-a.mkv", "/media/aset/aset/", "/media/aset//aset/logo-contoh.svg",
  ];
  for (const r of jahat) {
    const a = await dapat(s, r);
    tegas(a.status === 404, `${r} harus 404, dapat ${a.status}`);
  }
  const mentahJahat = await mentah(s.port, [`GET /media/klip/../../../etc/passwd HTTP/1.1`, `Host: 127.0.0.1:${s.port}`, `X-Awvd-Token: ${s.token}`, "Connection: close"]);
  tegas(mentahJahat.status === 404, `.. mentah harus 404, dapat ${mentahJahat.status}`);

  // tautan simbolik keluar folder media: frame klip dan aset diganti simlink ke berkas di luar
  const rahasia = j("rahasia.jpg");
  writeFileSync(rahasia, "RAHASIA-BUKAN-GAMBAR");
  const frameSimlink = j("cache", "klip", folder, "000999.jpg");
  symlinkSync(rahasia, frameSimlink);
  const a1 = await dapat(s, `/media/klip/${folder}/000999.jpg`);
  tegas(a1.status === 404, `simlink frame klip harus 404, dapat ${a1.status}`);
  const berkasAset = join(dirDasar, aset.jalur);
  const cadangan = readFileSync(berkasAset);
  rmSync(berkasAset);
  symlinkSync(rahasia, berkasAset);
  try {
    const a2 = await dapat(s, `/media/aset/${aset.jalur}`);
    tegas(a2.status === 404, `simlink aset harus 404, dapat ${a2.status}`);
    tegas(!(await a2.text()).includes("RAHASIA"), "isi simlink tidak boleh bocor");
  } finally {
    rmSync(berkasAset);
    writeFileSync(berkasAset, cadangan);
    rmSync(frameSimlink);
  }
});

daftar("(d) header keamanan: CSP halaman tanpa unsafe-inline skrip, CSP komposisi berbasis hash, tanpa cache, tanpa referrer", async () => {
  await pastikanUtama();
  const s = utama;
  const h = await dapat(s, "/");
  const csp = h.headers.get("content-security-policy");
  tegas(csp.includes("default-src 'self'") && csp.includes("connect-src 'self'") && csp.includes("frame-ancestors 'self'") && csp.includes("object-src 'none'"), `CSP halaman: ${csp}`);
  tegas(!/script-src/.test(csp) && !/unsafe-eval/.test(csp), "halaman penyunting tidak boleh melonggarkan skrip");
  tegas(h.headers.get("cache-control") === "no-store" && h.headers.get("referrer-policy") === "no-referrer", "cache dan referrer");
  const k = await dapat(s, "/komposisi.html");
  const cspK = k.headers.get("content-security-policy");
  const skrip = /script-src ([^;]+)/.exec(cspK)?.[1] ?? "";
  tegas(/'sha256-[A-Za-z0-9+/=]+'/.test(skrip) && !/unsafe-inline|unsafe-eval/.test(skrip), `CSP komposisi: ${cspK}`);
  const html = await k.text();
  tegas(html.includes('<script src="/__props.js?v='), "props disuntik lewat satu tag skrip");
  const templat = readFileSync(indexTemplat, "utf8");
  tegas(html.replace(/<head>\n<script src="\/__props\.js\?v=[0-9a-f]+"><\/script>/, "<head>") === templat, "templat dilayani apa adanya selain satu tag props");
  const props = await dapat(s, "/__props.js");
  tegas(props.headers.get("content-type").startsWith("text/javascript"), "tipe props.js");
});

// =============================================================== (e) tampilan
daftar("(e) halaman memuat semua track dan butir sesuai timeline.json dan Timeline.rencana (jumlah, id, mulai, durasi, posisi)", async () => {
  await pastikanUtama();
  const dom = await page.evaluate(() => ({
    sel: [...document.querySelectorAll('[role="gridcell"]')].map((c) => ({ t: Number(c.dataset.track), b: Number(c.dataset.butir), id: c.dataset.id, mulai: Number(c.dataset.mulai), durasi: Number(c.dataset.durasi), left: parseFloat(c.style.left), width: parseFloat(c.style.width), jenis: c.dataset.jenis })),
    baris: [...document.querySelectorAll('#grid [role="row"]')].map((r) => ({ t: Number(r.dataset.track), kepala: r.querySelector('[role="rowheader"]').textContent })),
    lebarJalur: parseFloat(document.querySelector(".jalur").style.width),
    grid: document.getElementById("grid").getAttribute("role"),
  }));
  tegas(dom.grid === "grid", "role grid");
  tegas(dom.baris.length === tl.track.length, `jumlah track ${dom.baris.length} != ${tl.track.length}`);
  // urutan tampil: lapisan atas (indeks terbesar) di atas
  samaIsi(dom.baris.map((r) => r.t), tl.track.map((_, i) => tl.track.length - 1 - i), "urutan baris track");
  const total = rencana.track.reduce((n, tr) => n + tr.butir.length, 0);
  tegas(dom.sel.length === total, `jumlah butir ${dom.sel.length} != ${total}`);
  const ppf = dom.lebarJalur / rencana.proyek.durasi;
  rencana.track.forEach((tr, i) => {
    const sel = dom.sel.filter((c) => c.t === i);
    tegas(sel.length === tr.butir.length, `track ${i}: ${sel.length} butir, rencana ${tr.butir.length}`);
    tr.butir.forEach((b) => {
      const c = sel.find((x) => x.id === b.id);
      tegas(c, `butir ${b.id} tidak ada di DOM`);
      tegas(c.mulai === b.mulai && c.durasi === b.durasi && c.jenis === b.jenis, `butir ${b.id}: mulai/durasi/jenis ${c.mulai}/${c.durasi}/${c.jenis} != ${b.mulai}/${b.durasi}/${b.jenis}`);
      tegas(Math.abs(c.left - b.mulai * ppf) <= 1, `butir ${b.id}: left ${c.left} != ${(b.mulai * ppf).toFixed(2)}`);
      tegas(Math.abs(c.width - Math.max(24, b.durasi * ppf)) <= 1, `butir ${b.id}: lebar ${c.width} != ${Math.max(24, b.durasi * ppf).toFixed(2)}`);
    });
  });
  // transisi tampak sebagai irisan: butir bertransisi memuat penanda tumpang selebar durasi transisi
  const tumpang = await page.evaluate(() => [...document.querySelectorAll(".tumpang")].map((e) => ({ id: e.parentElement.dataset.id, d: Number(e.dataset.durasi), w: parseFloat(e.style.width) })));
  samaIsi(tumpang.map((x) => `${x.id}:${x.d}`).sort(), ["adegan-2:15", "adegan-3:15"], "irisan transisi");
  // tidak ada elemen yang lolos dari data: panel masalah memuat 0 galat untuk contoh
  tegas((await page.locator("#status").textContent()).startsWith("Lolos validator (0 galat, 0 peringatan)"), `status: ${await page.locator("#status").textContent()}`);
  tegas((await page.locator("#h-masalah").textContent()) === "Masalah (0)", "judul masalah");
  // sublajur: butir yang bertumpuk karena transisi tidak saling menutupi
  const posisi = await page.evaluate(() => [...document.querySelectorAll('.jalur[data-track="0"] .butir')].map((c) => ({ id: c.dataset.id, top: parseFloat(c.style.top) })));
  tegas(new Set(posisi.map((p) => p.top)).size >= 2, `butir bertumpuk harus di sublajur berbeda: ${JSON.stringify(posisi)}`);
});

// =============================================================== (f) scrubber
daftar("(f) scrubber: panah, Home, End, PageUp/PageDown 10 frame, kolom angka dijepit, tombol lompat, penanda; label dan aria-valuetext benar", async () => {
  await pastikanUtama();
  const durasi = rencana.proyek.durasi, akhir = durasi - 1;
  const slider = page.getByRole("slider", { name: "Posisi frame" });
  tegas(await slider.count() === 1, "slider berlabel 'Posisi frame'");
  tegas((await slider.getAttribute("min")) === "0" && (await slider.getAttribute("max")) === String(akhir) && (await slider.getAttribute("step")) === "1", "min/max/step scrubber");
  await slider.focus();
  const cek = async (n, teks) => {
    await tungguFrame(n);
    tegas((await frameKini()) === n, `scrubber di ${await frameKini()}, harapan ${n} (${teks})`);
    tegas((await page.locator("#frame-angka").inputValue()) === String(n), `kolom angka ${teks}`);
    const vt = await slider.getAttribute("aria-valuetext");
    const harapan = `frame ${n}, ${(n / 30).toFixed(2).replace(".", ",")} detik`;
    tegas(vt === harapan, `aria-valuetext "${vt}" != "${harapan}" (${teks})`);
    tegas((await page.title()).includes("Penyunting awvd"), "judul halaman");
    tegas((await page.locator("#komposisi").getAttribute("title")) === `Pratinjau frame ${n}`, `judul iframe ${teks}`);
  };
  await page.keyboard.press("End"); await cek(akhir, "End");
  await page.keyboard.press("Home"); await cek(0, "Home");
  await page.keyboard.press("ArrowRight"); await cek(1, "ArrowRight");
  await page.keyboard.press("ArrowRight"); await cek(2, "ArrowRight 2");
  await page.keyboard.press("ArrowLeft"); await cek(1, "ArrowLeft");
  await page.keyboard.press("PageUp"); await cek(11, "PageUp");
  await page.keyboard.press("PageUp"); await cek(21, "PageUp 2");
  await page.keyboard.press("PageDown"); await cek(11, "PageDown");
  await page.keyboard.press("PageDown"); await cek(1, "PageDown 2");
  await page.keyboard.press("PageDown"); await cek(0, "PageDown dijepit di 0");
  await page.keyboard.press("Home");
  await page.keyboard.press("End"); await page.keyboard.press("PageUp"); await cek(akhir, "PageUp dijepit di akhir");
  // kolom angka: nilai di luar jangkauan dijepit dan diumumkan
  await page.fill("#frame-angka", "99999"); await page.press("#frame-angka", "Enter");
  await cek(akhir, "angka 99999");
  tegas((await page.locator("#status").textContent()).includes(`dijepit ke ${akhir}`), `pengumuman jepit: ${await page.locator("#status").textContent()}`);
  await page.fill("#frame-angka", "-7"); await page.press("#frame-angka", "Enter");
  await cek(0, "angka -7");
  await page.fill("#frame-angka", "123"); await page.press("#frame-angka", "Enter");
  await cek(123, "angka 123");
  // tombol lompat
  await page.getByRole("button", { name: "Maju 1" }).click(); await cek(124, "Maju 1");
  await page.getByRole("button", { name: "Mundur 1" }).click(); await cek(123, "Mundur 1");
  await page.getByRole("button", { name: "Akhir" }).click(); await cek(akhir, "tombol Akhir");
  await page.getByRole("button", { name: "Awal" }).click(); await cek(0, "tombol Awal");
  // penanda dari timeline.json
  const opsi = await page.locator("#penanda option").allTextContents();
  samaIsi(opsi, ["Lompat ke penanda...", "Pembuka (frame 0)", "Kredit (frame 390)"], "opsi penanda");
  await page.getByLabel("Penanda").selectOption("390");
  await cek(390, "penanda Kredit");
  tegas((await page.locator("#status").textContent()).includes("Lompat ke penanda Kredit"), "pengumuman penanda");
  // ruler: klik menaruh playhead
  await page.locator("#penggaris").click({ position: { x: 5, y: 5 } });
  await cek(Math.round(5 / (parseFloat(await page.locator(".jalur").first().evaluate((e) => e.style.width)) / durasi)), "klik penggaris");
  await keFrame(0);
});

daftar("(g) pemutaran: Spasi di scrubber memutar dan menjeda; bawaan jeda; zum menggeser tik penggaris", async () => {
  await pastikanUtama();
  await keFrame(0);
  tegas((await page.locator("#putar").textContent()) === "Putar", "bawaan jeda");
  await page.getByRole("slider", { name: "Posisi frame" }).focus();
  await page.keyboard.press(" ");
  tegas((await page.locator("#putar").textContent()) === "Jeda", "Spasi memutar");
  await page.waitForFunction(() => Number(document.getElementById("scrubber").value) >= 5, null, { timeout: 15000 });
  await page.keyboard.press(" ");
  tegas((await page.locator("#putar").textContent()) === "Putar", "Spasi menjeda");
  const f1 = await frameKini();
  await Bun.sleep(300);
  tegas((await frameKini()) === f1, "frame tidak bergerak setelah jeda");
  await tungguFrame(f1);
  // zum: lebar jalur berlipat dan tik berubah
  const lebar0 = await page.locator(".jalur").first().evaluate((e) => parseFloat(e.style.width));
  await page.getByRole("button", { name: "Zum +" }).click();
  const lebar1 = await page.locator(".jalur").first().evaluate((e) => parseFloat(e.style.width));
  tegas(Math.abs(lebar1 - 2 * lebar0) <= 1, `zum 200%: ${lebar0} -> ${lebar1}`);
  tegas((await page.locator("#zum").textContent()) === "200%", "keluaran zum");
  const apakahGulir = await page.locator("#gulir-track").evaluate((e) => e.scrollWidth > e.clientWidth);
  tegas(apakahGulir, "area track harus bergulir setelah zum");
  await page.getByRole("button", { name: "Zum -" }).click();
  tegas((await page.locator("#zum").textContent()) === "100%", "zum kembali 100%");
  await page.getByRole("button", { name: "Zum -" }).click();
  tegas((await page.locator("#status").textContent()).includes("minimum"), "zum minimum diumumkan");
  await keFrame(0);
});

// =============================================================== (h) papan ketik di grid
daftar("(h) widget track: panah, Home/End, atas/bawah, Enter; satu sel dapat fokus; urutan tab; tanpa jebakan fokus", async () => {
  await pastikanUtama();
  const stop = await page.evaluate(() => [...document.querySelectorAll('[role="gridcell"][tabindex="0"]')].length);
  tegas(stop === 1, `tepat satu gridcell dengan tabindex=0, dapat ${stop}`);
  await page.locator('[role="gridcell"][tabindex="0"]').focus();
  // pindah ke butir pertama track 0 lewat klik, lalu navigasi
  await page.locator('[role="gridcell"][data-id="adegan-1"]').click();
  tegas((await aktif()).dataId === "adegan-1", "klik memfokuskan butir");
  const urut0 = rencana.track[0].butir.map((b) => b.id);
  samaIsi(urut0, ["adegan-1", "adegan-2", "adegan-3"], "urutan butir track 0");
  await page.keyboard.press("ArrowRight"); tegas((await aktif()).dataId === "adegan-2", "ArrowRight");
  await page.keyboard.press("ArrowRight"); tegas((await aktif()).dataId === "adegan-3", "ArrowRight 2");
  await page.keyboard.press("ArrowRight"); tegas((await aktif()).dataId === "adegan-3", "ArrowRight di ujung tetap");
  await page.keyboard.press("Home"); tegas((await aktif()).dataId === "adegan-1", "Home");
  await page.keyboard.press("End"); tegas((await aktif()).dataId === "adegan-3", "End");
  await page.keyboard.press("ArrowLeft"); tegas((await aktif()).dataId === "adegan-2", "ArrowLeft");
  // Atas = lapisan lebih atas (track 1, pip: butir paling dekat dengan mulai adegan-2 = 75 -> pip-balik 200)
  await page.keyboard.press("ArrowUp");
  let a = await aktif();
  tegas(a.track === "1" && a.dataId === "pip-balik", `ArrowUp dari adegan-2: ${JSON.stringify(a)}`);
  await page.keyboard.press("ArrowDown");
  a = await aktif();
  tegas(a.track === "0" && a.dataId === "adegan-3", `ArrowDown dari pip-balik (mulai 200): butir terdekat waktunya ${JSON.stringify(a)}`);
  await page.keyboard.press("ArrowDown"); // track 0 paling bawah: tetap
  tegas((await aktif()).dataId === "adegan-3", "ArrowDown di track terbawah tetap");
  // Atas berulang melewati track: t-logo (2), t-teks-1 (3), t-teks-2 (4), a-narasi (5), a-musik (6)
  const jalur = [];
  for (let i = 0; i < 7; i++) { await page.keyboard.press("ArrowUp"); jalur.push((await aktif()).track); }
  samaIsi(jalur, ["1", "2", "3", "4", "5", "6", "6"], "naik antar track");
  // seleksi mengikuti fokus (aria-selected) dan panel properti memuat butir terpilih
  const terpilih = await page.evaluate(() => [...document.querySelectorAll('[role="gridcell"][aria-selected="true"]')].map((c) => c.dataset.id));
  samaIsi(terpilih, ["musik-1"], "aria-selected");
  tegas((await page.locator("#isi-properti").textContent()).includes("musik-1"), "panel properti");
  // Enter: playhead ke awal butir
  await page.locator('[role="gridcell"][data-id="adegan-3"]').focus();
  await page.keyboard.press("Enter");
  await tungguFrame(140);
  tegas((await frameKini()) === 140, "Enter menaruh playhead di awal butir (140)");
  tegas((await page.locator("#status").textContent()).includes("awal butir adegan-3"), "pengumuman Enter");
  await page.getByRole("button", { name: "Ke awal butir" }).click();
  // urutan tab: kontrol pratinjau, scrubber, lalu track; Tab keluar dari grid (tanpa jebakan)
  await page.locator("#h-pratinjau").click(); // titik awal navigasi fokus berurutan: judul pratinjau (tidak dapat difokuskan)
  const urutanTab = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const d = await page.evaluate(() => {
      const a = document.activeElement;
      return a === document.body ? null : (a.id || a.getAttribute("role") || a.tagName.toLowerCase()) + (a.getAttribute("role") === "gridcell" ? ":" + a.dataset.id : "");
    });
    if (d === null || urutanTab.includes(d)) break;
    urutanTab.push(d);
  }
  const i = (n) => urutanTab.findIndex((x) => x === n || x.startsWith(`${n}:`));
  tegas(i("gulir-pratinjau") >= 0 && i("scrubber") > i("gulir-pratinjau"), `pratinjau sebelum scrubber: ${urutanTab.join(" > ")}`);
  tegas(i("gridcell") > i("scrubber"), `scrubber sebelum track: ${urutanTab.join(" > ")}`);
  tegas(urutanTab.filter((x) => x.startsWith("gridcell")).length === 1, `grid hanya satu perhentian tab: ${urutanTab.join(" > ")}`);
  tegas(i("gridcell") < urutanTab.length - 1, `fokus keluar dari grid dengan Tab: ${urutanTab.join(" > ")}`);
  await keFrame(0);
});

daftar("(i) pohon aksesibilitas: semua kontrol interaktif bernama, landmark, rowheader, iframe berjudul", async () => {
  await pastikanUtama();
  const cdp = await ctx.newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const nama = (n) => (n.name?.value ?? "").trim();
  const peran = (n) => n.role?.value;
  const interaktif = new Set(["button", "slider", "spinbutton", "combobox", "PopUpButton", "radio", "gridcell", "link", "checkbox", "textbox", "DisclosureTriangle", "menuitem", "tab"]);
  const kena = nodes.filter((n) => !n.ignored && interaktif.has(peran(n)));
  tegas(kena.length >= 20, `terlalu sedikit kontrol interaktif terdeteksi: ${kena.length}`);
  const tanpaNama = kena.filter((n) => nama(n) === "").map((n) => peran(n));
  tegas(tanpaNama.length === 0, `kontrol tanpa nama aksesibel: ${tanpaNama.join(", ")}`);
  const butirNama = kena.filter((n) => peran(n) === "gridcell").map(nama);
  tegas(butirNama.length === 11, `gridcell ${butirNama.length}`);
  tegas(butirNama.includes("adegan-2, video, mulai frame 75, durasi 80 frame, bertransisi pudarMelalui 15 frame"), `nama gridcell: ${butirNama.join(" | ")}`);
  const sliderNama = kena.filter((n) => peran(n) === "slider").map(nama);
  samaIsi(sliderNama, ["Posisi frame"], "slider");
  const rowheader = nodes.filter((n) => !n.ignored && peran(n) === "rowheader").map(nama);
  tegas(rowheader.length === tl.track.length && rowheader.every((x) => x.length > 0), `rowheader ${rowheader.length}`);
  const peranTampil = new Set(nodes.filter((n) => !n.ignored).map(peran));
  for (const r of ["banner", "main", "complementary", "grid", "region", "status"]) tegas(peranTampil.has(r), `peran ${r} harus ada: ${[...peranTampil].join(", ")}`);
  const landmark = await page.evaluate(() => ({ lang: document.documentElement.lang, h1: document.querySelectorAll("h1").length, live: document.getElementById("status").getAttribute("aria-live") }));
  samaIsi(landmark, { lang: "id", h1: 1, live: "polite" }, "lang, h1, aria-live");
  const iframe = nodes.find((n) => !n.ignored && /^Iframe|iframe$/i.test(peran(n) ?? ""));
  tegas(!iframe || nama(iframe).startsWith("Pratinjau frame"), `iframe berjudul: ${iframe && nama(iframe)}`);
  tegas((await page.locator("#komposisi").getAttribute("title")).startsWith("Pratinjau frame"), "judul iframe");
  // sasaran 24 x 24 px untuk kontrol yang dapat ditekan (SC 2.5.8)
  const kecil = await page.evaluate(() => [...document.querySelectorAll('button, [role="gridcell"], summary, select, input:not([type="range"]):not([type="radio"])')]
    .map((e) => ({ id: e.id || e.dataset.id || e.textContent.trim().slice(0, 20), r: e.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0 && (x.r.width < 24 || x.r.height < 24)).map((x) => `${x.id} ${x.r.width}x${x.r.height}`));
  tegas(kecil.length === 0, `sasaran < 24 px: ${kecil.join(", ")}`);
  await cdp.detach();
});

// =============================================================== (j) frame sama dengan render
daftar("(j) frame pratinjau 100% identik piksel dengan render.mjs --still (dalam transisi, tepi butir, awal kredit, akhir)", async () => {
  await pastikanUtama();
  const siap = await bun(siapkanMjs, berkasDasar, "--out", j("siap"));
  tegas(siap.kode === 0, `siapkan: ${siap.err}${siap.out}`);
  const ukuran = await page.locator("#komposisi").evaluate((e) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, x: e.getBoundingClientRect().x, y: e.getBoundingClientRect().y }));
  tegas(ukuran.w === 1280 && ukuran.h === 720, `mode 100%: iframe ${ukuran.w}x${ukuran.h}`);
  const ringkas = [];
  for (const n of FRAME_UJI) {
    // pemanasan yang sama dengan render-sesi.mjs (JUMLAH_PEMANASAN = 2): dua frame terdekat sebelum n ditangkap dan dibuang
    for (const w of [Math.max(0, n - 2), Math.max(0, n - 1)]) { await keFrame(w); await page.locator("#komposisi").screenshot(); }
    await keFrame(n);
    const png = j(`pen-${n}.png`);
    writeFileSync(png, await page.locator("#komposisi").screenshot());
    const keluar = j(`render-${n}.png`);
    const r = await bun(renderMjs, indexTemplat, "--props-file", j("siap", "props.json"), "--still", String(n), "--out", keluar);
    tegas(r.kode === 0, `render --still ${n}: exit ${r.kode} ${r.err}`);
    const [a, b] = [await md5Gambar(png), await md5Gambar(keluar)];
    tegas(a === b, `frame ${n}: tangkapan penyunting ${a} != render ${b}`);
    ringkas.push(`${n}:${a.slice(4, 12)}`);
  }
  // sanity: frame berbeda menghasilkan piksel berbeda (uji tidak lolos karena gambar kosong)
  tegas(new Set(ringkas.map((x) => x.split(":")[1])).size >= 5, `frame uji harus cukup beragam: ${ringkas.join(" ")}`);
  await keFrame(0);
});

// =============================================================== (k) timeline ditolak, draf, besar
daftar("(k) timeline yang ditolak validator tetap dibuka: galat berlokasi di panel masalah dan terhubung ke butir", async () => {
  const dir = j("ditolak");
  cpSync(templatContoh, dir, { recursive: true });
  const t = bacaJson(join(dir, "timeline.json"));
  t.track[1].butir[1].id = t.track[1].butir[0].id; // id ganda (R01)
  t.track[0].butir[2].mulai = 100; // tumpang tindih dengan adegan-2 yang tak sesuai transisi
  tulisJson(join(dir, "timeline.json"), t);
  const s = await mulaiPenyunting(join(dir, "timeline.json"), "--cache", j("cache-ditolak"));
  const b2 = await browser.newContext({ viewport: { width: 1920, height: 1300 } });
  try {
    const sesi = await (await dapat(s, "/api/sesi")).json();
    tegas(sesi.validasi.lolos === false && sesi.validasi.galat.length >= 2, `validasi: ${JSON.stringify(sesi.validasi.galat)}`);
    tegas(sesi.validasi.galat.some((x) => x.kode === "R01" && /^\/track\/1\/butir\/1/.test(x.lok)), `R01 berlokasi: ${JSON.stringify(sesi.validasi.galat)}`);
    tegas(s.out.includes("validator: DITOLAK"), `CLI melaporkan penolakan: ${s.out}`);
    const p2 = await b2.newPage();
    const galat = [];
    p2.on("pageerror", (e) => galat.push(e.message));
    await p2.goto(s.url);
    await p2.waitForSelector("#daftar-masalah li button");
    tegas((await p2.locator("#status").textContent()).startsWith("Ditolak validator"), `status: ${await p2.locator("#status").textContent()}`);
    const teks = await p2.locator("#daftar-masalah").textContent();
    tegas(/galat \[R01\] \/track\/1\/butir\/1/.test(teks), `masalah berlokasi: ${teks}`);
    tegas(/Masalah \(\d+\)/.test(await p2.locator("#h-masalah").textContent()), "judul masalah memuat jumlah");
    // klik masalah menaruh fokus ke butir terkait
    await p2.locator("#daftar-masalah li button", { hasText: "R01" }).first().click();
    const a = await p2.evaluate(() => ({ id: document.activeElement.dataset.id, t: document.activeElement.dataset.track, b: document.activeElement.dataset.butir, sel: document.activeElement.getAttribute("aria-selected") }));
    tegas(a.t === "1" && a.b === "1" && a.sel === "true", `fokus ke butir terkait: ${JSON.stringify(a)}`);
    tegas((await p2.locator("#isi-properti").textContent()).includes("Masalah terkait: "), "panel properti memuat jumlah masalah terkait");
    // komposisi menolak timeline itu (galat dari timeline.js di iframe), tetapi halaman penyunting tetap hidup dan memberi tahu
    tegas(galat.length > 0 && galat.every((x) => x.startsWith("timeline.js:")), `galat halaman harus hanya dari komposisi: ${galat.join("; ")}`);
    await p2.waitForSelector("#galat-pratinjau:not([hidden])");
    tegas((await p2.locator("#galat-pratinjau").textContent()).startsWith("Pratinjau tidak tersedia"), "pesan pratinjau tidak tersedia");
    tegas((await p2.locator("#galat-pratinjau").getAttribute("role")) === "alert", "pesan galat pratinjau memakai role=alert");
    await p2.keyboard.press("End"); // halaman tetap responsif
    tegas((await p2.evaluate(() => document.activeElement === document.body || document.activeElement !== null)), "halaman responsif");
    tegas((await p2.locator('[role="gridcell"]').count()) === 11, "semua butir tetap tergambar");
  } finally {
    await b2.close();
    await s.henti();
  }
});

daftar("(l) --draf diteruskan ke validator dan klip (gerbang hukum GH belum disetujui: galat tanpa --draf, peringatan DRAF dengan --draf)", async () => {
  const dir = j("draf");
  cpSync(templatContoh, dir, { recursive: true });
  const t = bacaJson(join(dir, "timeline.json"));
  t.track.push({ id: "t-cap", jenis: "teks", butir: [{ id: "cap-kutipan", jenis: "teks", peran: "caption", isi: "Komentar atas kutipan (fiktif)", mulai: 75, durasi: 80, gaya: { ukuran: 40 }, tata: { x: 80, y: 560, lebar: 1100, tinggi: 60 } }] });
  tulisJson(join(dir, "timeline.json"), t);
  const sm = bacaJson(join(dir, "sumber.json"));
  sm.proyek.kebijakanKutipan = { sumberMaksPersen: 100, videoMaksPersen: 30, catatanIzinTertulis: "catatan fiktif untuk uji (sumber contoh hanya 4 detik; klip.mjs menghitung seluruh klip)" };
  sm.proyek.durasiVideoDetik = 15; // sama dengan jadwal turunan timeline (450 frame / 30 fps)
  sm.klip[1].mulaiVideo = 2.5;
  sm.proyek.komentar = [{ mulai: 2.5, akhir: 155 / 30, jenis: "caption" }, { mulai: 160 / 30, akhir: 250 / 30, jenis: "narasi" }];
  Object.assign(sm.sumber[1], {
    lisensi: "KUTIPAN-WAJAR", caraPerolehan: "milik-sendiri", tanggalAkses: "2026-11-07",
    kutipan: { tujuan: "ulasan", isiAudio: "ucapan", musikDibahas: false, menyasarKarya: true, bukanBagianKhas: true, perubahanMakna: false, orangDikenali: false, sintetis: false },
  });
  tulisJson(join(dir, "sumber.json"), sm);
  const tanpa = await mulaiPenyunting(join(dir, "timeline.json"), "--cache", j("cache-draf-a"));
  try {
    const sesi = await (await dapat(tanpa, "/api/sesi")).json();
    tegas(sesi.draf === false && sesi.validasi.lolos === false, `tanpa --draf: ${JSON.stringify(sesi.validasi.galat)} ${JSON.stringify(sesi.masalahMuat)}`);
    tegas(sesi.validasi.galat.some((x) => /gerbang hukum GH/.test(x.pesan)) || sesi.masalahMuat.some((x) => /gerbang hukum GH/.test(x.pesan)), "gerbang GH harus menolak tanpa --draf");
  } finally { await tanpa.henti(); }
  const dengan = await mulaiPenyunting(join(dir, "timeline.json"), "--draf", "--cache", j("cache-draf-b"));
  try {
    const sesi = await (await dapat(dengan, "/api/sesi")).json();
    tegas(sesi.draf === true && sesi.masalahMuat.length === 0, `--draf: ${JSON.stringify(sesi.masalahMuat)}`);
    tegas(!sesi.validasi.galat.some((x) => /gerbang hukum GH/.test(x.pesan)) && sesi.validasi.peringatan.some((x) => /DRAF: gerbang hukum GH/.test(x.pesan)), `--draf: ${JSON.stringify(sesi.validasi)}`);
    tegas(dengan.out.includes("validator: lolos"), `CLI --draf: ${dengan.out}`);
  } finally { await dengan.henti(); }
});

daftar("(m) timeline besar (500 butir) tetap dibuka cepat: semua butir tergambar, tanpa galat", async () => {
  const dir = j("besar");
  mkdirSync(dir, { recursive: true });
  const butir = Array.from({ length: 500 }, (_, i) => ({ id: `w-${i}`, jenis: "warna", warna: i % 2 ? "#112233" : "#223344", mulai: i, durasi: 1 }));
  const t = { skema: 1, proyek: { judul: "Timeline sintetis 500 butir (fiktif)", lebar: 1280, tinggi: 720, fps: 30, durasi: 500, jenisVideo: "promo", latar: "#000000" }, track: [{ id: "t-warna", jenis: "video", butir }] };
  tulisJson(join(dir, "timeline.json"), t);
  const s = await mulaiPenyunting(join(dir, "timeline.json"), "--cache", j("cache-besar"));
  const b2 = await browser.newContext({ viewport: { width: 1920, height: 1300 } });
  try {
    const p2 = await b2.newPage();
    const galat = [];
    p2.on("pageerror", (e) => galat.push(e.message));
    const t0 = performance.now();
    await p2.goto(s.url);
    await p2.waitForSelector('#komposisi[data-frame-tampil="0"]', { timeout: 30000 });
    const dt = performance.now() - t0;
    tegas((await p2.locator('[role="gridcell"]').count()) === 500, "500 butir tergambar");
    tegas(dt < 15000, `pembukaan 500 butir ${dt.toFixed(0)} ms (> 15000)`);
    await p2.locator('[role="gridcell"][data-id="w-250"]').focus();
    await p2.keyboard.press("End");
    tegas((await p2.evaluate(() => document.activeElement.dataset.id)) === "w-499", "End di 500 butir");
    tegas(galat.length === 0, `galat halaman: ${galat.join("; ")}`);
    console.log(`        500 butir dibuka dalam ${dt.toFixed(0)} ms`);
  } finally { await b2.close(); await s.henti(); }
});

// =============================================================== (n) tampilan sempit, tema, kontras
daftar("(n) lebar 320 px: halaman tanpa gulir horizontal; area track dan pratinjau bergulir sendiri dan dapat difokuskan", async () => {
  await pastikanUtama();
  const b2 = await browser.newContext({ viewport: { width: 320, height: 700 } });
  try {
    const p2 = await b2.newPage();
    await p2.goto(utama.url);
    await p2.waitForSelector('#komposisi[data-frame-tampil="0"]', { timeout: 30000 });
    const m = await p2.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth,
      trackGulir: document.getElementById("gulir-track").scrollWidth > document.getElementById("gulir-track").clientWidth,
      tab1: document.getElementById("gulir-track").tabIndex, tab2: document.getElementById("gulir-pratinjau").tabIndex }));
    tegas(m.sw <= m.cw && m.bw <= m.cw, `gulir horizontal halaman: scrollWidth ${m.sw} > ${m.cw}`);
    tegas(m.tab1 === 0 && m.tab2 === 0, "area gulir dapat difokuskan");
    // mode "muat ke panel": iframe diskalakan, tetap tanpa gulir horizontal halaman
    await p2.getByLabel("Muat ke panel").check();
    const t2 = await p2.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, tr: document.getElementById("komposisi").style.transform }));
    tegas(t2.sw <= t2.cw && /^scale\(/.test(t2.tr), `mode panel: ${JSON.stringify(t2)}`);
    // zum teks 200% (padanan: lebar 160 CSS px) tetap tanpa gulir horizontal halaman
    await p2.setViewportSize({ width: 160, height: 700 });
    await Bun.sleep(100);
    const sempit = await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    tegas(sempit, "lebar 160 px (padanan reflow zum 200% pada 320 px) tanpa gulir horizontal halaman");
  } finally { await b2.close(); }
});

function bacaToken(css, blok) {
  const peta = {};
  for (const m of blok.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) peta[m[1]] = m[2];

  return peta;
}
daftar("(o) kontras token warna lolos ambang pada tema terang dan gelap (kontras dari runtime.js); gelap benar-benar dipakai", async () => {
  const css = readFileSync(join(dirHalaman, "penyunting.css"), "utf8");
  const terang = bacaToken(css, /:root\s*{([^}]*)}/.exec(css)[1]);
  const gelapBlok = /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}/.exec(css)[1];
  const gelap = { ...terang, ...bacaToken(css, gelapBlok) };
  // [teks, latar, ambang, keterangan]: teks >= 4,5; komponen UI, batas, dan fokus >= 3
  const pasangan = [
    ["teks", "latar", 4.5], ["teks", "panel", 4.5], ["redup", "latar", 4.5], ["redup", "panel", 4.5], ["teks", "tombol", 4.5], ["redup", "tombol", 4.5],
    ["butir-teks", "butir-latar", 4.5], ["galat", "latar", 4.5], ["galat", "panel", 4.5], ["peringatan", "latar", 4.5], ["peringatan", "panel", 4.5],
    ["aksen", "latar", 3], ["aksen", "panel", 3], ["latar", "butir-garis", 4.5],
    ["garis", "latar", 3], ["garis", "panel", 3], ["garis", "tombol", 3], ["fokus", "latar", 3], ["fokus", "panel", 3],
    ["butir-garis", "panel", 3], ["butir-garis", "butir-latar", 3], ["pilih", "panel", 3], ["pilih", "butir-latar", 3], ["kepala", "panel", 3],
  ];
  for (const [nama, peta] of [["terang", terang], ["gelap", gelap]]) {
    for (const [a, b, min] of pasangan) {
      tegas(peta[a] && peta[b], `token ${a} atau ${b} tidak ditemukan (${nama})`);
      const r = RT.kontras(peta[a], peta[b]);
      tegas(r >= min, `tema ${nama}: kontras ${a} (${peta[a]}) terhadap ${b} (${peta[b]}) = ${r.toFixed(2)} < ${min}`);
    }
  }
  tegas(terang.latar !== gelap.latar && terang.teks !== gelap.teks, "tema gelap harus mengubah token");
  await pastikanUtama();
  const b2 = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: "dark" });
  try {
    const p2 = await b2.newPage();
    await p2.goto(utama.url);
    await p2.waitForSelector("#grid");
    const warna = await p2.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color }));
    const rgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(", ")})`;
    tegas(warna.bg === rgb(gelap.latar) && warna.fg === rgb(gelap.teks), `tema gelap dipakai: ${JSON.stringify(warna)}`);
  } finally { await b2.close(); }
});

daftar("(p) tanpa animasi atau transisi CSS, tanpa Date.now/Math.random di halaman; logika murni (jepit, pointer, sublajur, tik, tetangga, normalisasi)", async () => {
  const css = readFileSync(join(dirHalaman, "penyunting.css"), "utf8");
  tegas(!/@keyframes/.test(css), "CSS tidak boleh memuat @keyframes");
  const tanpaReset = css.split("\n").filter((l) => /(^|[\s;{])(animation|transition)\s*:/.test(l) && !/(animation|transition):\s*none\s*!important/.test(l));
  tegas(tanpaReset.length === 0, `animation/transition selain 'none': ${tanpaReset.join(" | ")}`);
  const js = readFileSync(join(dirHalaman, "penyunting.js"), "utf8");
  tegas(!/Date\.now|Math\.random|new Date\(/.test(js), "halaman penyunting tidak boleh memakai Date.now atau Math.random");
  tegas(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js.replace(/\/\*[\s\S]*?\*\//g, "")), "teks timeline dipasang lewat textContent saja");

  tegas(PY.jepit(5, 0, 10) === 5 && PY.jepit(-3, 0, 10) === 0 && PY.jepit(99, 0, 10) === 10 && PY.jepit("x", 0, 10) === 0 && PY.jepit(2.6, 0, 10) === 3, "jepit");
  samaIsi(PY.bacaPointer("/track/3/butir/1/mulai"), { track: 3, butir: 1 }, "pointer butir");
  samaIsi(PY.bacaPointer("/track/3"), { track: 3, butir: null }, "pointer track");
  tegas(PY.bacaPointer("/proyek/durasi") === null && PY.bacaPointer("") === null && PY.bacaPointer(undefined) === null, "pointer lain");
  const sub = PY.aturSublajur([{ mulai: 0, akhir: 90 }, { mulai: 75, akhir: 155 }, { mulai: 140, akhir: 450 }]);
  samaIsi(sub, { lajur: [0, 1, 0], jumlah: 2 }, "sublajur");
  tegas(PY.langkahTik(1, 30, 70) >= 70 && PY.langkahTik(100, 30, 70) === 3 && PY.langkahTik(0.0001, 30, 70) > 0, "langkah tik");
  tegas(PY.nilaiTeks(75, 30) === "frame 75, 2,50 detik", "nilaiTeks");
  const model = { urut: [[0, 1, 2], [], [0]], mulai: [{ 0: 0, 1: 75, 2: 140 }, {}, { 0: 100 }] };
  samaIsi(PY.tetangga(model, { t: 0, b: 1 }, "ArrowUp"), { t: 2, b: 0 }, "atas melewati track kosong");
  samaIsi(PY.tetangga(model, { t: 2, b: 0 }, "ArrowDown"), { t: 0, b: 1 }, "bawah terdekat waktunya (75 vs 140 dari 100)");
  samaIsi(PY.tetangga(model, { t: 0, b: 2 }, "ArrowRight"), { t: 0, b: 2 }, "kanan di ujung");
  const aneh = PY.normalisasi({ proyek: { fps: "x", durasi: -5 }, track: [null, { butir: "bukan array" }, { id: 7, jenis: [], butir: [null, 3, { mulai: "a", durasi: 0 }, { id: "ok", jenis: "warna", mulai: 5, durasi: 10 }] }], penanda: [1, { pada: -1 }, { id: "p", pada: 3, label: "L" }] });
  tegas(aneh.fps === 30 && aneh.durasi === 15 && aneh.track.length === 3 && aneh.track[2].butir.length === 2 && aneh.penanda.length === 1, `normalisasi defensif: ${JSON.stringify(aneh)}`);
  tegas(PY.normalisasi(null).track.length === 0 && PY.normalisasi(undefined).durasi === 1, "normalisasi null");
});

// =============================================================== (q)-(r) model suntingan murni (#55)
function bekukan(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(bekukan); }
  return o;
}
const semuaButir = (t) => t.track.flatMap((tr, i) => tr.butir.map((b, j) => ({ b, i, j })));
const butirDi = (t, id) => semuaButir(t).find((x) => x.b.id === id)?.b;
const ringkasButir = (t, trk) => t.track[trk].butir.map((b) => `${b.id}:${b.mulai}+${b.durasi}${b.transisi ? `/t${b.transisi.durasi}` : ""}`);

daftar("(q) model: pindah, ubah durasi, dan potong pada video bertransisi, teks, warna, dan audio; transisi disinkronkan (R05); masukan tidak bermutasi; urungkan byte-identik", () => {
  const dasar = bekukan(salin(tl)); // beku: mutasi apa pun melempar (modul ber-"use strict")
  const asli = JSON.stringify(dasar);

  // video bertransisi (adegan-2: mulai 75, durasi 80, pudarMelalui 15 dengan adegan-1 [0,90); adegan-3 celup 15 dengan adegan-2)
  let r = MD.pindah(dasar, "adegan-2", 70);
  tegas(r.ok && r.berubah && butirDi(r.timeline, "adegan-2").mulai === 70, `pindah adegan-2: ${JSON.stringify(r)}`);
  tegas(butirDi(r.timeline, "adegan-2").transisi.durasi === 20, "transisi adegan-2 disetel ke tumpang tindih baru (20)");
  tegas(butirDi(r.timeline, "adegan-3").transisi.durasi === 10, "transisi adegan-3 ikut disetel (tumpang tindih dengan adegan-2 menyusut ke 10)");
  tegas(r.catatan.length === 2 && /dipindah ke mulai frame 70/.test(r.ringkas), `catatan: ${r.catatan}`);
  tegas(JSON.stringify(dasar) === asli, "masukan tidak boleh berubah");
  r = MD.pindah(dasar, "adegan-2", 91); // tak lagi bertumpang dengan adegan-1: transisi dihapus (dapat diurungkan); adegan-3 menyesuaikan
  tegas(r.ok && butirDi(r.timeline, "adegan-2").transisi === undefined && butirDi(r.timeline, "adegan-3").transisi.durasi === 31, `hapus transisi: ${ringkasButir(r.timeline, 0)}`);
  tegas(r.catatan.some((c) => /Transisi adegan-2 dihapus/.test(c)) && /dihapus/.test(r.ringkas), `pemberitahuan penghapusan transisi: ${r.catatan}`);
  r = MD.pindah(dasar, "adegan-2", 99999); // dijepit ke durasi proyek - durasi butir = 370; urutan waktu berganti: adegan-3 tak lagi punya butir sebelumnya
  tegas(r.ok && r.dijepit && butirDi(r.timeline, "adegan-2").mulai === 370 && butirDi(r.timeline, "adegan-2").transisi.durasi === 80 && butirDi(r.timeline, "adegan-3").transisi === undefined, `jepit atas dan urutan baru: ${ringkasButir(r.timeline, 0)}`);
  r = MD.pindah(dasar, "adegan-2", -40);
  tegas(butirDi(r.timeline, "adegan-2").mulai === 0 && r.dijepit, "jepit bawah di 0");
  r = MD.pindah(dasar, "adegan-2", 75);
  tegas(r.ok && r.berubah === false && r.timeline === dasar, "pindah ke posisi yang sama: tanpa perubahan");
  r = MD.ubahDurasi(dasar, "adegan-2", 90);
  tegas(butirDi(r.timeline, "adegan-2").durasi === 90 && butirDi(r.timeline, "adegan-3").transisi.durasi === 25, `ubahDurasi kanan menyinkronkan transisi butir berikut: ${ringkasButir(r.timeline, 0)}`);
  r = MD.ubahDurasi(dasar, "adegan-2", 9999);
  tegas(butirDi(r.timeline, "adegan-2").durasi === 450 - 75 && r.dijepit, "durasi dijepit sampai akhir proyek");
  r = MD.ubahDurasi(dasar, "adegan-2", 50, "kiri");
  tegas(!r.ok && /ber-waktu/.test(r.alasan), `sisi kiri video ber-waktu ditolak: ${r.alasan}`);
  tegas(MD.bolehSisiKiri(dasar, "adegan-2").boleh === false && MD.bolehSisiKiri(dasar, "adegan-1").boleh === true, "bolehSisiKiri");
  // video tanpa waktu: sisi kiri memajukan mulai dan dari (adegan-1: dari 0, mulai 0, durasi 90)
  r = MD.ubahDurasi(dasar, "adegan-1", 50, "kiri");
  const a1 = butirDi(r.timeline, "adegan-1");
  tegas(r.ok && a1.mulai === 40 && a1.durasi === 50 && a1.dari === 40, `sisi kiri video: ${JSON.stringify(a1)}`);
  tegas(butirDi(r.timeline, "adegan-2").transisi.durasi === 15 && r.catatan.length === 0, "akhir adegan-1 tetap di 90: tumpang tindih dan transisi adegan-2 tidak berubah");
  r = MD.ubahDurasi(r.timeline, "adegan-1", 200, "kiri"); // memperpanjang ke kiri: dari tak boleh negatif, jadi mulai >= 0
  tegas(r.ok && butirDi(r.timeline, "adegan-1").mulai === 0 && butirDi(r.timeline, "adegan-1").dari === 0 && butirDi(r.timeline, "adegan-1").durasi === 90, `perpanjang kiri dijepit: ${JSON.stringify(butirDi(r.timeline, "adegan-1"))}`);

  // teks (judul: mulai 20, durasi 180; tanpa dari)
  r = MD.pindah(dasar, "judul", 100);
  tegas(butirDi(r.timeline, "judul").mulai === 100 && butirDi(r.timeline, "judul").durasi === 180 && r.catatan.length === 0, "pindah teks");
  r = MD.ubahDurasi(dasar, "judul", 100, "kiri");
  tegas(butirDi(r.timeline, "judul").mulai === 100 && butirDi(r.timeline, "judul").durasi === 100 && !("dari" in butirDi(r.timeline, "judul")), "sisi kiri teks: mulai maju, akhir tetap (200), tanpa dari");
  r = MD.potong(dasar, "judul", 100);
  tegas(!r.ok && /animasi/.test(r.alasan), `potong teks beranimasi ditolak: ${r.alasan}`);
  tegas(MD.bolehPotong(dasar, "kredit").boleh === false && MD.bolehPotong(dasar, "subjudul").boleh === false && MD.bolehPotong(dasar, "pip-balik").boleh === false, "animasi dan properti menolak potong");
  for (const [id, kata] of [["adegan-2", "waktu"], ["pip-balik", "properti"], ["pip-beku", "animasi"]]) {
    tegas(new RegExp(kata).test(MD.bolehPotong(dasar, id).alasan), `alasan potong ${id} menyebut ${kata}`);
  }
  const kb = salin(tl);
  kb.track[2].butir[0].kenBurns = { dari: 1, ke: 1.1 };
  tegas(/kenBurns/.test(MD.bolehPotong(kb, "logo").alasan), "kenBurns menolak potong");

  // warna (adegan-3: mulai 140, durasi 310, celup 15) dan video sederhana
  r = MD.potong(dasar, "adegan-3", 300);
  tegas(r.ok && JSON.stringify(ringkasButir(r.timeline, 0)) === JSON.stringify(["adegan-1:0+90", "adegan-2:75+80/t15", "adegan-3:140+160/t15", "adegan-3-b:300+150"]), `potong warna: ${ringkasButir(r.timeline, 0)}`);
  tegas(r.id2 === "adegan-3-b" && r.ref2.butir === 3 && butirDi(r.timeline, "adegan-3-b").warna === "#0b1220", "butir kedua: id baru, tanpa transisi, isi disalin");
  r = MD.potong(dasar, "adegan-1", 30);
  tegas(butirDi(r.timeline, "adegan-1-b").dari === 30 && butirDi(r.timeline, "adegan-1-b").mulai === 30 && butirDi(r.timeline, "adegan-1-b").durasi === 60 && butirDi(r.timeline, "adegan-1").durasi === 30, "potong video: dari butir kedua = dari + (frame - mulai)");
  for (const f of [140, 450, 139, 9999, "x", NaN]) tegas(!MD.potong(dasar, "adegan-3", f).ok, `frame ${f} di luar butir ditolak`);
  const bentrok = salin(tl);
  bentrok.track[0].butir.push({ id: "adegan-3-b", jenis: "warna", warna: "#000000", mulai: 449, durasi: 1 });
  tegas(MD.potong(bentrok, "adegan-3", 300).id2 === "adegan-3-c", "id bentrok: -c");
  const panjang = salin(tl);
  const idPanjang = "x".repeat(64);
  panjang.track[0].butir[2].id = idPanjang;
  tegas(MD.potong(panjang, idPanjang, 300).id2.length === 64, "id baru dipangkas agar <= 64 karakter");

  // audio (narasi-1: mulai 160, durasi 90; musik-1: mulai 0, durasi 450)
  r = MD.pindah(dasar, "narasi-1", 100);
  tegas(butirDi(r.timeline, "narasi-1").mulai === 100 && r.catatan.length === 0, "pindah audio");
  r = MD.potong(dasar, "narasi-1", 200);
  tegas(!r.ok && /audio/.test(r.alasan), `potong audio ditolak: ${r.alasan}`);
  tegas(!MD.ubahDurasi(dasar, "narasi-1", 40, "kiri").ok, "sisi kiri audio ditolak");
  tegas(MD.ubahDurasi(dasar, "narasi-1", 40).ok, "durasi kanan audio diizinkan (validator R10 yang menilai)");

  // rujukan
  tegas(!MD.pindah(dasar, "tidak-ada", 1).ok && !MD.pindah(dasar, { track: 99, butir: 0 }, 1).ok && !MD.pindah(dasar, 7, 1).ok, "rujukan salah ditolak");
  tegas(!MD.pindah(dasar, "adegan-1", "abc").ok && !MD.ubahDurasi(dasar, "adegan-1", NaN).ok && !MD.ubahDurasi(dasar, "adegan-1", 5, "tengah").ok, "nilai bukan angka dan sisi salah ditolak");
  const ganda = salin(tl);
  ganda.track[1].butir[1].id = "pip-balik";
  tegas(/dipakai 2 butir/.test(MD.pindah(ganda, "pip-balik", 1).alasan) && MD.pindah(ganda, { track: 1, butir: 1 }, 270).ok, "id ganda hanya dapat dirujuk lewat indeks");
  tegas(!MD.pindah({ proyek: { durasi: 10 }, track: [{ butir: [{ id: "a", jenis: "warna" }] }] }, "a", 1).ok, "butir tanpa mulai dan durasi bulat ditolak tanpa melempar");
  tegas(!MD.pindah({}, "a", 1).ok && !MD.pindah(null, "a", 1).ok, "timeline tanpa track ditolak tanpa melempar");

  // riwayat
  let rw = MD.buatRiwayat(dasar);
  const urutan = [(t) => MD.pindah(t, "adegan-3", 139), (t) => MD.ubahDurasi(t, "judul", 190), (t) => MD.potong(t, "adegan-3", 300), (t) => MD.pindah(t, "narasi-1", 170), (t) => MD.ubahDurasi(t, "adegan-1", 60, "kiri")];
  const jejak = [JSON.stringify(rw.kini())];
  for (const op of urutan) {
    const h = op(rw.kini());
    tegas(h.ok && h.berubah, `langkah riwayat: ${h.alasan ?? h.ringkas}`);
    rw.terapkan(h.timeline);
    jejak.push(JSON.stringify(rw.kini()));
  }
  tegas(rw.jumlahUrungkan() === 5 && !rw.bisaUlangi(), "lima langkah");
  for (let i = 4; i >= 0; i--) tegas(JSON.stringify(rw.urungkan()) === jejak[i], `urungkan ke langkah ${i} byte-identik`);
  tegas(rw.urungkan() === null && JSON.stringify(rw.kini()) === asli, "urungkan habis: kembali ke asal, byte-identik");
  for (let i = 1; i <= 5; i++) tegas(JSON.stringify(rw.ulangi()) === jejak[i], `ulangi ke langkah ${i} byte-identik`);
  tegas(rw.ulangi() === null, "ulangi habis");
  rw.urungkan(); rw.urungkan();
  rw.terapkan(MD.pindah(rw.kini(), "judul", 5).timeline);
  tegas(!rw.bisaUlangi() && rw.jumlahUrungkan() === 4, "langkah baru mengosongkan tumpukan ulangi");
  // gabung: satu rangkaian kunci sama = satu langkah; kunci beda atau putus = langkah baru
  rw = MD.buatRiwayat(dasar);
  for (const n of [71, 72, 73]) rw.terapkan(MD.pindah(rw.kini(), "adegan-2", n).timeline, "kolom-mulai:1");
  tegas(rw.jumlahUrungkan() === 1 && butirDi(rw.kini(), "adegan-2").mulai === 73, "tiga ketikan berkunci sama = satu langkah");
  rw.terapkan(MD.pindah(rw.kini(), "adegan-2", 74).timeline, "kolom-mulai:2");
  tegas(rw.jumlahUrungkan() === 2, "kunci berbeda = langkah baru");
  rw.putus();
  rw.terapkan(MD.pindah(rw.kini(), "adegan-2", 75).timeline, "kolom-mulai:2");
  tegas(rw.jumlahUrungkan() === 3, "putus() memutus penggabungan");
  tegas(JSON.stringify(rw.urungkan()) !== JSON.stringify(rw.ulangi()), "urungkan lalu ulangi bolak-balik");
  rw = MD.buatRiwayat(dasar);
  let kini = dasar;
  for (let i = 0; i < MD.BATAS_RIWAYAT + 5; i++) { kini = MD.pindah(kini, "narasi-1", 100 + i).timeline; rw.terapkan(kini); }
  tegas(rw.jumlahUrungkan() === MD.BATAS_RIWAYAT, `riwayat dibatasi ${MD.BATAS_RIWAYAT} langkah: ${rw.jumlahUrungkan()}`);
});

daftar("(r) properti acak ber-seed (acak(seed)): deretan operasi tidak pernah menghasilkan id ganda (R01), butir di luar 0..proyek.durasi (R03), atau pelanggaran skema; deterministik", async () => {
  const dir = j("acak");
  cpSync(templatContoh, dir, { recursive: true });
  const konteks = await muatKonteks(tl, dir);
  const total = tl.proyek.durasi;
  const jalankanSeed = async (seed, langkah, periksaValidator) => {
    const rnd = RT.acak(seed);
    const bulat = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    let t = tl;
    const hitung = { pindah: 0, durasi: 0, kiri: 0, potong: 0, ditolak: 0 };
    for (let n = 0; n < langkah; n++) {
      bekukan(t);
      const semua = semuaButir(t);
      const pilih = semua[bulat(0, semua.length - 1)];
      const ref = { track: pilih.i, butir: pilih.j };
      const op = bulat(0, 3);
      let h;
      if (op === 0) { h = MD.pindah(t, ref, bulat(-60, total + 60)); hitung.pindah++; }
      else if (op === 1) { h = MD.ubahDurasi(t, ref, bulat(-10, total + 60), "kanan"); hitung.durasi++; }
      else if (op === 2) { h = MD.ubahDurasi(t, ref, bulat(-10, total + 60), "kiri"); hitung.kiri++; }
      else { h = MD.potong(t, ref, bulat(pilih.b.mulai - 5, pilih.b.mulai + pilih.b.durasi + 5)); hitung.potong++; }
      if (!h.ok) { hitung.ditolak++; continue; }
      t = h.timeline;
      const ids = new Set();
      for (const { b } of semuaButir(t)) {
        tegas(!ids.has(b.id), `seed ${seed} langkah ${n}: id ganda ${b.id}`);
        ids.add(b.id);
        tegas(Number.isInteger(b.mulai) && Number.isInteger(b.durasi) && b.mulai >= 0 && b.durasi >= 1 && b.mulai + b.durasi <= total, `seed ${seed} langkah ${n}: ${b.id} di luar 0..${total}: ${b.mulai}+${b.durasi}`);
        if (b.jenis === "video" && b.dari !== undefined) tegas(Number.isInteger(b.dari) && b.dari >= 0, `seed ${seed}: dari ${b.dari} tidak valid`);
      }
      if (periksaValidator && n % 7 === 0) {
        const v = await periksaTimeline(t, { dir, konteks });
        const buruk = v.galat.filter((x) => ["SKEMA", "R01", "R03"].includes(x.kode));
        tegas(buruk.length === 0, `seed ${seed} langkah ${n}: validator R01/R03/SKEMA: ${JSON.stringify(buruk)}`);
      }
    }
    return { akhir: JSON.stringify(t), hitung };
  };
  const a = await jalankanSeed(20261108, 300, true);
  const b = await jalankanSeed(20261108, 300, false);
  tegas(a.akhir === b.akhir, "seed sama harus menghasilkan deretan yang sama");
  tegas(a.hitung.pindah >= 40 && a.hitung.durasi >= 40 && a.hitung.kiri >= 40 && a.hitung.potong >= 40, `semua operasi harus teruji: ${JSON.stringify(a.hitung)}`);
  for (const seed of [1, 2, 3, 99, 4242]) await jalankanSeed(seed, 150, seed === 1);
  const c = await jalankanSeed(7, 300, false);
  tegas(c.akhir !== a.akhir, "seed berbeda menghasilkan deretan berbeda");
});

daftar("(s) validasi ber-cache sama dengan tanpa cache; bagianTetap menolak perubahan di luar butir; tulisAtomik membersihkan berkas sementara bila gagal", async () => {
  const dir = j("cache-sama");
  cpSync(templatContoh, dir, { recursive: true });
  const konteks = await muatKonteks(tl, dir);
  const varian = [tl];
  let t = MD.pindah(tl, "adegan-2", 60).timeline; varian.push(t);
  t = MD.pindah(t, "kredit", 100).timeline; varian.push(t); // tumpang tindih tanpa transisi: galat R04
  t = MD.ubahDurasi(t, "judul", 400).timeline; varian.push(t);
  t = MD.potong(t, "adegan-3", 300).timeline; varian.push(t);
  for (const v of varian) {
    const [x, y] = [await periksaTimeline(v, { dir, konteks }), await periksaTimeline(v, { dir })];
    samaIsi({ g: x.galat, w: x.peringatan, l: x.lolos }, { g: y.galat, w: y.peringatan, l: y.lolos }, "cache sama dengan tanpa cache");
  }
  tegas((await periksaTimeline(varian[2], { dir, konteks })).galat.some((x) => x.kode === "R04"), "variasi pelanggaran memang menghasilkan galat");

  tegas(bagianTetap(tl, salin(tl)) === null && bagianTetap(tl, MD.pindah(tl, "adegan-1", 1).timeline) === null, "butir boleh berubah");
  const ubah = (fn) => { const x = salin(tl); fn(x); return bagianTetap(tl, x); };
  tegas(/proyek/.test(ubah((x) => { x.proyek.durasi = 999; })), "proyek.durasi tetap");
  tegas(/proyek/.test(ubah((x) => { x.proyek.fps = 60; })), "proyek.fps tetap");
  tegas(/manifes/.test(ubah((x) => { x.manifes.aset = "../rahasia.json"; })), "manifes tetap");
  tegas(/manifes/.test(ubah((x) => { delete x.manifes; })), "manifes tidak boleh dihapus");
  tegas(/tidak boleh diubah/.test(ubah((x) => { x.berkasBaru = 1; })), "kunci baru ditolak");
  tegas(/jumlah track/.test(ubah((x) => { x.track.pop(); })), "jumlah track tetap");
  tegas(/track\/1\/jenis/.test(ubah((x) => { x.track[1].jenis = "teks"; })), "jenis track tetap");
  tegas(/track\/2\/id/.test(ubah((x) => { x.track[2].id = "lain"; })), "id track tetap");
  tegas(/butir harus array/.test(ubah((x) => { x.track[0].butir = {}; })), "butir harus array");
  tegas(/objek/.test(bagianTetap(tl, [])) && /objek/.test(bagianTetap(tl, null)), "bukan objek");
  tegas(bagianTetap(tl, Object.fromEntries(Object.entries(salin(tl)).reverse())) === null, "urutan kunci tidak menentukan kesamaan");

  const dirTulis = j("tulis");
  mkdirSync(dirTulis, { recursive: true });
  tulisAtomik(join(dirTulis, "a.json"), "{}\n");
  tegas(readFileSync(join(dirTulis, "a.json"), "utf8") === "{}\n", "tulisAtomik menulis isi");
  mkdirSync(join(dirTulis, "folder.json"));
  let gagalTulis = false;
  try { tulisAtomik(join(dirTulis, "folder.json"), "x"); } catch { gagalTulis = true; }
  tegas(gagalTulis, "tujuan berupa folder harus gagal");
  samaIsi(readdirSync(dirTulis).sort(), ["a.json", "folder.json"], "tanpa berkas sementara tersisa");
});

// =============================================================== (t)-(y) penyuntingan dan ekspor lewat server dan halaman (#55)
const salinFixture = (nama) => { const d = j(nama); cpSync(templatContoh, d, { recursive: true }); return d; };
const kirimPost = (s, rute, badan, { headers = {}, tanpaToken = false, mentahBodi } = {}) =>
  fetch(`${s.base}${rute}`, { method: "POST", headers: { "Content-Type": "application/json", ...(tanpaToken ? {} : { "X-Awvd-Token": s.token }), ...headers }, body: mentahBodi ?? JSON.stringify(badan) });
/** POST mentah (Host, Origin, dan header lain persis seperti ditulis) lewat soket. */
function mentahPost(port, headerTambahan, badan) {
  const isi = JSON.stringify(badan);
  return mentah(port, ["POST /api/ekspor HTTP/1.1", ...headerTambahan, "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(isi)}`, "Connection: close"], isi);
}
const daftarFolder = (d) => readdirSync(d).sort();
const sha = (f) => new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex");
const periksaCli = (f, ...ekstra) => bun(join(akar, "scripts", "timeline.mjs"), "periksa", f, ...ekstra);

/** Konteks peramban baru ke satu server: tanpa jaringan non-lokal; galat konsol dan halaman dikumpulkan. */
async function bukaHalaman(s, ukuran = { width: 1920, height: 1300 }) {
  const c = await browser.newContext({ viewport: ukuran, deviceScaleFactor: 1 });
  const asing = [], galat = [];
  await c.route("**/*", (route) => { const u = route.request().url(); if (u.startsWith(`${s.base}/`)) return route.continue(); asing.push(u); return route.abort("blockedbyclient"); });
  const p = await c.newPage();
  p.on("pageerror", (e) => galat.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") galat.push(m.text()); });
  await p.goto(s.url);
  await p.waitForSelector('#komposisi[data-frame-tampil="0"]', { timeout: 30000 });
  return { c, p, asing, galat };
}
const sel = (id) => `[role="gridcell"][data-id="${id}"]`;
const kolom = (p, id, a) => p.locator(sel(id)).getAttribute(a);
const statusTeks = (p) => p.locator("#status").textContent();
const tungguStatus = (p, re, timeout = 15000) => p.waitForFunction((x) => new RegExp(x).test(document.getElementById("status").textContent), re.source, { timeout });

daftar("(t) POST /api/periksa dan /api/ekspor: token wajib lewat header, Host/Origin/Sec-Fetch-Site, Content-Type, batas 5 MB, bentuk badan, bagian tetap, jalur keluaran tidak dari klien", async () => {
  const dir = salinFixture("post");
  const s = await mulaiPenyunting(join(dir, "timeline.json"), "--cache", j("cache-post"));
  try {
    const sebelum = daftarFolder(dir), sebelumInduk = daftarFolder(tmp), shaSumber = sha(join(dir, "timeline.json"));
    const sah = { timeline: tl };
    // token: tanpa, salah, lewat query atau cookie saja (POST wajib header)
    for (const rute of ["/api/periksa", "/api/ekspor"]) {
      tegas((await kirimPost(s, rute, sah, { tanpaToken: true })).status === 403, `${rute} tanpa token harus 403`);
      tegas((await kirimPost(s, rute, sah, { tanpaToken: true, headers: { "X-Awvd-Token": "1".repeat(32) } })).status === 403, `${rute} token salah harus 403`);
      tegas((await kirimPost(s, `${rute}?token=${s.token}`, sah, { tanpaToken: true })).status === 403, `${rute} token lewat query saja harus 403`);
      tegas((await kirimPost(s, rute, sah, { tanpaToken: true, headers: { Cookie: `awvd_token=${s.token}` } })).status === 403, `${rute} token lewat cookie saja harus 403`);
      const g = await dapat(s, rute);
      tegas(g.status === 405 && g.headers.get("allow") === "POST", `GET ${rute} harus 405 Allow: POST, dapat ${g.status}`);
      for (const metode of ["PUT", "DELETE", "PATCH", "OPTIONS"]) tegas((await dapat(s, rute, { method: metode })).status === 405, `${metode} ${rute} harus 405`);
    }
    // Host, Origin, dan Sec-Fetch-Site asing pada POST (soket mentah, token header benar)
    const h = (host, ekstra = []) => [`Host: ${host}`, `X-Awvd-Token: ${s.token}`, ...ekstra];
    tegas((await mentahPost(s.port, h("evil.example"), sah)).status === 403, "Host asing harus 403");
    tegas((await mentahPost(s.port, h(`127.0.0.1:${s.port}`, ["Origin: http://evil.example"]), sah)).status === 403, "Origin asing harus 403");
    tegas((await mentahPost(s.port, h(`127.0.0.1:${s.port}`, ["Sec-Fetch-Site: cross-site"]), sah)).status === 403, "Sec-Fetch-Site cross-site harus 403");
    tegas((await mentahPost(s.port, h(`127.0.0.1:${s.port}`, [`Origin: http://127.0.0.1:${s.port}`, "Sec-Fetch-Site: same-origin"]), sah)).status === 200, "POST sah lewat soket mentah harus 200");
    rmSync(join(dir, "timeline.sunting.json"), { force: true });
    // Content-Type
    for (const tipe of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const r = await kirimPost(s, "/api/ekspor", sah, { headers: { "Content-Type": tipe } });
      tegas(r.status === 415, `Content-Type "${tipe}" harus 415, dapat ${r.status}`);
    }
    tegas((await kirimPost(s, "/api/periksa", sah, { headers: { "Content-Type": "Application/JSON; charset=utf-8" } })).status === 200, "application/json dengan parameter diterima");
    // bentuk badan
    for (const mentahBodi of ["{ bukan json", "[]", "null", "5", "{}", '{"timeline": 5}', '{"timeline": []}', '{"timeline": null}']) {
      const r = await kirimPost(s, "/api/ekspor", null, { mentahBodi });
      tegas(r.status === 400, `badan ${mentahBodi} harus 400, dapat ${r.status}`);
      tegas(typeof (await r.json()).galat === "string", "badan galat berisi pesan");
    }
    // batas ukuran: Content-Length besar, dan aliran tanpa Content-Length
    const besar = `{"timeline":{"x":"${"a".repeat(6_000_000)}"}}`;
    const r413 = await kirimPost(s, "/api/periksa", null, { mentahBodi: besar });
    tegas(r413.status === 413, `badan 6 MB harus 413, dapat ${r413.status}`);
    const aliran = new ReadableStream({ start(c) { const potong = new TextEncoder().encode("a".repeat(1_000_000)); for (let i = 0; i < 6; i++) c.enqueue(potong); c.close(); } });
    const rAliran = await fetch(`${s.base}/api/periksa`, { method: "POST", headers: { "Content-Type": "application/json", "X-Awvd-Token": s.token }, body: aliran, duplex: "half" });
    tegas(rAliran.status === 413, `aliran 6 MB tanpa Content-Length harus 413, dapat ${rAliran.status}`);
    tegas((await dapat(s, "/api/sesi")).status === 200, "server masih hidup setelah badan terlalu besar");
    // bagian tetap: hanya butir yang boleh berubah
    const ubah = (fn) => { const x = salin(tl); fn(x); return { timeline: x }; };
    for (const [nama, badan] of [
      ["proyek.durasi", ubah((x) => { x.proyek.durasi = 9999; })], ["proyek.fps", ubah((x) => { x.proyek.fps = 60; })],
      ["manifes.aset ke luar folder", ubah((x) => { x.manifes.aset = "../../etc/passwd"; })], ["jumlah track", ubah((x) => { x.track.pop(); })],
      ["id track", ubah((x) => { x.track[0].id = "lain"; })], ["kunci baru", ubah((x) => { x.rahasia = 1; })],
    ]) {
      for (const rute of ["/api/periksa", "/api/ekspor"]) {
        const r = await kirimPost(s, rute, badan);
        tegas(r.status === 422 && /tidak boleh diubah|jumlah track/.test((await r.json()).galat), `${nama} lewat ${rute} harus 422`);
      }
    }
    // jalur keluaran tidak dapat dikendalikan klien: bidang tambahan diabaikan
    const iseng = await kirimPost(s, "/api/ekspor", { timeline: tl, berkas: "../../diluar.json", keluaran: "/tmp/diluar.json", jalur: "../x", timpa: true, tampil: "timeline.json" });
    const hasil = await iseng.json();
    tegas(iseng.status === 200 && hasil.timpa === false && hasil.berkas === join(dir, "timeline.sunting.json"), `bidang jalur diabaikan: ${JSON.stringify(hasil)}`);
    samaIsi(daftarFolder(dir), [...sebelum, "timeline.sunting.json"].sort(), "hanya timeline.sunting.json yang bertambah di folder timeline");
    samaIsi(daftarFolder(tmp), sebelumInduk, "tidak ada penulisan di luar folder timeline");
    tegas(sha(join(dir, "timeline.json")) === shaSumber, "sumber tidak berubah");
    rmSync(join(dir, "timeline.sunting.json"));
    // ekspor yang ditolak validator: 422, validasi berlokasi, tanpa berkas
    const rusak = salin(tl);
    rusak.track[3].butir[1].mulai = 190; // kredit tumpang tindih dengan judul tanpa transisi (R04)
    const tolak = await kirimPost(s, "/api/ekspor", { timeline: rusak });
    const jt = await tolak.json();
    tegas(tolak.status === 422 && jt.validasi.lolos === false && jt.validasi.galat.some((x) => x.kode === "R04" && x.lok === "/track/3/butir/1"), `ekspor ditolak: ${tolak.status} ${JSON.stringify(jt).slice(0, 300)}`);
    tegas(!existsSync(join(dir, "timeline.sunting.json")), "tidak ada berkas yang ditulis untuk timeline yang ditolak");
    const sesi = await (await dapat(s, "/api/sesi")).json();
    tegas(sesi.timeline.track[3].butir[1].mulai === 190 && sesi.validasi.lolos === false && sesi.versi === 2, "salinan kerja server mengikuti draf terakhir (juga yang ditolak)");
    const props = await (await dapat(s, "/__props.js")).text();
    tegas(props.includes('"mulai":190'), "iframe dirender dari salinan kerja server");
    samaIsi(daftarFolder(dir), sebelum, "folder tetap sama setelah penolakan");
    samaIsi(daftarFolder(tmp), sebelumInduk, "induk tetap sama");
  } finally { await s.henti(); }
});

daftar("(u) ekspor: bawaan menulis <nama>.sunting.json tanpa menimpa sumber, indentasi 2 dan baris baru akhir, atomik, lolos `timeline periksa --ketat`; --timpa menimpa sumber; ekspor ketat menolak peringatan", async () => {
  const dir = salinFixture("ekspor");
  const sumber = join(dir, "timeline.json");
  const keluaran = join(dir, "timeline.sunting.json");
  const s = await mulaiPenyunting(sumber, "--cache", j("cache-ekspor"));
  try {
    tegas(s.out.includes(`ekspor: ${keluaran}`) && !s.out.includes("menimpa sumber"), `CLI mencetak jalur ekspor: ${s.out}`);
    const shaAwal = sha(sumber);
    // tanpa suntingan: keluaran byte-identik dengan sumber berformat baku
    let r = await kirimPost(s, "/api/ekspor", { timeline: tl });
    let h = await r.json();
    tegas(r.status === 200 && h.ok && h.byte === statSync(keluaran).size && h.berkas === keluaran && h.timpa === false && h.validasi.lolos, `ekspor tanpa suntingan: ${JSON.stringify(h)}`);
    tegas(readFileSync(keluaran, "utf8") === readFileSync(sumber, "utf8"), "keluaran tanpa suntingan byte-identik dengan sumber");
    // dengan suntingan
    let t = MD.pindah(tl, "adegan-3", 137).timeline;
    t = MD.ubahDurasi(t, "judul", 212).timeline;
    t = MD.potong(t, "adegan-3", 300).timeline;
    r = await kirimPost(s, "/api/ekspor", { timeline: t });
    h = await r.json();
    tegas(r.status === 200, `ekspor tersunting: ${JSON.stringify(h)}`);
    const teks = readFileSync(keluaran, "utf8");
    tegas(teks === `${JSON.stringify(t, null, 2)}\n` && teks.endsWith("}\n") && !teks.endsWith("\n\n") && /^\{\n {2}"\$schema"/.test(teks), "format: indentasi 2, satu baris baru di akhir, urutan kunci dipertahankan");
    tegas(sha(sumber) === shaAwal, "sumber tidak berubah tanpa --timpa");
    samaIsi(daftarFolder(dir).filter((f) => f.endsWith(".tmp")), [], "tanpa berkas sementara tersisa");
    const cek = await periksaCli(keluaran, "--ketat");
    tegas(cek.kode === 0 && /LOLOS/.test(cek.out), `bun run timeline periksa --ketat pada hasil ekspor: exit ${cek.kode}\n${cek.out}${cek.err}`);
    const sesi = await (await dapat(s, "/api/sesi")).json();
    tegas(sesi.timeline.track[0].butir.length === 4 && sesi.ekspor.berkas === keluaran && sesi.ekspor.timpa === false, "salinan kerja server = hasil ekspor");
    // ekspor ketat: tanpa peringatan lolos
    r = await kirimPost(s, "/api/ekspor", { timeline: t, ketat: true });
    tegas(r.status === 200 && (await r.json()).ketat === true, "ekspor ketat tanpa peringatan lolos");
  } finally { await s.henti(); }

  // ketat dengan peringatan (W09: manifes.konsep terbaca tetapi belum dipakai): ekspor biasa lolos, ekspor ketat 422
  const dirW = salinFixture("ekspor-w09");
  writeFileSync(join(dirW, "konsep.json"), "{}\n");
  const tw = bacaJson(join(dirW, "timeline.json"));
  tw.manifes.konsep = "konsep.json";
  tulisJson(join(dirW, "timeline.json"), tw);
  const sw = await mulaiPenyunting(join(dirW, "timeline.json"), "--cache", j("cache-ekspor-w"));
  try {
    const sesi = await (await dapat(sw, "/api/sesi")).json();
    tegas(sesi.validasi.lolos && sesi.validasi.peringatan.length === 1, `peringatan awal: ${JSON.stringify(sesi.validasi.peringatan)}`);
    const k = await kirimPost(sw, "/api/ekspor", { timeline: tw, ketat: true });
    tegas(k.status === 422 && /ekspor ketat/.test((await k.json()).galat) && !existsSync(join(dirW, "timeline.sunting.json")), `ekspor ketat dengan peringatan harus 422 tanpa berkas: ${k.status}`);
    const b = await kirimPost(sw, "/api/ekspor", { timeline: tw });
    tegas(b.status === 200 && existsSync(join(dirW, "timeline.sunting.json")), "ekspor biasa dengan peringatan lolos");
    tegas((await periksaCli(join(dirW, "timeline.sunting.json"))).kode === 0 && (await periksaCli(join(dirW, "timeline.sunting.json"), "--ketat")).kode === 2, "hasil ekspor: lolos tanpa --ketat, gagal dengan --ketat (peringatan yang sama)");
  } finally { await sw.henti(); }

  // --timpa menimpa sumber (atomik), tanpa membuat <nama>.sunting.json
  const dirT = salinFixture("ekspor-timpa");
  const sumberT = join(dirT, "timeline.json");
  const st = await mulaiPenyunting(sumberT, "--timpa", "--cache", j("cache-ekspor-t"));
  try {
    tegas(st.out.includes("menimpa sumber"), `CLI menyebut penimpaan: ${st.out}`);
    const t2 = MD.pindah(tl, "narasi-1", 170).timeline;
    const r = await kirimPost(st, "/api/ekspor", { timeline: t2 });
    const h = await r.json();
    tegas(r.status === 200 && h.timpa === true && h.berkas === sumberT, `ekspor --timpa: ${JSON.stringify(h)}`);
    tegas(readFileSync(sumberT, "utf8") === `${JSON.stringify(t2, null, 2)}\n` && !existsSync(join(dirT, "timeline.sunting.json")), "sumber ditimpa dan tidak ada .sunting.json");
    samaIsi(daftarFolder(dirT).filter((f) => f.endsWith(".tmp")), [], "tanpa berkas sementara");
    tegas((await periksaCli(sumberT, "--ketat")).kode === 0, "sumber hasil timpa lolos --ketat");
  } finally { await st.henti(); }
  tegas((await bun(penyuntingMjs, "--help")).out.includes("--timpa"), "--help memuat --timpa");
});

daftar("(v) alur E2E hanya dengan papan ketik: pindah adegan-3, ubah durasi judul, potong butir warna, ekspor; hasil lolos --ketat dan frame pratinjau = render --still dari hasil ekspor", async () => {
  await pastikanUtama();
  const dir = salinFixture("e2e");
  const sumber = join(dir, "timeline.json");
  const keluaran = join(dir, "timeline.sunting.json");
  const s = await mulaiPenyunting(sumber, "--cache", j("cache-e2e"));
  const { c, p, asing, galat } = await bukaHalaman(s);
  try {
    const aktifKini = () => p.evaluate(() => { const a = document.activeElement; return { id: a.id, role: a.getAttribute("role"), dataId: a.dataset.id, track: a.dataset.track }; });
    const tekan = async (...kunci) => { for (const k of kunci) await p.keyboard.press(k); };
    const sampai = async (kunci, kondisi, maks, nama) => {
      for (let i = 0; i < maks; i++) { if (await kondisi(await aktifKini())) return; await p.keyboard.press(kunci); }
      tegas(await kondisi(await aktifKini()), `fokus tidak sampai ke ${nama} dengan ${kunci}`);
    };
    const tungguRev = (n, frame) => p.waitForSelector(`#komposisi[data-revisi="${n}"][data-frame-tampil="${frame}"]`, { timeout: 30000 });
    const keAdegan3 = async () => {
      await sampai("ArrowDown", (a) => a.track === "0", 8, "track 0");
      await sampai("ArrowRight", (a) => a.dataId === "adegan-3", 4, "adegan-3");
    };

    // 1. fokus ke grid hanya dengan Tab
    await sampai("Tab", (a) => a.role === "gridcell", 60, "widget track");
    // 2. adegan-3: Enter (playhead ke awal + mode sunting), tiga kali Kiri
    await keAdegan3();
    await tekan("Enter");
    tegas((await statusTeks(p)).includes("Mode sunting butir adegan-3"), `mode sunting diumumkan: ${await statusTeks(p)}`);
    tegas((await p.locator("#grid").getAttribute("data-mode-sunting")) === "1", "indikator mode sunting");
    await tungguRev(0, 140);
    await tekan("ArrowLeft", "ArrowLeft", "ArrowLeft");
    tegas((await statusTeks(p)).includes("dipindah ke mulai frame 137") && (await statusTeks(p)).includes("Transisi adegan-3 disesuaikan ke 18 frame"), `pengumuman pindah: ${await statusTeks(p)}`);
    tegas((await kolom(p, "adegan-3", "data-mulai")) === "137" && (await kolom(p, "adegan-3", "aria-label")).includes("bertransisi celup 18 frame"), "adegan-3 di frame 137 dengan transisi 18");
    tegas((await aktifKini()).dataId === "adegan-3", "fokus tetap di butir setelah muat ulang grid");
    await tungguRev(3, 140);
    await tungguStatus(p, /^Lolos validator/);
    await tekan("Escape");
    tegas((await p.locator("#grid").getAttribute("data-mode-sunting")) === null, "Esc keluar dari mode sunting");
    // 3. judul: F2 lalu Alt+Shift+Kanan (30 frame) dan Alt+Kanan dua kali
    await sampai("ArrowUp", (a) => a.track === "3", 4, "track 3");
    await sampai("ArrowLeft", (a) => a.dataId === "judul", 3, "judul");
    await tekan("F2", "Alt+Shift+ArrowRight", "Alt+ArrowRight", "Alt+ArrowRight");
    tegas((await kolom(p, "judul", "data-durasi")) === "212" && (await kolom(p, "judul", "data-mulai")) === "20", "judul: durasi 212, mulai tetap 20");
    tegas((await statusTeks(p)).includes("Durasi judul menjadi 212 frame"), `pengumuman durasi: ${await statusTeks(p)}`);
    await tekan("Escape");
    // 4. playhead ke frame 300: Shift+Tab ke kolom Frame, ketik angka, Enter
    await sampai("Shift+Tab", (a) => a.id === "frame-angka", 30, "kolom Frame");
    await tekan("Control+a");
    await p.keyboard.type("300");
    await tekan("Enter");
    await p.waitForSelector('#komposisi[data-frame-tampil="300"]', { timeout: 30000 });
    // 5. kembali ke grid (satu perhentian tab = butir terpilih), ke adegan-3, tekan S
    await sampai("Tab", (a) => a.role === "gridcell", 30, "widget track");
    await sampai("ArrowDown", (a) => a.track === "0", 8, "track 0");
    await sampai("ArrowRight", (a) => a.dataId === "adegan-3", 4, "adegan-3");
    await tekan("s");
    tegas((await statusTeks(p)).includes("dipotong di frame 300 menjadi adegan-3 (frame 137 sampai 299) dan adegan-3-b (frame 300 sampai 446)"), `pengumuman potong: ${await statusTeks(p)}`);
    tegas((await p.locator('[role="gridcell"]').count()) === 12 && (await kolom(p, "adegan-3-b", "data-mulai")) === "300", "butir kedua tergambar");
    // 6. tunggu validator lolos, lalu ekspor dengan Ctrl+S
    await tungguStatus(p, /^Lolos validator/);
    await p.waitForFunction(() => document.getElementById("ekspor").getAttribute("aria-disabled") === "false", null, { timeout: 15000 });
    await tekan("Control+s");
    await tungguStatus(p, /^Diekspor ke /);
    tegas((await statusTeks(p)).includes(keluaran), `pengumuman ekspor: ${await statusTeks(p)}`);
    tegas(!(await p.locator("#alasan-ekspor").textContent()).includes("Memeriksa") && (await p.locator("#alasan-ekspor").textContent()).includes("sudah diekspor"), "alasan ekspor: sudah diekspor");

    // hasil: berkas, validator proses terpisah
    const hasil = bacaJson(keluaran);
    const ringkas = (id) => { const b = semuaButir(hasil).find((x) => x.b.id === id)?.b; return b && `${b.mulai}+${b.durasi}${b.transisi ? `/t${b.transisi.durasi}` : ""}`; };
    samaIsi([ringkas("adegan-3"), ringkas("adegan-3-b"), ringkas("judul")], ["137+163/t18", "300+147", "20+212"], "isi hasil ekspor");
    tegas(sha(sumber) === sha(join(templatContoh, "timeline.json")), "sumber tidak berubah");
    const cek = await periksaCli(keluaran, "--ketat");
    tegas(cek.kode === 0 && /LOLOS/.test(cek.out), `periksa --ketat pada hasil: exit ${cek.kode}\n${cek.out}${cek.err}`);

    // frame pratinjau setelah sunting = render --still dari timeline hasil ekspor
    const siap = await bun(siapkanMjs, keluaran, "--out", j("siap-e2e"));
    tegas(siap.kode === 0, `siapkan hasil ekspor: ${siap.err}${siap.out}`);
    const ringkasFrame = [];
    for (const n of [138, 150, 225, 299, 300, 449]) {
      for (const w of [Math.max(0, n - 2), Math.max(0, n - 1)]) { await p.fill("#frame-angka", String(w)); await p.press("#frame-angka", "Enter"); await p.waitForSelector(`#komposisi[data-frame-tampil="${w}"]`); await p.locator("#komposisi").screenshot(); }
      await p.fill("#frame-angka", String(n)); await p.press("#frame-angka", "Enter");
      await p.waitForSelector(`#komposisi[data-frame-tampil="${n}"]`);
      const png = j(`e2e-pen-${n}.png`), ref = j(`e2e-render-${n}.png`);
      writeFileSync(png, await p.locator("#komposisi").screenshot());
      const rr = await bun(renderMjs, indexTemplat, "--props-file", j("siap-e2e", "props.json"), "--still", String(n), "--out", ref);
      tegas(rr.kode === 0, `render --still ${n}: ${rr.err}`);
      const [a, b] = [await md5Gambar(png), await md5Gambar(ref)];
      tegas(a === b, `frame ${n} setelah sunting: penyunting ${a} != render hasil ekspor ${b}`);
      ringkasFrame.push(a.slice(4, 12));
    }
    tegas(new Set(ringkasFrame).size >= 4, `frame uji beragam: ${ringkasFrame.join(" ")}`);
    tegas(asing.length === 0 && galat.length === 0, `jaringan non-lokal: ${asing.join(",")}; galat: ${galat.join(" | ")}`);
  } finally { await c.close(); await s.henti(); }
});

daftar("(w) pelanggaran hasil sunting: galat berlokasi di panel masalah, Ekspor nonaktif dengan alasan (alert), POST langsung 422 tanpa berkas; Ctrl+Z memulihkan", async () => {
  await pastikanUtama();
  const dir = salinFixture("pelanggaran");
  const s = await mulaiPenyunting(join(dir, "timeline.json"), "--cache", j("cache-pelanggaran"));
  const { c, p } = await bukaHalaman(s);
  try {
    tegas((await p.locator("#ekspor").getAttribute("aria-disabled")) === "false", "ekspor aktif untuk timeline yang lolos");
    await p.locator(sel("kredit")).click();
    await p.fill("#f-mulai", "190");
    await p.press("#f-mulai", "Enter"); // kredit tumpang tindih dengan judul tanpa transisi
    await tungguStatus(p, /^Ditolak validator/);
    const teks = await p.locator("#daftar-masalah").textContent();
    tegas(/galat \[R04\] \/track\/3\/butir\/1/.test(teks), `galat R04 berlokasi: ${teks}`);
    tegas((await p.locator("#ekspor").getAttribute("aria-disabled")) === "true" && (await p.locator("#ekspor-ketat").getAttribute("aria-disabled")) === "true", "tombol Ekspor nonaktif");
    tegas(/Ekspor dinonaktifkan: validator menemukan [1-9]\d* galat/.test(await p.locator("#alasan-ekspor").textContent()), `alasan: ${await p.locator("#alasan-ekspor").textContent()}`);
    tegas((await p.locator("#ekspor").getAttribute("aria-describedby")) === "alasan-ekspor", "alasan terhubung ke tombol");
    const alarm = p.locator("#galat-ekspor");
    tegas((await alarm.getAttribute("role")) === "alert" && !(await alarm.isHidden()) && (await alarm.textContent()).includes("Ekspor dinonaktifkan"), "galat pemblokir ekspor memakai role=alert");
    // menekan Ekspor yang nonaktif (papan ketik) tidak menulis apa pun dan mengumumkan alasan
    await p.locator("#ekspor").focus();
    await p.keyboard.press("Enter");
    tegas((await statusTeks(p)).includes("Ekspor dinonaktifkan"), "alasan diumumkan saat Ekspor nonaktif ditekan");
    await p.keyboard.press("Control+s");
    tegas(!existsSync(join(dir, "timeline.sunting.json")), "tidak ada berkas dari Ekspor nonaktif");
    // POST langsung dengan timeline yang sama (salinan kerja server): 422
    const kerja = (await (await dapat(s, "/api/sesi")).json()).timeline;
    const r = await kirimPost(s, "/api/ekspor", { timeline: kerja });
    tegas(r.status === 422 && !existsSync(join(dir, "timeline.sunting.json")), `POST langsung harus 422 tanpa berkas: ${r.status}`);
    // urungkan dengan Ctrl+Z (fokus di luar kolom angka) memulihkan
    await p.locator("#h-pratinjau").click();
    await p.keyboard.press("Control+z");
    tegas((await statusTeks(p)).startsWith("Diurungkan"), `urungkan diumumkan: ${await statusTeks(p)}`);
    await tungguStatus(p, /^Lolos validator/);
    await p.waitForFunction(() => document.getElementById("ekspor").getAttribute("aria-disabled") === "false" && document.getElementById("galat-ekspor").hidden, null, { timeout: 15000 });
    tegas((await p.locator("#daftar-masalah").textContent()).includes("Tidak ada galat"), "panel masalah bersih setelah urungkan");
    // ulangi lewat Ctrl+Shift+Z membawa pelanggaran kembali; tombol Ulangi/Urungkan juga bekerja
    await p.keyboard.press("Control+Shift+z");
    await tungguStatus(p, /^Ditolak validator/);
    await p.getByRole("button", { name: "Urungkan" }).click();
    await tungguStatus(p, /^Lolos validator/);
    await p.getByRole("button", { name: "Ulangi" }).click();
    await tungguStatus(p, /^Ditolak validator/);
    await p.keyboard.press("Control+y");
    tegas((await statusTeks(p)).includes("Tidak ada langkah yang dapat diulangi") || (await statusTeks(p)).startsWith("Ditolak"), "Ctrl+Y tanpa langkah ulangi");
  } finally { await c.close(); await s.henti(); }
});

daftar("(x) tanpa seret (SC 2.5.7): kolom angka, tombol, dan opsi sisi; urungkan menggabung rangkaian di kolom angka; seret = satu langkah; operasi yang dinonaktifkan bernalar tertulis; pintasan satu karakter tidak global (SC 2.1.4)", async () => {
  await pastikanUtama();
  const dir = salinFixture("tanpa-seret");
  const s = await mulaiPenyunting(join(dir, "timeline.json"), "--cache", j("cache-tanpa-seret"));
  const { c, p, asing, galat } = await bukaHalaman(s);
  try {
    const mulaiDi = (id) => kolom(p, id, "data-mulai");
    // tombol: Geser +1 / -1 dan Durasi +1 / -1 (tanpa seret)
    await p.locator(sel("narasi-1")).click();
    await p.getByRole("button", { name: "Geser +1" }).click();
    tegas((await mulaiDi("narasi-1")) === "161", "Geser +1");
    await p.getByRole("button", { name: "Geser -1" }).click();
    await p.getByRole("button", { name: "Geser -1" }).click();
    tegas((await mulaiDi("narasi-1")) === "159", "Geser -1 dua kali");
    await p.getByRole("button", { name: "Durasi +1" }).click();
    tegas((await kolom(p, "narasi-1", "data-durasi")) === "91", "Durasi +1");
    await p.getByRole("button", { name: "Durasi -1" }).click();
    tegas((await kolom(p, "narasi-1", "data-durasi")) === "90", "Durasi -1");
    // audio: potong dan sisi kiri dinonaktifkan dengan alasan tertulis
    tegas((await p.locator("#potong").getAttribute("aria-disabled")) === "true" && (await p.locator("#alasan-potong").textContent()).includes("Butir audio tidak dapat dipotong"), "potong audio nonaktif dengan alasan");
    tegas((await p.locator("#potong").getAttribute("aria-describedby")) === "alasan-potong", "alasan potong terhubung");
    tegas(await p.locator('#f-sisi option[value="kiri"]').isDisabled() && (await p.locator("#alasan-sisi").textContent()).includes("Sisi awal dinonaktifkan"), "sisi kiri audio nonaktif dengan alasan");
    await p.locator("#potong").click({ force: true });
    tegas((await statusTeks(p)).includes("Potong dinonaktifkan"), `menekan potong nonaktif mengumumkan alasan: ${await statusTeks(p)}`);
    await p.locator(sel("narasi-1")).focus();
    await p.keyboard.press("s");
    tegas((await statusTeks(p)).includes("Tidak dapat memotong: Butir audio"), "tombol S pada butir audio mengumumkan alasan");
    await p.locator(sel("pip-balik")).click();
    tegas((await p.locator("#alasan-potong").textContent()).includes("waktu, properti"), `alasan pip-balik: ${await p.locator("#alasan-potong").textContent()}`);
    // klem di batas: diumumkan, tanpa langkah baru
    await p.locator(sel("adegan-3")).click();
    await p.getByRole("button", { name: "Geser +1" }).click();
    tegas((await statusTeks(p)).includes("sudah di batas") && (await mulaiDi("adegan-3")) === "140", `jepit di batas: ${await statusTeks(p)}`);

    // sisi kiri lewat pilihan "Sisi yang diubah" (adegan-1: video tanpa waktu)
    await p.locator(sel("adegan-1")).click();
    await p.selectOption("#f-sisi", "kiri");
    await p.getByRole("button", { name: "Durasi -1" }).click();
    tegas((await mulaiDi("adegan-1")) === "1" && (await kolom(p, "adegan-1", "data-durasi")) === "89", "sisi kiri: mulai maju 1, durasi 89");
    await p.selectOption("#f-sisi", "kanan");
    // satu rangkaian putaran panah di kolom angka = satu langkah riwayat
    await p.locator("#f-mulai").focus();
    for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowUp");
    tegas((await mulaiDi("adegan-1")) === "4", `tiga putaran panah di kolom: ${await mulaiDi("adegan-1")}`);
    await p.keyboard.press("Tab"); // keluar dari kolom: memutus penggabungan
    await p.locator("#h-pratinjau").click();
    await p.keyboard.press("Control+z");
    tegas((await mulaiDi("adegan-1")) === "1", `satu Ctrl+Z membatalkan seluruh rangkaian di kolom: ${await mulaiDi("adegan-1")}`);
    await p.keyboard.press("Control+Shift+z");
    tegas((await mulaiDi("adegan-1")) === "4", "ulangi mengembalikan rangkaian");
    await p.keyboard.press("Control+z");
    // kolom angka: nilai kosong ditolak, nilai di luar rentang dijepit
    await p.fill("#f-mulai", "");
    await p.press("#f-mulai", "Enter");
    tegas((await statusTeks(p)).includes("Isi angka frame yang valid") && (await p.locator("#f-mulai").inputValue()) === "1", "kolom kosong ditolak dan dipulihkan");
    await p.fill("#f-mulai", "-30");
    await p.press("#f-mulai", "Enter");
    tegas((await mulaiDi("adegan-1")) === "0" && (await statusTeks(p)).includes("dijepit"), `kolom -30 dijepit ke 0: ${await statusTeks(p)}`);

    // seret (tambahan): satu seretan = satu langkah
    await p.locator(sel("adegan-3")).click();
    const ppf = (await p.locator(".jalur").first().evaluate((e) => parseFloat(e.style.width))) / tl.proyek.durasi;
    const kotak = await p.locator(sel("adegan-3")).boundingBox();
    const x0 = kotak.x + kotak.width / 2, y0 = kotak.y + kotak.height / 2;
    await p.mouse.move(x0, y0); await p.mouse.down();
    const dxSeret = -Math.round(ppf * 18); // 18 frame ke kiri (jauh dari batas pembulatan)
    for (const dx of [dxSeret / 6, dxSeret / 2, dxSeret]) await p.mouse.move(x0 + dx, y0);
    await p.mouse.up();
    const harapan = String(140 - 18);
    tegas((await mulaiDi("adegan-3")) === harapan, `seret pindah: ${await mulaiDi("adegan-3")} != ${harapan}`);
    await p.waitForFunction(() => document.getElementById("ekspor").getAttribute("aria-disabled") === "false", null, { timeout: 15000 });
    await p.locator("#h-pratinjau").click();
    await p.keyboard.press("Control+z");
    tegas((await mulaiDi("adegan-3")) === "140", "satu Ctrl+Z membatalkan seluruh seretan");
    await p.locator(sel("judul")).click();
    tegas((await p.locator(".gagang").count()) === 1 && (await p.locator(`${sel("judul")} .gagang`).count()) === 1, "gagang durasi hanya ada di butir terpilih");
    const gagang =await p.locator(`${sel("judul")} .gagang`).boundingBox();
    const gx = gagang.x + gagang.width / 2, gy = gagang.y + gagang.height / 2;
    await p.mouse.move(gx, gy); await p.mouse.down();
    const dxDurasi = Math.round(ppf * 10); // 10 frame ke kanan
    for (const dx of [dxDurasi / 5, dxDurasi / 2, dxDurasi]) await p.mouse.move(gx + dx, gy);
    await p.mouse.up();
    const dh = String(180 + 10);
    tegas((await kolom(p, "judul", "data-durasi")) === dh, `seret gagang durasi: ${await kolom(p, "judul", "data-durasi")} != ${dh}`);
    await p.locator("#h-pratinjau").click();
    await p.keyboard.press("Control+z");
    tegas((await kolom(p, "judul", "data-durasi")) === "180", "satu Ctrl+Z membatalkan seretan durasi");
    // SC 2.1.4: pintasan satu karakter tidak aktif di luar widget track; pintasan global wajib memakai Ctrl
    await p.locator("#h-pratinjau").click();
    const urutSebelum = await p.locator("#status").textContent();
    const mulaiSebelum = await mulaiDi("adegan-3");
    for (const k of ["s", "z", "y", "S", "Delete", "ArrowLeft"]) await p.keyboard.press(k);
    tegas((await mulaiDi("adegan-3")) === mulaiSebelum && (await p.locator('[role="gridcell"]').count()) === 11 && (await p.locator("#status").textContent()) === urutSebelum, "tombol karakter tanpa fokus di widget tidak melakukan apa pun");
    const js = readFileSync(join(dirHalaman, "penyunting.js"), "utf8");
    const pendengar = js.split('document.addEventListener("keydown"');
    tegas(pendengar.length === 2 && /^[^\n]*\n\s*if \(!\(ev\.ctrlKey \|\| ev\.metaKey\)/.test(pendengar[1]), "satu-satunya pendengar keydown global langsung menolak tanpa Ctrl/Cmd");
    tegas(asing.length === 0 && galat.length === 0, `jaringan non-lokal: ${asing.join(",")}; galat: ${galat.join(" | ")}`);
  } finally { await c.close(); await s.henti(); }
});

daftar("(y) pohon aksesibilitas penyuntingan: kontrol sunting bernama, mode sunting dan potong nonaktif dapat dibaca, tombol aria-disabled tetap dapat difokuskan", async () => {
  await pastikanUtama();
  const dir = salinFixture("aksesibilitas");
  const s = await mulaiPenyunting(join(dir, "timeline.json"), "--cache", j("cache-aksesibilitas"));
  const { c, p } = await bukaHalaman(s);
  try {
    await p.locator(sel("adegan-1")).click();
    const cdp = await c.newCDPSession(p);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const nama = (n) => (n.name?.value ?? "").trim();
    const peran = (n) => n.role?.value;
    const byName = (r) => nodes.filter((n) => !n.ignored && peran(n) === r).map(nama);
    for (const b of ["Urungkan", "Ulangi", "Ekspor", "Ekspor ketat", "Geser -1", "Geser +1", "Durasi -1", "Durasi +1", "Potong di playhead"]) tegas(byName("button").includes(b), `tombol "${b}" bernama aksesibel: ${byName("button").join(" | ")}`);
    tegas(byName("spinbutton").includes("Mulai (frame)") && byName("spinbutton").includes("Durasi (frame)"), `kolom angka berlabel: ${byName("spinbutton")}`);
    tegas(byName("combobox").some((x) => x === "Sisi yang diubah") || byName("PopUpButton").some((x) => x === "Sisi yang diubah"), "pilihan sisi berlabel");
    await cdp.detach();
    // tombol aria-disabled tetap dapat difokuskan (fokus tidak hilang saat tombol menjadi nonaktif)
    await p.locator("#urungkan").focus();
    tegas((await p.evaluate(() => document.activeElement.id)) === "urungkan", "Urungkan nonaktif tetap dapat difokuskan");
    // semua kontrol baru memenuhi ukuran sasaran 24 px
    const kecil = await p.evaluate(() => [...document.querySelectorAll("#aksi-atas button, #sunting button, #sunting input, #sunting select")].map((e) => ({ id: e.id, r: e.getBoundingClientRect() })).filter((x) => x.r.width < 24 || x.r.height < 24).map((x) => `${x.id} ${x.r.width}x${x.r.height}`));
    tegas(kecil.length === 0, `sasaran < 24 px: ${kecil.join(", ")}`);
    tegas((await p.locator("#grid").getAttribute("aria-readonly")) === null, "grid tidak lagi aria-readonly");
  } finally { await c.close(); await s.henti(); }
});

// =============================================================== (z) akhir sesi
daftar("(za) butir sangat pendek (#94): dua butir 1 frame berdampingan pada zum 100% tidak saling menumpuk, target minimal 24x24 px (SC 2.5.8), klik pusat memilih butir itu, posisi waktu tetap jujur", async () => {
  await pastikanUtama();
  const dir = salinFixture("pendek");
  const berkas = join(dir, "timeline.json");
  const dok = bacaJson(berkas);
  const dasar = dok.track.find((tr) => tr.id === "t-teks-2").butir[0];
  const buat = (id, mulai) => ({ ...salin(dasar), id, isi: id, mulai, durasi: 1, animasi: undefined });
  dok.track.find((tr) => tr.id === "t-teks-2").butir.push(buat("pendek-a", 300), buat("pendek-b", 301));
  tulisJson(berkas, dok);
  const s = await mulaiPenyunting(berkas, "--cache", j("cache-pendek"));
  const { c, p } = await bukaHalaman(s);
  try {
    const kotak = () => p.evaluate(() => [...document.querySelectorAll('[role="gridcell"]')].map((e) => {
      const r = e.getBoundingClientRect();
      return { id: e.dataset.id, t: e.dataset.track, mulai: Number(e.dataset.mulai), x: r.x, y: r.y, w: r.width, h: r.height, left: parseFloat(e.style.left) };
    }));
    tegas((await p.locator("#zum").textContent()) === "100%", "zum awal 100%");
    const semua = await kotak();
    const ppf = parseFloat(await p.evaluate(() => document.querySelector(".jalur").style.width)) / rencana.proyek.durasi;
    tegas(ppf < 12, `fixture harus membuat butir 1 frame lebih sempit dari 24 px (ppf ${ppf})`);
    // SC 2.5.8: tiap target >= 24x24 px
    for (const k of semua) tegas(k.w >= 24 - 0.01 && k.h >= 24 - 0.01, `butir ${k.id} ${k.w}x${k.h} < 24x24`);
    // tidak ada dua butir yang saling menutupi (kotak persegi panjang beririsan)
    for (const a of semua) for (const b of semua) {
      if (a.id >= b.id) continue;
      const irisan = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
      tegas(!irisan, `butir ${a.id} dan ${b.id} saling menumpuk`);
    }
    // posisi waktu jujur: left = round(mulai * ppf), tidak digeser demi target
    for (const k of semua) tegas(Math.abs(k.left - k.mulai * ppf) <= 1, `butir ${k.id}: left ${k.left} != ${(k.mulai * ppf).toFixed(2)}`);
    // klik pusat memilih butir itu, bukan tetangganya
    for (const id of ["pendek-a", "pendek-b", "pendek-a"]) {
      await p.locator(sel(id)).scrollIntoViewIfNeeded(); // area track bergulir sendiri
      const k = (await kotak()).find((x) => x.id === id);
      await p.mouse.click(k.x + k.w / 2, k.y + k.h / 2);
      const terpilih = await p.evaluate(() => [...document.querySelectorAll('[role="gridcell"][aria-selected="true"]')].map((e) => e.dataset.id));
      samaIsi(terpilih, [id], `klik pusat ${id}`);
    }
  } finally { await c.close(); await s.henti(); }
});

daftar("(z) selama seluruh sesi: tidak ada permintaan jaringan non-lokal, tidak ada galat konsol, tidak ada galat halaman", async () => {
  await pastikanUtama();
  tegas(permintaanAsing.length === 0, `permintaan non-lokal: ${permintaanAsing.join(", ")}`);
  tegas(galatKonsol.length === 0, `galat konsol: ${galatKonsol.join(" | ")}`);
  tegas(galatHalaman.length === 0, `galat halaman: ${galatHalaman.join(" | ")}`);
});

const t0 = Date.now();
let gagal = 0;
let dijalankan = 0;
try {
  for (const [nama, fn] of uji) {
    if (hanya && !nama.startsWith(hanya) && !nama.startsWith("(z)")) continue;
    dijalankan++;
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
  if (browser) await browser.close().catch(() => {});
  if (utama) await utama.henti().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${dijalankan - gagal}/${dijalankan} lolos, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(gagal ? 1 : 0);

