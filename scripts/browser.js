/**
 * awvd / browser.js — mencari Chromium untuk render.mjs, sop.mjs, dan aset.mjs.
 *
 * Urutan: --browser, lalu PLAYWRIGHT_BROWSERS_PATH atau ~/.cache/ms-playwright
 * (headless shell, lalu chromium penuh), lalu browser sistem.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** @throws {Error} dengan properti kode = 2 bila browser tidak ditemukan */
export function cariBrowser(pilihan) {
  const gagal = (pesan) => Object.assign(new Error(pesan), { kode: 2 });
  if (pilihan) {
    if (!existsSync(pilihan)) throw gagal(`--browser tidak ada: ${pilihan}`);
    return pilihan;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  const kandidat = [
    ["chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell"],
    ["chromium-", "chrome-linux64/chrome"],
  ];
  if (existsSync(root)) {
    for (const [awalan, rel] of kandidat) {
      const dirs = readdirSync(root)
        .filter((d) => d.startsWith(awalan) && /^\d+$/.test(d.slice(awalan.length)))
        .sort((a, b) => Number(b.slice(awalan.length)) - Number(a.slice(awalan.length)));
      for (const d of dirs) {
        const exe = join(root, d, rel);
        if (existsSync(exe)) return exe;
      }
    }
  }
  for (const exe of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(exe)) return exe;
  }
  throw gagal("tidak menemukan browser Chromium; pakai --browser /path/chrome");
}
