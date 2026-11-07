/*!
 * ketukan.js — helper murni untuk memakai keluaran `bun run ketukan` (ketukan.json) di komposisi.
 *
 * Dimuat komposisi (tidak bergantung pada runtime.js): <script src=".../scripts/ketukan.js"></script>
 * lalu dipakai lewat window.Ketukan. Data (isi ketukan.json) dikirim lewat props. Semua fungsi
 * MURNI dari nomor frame dan data: tanpa Date.now(), Math.random(), timer, CSS animation/transition.
 * Waktu dihitung dari `detik` tiap ketukan; `fps` bawaan = data.fps, boleh diganti bila
 * komposisi memakai fps lain dari yang dipakai saat analisis. Karya asli repo ini.
 *
 * API (rincian: docs/ketukan.md)
 *   ketukanTerdekat(data, frame, fps?) -> {indeks, frame, detik, selisih} | null
 *   rapatkan(data, frame, {maks, fps}) -> frame ketukan terdekat bila dalam `maks` frame, jika tidak `frame`
 *   fasaKetukan(data, frame, fps?)     -> {indeks, fase 0..1, sejak, menuju} | null (di luar rentang ketukan)
 *   denyut(data, frame, {panjang, fps}) -> 0..1: 1 tepat di ketukan, meluruh ke 0 dalam `panjang` detik
 *   ketukanDalam(data, dari, sampai, fps?) -> [{indeks, frame, detik}] pada rentang frame (inklusif)
 */
(function (akar) {
  "use strict";

  function periksa(data) {
    if (!data || !Array.isArray(data.ketukan)) throw new Error("ketukan: data harus berisi larik `ketukan` (isi ketukan.json)");
  }
  function laju(data, fps) {
    var f = fps === undefined ? data.fps : fps;
    if (!(typeof f === "number" && f > 0)) throw new Error("ketukan: fps tidak valid (beri argumen fps atau data.fps)");
    return f;
  }
  function frameKe(k, i, f) { return Math.round(k[i].detik * f); }
  /** indeks ketukan terakhir yang framenya <= frame (-1 bila belum ada). */
  function cariAtas(k, frame, f) {
    var lo = 0, hi = k.length - 1, hasil = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (frameKe(k, mid, f) <= frame) { hasil = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return hasil;
  }

  function ketukanTerdekat(data, frame, fps) {
    periksa(data);
    var k = data.ketukan;
    if (!k.length) return null;
    var f = laju(data, fps);
    var i = cariAtas(k, frame, f);
    var terbaik = i;
    if (i < 0) terbaik = 0;
    else if (i + 1 < k.length && frameKe(k, i + 1, f) - frame < frame - frameKe(k, i, f)) terbaik = i + 1;
    var fr = frameKe(k, terbaik, f);
    return { indeks: terbaik, frame: fr, detik: k[terbaik].detik, selisih: fr - frame };
  }

  function rapatkan(data, frame, opsi) {
    var o = opsi || {};
    var maks = o.maks === undefined ? 3 : o.maks;
    var n = ketukanTerdekat(data, frame, o.fps);
    return n && Math.abs(n.selisih) <= maks ? n.frame : frame;
  }

  function fasaKetukan(data, frame, fps) {
    periksa(data);
    var k = data.ketukan;
    if (k.length < 2) return null;
    var f = laju(data, fps);
    var i = cariAtas(k, frame, f);
    if (i < 0 || i >= k.length - 1) return null;
    var a = frameKe(k, i, f), b = frameKe(k, i + 1, f);
    return { indeks: i, fase: b > a ? (frame - a) / (b - a) : 0, sejak: frame - a, menuju: b - frame };
  }

  function denyut(data, frame, opsi) {
    var o = opsi || {};
    var panjang = o.panjang === undefined ? 0.2 : o.panjang;
    if (!(panjang > 0)) throw new Error("ketukan: panjang denyut harus > 0 detik");
    periksa(data);
    var k = data.ketukan;
    var f = laju(data, o.fps);
    var i = cariAtas(k, frame, f);
    if (i < 0) return 0;
    var x = (frame - frameKe(k, i, f)) / (panjang * f);
    if (x >= 1 - 1e-9) return 0;
    return (1 - x) * (1 - x);
  }

  function ketukanDalam(data, dari, sampai, fps) {
    periksa(data);
    var f = laju(data, fps), hasil = [];
    for (var i = 0; i < data.ketukan.length; i++) {
      var fr = frameKe(data.ketukan, i, f);
      if (fr > sampai) break;
      if (fr >= dari) hasil.push({ indeks: i, frame: fr, detik: data.ketukan[i].detik });
    }
    return hasil;
  }

  var api = { ketukanTerdekat: ketukanTerdekat, rapatkan: rapatkan, fasaKetukan: fasaKetukan, denyut: denyut, ketukanDalam: ketukanDalam };
  akar.Ketukan = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
