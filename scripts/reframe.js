/*!
 * reframe.js — helper murni untuk reframe 16:9 ke 9:16 (crop berkeyframe) di komposisi.
 *
 * Dimuat komposisi (tidak bergantung pada runtime.js): <script src=".../scripts/reframe.js"></script>
 * lalu dipakai lewat window.Reframe. Data (isi reframe.json, atau objek yang sama) dikirim lewat
 * props atau ditulis langsung. Semua fungsi MURNI dari nomor frame dan data: tanpa Date.now(),
 * Math.random(), timer, CSS animation/transition. Interpolasi keyframe dipasang lokal dan
 * minimal (linear, masukKeluarCubic, keluarCubic, tahan). Karya asli repo ini.
 *
 * Skema (rincian: docs/reframe.md)
 *   { versi: 1, sumber: {lebar, tinggi}, keluar: {lebar, tinggi}, fps?,
 *     keyframe: [{frame, fokus: [x, y], zoom?, easing?}],      // fokus = 0..1 dari lebar/tinggi sumber
 *     teksSumber?: [{x, y, w, h, dari?, sampai?, catatan?}] }   // kotak teks/subjek di piksel sumber
 *
 * API
 *   kotakCrop(opsi, frame)  -> {x, y, w, h, skala, fokus: [fx, fy], zoom}   (piksel sumber)
 *   gayaCrop(opsi, frame)   -> {width, height, transformOrigin, transform}  (untuk elemen sumber)
 *   periksaReframe(opsi, {durasi?}) -> {ok, galat[], peringatan[]}
 *   periksaAreaAman(kotakKeluar[], aman?) -> {ok, luar: [indeks]}    (kotak teks di bingkai 9:16)
 */
