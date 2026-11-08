#!/usr/bin/env bun
/**
 * uji-penyunting.mjs — uji penyunting pratinjau lokal (scripts/penyunting.mjs dan scripts/penyunting/):
 * CLI dan kode keluar, pengerasan server (token, Host, Origin, rute daftar putih, tautan simbolik, CSP),
 * kesesuaian daftar track dengan Timeline.rencana, scrubber dan navigasi papan ketik, nama aksesibel
 * (pohon aksesibilitas CDP), frame pratinjau identik piksel dengan `render.mjs --still`, timeline yang
 * ditolak validator, tanpa permintaan jaringan non-lokal dan tanpa galat konsol, kontras token warna,
 * dan tampilan 320 px. Fixture: templates/timeline-contoh disalin ke folder sementara (data fiktif).
 * Browser lewat playwright-core dan cariBrowser (scripts/browser.js), tanpa dependensi baru.
 * Butuh Chromium dan ffmpeg. Exit 0 bila semua lolos, 1 bila ada yang gagal.
 *
 *   bun scripts/uji-penyunting.mjs [--hanya h]   # hanya uji yang namanya diawali "(h)"
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { cariBrowser } from "./browser.js";

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
function mentah(port, baris) {
  return new Promise((ok, tolak) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1", port,
      socket: {
        open(s) { s.write(`${baris.join("\r\n")}\r\n\r\n`); },
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
  for (const r of ["/tidak-ada", "/api", "/api/ekspor", "/api/periksa", "/media", "/media/klip", "/media/klip/", "/media/aset", "/scripts", "/scripts/timeline.mjs", "/scripts/render.mjs",
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
    ["teks", "latar", 4.5], ["teks", "panel", 4.5], ["redup", "latar", 4.5], ["redup", "panel", 4.5], ["teks", "tombol", 4.5],
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

// =============================================================== (z) akhir sesi
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