(function (akar) {
  "use strict";

  var EASING = {
    linear: function (t) { return t; },
    masukKeluarCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    keluarCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    tahan: function (t) { return t < 1 ? 0 : 1; }
  };
  var ZOOM_MAKS = 8;

  function galat(pesan) { throw new Error("reframe: " + pesan); }
  function r(n) { var v = Math.round(n * 1000) / 1000; return v === 0 ? 0 : v; }
  function jepit(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function positif(n) { return typeof n === "number" && isFinite(n) && n > 0; }

  /** Daftar galat skema (kosong bila valid); dipakai periksaReframe dan kotakCrop. */
  function galatSkema(opsi) {
    var g = [];
    if (!opsi || typeof opsi !== "object") return ["opsi harus objek"];
    if (!opsi.sumber || !positif(opsi.sumber.lebar) || !positif(opsi.sumber.tinggi)) g.push("sumber harus {lebar, tinggi} positif");
    if (!opsi.keluar || !positif(opsi.keluar.lebar) || !positif(opsi.keluar.tinggi)) g.push("keluar harus {lebar, tinggi} positif");
    var k = opsi.keyframe;
    if (!Array.isArray(k) || !k.length) { g.push("keyframe harus larik tidak kosong"); return g; }
    for (var i = 0; i < k.length; i++) {
      var q = k[i], id = "keyframe[" + i + "]";
      if (!q || typeof q.frame !== "number" || !isFinite(q.frame) || Math.floor(q.frame) !== q.frame || q.frame < 0) { g.push(id + ".frame harus bilangan bulat >= 0"); continue; }
      if (i > 0 && typeof k[i - 1].frame === "number" && q.frame <= k[i - 1].frame) g.push(id + ".frame harus naik tegas");
      if (!Array.isArray(q.fokus) || q.fokus.length !== 2 || !isFinite(q.fokus[0]) || !isFinite(q.fokus[1]) ||
          q.fokus[0] < 0 || q.fokus[0] > 1 || q.fokus[1] < 0 || q.fokus[1] > 1) g.push(id + ".fokus harus [x, y] dalam 0..1");
      if (q.zoom !== undefined && !(typeof q.zoom === "number" && q.zoom >= 1 && q.zoom <= ZOOM_MAKS)) g.push(id + ".zoom harus 1.." + ZOOM_MAKS);
      if (q.easing !== undefined && !Object.prototype.hasOwnProperty.call(EASING, q.easing)) g.push(id + ".easing tidak dikenal: " + q.easing);
    }
    return g;
  }

  /** Ukuran jendela crop pada zoom 1: persegi terbesar berasio keluar yang muat di sumber. */
  function dasarCrop(sumber, keluar) {
    var w = sumber.tinggi * keluar.lebar / keluar.tinggi;
    if (w <= sumber.lebar) return { w: w, h: sumber.tinggi };
    return { w: sumber.lebar, h: sumber.lebar * keluar.tinggi / keluar.lebar };
  }

  /** Crop tanpa pembulatan (dipakai gayaCrop agar skala tidak menggeser tepi); kotakCrop membulatkannya. */
  function hitungCrop(opsi, frame) {
    var g = galatSkema(opsi);
    if (g.length) galat(g[0]);
    if (typeof frame !== "number" || !isFinite(frame)) galat("frame harus angka");
    var k = opsi.keyframe, a, b, t = 0;
    if (frame <= k[0].frame) { a = b = k[0]; }
    else if (frame >= k[k.length - 1].frame) { a = b = k[k.length - 1]; }
    else {
      var i = 0;
      while (k[i + 1].frame <= frame) i++;
      a = k[i]; b = k[i + 1];
      t = EASING[a.easing || "linear"]((frame - a.frame) / (b.frame - a.frame));
    }
    var za = a.zoom === undefined ? 1 : a.zoom, zb = b.zoom === undefined ? 1 : b.zoom;
    var fx = a.fokus[0] + (b.fokus[0] - a.fokus[0]) * t;
    var fy = a.fokus[1] + (b.fokus[1] - a.fokus[1]) * t;
    var zoom = za + (zb - za) * t;
    var d = dasarCrop(opsi.sumber, opsi.keluar);
    var w = d.w / zoom, h = d.h / zoom;
    // Pusat di titik fokus, lalu digeser agar jendela tidak keluar dari sumber.
    var x = jepit(fx * opsi.sumber.lebar - w / 2, 0, opsi.sumber.lebar - w);
    var y = jepit(fy * opsi.sumber.tinggi - h / 2, 0, opsi.sumber.tinggi - h);
    return { x: x, y: y, w: w, h: h, skala: opsi.keluar.lebar / w, fokus: [fx, fy], zoom: zoom };
  }

  function kotakCrop(opsi, frame) {
    var c = hitungCrop(opsi, frame);
    return { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h), skala: r(c.skala), fokus: [r(c.fokus[0]), r(c.fokus[1])], zoom: r(c.zoom) };
  }

  /**
   * Gaya untuk elemen berukuran sumber (mis. stage 1920x1080 atau <video>) di dalam pembungkus
   * berukuran keluar dengan overflow: hidden dan posisi relative. Elemen: position: absolute; left/top 0.
   */
  function gayaCrop(opsi, frame) {
    var c = hitungCrop(opsi, frame);
    return {
      width: opsi.sumber.lebar + "px",
      height: opsi.sumber.tinggi + "px",
      transformOrigin: "0 0",
      transform: "translate(" + r(-c.x * c.skala) + "px, " + r(-c.y * c.skala) + "px) scale(" + Math.round(c.skala * 1e6) / 1e6 + ")"
    };
  }

  /**
   * Memeriksa skema, lalu (bila ada) memastikan setiap kotak teksSumber berada utuh di dalam
   * crop pada SETIAP frame dalam rentangnya (dari..sampai; bawaan seluruh keyframe atau `durasi`).
   * Galat melaporkan frame pertama yang memotong.
   */
  function periksaReframe(opsi, o) {
    var galatList = galatSkema(opsi), peringatan = [];
    if (galatList.length) return { ok: false, galat: galatList, peringatan: peringatan };
    var k = opsi.keyframe, akhir = k[k.length - 1].frame;
    var durasi = o && positif(o.durasi) ? o.durasi : null;
    if (durasi !== null && akhir > durasi - 1) peringatan.push("keyframe terakhir (frame " + akhir + ") di luar durasi " + durasi);
    var d = dasarCrop(opsi.sumber, opsi.keluar);
    if (d.w >= opsi.sumber.lebar && d.h >= opsi.sumber.tinggi) peringatan.push("sumber dan keluar berasio sama: reframe tidak memotong apa pun pada zoom 1");
    var teks = opsi.teksSumber || [];
    if (!Array.isArray(teks)) { galatList.push("teksSumber harus larik"); teks = []; }
    for (var i = 0; i < teks.length; i++) {
      var t = teks[i], id = "teksSumber[" + i + "]";
      if (!t || !isFinite(t.x) || !isFinite(t.y) || !positif(t.w) || !positif(t.h)) { galatList.push(id + " harus {x, y, w, h} (w, h positif)"); continue; }
      if (t.x < 0 || t.y < 0 || t.x + t.w > opsi.sumber.lebar || t.y + t.h > opsi.sumber.tinggi) { galatList.push(id + " keluar dari bingkai sumber"); continue; }
      var dari = t.dari === undefined ? 0 : t.dari;
      var sampai = t.sampai === undefined ? (durasi !== null ? durasi - 1 : akhir) : t.sampai;
      if (!(dari <= sampai)) { galatList.push(id + ": dari harus <= sampai"); continue; }
      for (var f = dari; f <= sampai; f++) {
        var c = kotakCrop(opsi, f);
        // Toleransi 0,01 piksel terhadap pembulatan kotakCrop.
        if (t.x < c.x - 0.01 || t.y < c.y - 0.01 || t.x + t.w > c.x + c.w + 0.01 || t.y + t.h > c.y + c.h + 0.01) {
          galatList.push(id + (t.catatan ? " (" + t.catatan + ")" : "") + " terpotong crop pada frame " + f);
          break;
        }
      }
    }
    return { ok: galatList.length === 0, galat: galatList, peringatan: peringatan };
  }

  /**
   * Kotak teks di bingkai keluaran ({x, y, w, h}) harus utuh di dalam `aman` ({x, y, w, h}, wajib;
   * mis. areaAmanVertikal(1080, 1920) dari runtime.js). Tidak ada nilai bawaan agar modul mandiri.
   */
  function periksaAreaAman(kotak, aman) {
    if (!Array.isArray(kotak)) galat("kotak harus larik {x, y, w, h}");
    if (!aman || !isFinite(aman.x)) galat("aman wajib {x, y, w, h} (mis. areaAmanVertikal(1080, 1920) dari runtime.js)");
    var luar = [];
    for (var i = 0; i < kotak.length; i++) {
      var b = kotak[i];
      if (!b || !isFinite(b.x) || !isFinite(b.y) || !positif(b.w) || !positif(b.h)) galat("kotak[" + i + "] harus {x, y, w, h}");
      if (b.x < aman.x || b.y < aman.y || b.x + b.w > aman.x + aman.w || b.y + b.h > aman.y + aman.h) luar.push(i);
    }
    return { ok: luar.length === 0, luar: luar };
  }

  var api = { kotakCrop: kotakCrop, gayaCrop: gayaCrop, periksaReframe: periksaReframe, periksaAreaAman: periksaAreaAman, galatSkema: galatSkema, easing: Object.keys(EASING) };
  akar.Reframe = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
