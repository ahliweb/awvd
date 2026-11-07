/*!
 * transisi.js — modul transisi antar adegan dan animasi elemen untuk awvd.
 *
 * Dimuat komposisi setelah runtime.js: <script src=".../scripts/transisi.js"></script>
 * lalu dipakai lewat window.Transisi. Mandiri (tanpa dependensi, tidak memerlukan
 * runtime.js). Semua fungsi MURNI dari nomor frame: tanpa Date.now(), Math.random(),
 * timer, CSS animation/transition. Pembangkit acak ber-seed memakai mulberry32
 * (Tommy Ettinger, 2017, domain publik), atribusi sama dengan scripts/runtime.js.
 * Karya asli repo ini; tidak diturunkan dari proyek video lain.
 *
 * ATRIBUSI. Angka pola Material (fade through: ambang 35 %, skala awal 0,92, durasi
 * 450 ms; token durasi; kurva bezier standard/emphasized) diambil sebagai NILAI dari
 * dokumentasi dan kode terbuka Material Components for Android (Apache License 2.0,
 * Copyright Google LLC). Tidak ada kode yang disalin.
 *
 * API (rincian: docs/transisi-animasi.md)
 *   transisi(frame, {jenis, mulai, durasi|durasiMs, easing, arah, warna, intensitas, ...})
 *       -> { keluar, masuk, wadah, overlay[], svg, tampil, progres, ... }
 *   animasi(frame, {jenis, mulai, durasi|durasiMs, easing, arah, jarak, stagger, indeks,
 *                   keluarMulai, keluarDurasi, intensitas, ...}) -> gaya CSS (objek)
 *   animasiTeks(frame, teks, {mode:"huruf"|"kata", ...}) -> [{teks, spasi, gaya}]
 *   ketik(frame, teks, {mulai, cps, fps}) -> {teks, jumlah, kursor}
 *   angkaBergulir(frame, {dari, ke, mulai, durasi, desimal, awalan, akhiran}) -> {nilai, teks}
 *   jalur(frame, {titik, mulai, durasi, easing, orientasi}) -> {x, y, sudut, transform}
 *   kamera(frame, {dari, ke, ...}) / paralaks(frame, {...})  (risiko vestibular, ada peringatan)
 *   bersama(frame, {dari, ke, ...})   transformasi kontainer / elemen bersama ("magic move")
 *   susunAdegan(daftarAdegan, {fps}) -> {total, peta, pada(frame)}   penyusun adegan + transisi
 *   terapkan(hasil, {keluar, masuk, wadah, overlay})            tempel ke DOM
 *   grain(kanvas, frame, {seed, hidup, tahan, kekuatan, jenisVideo})   butiran film (kanvas)
 *   periksaKilatan(daftarTransisi, fps) -> {ok, galat[], peringatan[], kilatan}
 *   daftarTransisi(nama, fungsi, meta) / daftarAnimasi(nama, fungsi, meta)  registri kustom
 *   gabungGaya(...gaya)  komposisi berantai;  jenis boleh array: ["geser","kebocoran"]
 *   easing  (bezier, pegasEasing, nama bawaan) ; profil (standar|lansia|anak|kurangiGerak)
 *   presetJenisVideo(jenis, peran) ; efekBerat(jenisVideo) ; katalog()
 *
 * Konvensi lapisan: adegan masuk di atas (zIndex 2), keluar di bawah (zIndex 1);
 * overlay zIndex 10. Adegan dianggap OPAK (latar penuh) kecuali opsi.tembus = true.
 */
(function (akar) {
  "use strict";

  var PI = Math.PI;
  function jepit(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function r(n, d) {
    var k = Math.pow(10, d == null ? 3 : d);
    var v = Math.round(n * k) / k;
    return v === 0 ? 0 : v; // hindari -0
  }
  function px(n) { return r(n, 2) + "px"; }
  function galat(pesan) { throw new Error("transisi.js: " + pesan); }

  // ------------------------------------------------------------ acak ber-seed
  // Atribusi: mulberry32 oleh Tommy Ettinger (2017), domain publik. Dipakai sekali-tembak:
  // nilai = f(seed, k, j) murni, jadi urutan pemanggilan tak berpengaruh (aman acak-akses).
  function mulberry32(a) {
    a = (a + 0x6d2b79f5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function acak3(seed, k, j) {
    var h = (seed | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (k | 0), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13) ^ (j | 0), 0xc2b2ae35);
    return mulberry32((h ^ (h >>> 16)) >>> 0);
  }

  // ------------------------------------------------------------------ easing
  function bezier(x1, y1, x2, y2) {
    function samp(a, b, t) {
      return 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
    }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var lo = 0, hi = 1, t = x;
      for (var i = 0; i < 40; i++) {
        t = (lo + hi) / 2;
        var sx = samp(x1, x2, t);
        if (Math.abs(sx - x) < 1e-7) break;
        if (sx < x) lo = t; else hi = t;
      }
      return samp(y1, y2, t);
    };
  }
  // Easing "pegas" ternormalisasi: 1 - e^(-k t) cos(2 pi n t). Melampaui 1 (overshoot
  // ~ e^(-k/(2n)) ) lalu mereda; sisa di t=1 ~ e^-k (<0,3 %) dipotong ke 1.
  function pegasEasing(o) {
    o = o || {};
    var n = o.osilasi == null ? 1.5 : o.osilasi;
    var k = o.redaman == null ? 6.2 : o.redaman;
    return function (t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return 1 - Math.exp(-k * t) * Math.cos(2 * PI * n * t);
    };
  }
  var easing = {
    linear: function (t) { return t; },
    standar: bezier(0.2, 0, 0, 1),            // token M3 "standard"
    percepat: bezier(0.3, 0, 1, 1),           // M3 standard accelerate (keluar layar)
    perlambat: bezier(0, 0, 0, 1),            // M3 standard decelerate (masuk layar)
    ditekankan: bezier(0.05, 0.7, 0.1, 1),    // M3 emphasized decelerate
    ditekankanKeluar: bezier(0.3, 0, 0.8, 0.15),
    masukKeluar: bezier(0.4, 0, 0.2, 1),      // M2 standard curve
    kuat: bezier(0.7, 0, 0.3, 1),             // gaya promo (praktik)
    keluarCubic: function (t) { return 1 - Math.pow(1 - jepit(t, 0, 1), 3); },
    masukKeluarCubic: function (t) {
      t = jepit(t, 0, 1);
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },
    pegas: pegasEasing({ osilasi: 1.5, redaman: 6.2 }),
    pegasLembut: pegasEasing({ osilasi: 1, redaman: 6 }),
    bezier: bezier,
    pegasEasing: pegasEasing,
  };
  function lihatEasing(spec, bawaan) {
    if (spec == null) spec = bawaan;
    if (typeof spec === "function") return spec;
    if (Array.isArray(spec) && spec.length === 4) return bezier(spec[0], spec[1], spec[2], spec[3]);
    if (typeof spec === "string" && typeof easing[spec] === "function" &&
        spec !== "bezier" && spec !== "pegasEasing") return easing[spec];
    return galat("easing tidak dikenal: " + JSON.stringify(spec));
  }

  // ------------------------------------------------------------------ profil
  // Profil audiens/aksesibilitas. Angka skalaDurasi adalah KEPUTUSAN DESAIN (tidak ada
  // angka riset primer yang dibaca); kurangiGerak mengikuti pola prefers-reduced-motion.
  // Catatan: profil memengaruhi panjang total video (skalaDurasi menambah tumpang-tindih).
  var profil = {
    standar: { nama: "standar", skalaDurasi: 1, kurangiGerak: false, paralaks: true, jarak: 1, intensitas: 1, hindari: [] },
    lansia: { nama: "lansia", skalaDurasi: 1.5, kurangiGerak: false, paralaks: false, jarak: 0.6, intensitas: 0.7,
      hindari: ["gangguan", "cambuk", "kilat", "kebocoran", "halaman", "balik", "zoom", "pudarBlur"] },
    anak: { nama: "anak", skalaDurasi: 1.25, kurangiGerak: false, paralaks: false, jarak: 1, intensitas: 0.85,
      hindari: ["gangguan", "kilat"] },
    kurangiGerak: { nama: "kurangiGerak", skalaDurasi: 1, kurangiGerak: true, paralaks: false, jarak: 0, intensitas: 0.5, hindari: [] },
  };
  function lihatProfil(p) {
    if (p == null) return profil.standar;
    if (typeof p === "string") return profil[p] || galat("profil tidak dikenal: " + p);
    var d = profil.standar, o = {};
    for (var k in d) o[k] = p[k] == null ? d[k] : p[k];
    o.hindari = p.hindari || d.hindari;
    return o;
  }

  // ------------------------------------------------------------ util geometri
  var VEC = { kiri: [-1, 0], kanan: [1, 0], atas: [0, -1], bawah: [0, 1] };
  function vec(arah) { return VEC[arah] || galat("arah harus kiri|kanan|atas|bawah, dapat: " + arah); }
  function msKeFrame(ms, fps) { var n = Math.round(ms * fps / 1000); return ms > 0 && n < 1 ? 1 : (n || 0); }

  // Gaya dasar lengkap supaya properti sisa dari frame/efek sebelumnya selalu direset.
  function dasarLapis(ekstra) {
    var g = {
      display: "", opacity: 1, transform: "none", transformOrigin: "50% 50%", clipPath: "none",
      filter: "none", maskImage: "none", webkitMaskImage: "none", backfaceVisibility: "visible",
      zIndex: 1,
    };
    if (ekstra) for (var k in ekstra) g[k] = ekstra[k];
    if (g.maskImage !== "none" && ekstra && ekstra.webkitMaskImage == null) g.webkitMaskImage = g.maskImage;
    if (typeof g.opacity === "number") g.opacity = r(jepit(g.opacity, 0, 1), 4);
    return g;
  }
  function dasarWadah(ekstra) {
    var g = { perspective: "none", perspectiveOrigin: "50% 50%", background: "" };
    if (ekstra) for (var k in ekstra) g[k] = ekstra[k];
    return g;
  }

  // Komposisi berantai: transform & filter digabung berurutan, opacity dikalikan,
  // clipPath/maskImage: yang terakhir non-"none" menang, properti lain: yang terakhir menang.
  function gabungGaya() {
    var hasil = {};
    for (var i = 0; i < arguments.length; i++) {
      var s = arguments[i];
      if (!s) continue;
      for (var k in s) {
        var v = s[k];
        if (k === "transform" || k === "filter") {
          if (v === "none" || v == null) { if (hasil[k] == null) hasil[k] = "none"; continue; }
          hasil[k] = hasil[k] && hasil[k] !== "none" ? hasil[k] + " " + v : v;
        } else if (k === "opacity") {
          hasil[k] = (hasil[k] == null ? 1 : hasil[k]) * v;
        } else if (k === "clipPath" || k === "maskImage" || k === "webkitMaskImage") {
          if (v !== "none" || hasil[k] == null) hasil[k] = v;
        } else hasil[k] = v;
      }
    }
    if (typeof hasil.opacity === "number") hasil.opacity = r(hasil.opacity, 4);
    return hasil;
  }

  // ===================================================================== TRANSISI
  var T = {}; // registri: nama -> {fn, meta}
  function def(nama, fn, meta) {
    meta = meta || {};
    T[nama] = {
      fn: fn,
      durMs: meta.durMs == null ? 500 : meta.durMs,
      durMinMs: meta.durMinMs || 0,
      easing: meta.easing || "standar",
      gerakBesar: !!meta.gerakBesar,
      kilat: meta.kilat || 0,        // perkiraan jumlah "kilatan" WCAG per kemunculan
      biaya: meta.biaya || "rendah", // biaya render/kompresi: rendah | sedang | tinggi (tinggi: mati bawaan untuk jenis video tanpa efekBerat)
      risiko: meta.risiko || "rendah",
      makna: meta.makna || "",
      cocok: meta.cocok || [],
      sumber: meta.sumber || "",
    };
  }

  // ---- potong / dissolve / dip ------------------------------------------------
  def("potong", function () { return { tampilKhusus: true }; }, {
    durMs: 0, easing: "linear",
    makna: "kontinuitas, kecepatan; edit tak terdeteksi bila mengikuti kontinuitas",
    cocok: ["formal", "edukasi", "dokumenter", "panduan", "internal", "promo", "sosial", "data", "kreatif"],
    sumber: "Murch 2001; Smith & Henderson 2008; Magliano & Zacks 2011",
  });
  def("pudar", function (pe, p, c) {
    var m = jepit(pe, 0, 1);
    return { masuk: { opacity: m, zIndex: 2 }, keluar: c.tembus ? { opacity: 1 - m } : {} };
  }, {
    biaya: "sedang",
    durMs: 500, easing: "masukKeluar",
    makna: "waktu berlalu, hubungan/kemiripan antar adegan, nada tenang",
    cocok: ["formal", "dokumenter", "edukasi", "testimoni", "produk", "data", "internal"],
    sumber: "Bordwell & Thompson; Cutting 2014 (dissolve/fade menandai batas peristiwa)",
  });
  def("celup", function (pe, p, c) {
    var e = c.ease;
    var u = p < 0.5 ? e(p * 2) : 1 - e(p * 2 - 1);
    return {
      overlay: [{ background: c.warna, opacity: jepit(u, 0, 1) }],
      tampil: { keluar: p < 0.5, masuk: p >= 0.5 },
      masuk: { zIndex: 2 },
    };
  }, {
    durMs: 700, easing: "masukKeluar", kilat: 1,
    makna: "akhir bab/segmen, jeda napas, penutup (dip to black)",
    cocok: ["dokumenter", "formal", "kreatif", "testimoni", "psa"],
    sumber: "Dancyger 2010; Bordwell & Thompson",
  });
  def("pudarMelalui", function (pe, p, c) {
    // keluar memudar di 35 % pertama; masuk muncul dari 35 % dengan skala 0,92 -> 1
    var o1 = jepit(p / 0.35, 0, 1);
    var o2 = jepit((p - 0.35) / 0.65, 0, 1);
    var skala = c.kurangiGerak ? 1 : 0.92 + 0.08 * jepit(pe, 0, 1);
    var ekstra = { opacity: c.ease(o2), zIndex: 2 };
    if (skala !== 1) ekstra.transform = "scale(" + r(skala, 4) + ")";
    return {
      keluar: { opacity: 1 - o1 }, masuk: ekstra,
      wadah: c.warna ? { background: c.warna } : null,
      tampil: { keluar: p < 0.35, masuk: p > 0.35 - 1e-9 },
    };
  }, {
    biaya: "sedang",
    durMs: 450, easing: "ditekankan",
    makna: "antar bagian/destinasi tanpa hubungan kuat (fade through Material)",
    cocok: ["formal", "edukasi", "panduan", "produk", "data", "internal"],
    sumber: "Material Design 3 transition patterns (fade through): 35 %, skala 0,92, 450 ms",
  });
  def("pudarBlur", function (pe, p, c) {
    var m = jepit(pe, 0, 1), B = 14 * c.intensitas;
    return {
      keluar: { filter: m > 0 ? "blur(" + r(B * m, 2) + "px)" : "none" },
      masuk: { opacity: m, zIndex: 2, filter: m < 1 ? "blur(" + r(B * (1 - m), 2) + "px)" : "none" },
    };
  }, {
    biaya: "sedang",
    durMs: 600, easing: "masukKeluar", gerakBesar: true, risiko: "sedang",
    makna: "mimpi/kenangan, lembut, bertema fokus (blur counts as motion di WCAG 2.3.3)",
    cocok: ["kreatif", "dokumenter", "testimoni"],
    sumber: "praktik; WCAG 2.2 Understanding 2.3.3 (blur = animasi gerak)",
  });

  // ---- geser / dorong / tumpuk ---------------------------------------------------
  function ofsMasuk(v, w, h, m) { return [-v[0] * w * (1 - m), -v[1] * h * (1 - m)]; }
  def("geser", function (pe, p, c) {
    var v = vec(c.arah), o = ofsMasuk(v, c.w, c.h, pe);
    var kx = v[0] * c.w * 0.3 * jepit(pe, 0, 1) * c.paralaks, ky = v[1] * c.h * 0.3 * jepit(pe, 0, 1) * c.paralaks;
    return {
      masuk: { transform: "translate(" + px(o[0]) + "," + px(o[1]) + ")", zIndex: 2 },
      keluar: c.paralaks > 0 ? { transform: "translate(" + px(kx) + "," + px(ky) + ")" } : {},
    };
  }, {
    durMs: 450, easing: "ditekankan", gerakBesar: true, risiko: "sedang",
    makna: "perpindahan topik/tempat; lapisan baru menutup lapisan lama",
    cocok: ["promo", "sosial", "produk", "acara", "kreatif", "edukasi"],
    sumber: "Material shared axis (x/y); praktik",
  });
  def("dorong", function (pe, p, c) {
    var v = vec(c.arah), o = ofsMasuk(v, c.w, c.h, pe), m = pe;
    var rk = c.rasioKeluar == null ? 1 : c.rasioKeluar;
    return {
      masuk: { transform: "translate(" + px(o[0]) + "," + px(o[1]) + ")", zIndex: 2 },
      keluar: { transform: "translate(" + px(v[0] * c.w * m * rk) + "," + px(v[1] * c.h * m * rk) + ")" },
    };
  }, {
    durMs: 450, easing: "masukKeluar", gerakBesar: true, risiko: "sedang",
    makna: "perpindahan tempat/topik berurutan (push); rasioKeluar<1 = paralaks",
    cocok: ["promo", "sosial", "produk", "acara", "edukasi", "panduan"],
    sumber: "Apple HIG (arah gerak konsisten); Material shared axis",
  });
  def("tumpuk", function (pe, p, c) {
    var v = vec(c.arah), o = ofsMasuk(v, c.w, c.h, pe), m = jepit(pe, 0, 1);
    return {
      masuk: { transform: "translate(" + px(o[0]) + "," + px(o[1]) + ")", zIndex: 2 },
      keluar: {
        transform: "translate(" + px(v[0] * c.w * 0.15 * m) + "," + px(v[1] * c.h * 0.15 * m) + ") scale(" + r(1 - 0.06 * m, 4) + ")",
        filter: m > 0 ? "brightness(" + r(1 - 0.35 * m, 3) + ")" : "none",
      },
    };
  }, {
    durMs: 500, easing: "ditekankan", gerakBesar: true, risiko: "sedang",
    makna: "hierarki/kedalaman: adegan baru 'di atas' adegan lama (z-axis)",
    cocok: ["produk", "panduan", "promo", "edukasi"],
    sumber: "Material shared axis (z); praktik",
  });

  // ---- sapu / belah / kisi -------------------------------------------------------
  var SUDUT = { kanan: 90, kiri: 270, bawah: 180, atas: 0 };
  def("sapu", function (pe, p, c) {
    var m = jepit(pe, 0, 1), lembut = c.lembut || 0;
    if (lembut <= 0 && c.sudut == null) {
      var s = (1 - m) * 100, a = vec(c.arah), inset;
      if (a[0] > 0) inset = "inset(0 " + r(s, 3) + "% 0 0)";
      else if (a[0] < 0) inset = "inset(0 0 0 " + r(s, 3) + "%)";
      else if (a[1] > 0) inset = "inset(0 0 " + r(s, 3) + "% 0)";
      else inset = "inset(" + r(s, 3) + "% 0 0 0)";
      return { masuk: { clipPath: inset, zIndex: 2 } };
    }
    var f = Math.max(lembut, 2), pos = m * (100 + f) - f;
    var ang = c.sudut != null ? c.sudut : SUDUT[c.arah];
    var mask = "linear-gradient(" + ang + "deg,#000 " + r(pos, 3) + "%,transparent " + r(pos + f, 3) + "%)";
    return { masuk: { maskImage: mask, webkitMaskImage: mask, zIndex: 2 } };
  }, {
    durMs: 500, easing: "masukKeluar", gerakBesar: true, risiko: "sedang",
    makna: "perpindahan tempat/topik, gaya grafis; tepi lembut = lebih halus",
    cocok: ["promo", "sosial", "produk", "acara", "kreatif", "edukasi"],
    sumber: "Bordwell & Thompson (wipe); praktik",
  });
  def("belah", function (pe, p, c) {
    var m = jepit(pe, 0, 1), a = 50 - 50 * m, b = 50 + 50 * m, hor = vec(c.arah)[0] !== 0;
    var poly = hor
      ? "polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0," + r(a, 3) + "% 0," + r(a, 3) + "% 100%," + r(b, 3) + "% 100%," + r(b, 3) + "% 0," + r(a, 3) + "% 0)"
      : "polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,0 " + r(a, 3) + "%,100% " + r(a, 3) + "%,100% " + r(b, 3) + "%,0 " + r(b, 3) + "%,0 " + r(a, 3) + "%)";
    return { keluar: { clipPath: poly, zIndex: 2 }, masuk: { zIndex: 1 } };
  }, {
    durMs: 600, easing: "masukKeluar", gerakBesar: true, risiko: "sedang",
    makna: "membuka (barn door): pengungkapan, pembuka acara",
    cocok: ["acara", "promo", "kreatif"],
    sumber: "praktik",
  });
  def("kisi", function (pe, p, c) {
    var m = jepit(pe, 0, 1), n = c.jumlah || 8, vert = vec(c.arah)[0] !== 0;
    var S = (vert ? c.w : c.h) / n, X = S * m;
    var mask = "repeating-linear-gradient(" + (vert ? 90 : 180) + "deg,#000 0px,#000 " + r(X, 2) + "px,transparent " + r(X, 2) + "px,transparent " + r(S, 2) + "px)";
    return { masuk: { maskImage: mask, webkitMaskImage: mask, zIndex: 2 } };
  }, {
    durMs: 600, easing: "masukKeluar", gerakBesar: true, risiko: "sedang",
    makna: "jalusi (blinds): ritme grafis, tema teknologi/data",
    cocok: ["promo", "data", "kreatif", "produk"],
    sumber: "praktik",
  });

  // ---- iris / bentuk ----------------------------------------------------------------
  function pusatPx(c) {
    var q = c.pusat || [0.5, 0.5];
    return [q[0] * c.w, q[1] * c.h];
  }
  function jarakTerjauh(c, ct) {
    var dx = Math.max(ct[0], c.w - ct[0]), dy = Math.max(ct[1], c.h - ct[1]);
    return Math.sqrt(dx * dx + dy * dy);
  }
  def("iris", function (pe, p, c) {
    var ct = pusatPx(c), R = jarakTerjauh(c, ct), m = jepit(pe, 0, 1), lembut = c.lembut || 0;
    if (c.mode === "tutup") { // lingkaran keluar menyusut, masuk sudah di bawah
      var rr = R * (1 - m);
      return { keluar: { clipPath: "circle(" + px(rr) + " at " + px(ct[0]) + " " + px(ct[1]) + ")", zIndex: 2 }, masuk: { zIndex: 1 } };
    }
    if (lembut > 0) {
      var rt = m * (R + lembut), mask = "radial-gradient(circle at " + px(ct[0]) + " " + px(ct[1]) + ",#000 " + px(Math.max(rt - lembut, 0)) + ",transparent " + px(rt) + ")";
      return { masuk: { maskImage: mask, webkitMaskImage: mask, zIndex: 2 } };
    }
    return { masuk: { clipPath: "circle(" + px(R * m) + " at " + px(ct[0]) + " " + px(ct[1]) + ")", zIndex: 2 } };
  }, {
    durMs: 600, easing: "ditekankan", gerakBesar: true, risiko: "sedang",
    makna: "fokus ke satu titik (iris/shape reveal); buka = pengungkapan, tutup = akhir",
    cocok: ["kreatif", "promo", "acara", "sosial", "edukasi"],
    sumber: "Bordwell & Thompson (iris); praktik",
  });
  var BENTUK = {
    berlian: [[0, -1], [1, 0], [0, 1], [-1, 0]],
    kotak: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
    segienam: (function () { var a = []; for (var i = 0; i < 6; i++) a.push([Math.cos(i * PI / 3), Math.sin(i * PI / 3)]); return a; })(),
    bintang: (function () { var a = []; for (var i = 0; i < 10; i++) { var rd = i % 2 ? 0.45 : 1, t = -PI / 2 + i * PI / 5; a.push([rd * Math.cos(t), rd * Math.sin(t)]); } return a; })(),
  };
  var apotemaCache = {};
  function apotema(nama) { // jari-jari lingkaran terbesar di dalam poligon (jarak min titik asal ke sisi)
    if (apotemaCache[nama]) return apotemaCache[nama];
    var P = BENTUK[nama], best = Infinity;
    for (var i = 0; i < P.length; i++) {
      var a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1];
      var t = jepit(-(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy), 0, 1);
      var qx = a[0] + t * dx, qy = a[1] + t * dy, d = Math.sqrt(qx * qx + qy * qy);
      if (d < best) best = d;
    }
    return (apotemaCache[nama] = best);
  }
  def("bentuk", function (pe, p, c) {
    var nama = c.bentuk || "berlian", P = BENTUK[nama] || galat("bentuk tidak dikenal: " + nama);
    var ct = pusatPx(c), R = jarakTerjauh(c, ct), s = (R / apotema(nama)) * 1.002 * jepit(pe, 0, 1);
    var pts = [];
    for (var i = 0; i < P.length; i++) pts.push(px(ct[0] + P[i][0] * s) + " " + px(ct[1] + P[i][1] * s));
    return { masuk: { clipPath: "polygon(" + pts.join(",") + ")", zIndex: 2 } };
  }, {
    durMs: 600, easing: "ditekankan", gerakBesar: true, risiko: "sedang",
    makna: "pengungkapan berbentuk (berlian/segienam/bintang/kotak) bermerek",
    cocok: ["kreatif", "promo", "acara", "sosial"],
    sumber: "praktik",
  });

  // ---- zoom / cambuk -----------------------------------------------------------------
  def("zoom", function (pe, p, c) {
    var m = jepit(pe, 0, 1), i = c.intensitas;
    if (c.mode === "keluar") {
      return {
        keluar: { transform: "scale(" + r(1 - 0.25 * i * m, 4) + ")", opacity: 1 - jepit(m * 1.4, 0, 1), zIndex: 2 },
        masuk: { transform: "scale(" + r(1 + 0.3 * i * (1 - m), 4) + ")", zIndex: 1 },
      };
    }
    return {
      keluar: { transform: "scale(" + r(1 + 0.6 * i * m, 4) + ")", opacity: 1 - jepit(m * 1.4, 0, 1), zIndex: 2 },
      masuk: { transform: "scale(" + r(1 + 0.18 * i * (1 - m), 4) + ")", zIndex: 1 }, // >=1: tak membuka tepi latar
    };
  }, {
    durMs: 450, easing: "masukKeluar", gerakBesar: true, risiko: "tinggi",
    makna: "energi, menyelam ke detail / mundur ke konteks (zoom through)",
    cocok: ["promo", "sosial", "acara", "kreatif"],
    sumber: "praktik; Apple HIG & WCAG 2.3.3 (zoom = pemicu vestibular)",
  });
  def("cambuk", function (pe, p, c) {
    var v = vec(c.arah), m = jepit(pe, 0, 1), B = 36 * c.intensitas * Math.sin(PI * m);
    var o = ofsMasuk(v, c.w, c.h, m);
    var spec = B > 0.3 ? { jenis: "kabur", sx: Math.abs(v[0]) * B, sy: Math.abs(v[1]) * B } : null;
    var f = spec ? "url(#awvd-%PERAN%)" : "none";
    return {
      keluar: { transform: "translate(" + px(v[0] * c.w * m) + "," + px(v[1] * c.h * m) + ")", filter: f.replace("%PERAN%", "keluar") },
      masuk: { transform: "translate(" + px(o[0]) + "," + px(o[1]) + ")", zIndex: 2, filter: f.replace("%PERAN%", "masuk") },
      svg: { keluar: spec, masuk: spec },
    };
  }, {
    biaya: "sedang",
    durMs: 300, easing: "kuat", gerakBesar: true, risiko: "tinggi",
    makna: "energi tinggi, cepat (whip pan) — promo/sosial",
    cocok: ["promo", "sosial", "acara", "kreatif"],
    sumber: "praktik; Bordwell & Thompson (swish pan)",
  });

  // ---- 3D: halaman / balik ------------------------------------------------------------
  def("halaman", function (pe, p, c) {
    var m = jepit(pe, 0, 1), kanan = vec(c.arah)[0] >= 0; // arah "kanan": halaman dibalik ke kanan
    var sudut = (kanan ? 1 : -1) * 180 * m;
    var asal = kanan ? "left center" : "right center";
    var bayang = 0.45 * Math.sin(PI * m);
    return {
      wadah: { perspective: "2400px", perspectiveOrigin: "50% 50%" },
      keluar: { transform: "rotateY(" + r(sudut, 3) + "deg)", transformOrigin: asal, backfaceVisibility: "hidden", zIndex: 2 },
      masuk: { zIndex: 1 },
      overlay: [{ background: "linear-gradient(" + (kanan ? "to right" : "to left") + ",rgba(0,0,0," + r(bayang, 3) + "),rgba(0,0,0,0) 55%)", opacity: 1 }],
    };
  }, {
    biaya: "sedang",
    durMs: 900, easing: "masukKeluar", gerakBesar: true, risiko: "tinggi",
    makna: "buku/majalah, urutan kronologis lembar (page turn sederhana, tanpa lengkung)",
    cocok: ["kreatif", "acara", "dokumenter"],
    sumber: "praktik; keterbatasan: tanpa lengkung halaman",
  });
  def("balik", function (pe, p, c) {
    var m = jepit(pe, 0, 1), kanan = vec(c.arah)[0] >= 0, s = kanan ? 1 : -1;
    if (m < 0.5) {
      return { keluar: { transform: "perspective(2400px) rotateY(" + r(-s * 180 * m, 3) + "deg)", zIndex: 2 }, tampil: { keluar: true, masuk: false } };
    }
    return { masuk: { transform: "perspective(2400px) rotateY(" + r(s * 180 * (1 - m), 3) + "deg)", zIndex: 2 }, tampil: { keluar: false, masuk: true } };
  }, {
    durMs: 700, easing: "masukKeluar", gerakBesar: true, risiko: "tinggi",
    makna: "kartu dibalik: dua sisi satu hal (sebelum/sesudah, mitos/fakta)",
    cocok: ["edukasi", "kreatif", "promo"],
    sumber: "praktik; Material container transform (konsep hubungan)",
  });

  // ---- efek piksel via filter SVG / overlay ------------------------------------------
  def("gangguan", function (pe, p, c) {
    var seed = c.seed | 0, k = Math.floor(c.frame / 2); // pembaruan 15 Hz pada 30 fps: tidak berkedip tiap frame
    var sp = 0.4 + 0.2 * acak3(seed, -1, 0);
    var env = Math.sin(PI * p);
    var aktif = acak3(seed, k, 1) < 0.45 + 0.5 * env;
    var A = c.intensitas * env * (0.5 + 0.5 * acak3(seed, k, 2));
    var tampilKeluar = p < sp;
    var out = { tampil: { keluar: tampilKeluar, masuk: !tampilKeluar }, masuk: { zIndex: 2 }, keluar: {} };
    if (aktif && A > 0.02) {
      var spec = {
        jenis: "gangguan", seed: 1 + Math.floor(acak3(seed, k, 3) * 9998),
        fy: r(0.015 + 0.07 * acak3(seed, k, 4), 4), skala: r(70 * A, 2),
        rgb: r(10 * A * (acak3(seed, k, 5) < 0.5 ? -1 : 1), 2),
      };
      var dx = r(24 * A * (acak3(seed, k, 6) - 0.5), 2);
      var peran = tampilKeluar ? "keluar" : "masuk";
      out[peran] = { filter: "url(#awvd-" + peran + ")", transform: "translateX(" + dx + "px)", zIndex: peran === "masuk" ? 2 : 1 };
      out.svg = {}; out.svg[peran] = spec;
    }
    return out;
  }, {
    biaya: "tinggi",
    durMs: 400, durMinMs: 300, easing: "linear", gerakBesar: true, risiko: "sedang", kilat: 0,
    makna: "gangguan digital/teknologi, hook promo/sosial; luminans tidak diubah (tanpa kilatan)",
    cocok: ["promo", "sosial", "kreatif", "acara"],
    sumber: "praktik; WCAG 2.3.1 (dijaga: pembaruan <=15 Hz, tanpa lonjakan luminans global)",
  });
  def("kebocoran", function (pe, p, c) {
    var env = Math.pow(Math.sin(PI * p), 2), A = 0.8 * c.intensitas * env;
    var w = c.warna || [255, 150, 70];
    if (typeof w === "string") w = [255, 150, 70];
    // jaga bukan merah jenuh (WCAG red flash: R/(R+G+B) >= 0,8)
    var jml = w[0] + w[1] + w[2] || 1, g = w[1];
    if (w[0] / jml >= 0.8) g = Math.ceil((w[0] * 0.25 + 1)); // dorong hijau agar R/(R+G+B) < 0,8
    var x = 10 + 80 * p;
    var bg = "radial-gradient(60% 85% at " + r(x, 2) + "% 40%,rgba(" + w[0] + "," + g + "," + w[2] + "," + r(A, 3) + ") 0%,rgba(255,80,30," + r(A * 0.55, 3) + ") 40%,rgba(255,80,30,0) 72%)," +
      "radial-gradient(50% 70% at " + r(Math.min(x + 28, 100), 2) + "% 72%,rgba(255,215,130," + r(A * 0.7, 3) + ") 0%,rgba(255,215,130,0) 66%)";
    var m = jepit(pe, 0, 1);
    return {
      masuk: { opacity: m, zIndex: 2 },
      overlay: [{ background: bg, opacity: 1, mixBlendMode: "screen" }],
    };
  }, {
    biaya: "sedang",
    durMs: 800, durMinMs: 700, easing: "masukKeluar", kilat: 1, risiko: "sedang",
    makna: "nostalgia, hangat, sinematik (light leak); naik-turun pelan sehingga bukan kilatan",
    cocok: ["kreatif", "dokumenter", "acara", "testimoni"],
    sumber: "praktik; WCAG 2.3.1 (durasi minimum 700 ms, puncak sin^2, bukan merah jenuh)",
  });
  def("kilat", function (pe, p, c) {
    var puncak = Math.min(0.5, 0.5 * c.intensitas), env = Math.pow(Math.sin(PI * p), 2);
    var m = jepit(pe, 0, 1);
    return { masuk: { opacity: m, zIndex: 2 }, overlay: [{ background: "#fff", opacity: puncak * env }] };
  }, {
    durMs: 450, durMinMs: 400, easing: "masukKeluar", kilat: 1, risiko: "tinggi",
    makna: "benturan/penekanan (flash bloom) — aman: puncak <=50 %, minimal 400 ms, satu kilatan",
    cocok: ["promo", "sosial", "acara"],
    sumber: "praktik; WCAG 2.3.1 (<=3 kilatan/detik; dibatasi puncak alfa dan durasi)",
  });
  def("tirai", function (pe, p, c) {
    var v = vec(c.arah), e = c.ease, W = c.w, H = c.h, x, y, warna2 = c.warna2;
    function pos(q) { // q 0..1 keseluruhan; <0.5 menutup, >=0.5 membuka
      var u = q < 0.5 ? -(1 - e(q * 2)) : e(q * 2 - 1);
      return [v[0] * W * u, v[1] * H * u];
    }
    var a = pos(p), ov = [{ background: c.warna || "#0ea5e9", transform: "translate(" + px(a[0]) + "," + px(a[1]) + ")", opacity: 1 }];
    if (warna2) {
      var b = pos(jepit(p - 0.12, 0, 1));
      ov.unshift({ background: warna2, transform: "translate(" + px(b[0]) + "," + px(b[1]) + ")", opacity: 1 });
    }
    return { overlay: ov, tampil: { keluar: p < 0.5, masuk: p >= 0.5 }, masuk: { zIndex: 2 } };
  }, {
    durMs: 700, easing: "masukKeluar", gerakBesar: true, risiko: "sedang", kilat: 1,
    makna: "panel warna merek menyapu layar (brand wipe) menyembunyikan pergantian adegan",
    cocok: ["promo", "sosial", "acara", "produk", "kreatif"],
    sumber: "praktik",
  });

  // -------------------------------------------------------------- inti transisi
  function durasiTransisi(o) {
    o = o || {};
    var fps = o.fps || 30, prof = lihatProfil(o.profil);
    var nama = namaEfektif(o.jenis || "pudar", prof, blokirBeratDari(o));
    var d = Array.isArray(nama) ? T[nama[0]] : T[nama];
    if (!d) galat("jenis transisi tidak dikenal: " + nama);
    var n;
    if (o.durasi != null) n = o.durasi;
    else if (o.durasiMs != null) n = msKeFrame(o.durasiMs, fps);
    else n = msKeFrame(d.durMs, fps);
    if (n > 0) n = Math.max(1, Math.round(n * prof.skalaDurasi));
    var dm = 0;
    (Array.isArray(nama) ? nama : [nama]).forEach(function (x) { if (T[x] && T[x].durMinMs > dm) dm = T[x].durMinMs; });
    var min = msKeFrame(dm, fps);
    if (n < min) n = min;
    return n;
  }
  // blokirBerat: true bila jenis video (opsi jenisVideo) tidak mengizinkan efek berbiaya tinggi.
  function blokirBeratDari(o) {
    return o.jenisVideo != null && !o.paksaEfekBerat && !efekBerat(o.jenisVideo);
  }
  function namaEfektif(jenis, prof, blokirBerat) {
    if (Array.isArray(jenis)) return jenis.map(function (j) { return namaEfektif(j, prof, blokirBerat); });
    var o = typeof jenis === "object" && jenis ? jenis.jenis : jenis;
    var d = T[o];
    if (!d) return o;
    if (prof.hindari.indexOf(o) >= 0) return "pudar";
    if (blokirBerat && d.biaya === "tinggi") return "pudar";
    if (prof.kurangiGerak && (d.gerakBesar || (d.kilat && o !== "celup"))) return "pudar";
    return o;
  }

  function transisi(frame, o) {
    o = o || {};
    var fps = o.fps || 30, prof = lihatProfil(o.profil);
    var asal = o.jenis || "pudar";
    var efektif = namaEfektif(asal, prof, blokirBeratDari(o));
    var daftar = Array.isArray(efektif) ? efektif : [efektif];
    var peringatan = [];
    var durasi = durasiTransisi(o);
    var mulai = o.mulai || 0;
    var potong = daftar.length === 1 && daftar[0] === "potong";
    var p = durasi <= 0 ? (frame >= mulai ? 1 : 0) : jepit((frame - mulai) / durasi, 0, 1);
    if (potong) p = frame >= mulai ? 1 : 0;
    var ease = lihatEasing(o.easing, T[daftar[0]] ? T[daftar[0]].easing : "standar");
    var pe = ease(p);
    var ctx = {
      w: o.lebar || 1280, h: o.tinggi || 720, arah: o.arah || "kiri", warna: o.warna, warna2: o.warna2,
      intensitas: (o.intensitas == null ? 1 : o.intensitas) * prof.intensitas,
      seed: o.seed == null ? 1 : o.seed, frame: frame, durasi: durasi, ease: ease,
      lembut: o.lembut, sudut: o.sudut, jumlah: o.jumlah, bentuk: o.bentuk, mode: o.mode,
      pusat: o.pusat, tembus: !!o.tembus, kurangiGerak: prof.kurangiGerak,
      paralaks: prof.paralaks && o.paralaks != null ? o.paralaks : 0, // paralaks hanya bila diminta & profil mengizinkan
      rasioKeluar: o.rasioKeluar,
    };
    if (ctx.warna == null && daftar[0] === "celup") ctx.warna = "#000";
    if (asal !== efektif && !(Array.isArray(asal))) {
      peringatan.push("jenis '" + asal + "' diganti '" + efektif + "' oleh " +
        (blokirBeratDari(o) && T[asal] && T[asal].biaya === "tinggi" && prof.hindari.indexOf(asal) < 0 ? "jenis video '" + o.jenisVideo + "' (efek berat mati)" : "profil '" + prof.nama + "'"));
    }

    var keluar = dasarLapis({ zIndex: 1 }), masuk = dasarLapis({ zIndex: 2 });
    var tampil = { keluar: p < 1, masuk: p > 0 };
    var wadah = dasarWadah(), overlay = [], svg = null;
    keluar.opacity = 1; masuk.opacity = p > 0 ? 1 : 0;

    var sub = [];
    daftar.forEach(function (nm, idx) {
      var d = T[nm];
      if (!d) galat("jenis transisi tidak dikenal: " + nm);
      var cc = ctx;
      if (daftar.length > 1) { // parameter per-anak boleh lewat objek {jenis, ...}
        var spec = Array.isArray(asal) && typeof asal[idx] === "object" ? asal[idx] : null;
        if (spec) { cc = {}; for (var k in ctx) cc[k] = ctx[k]; for (var k2 in spec) if (k2 !== "jenis") cc[k2] = spec[k2]; }
      }
      var s = nm === "potong" ? {} : d.fn(pe, p, cc) || {};
      sub.push(s);
    });

    // gabung: masuk/keluar dikomposisikan berurutan
    var k0 = { keluar: keluar, masuk: masuk };
    sub.forEach(function (s) {
      if (s.keluar) k0.keluar = gabungGaya(k0.keluar, s.keluar);
      if (s.masuk) k0.masuk = gabungGaya(k0.masuk, s.masuk);
      if (s.wadah) wadah = dasarWadah(gabungGaya(wadah, s.wadah));
      if (s.overlay) overlay = overlay.concat(s.overlay);
      if (s.svg) { svg = svg || {}; for (var q in s.svg) svg[q] = s.svg[q]; }
      if (s.tampil) { tampil.keluar = tampil.keluar && s.tampil.keluar; tampil.masuk = tampil.masuk && s.tampil.masuk; }
    });
    keluar = k0.keluar; masuk = k0.masuk;
    // clipPath/mask pada "keluar" dan "masuk": pastikan zIndex lapisan atas konsisten
    if (keluar.zIndex == null) keluar.zIndex = 1;
    if (masuk.zIndex == null) masuk.zIndex = 2;
    if (!tampil.keluar) { keluar.display = "none"; }
    if (!tampil.masuk) { masuk.display = "none"; }
    // ujung jendela: keadaan bersih (identitas) agar tak ada sisa transform/clip/filter
    if (p <= 0) { keluar = dasarLapis({ zIndex: 1 }); masuk = dasarLapis({ zIndex: 2, opacity: 0, display: "none" }); tampil.masuk = false; tampil.keluar = true; }
    if (p >= 1) { tampil.keluar = false; tampil.masuk = true; keluar = dasarLapis({ zIndex: 1, display: "none" }); masuk = dasarLapis({ zIndex: 2 }); svg = null; }
    var ov = overlay.map(function (g) {
      var q = { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 10, opacity: 1 };
      for (var k in g) q[k] = g[k];
      if (typeof q.opacity === "number") q.opacity = r(q.opacity, 4);
      return q;
    });
    // overlay tidak boleh tampil di luar jendela transisi
    if (p <= 0 || p >= 1) ov = [];

    return {
      jenis: asal, jenisEfektif: efektif, aktif: p > 0 && p < 1, selesai: p >= 1,
      progres: r(p, 5), progresEase: r(pe, 5), mulai: mulai, durasi: durasi,
      keluar: keluar, masuk: masuk, wadah: wadah, overlay: ov, svg: svg,
      tampil: tampil, peringatan: peringatan,
    };
  }

  function daftarTransisi(nama, fungsi, meta) {
    if (typeof nama !== "string" || !nama) galat("daftarTransisi: nama wajib");
    if (typeof fungsi !== "function") galat("daftarTransisi: fungsi wajib");
    def(nama, fungsi, meta);
    return nama;
  }

  // ============================================================ ANIMASI ELEMEN
  var A = {};
  function defA(nama, fn, meta) {
    meta = meta || {};
    A[nama] = {
      fn: fn, durMs: meta.durMs == null ? 400 : meta.durMs,
      easingMasuk: meta.easingMasuk || "perlambat", easingKeluar: meta.easingKeluar || "percepat",
      gerakBesar: !!meta.gerakBesar, siklik: !!meta.siklik, risiko: meta.risiko || "rendah",
      makna: meta.makna || "", sumber: meta.sumber || "",
    };
  }
  function tf(s) { return s ? { transform: s } : {}; }

  // v: 0 (tersembunyi) .. 1 (tampil penuh); boleh >1 saat overshoot.
  defA("pudar", function (v) { return { opacity: jepit(v, 0, 1) }; }, { durMs: 300, makna: "masuk/keluar paling aman" });
  defA("geser", function (v, c) {
    var a = vec(c.arah), j = c.jarak, k = 1 - v;
    return { opacity: jepit(v * 1.5, 0, 1), transform: "translate(" + px(-a[0] * j * k) + "," + px(-a[1] * j * k) + ")" };
  }, { durMs: 400, gerakBesar: true, makna: "masuk sambil bergeser; arah = arah gerak" });
  defA("skala", function (v, c) {
    var s0 = c.skalaAwal == null ? 0.8 : c.skalaAwal;
    return { opacity: jepit(v * 1.5, 0, 1), transform: "scale(" + r(s0 + (1 - s0) * v, 4) + ")" };
  }, { durMs: 400, gerakBesar: true, makna: "masuk dengan membesar; kombinasikan easing pegas untuk overshoot" });
  defA("kabur", function (v, c) {
    var b = (c.blur == null ? 12 : c.blur) * (1 - jepit(v, 0, 1));
    return { opacity: jepit(v, 0, 1), filter: b > 0.05 ? "blur(" + r(b, 2) + "px)" : "none" };
  }, { durMs: 500, gerakBesar: true, risiko: "sedang", makna: "blur-in; filter blur mahal di render" });
  defA("tirai", function (v, c) {
    var m = jepit(v, 0, 1), s = (1 - m) * 100, a = vec(c.arah), cp;
    if (a[0] > 0) cp = "inset(0 " + r(s, 3) + "% 0 0)"; else if (a[0] < 0) cp = "inset(0 0 0 " + r(s, 3) + "%)";
    else if (a[1] > 0) cp = "inset(0 0 " + r(s, 3) + "% 0)"; else cp = "inset(" + r(s, 3) + "% 0 0 0)";
    return { clipPath: m >= 1 ? "none" : cp };
  }, { durMs: 500, makna: "mask reveal: elemen disingkap tanpa bergerak", easingMasuk: "masukKeluar" });
  defA("gambarGaris", function (v, c) {
    // butuh pathLength="1" pada elemen SVG
    return { strokeDasharray: "1", strokeDashoffset: r(1 - jepit(v, 0, 1), 4) };
  }, { durMs: 800, easingMasuk: "masukKeluar", makna: "draw-on stroke SVG; set pathLength=1" });
  defA("sorot", function (v, c) {
    var w = c.warna || "rgba(255,213,0,.55)";
    return { backgroundImage: "linear-gradient(" + w + "," + w + ")", backgroundRepeat: "no-repeat", backgroundPosition: "0 50%",
      backgroundSize: r(jepit(v, 0, 1) * 100, 3) + "% " + (c.tinggiSorot || "85%") };
  }, { durMs: 500, easingMasuk: "masukKeluar", makna: "highlight spidol di belakang teks (inline)" });
  defA("garisBawah", function (v, c) {
    var w = c.warna || "currentColor";
    return { backgroundImage: "linear-gradient(" + w + "," + w + ")", backgroundRepeat: "no-repeat", backgroundPosition: "0 100%",
      backgroundSize: r(jepit(v, 0, 1) * 100, 3) + "% " + (c.tebal || 4) + "px" };
  }, { durMs: 450, easingMasuk: "masukKeluar", makna: "garis bawah digambar kiri ke kanan" });
  defA("mantul", function (v, c) {
    var j = c.jarak;
    return { opacity: jepit(v * 2, 0, 1), transform: "translateY(" + px((1 - v) * j) + ") scale(" + r(0.85 + 0.15 * v, 4) + ")" };
  }, { durMs: 600, easingMasuk: "pegas", gerakBesar: true, makna: "kinetik: masuk dengan overshoot (follow-through)" });
  defA("tumbuh", function (v, c) {
    var a = c.arah === "kiri" || c.arah === "kanan";
    return a
      ? { transform: "scaleX(" + r(Math.max(v, 0), 4) + ")", transformOrigin: c.arah === "kiri" ? "100% 50%" : "0% 50%" }
      : { transform: "scaleY(" + r(Math.max(v, 0), 4) + ")", transformOrigin: c.arah === "bawah" ? "50% 0%" : "50% 100%" };
  }, { durMs: 700, easingMasuk: "ditekankan", gerakBesar: true, makna: "batang grafik tumbuh dari dasar (arah 'atas' = tumbuh ke atas)" });
  // Emphasis: sirkuler, memakai p (0..1) dalam jendela [mulai, mulai+durasi]; tak ada keadaan "tersembunyi".
  defA("denyut", function (p, c) {
    var amp = 0.06 * c.intensitas, n = c.ulang || 1;
    return { transform: "scale(" + r(1 + amp * Math.sin(PI * jepit(p, 0, 1) * n) * (n > 1 ? 1 : 1), 4) + ")" };
  }, { durMs: 600, siklik: true, makna: "penekanan: denyut skala ringan" });
  defA("getar", function (p, c) {
    var amp = 6 * c.intensitas * c.jarakProf, siklus = c.siklus || 3, q = jepit(p, 0, 1);
    return { transform: "translateX(" + px(amp * Math.sin(2 * PI * siklus * q) * (1 - q)) + ")" };
  }, { durMs: 500, siklik: true, gerakBesar: true, makna: "penekanan: getar ringan meredam (maks ~6 px)" });
  defA("kilatSorot", function (p, c) {
    var q = jepit(p, 0, 1), a = 0.35 * c.intensitas * Math.sin(PI * q);
    return { boxShadow: "0 0 0 " + px(4 + 10 * q) + " rgba(255,213,0," + r(a, 3) + ")" };
  }, { durMs: 700, siklik: true, makna: "cincin sorot memudar (luminans kecil, bukan kilatan)" });

  var IDENTITAS = /^(\s*(translate[XY]?\(0(px)?(,\s*0(px)?)?\)|scale[XY]?\(1\))\s*)+$/;
  function animasi(frame, o) {
    o = o || {};
    var fps = o.fps || 30, prof = lihatProfil(o.profil);
    var nama = o.jenis || "pudar", d = A[nama];
    if (!d) galat("jenis animasi tidak dikenal: " + nama);
    var asal = nama;
    if ((prof.kurangiGerak && d.gerakBesar) || prof.hindari.indexOf(nama) >= 0) {
      if (d.siklik) return { peringatan: "animasi '" + nama + "' dimatikan oleh profil", transform: "none" };
      nama = "pudar"; d = A.pudar;
    }
    var ind = o.indeks || 0, stg = o.stagger || 0;
    var dur = o.durasi != null ? o.durasi : msKeFrame(o.durasiMs != null ? o.durasiMs : d.durMs, fps);
    dur = Math.max(1, Math.round(dur * prof.skalaDurasi));
    var lokal = frame - (o.mulai || 0) - ind * Math.round(stg);
    var p = jepit(lokal / dur, 0, 1);
    var c = {
      arah: o.arah || "bawah", jarak: (o.jarak == null ? 40 : o.jarak) * prof.jarak, jarakProf: prof.jarak,
      intensitas: (o.intensitas == null ? 1 : o.intensitas) * prof.intensitas, warna: o.warna,
      skalaAwal: o.skalaAwal, blur: o.blur, ulang: o.ulang, siklus: o.siklus, tebal: o.tebal,
      tinggiSorot: o.tinggiSorot,
    };
    var gaya;
    if (d.siklik) {
      gaya = d.fn(p, c);
      if (lokal < 0 || lokal >= dur) { gaya = d.fn(lokal < 0 ? 0 : 1, c); if (gaya.transform) gaya.transform = "none"; if (gaya.boxShadow) gaya.boxShadow = "none"; }
    } else {
      var eIn = lihatEasing(o.easing, d.easingMasuk)(p), v = eIn;
      if (o.keluarMulai != null) {
        var durK = Math.max(1, Math.round((o.keluarDurasi != null ? o.keluarDurasi : Math.round(dur * 0.7)) * prof.skalaDurasi));
        var pk = jepit((frame - o.keluarMulai - ind * Math.round(stg)) / durK, 0, 1);
        var eOut = lihatEasing(o.easingKeluar, d.easingKeluar)(pk);
        v = eIn * (1 - eOut);
        if (pk >= 1) v = 0;
      }
      gaya = d.fn(v, c);
      if (asal !== nama) gaya.peringatan = "animasi '" + asal + "' diganti '" + nama + "' oleh profil";
      if (jepit(v, 0, 1) <= 0 && gaya.opacity == null) gaya.opacity = 0;
      // keadaan akhir bersih: transform yang hanya berisi identitas ditulis "none"
      if (gaya.transform && IDENTITAS.test(gaya.transform)) gaya.transform = "none";
    }
    return gaya;
  }
  function daftarAnimasi(nama, fungsi, meta) {
    if (typeof nama !== "string" || !nama) galat("daftarAnimasi: nama wajib");
    if (typeof fungsi !== "function") galat("daftarAnimasi: fungsi wajib");
    defA(nama, fungsi, meta);
    return nama;
  }

  // -------------------------------------------------------------------- teks
  function pecahTeks(teks, mode) {
    teks = String(teks == null ? "" : teks);
    if (mode === "kata") return teks.split(/(\s+)/).filter(function (s) { return s !== ""; });
    return Array.from(teks);
  }
  // Setiap unit non-spasi mendapat indeks urut -> stagger; spasi ikut tampil.
  function animasiTeks(frame, teks, o) {
    o = o || {};
    var unit = pecahTeks(teks, o.mode === "kata" ? "kata" : "huruf"), idx = 0, hasil = [];
    var stagger = o.stagger != null ? o.stagger : (o.mode === "kata" ? 4 : 1);
    unit.forEach(function (u) {
      var spasi = /^\s+$/.test(u);
      var oo = {}; for (var k in o) oo[k] = o[k];
      oo.indeks = idx; oo.stagger = stagger;
      hasil.push({ teks: u, spasi: spasi, gaya: spasi ? {} : animasi(frame, oo) });
      if (!spasi) idx++;
    });
    return hasil;
  }
  function ketik(frame, teks, o) {
    o = o || {};
    var fps = o.fps || 30, cps = o.cps || 18, mulai = o.mulai || 0;
    var arr = Array.from(String(teks)), n = jepit(Math.floor(((frame - mulai) / fps) * cps), 0, arr.length);
    var kedip = Math.floor((frame - mulai) / Math.round(fps / 2)) % 2 === 0; // kursor 1 Hz, tanpa kilatan terang
    return { teks: arr.slice(0, n).join(""), jumlah: n, selesai: n >= arr.length, kursor: n < arr.length || kedip };
  }
  function formatAngka(x, desimal, id) {
    var s = Math.abs(x).toFixed(desimal), bagian = s.split("."), a = bagian[0];
    var out = id === false ? a : a.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    if (bagian[1]) out += (id === false ? "." : ",") + bagian[1];
    return (x < 0 ? "-" : "") + out;
  }
  function angkaBergulir(frame, o) {
    o = o || {};
    var dari = o.dari == null ? 0 : o.dari, ke = o.ke == null ? 100 : o.ke, dur = o.durasi || 45, mulai = o.mulai || 0;
    var p = jepit((frame - mulai) / dur, 0, 1), e = lihatEasing(o.easing, "perlambat")(p);
    var nilai = dari + (ke - dari) * e, des = o.desimal || 0;
    var q = Math.pow(10, des); nilai = Math.round(nilai * q) / q;
    return { nilai: nilai, teks: (o.awalan || "") + formatAngka(nilai, des, o.format !== "en") + (o.akhiran || ""), selesai: p >= 1 };
  }

  // -------------------------------------------------------------------- jalur
  function bezKubik(P, t) {
    var u = 1 - t;
    return [u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
      u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1]];
  }
  function jalur(frame, o) {
    o = o || {};
    var titik = o.titik; // [[x,y],[c1],[c2],[x2,y2]] atau rangkaian segmen: tiap segmen 3 titik baru setelah titik awal
    if (!Array.isArray(titik) || titik.length < 4 || (titik.length - 1) % 3 !== 0) galat("jalur: butuh 1+3n titik (bezier kubik)");
    var nSeg = (titik.length - 1) / 3, N = 64, lut = [[0, 0, titik[0][0], titik[0][1]]], tot = 0, prev = titik[0];
    for (var s = 0; s < nSeg; s++) {
      var P = titik.slice(s * 3, s * 3 + 4);
      for (var i = 1; i <= N; i++) {
        var q = bezKubik(P, i / N);
        tot += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q;
        lut.push([tot, s + i / N, q[0], q[1]]);
      }
    }
    var dur = o.durasi || 60, p = jepit((frame - (o.mulai || 0)) / dur, 0, 1), e = lihatEasing(o.easing, "masukKeluar")(p);
    var tgt = e * tot, lo = 0, hi = lut.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (lut[mid][0] <= tgt) lo = mid; else hi = mid; }
    var a = lut[lo], b = lut[hi], f = b[0] > a[0] ? (tgt - a[0]) / (b[0] - a[0]) : 0;
    var x = a[2] + (b[2] - a[2]) * f, y = a[3] + (b[3] - a[3]) * f;
    var sudut = Math.atan2(b[3] - a[3], b[2] - a[2]) * 180 / PI;
    var tr = "translate(" + px(x) + "," + px(y) + ")" + (o.orientasi ? " rotate(" + r(sudut, 2) + "deg)" : "");
    return { x: r(x, 2), y: r(y, 2), sudut: r(sudut, 2), panjang: r(tot, 2), transform: tr };
  }
  // Aksi sekunder / follow-through: elemen anak mengikuti induk dengan jeda dan easing pegas lembut.
  function sekunder(frame, o, j) {
    j = j || {};
    var oo = {}; for (var k in o) oo[k] = o[k];
    oo.mulai = (o.mulai || 0) + (j.jeda == null ? 4 : j.jeda);
    if (o.durasi != null) oo.durasi = Math.round(o.durasi * 1.3);
    oo.easing = j.easing || "pegasLembut";
    return animasi(frame, oo);
  }

  // ------------------------------------------------------------------- kamera
  function kamera(frame, o) {
    o = o || {};
    var prof = lihatProfil(o.profil), fps = o.fps || 30, W = o.lebar || 1280, H = o.tinggi || 720;
    var dari = o.dari || { skala: 1, x: 0, y: 0 }, ke = o.ke || { skala: 1.12, x: 0, y: 0 };
    var dur = o.durasi || 150, p = jepit((frame - (o.mulai || 0)) / dur, 0, 1);
    var e = lihatEasing(o.easing, "masukKeluar")(p), peringatan = [];
    var s0 = dari.skala == null ? 1 : dari.skala, s1 = ke.skala == null ? 1 : ke.skala;
    var laju = Math.abs(s1 - s0) / (dur / fps);
    if (laju > 0.15) peringatan.push("laju zoom " + r(laju * 100, 1) + " %/detik > 15 %/detik: risiko vestibular (ambang keputusan desain)");
    var jx = Math.abs((ke.x || 0) - (dari.x || 0)) / W / (dur / fps);
    if (jx > 0.25) peringatan.push("laju pan > 25 % lebar/detik: risiko vestibular (ambang keputusan desain)");
    if (prof.kurangiGerak) {
      return { transform: "none", transformOrigin: "50% 50%", peringatan: peringatan.concat("kamera dimatikan (kurangiGerak)") };
    }
    var s = s0 + (s1 - s0) * e, x = (dari.x || 0) + ((ke.x || 0) - (dari.x || 0)) * e, y = (dari.y || 0) + ((ke.y || 0) - (dari.y || 0)) * e;
    return { transform: "translate(" + px(-x) + "," + px(-y) + ") scale(" + r(s, 5) + ")", transformOrigin: (o.asal || "50% 50%"), peringatan: peringatan };
  }
  // Lapisan paralaks: kedalaman 0 (jauh, nyaris diam) .. 1 (dekat, bergerak penuh).
  function paralaks(frame, o) {
    o = o || {};
    var prof = lihatProfil(o.profil), dur = o.durasi || 150, p = jepit((frame - (o.mulai || 0)) / dur, 0, 1);
    var e = lihatEasing(o.easing, "masukKeluar")(p), g = o.gerak || { x: -120, y: 0 };
    return (o.lapisan || []).map(function (l) {
      if (!prof.paralaks || prof.kurangiGerak) return { transform: "none", peringatan: "paralaks dimatikan oleh profil" };
      var k = l.kedalaman == null ? 0.5 : l.kedalaman;
      return { transform: "translate(" + px(g.x * k * e) + "," + px(g.y * k * e) + ")" };
    });
  }

  // ------------------------------------------------- bersama (container transform)
  // Transformasi kontainer: kotak berubah ukuran/posisi/radius; isi lama memudar keluar lalu
  // isi baru masuk (mode "melalui") atau silang ("silang"). Properti layout (left/top/width/
  // height) dianimasikan sehingga teks tidak terdistorsi seperti scale().
  function bersama(frame, o) {
    o = o || {};
    var prof = lihatProfil(o.profil), fps = o.fps || 30;
    var d = o.dari, k = o.ke;
    if (!d || !k) galat("bersama: 'dari' dan 'ke' wajib {x,y,w,h,r}");
    var dur = o.durasi != null ? o.durasi : msKeFrame(o.durasiMs || 450, fps);
    dur = Math.max(1, Math.round(dur * prof.skalaDurasi));
    var p = jepit((frame - (o.mulai || 0)) / dur, 0, 1);
    var e = lihatEasing(o.easing, "ditekankan")(p);
    var eY = o.busur ? lihatEasing(o.easingY, "masukKeluar")(p) : e;
    if (prof.kurangiGerak) { e = p; eY = p; }
    function L(a, b, q) { return a + (b - a) * q; }
    var kotak = {
      left: px(L(d.x, k.x, e)), top: px(L(d.y, k.y, eY)), width: px(L(d.w, k.w, e)), height: px(L(d.h, k.h, e)),
      borderRadius: px(L(d.r || 0, k.r || 0, e)),
    };
    var dLuar, dDalam;
    if ((o.mode || "melalui") === "silang") { dLuar = 1 - jepit(p / 0.5, 0, 1); dDalam = jepit((p - 0.25) / 0.5, 0, 1); }
    else { dLuar = 1 - jepit(p / 0.35, 0, 1); dDalam = jepit((p - 0.35) / 0.65, 0, 1); }
    return { progres: p, kotak: kotak, isiDari: { opacity: r(dLuar, 4), display: dLuar <= 0 ? "none" : "" },
      isiKe: { opacity: r(dDalam, 4), display: dDalam <= 0 ? "none" : "" } };
  }

  // ----------------------------------------------------------- susunAdegan
  // daftar: [{durasi, transisi?: {jenis, durasi?, durasiMs?, ...}}]; transisi pada item i
  // adalah transisi dari adegan i-1 ke i; adegan i mulai `durasi transisi` frame sebelum
  // adegan i-1 berakhir (tumpang-tindih). Item pertama tak punya transisi.
  function susunAdegan(daftar, o) {
    o = o || {};
    var fps = o.fps || 30, lebar = o.lebar || 1280, tinggi = o.tinggi || 720, prof = o.profil, jv = o.jenisVideo;
    var peta = [], mulai = 0, tot = 0;
    daftar.forEach(function (a, i) {
      var tr = i > 0 && a.transisi ? a.transisi : null, ov = 0;
      if (tr) {
        ov = durasiTransisi({ jenis: tr.jenis, durasi: tr.durasi, durasiMs: tr.durasiMs, fps: fps, profil: tr.profil || prof, jenisVideo: tr.jenisVideo || jv, paksaEfekBerat: tr.paksaEfekBerat });
        if (typeof tr.jenis === "string" && tr.jenis === "potong") ov = 0;
        ov = Math.min(ov, peta[i - 1].durasi, a.durasi);
      }
      var m = i === 0 ? 0 : peta[i - 1].mulai + peta[i - 1].durasi - ov;
      peta.push({ mulai: m, durasi: a.durasi, overlap: ov, transisi: tr });
      tot = Math.max(tot, m + a.durasi);
    });
    // tunggal = frame adegan tampil sendirian (tanpa tumpang-tindih); pakai untuk memeriksa
    // durasi baca: tunggal >= durasiBaca(teks) + beberapa frame.
    peta.forEach(function (a, i) {
      var berikut = i + 1 < peta.length ? peta[i + 1].overlap : 0;
      a.tunggal = a.durasi - a.overlap - berikut;
    });
    return {
      total: tot, peta: peta,
      pada: function (frame) {
        var out = { adegan: [], wadah: dasarWadah(), overlay: [], svg: null, peringatan: [], transisi: null };
        for (var i = 0; i < peta.length; i++) {
          var a = peta[i], vis = frame >= a.mulai && frame < a.mulai + a.durasi;
          out.adegan.push({ indeks: i, lokal: frame - a.mulai, tampil: vis, gaya: dasarLapis({ display: vis ? "" : "none", zIndex: 1 }) });
        }
        for (var j = 1; j < peta.length; j++) {
          var b = peta[j], tr = b.transisi;
          if (!tr || b.overlap <= 0) continue; // potong: visibilitas sudah dari rentang adegan
          if (!(frame >= b.mulai && frame < b.mulai + b.overlap)) continue;
          var oo = {}; for (var k in tr) oo[k] = tr[k];
          oo.mulai = b.mulai; oo.durasi = b.overlap; oo.fps = fps; oo.lebar = lebar; oo.tinggi = tinggi;
          if (oo.profil == null) oo.profil = prof;
          if (oo.jenisVideo == null) oo.jenisVideo = jv;
          var h = transisi(frame, oo);
          out.transisi = h;
          out.adegan[j - 1].gaya = h.keluar; out.adegan[j - 1].tampil = h.tampil.keluar;
          out.adegan[j].gaya = h.masuk; out.adegan[j].tampil = h.tampil.masuk;
          out.wadah = h.wadah; out.overlay = h.overlay; out.svg = h.svg; out.peringatan = h.peringatan;
        }
        return out;
      },
    };
  }

  // -------------------------------------------------------------- terapkan (DOM)
  var NS = "http://www.w3.org/2000/svg";
  function svgRoot() {
    var s = document.getElementById("awvd-svg-filter");
    if (!s) {
      s = document.createElementNS(NS, "svg");
      s.setAttribute("id", "awvd-svg-filter"); s.setAttribute("width", "0"); s.setAttribute("height", "0");
      s.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
      document.body.appendChild(s);
    }
    return s;
  }
  function el(nama, atr) {
    var e = document.createElementNS(NS, nama);
    for (var k in atr) e.setAttribute(k, atr[k]);
    return e;
  }
  function pasangFilter(peran, spec) {
    var root = svgRoot(), id = "awvd-" + peran, f = root.querySelector("#" + id);
    if (f) root.removeChild(f);
    if (!spec) return;
    f = el("filter", { id: id, x: "0", y: "0", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" });
    if (spec.jenis === "kabur") {
      f.appendChild(el("feGaussianBlur", { stdDeviation: r(spec.sx, 2) + " " + r(spec.sy, 2), "edgeMode": "duplicate" }));
    } else if (spec.jenis === "gangguan") {
      // 1 noise pita horizontal -> kuantisasi blok -> displacement X saja -> pemisahan kanal RGB
      f.appendChild(el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.0008 " + spec.fy, numOctaves: "1", seed: String(spec.seed), result: "n" }));
      f.appendChild(el("feColorMatrix", { in: "n", type: "matrix", values: "1 0 0 0 0  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 1", result: "n2" }));
      var ct = el("feComponentTransfer", { in: "n2", result: "n3" });
      ct.appendChild(el("feFuncR", { type: "discrete", tableValues: "0.5 0.5 0.5 0.8 0.5 0.2 0.5 0.5 0.95 0.5" }));
      f.appendChild(ct);
      f.appendChild(el("feDisplacementMap", { in: "SourceGraphic", in2: "n3", scale: String(spec.skala), xChannelSelector: "R", yChannelSelector: "G", result: "d" }));
      f.appendChild(el("feColorMatrix", { in: "d", type: "matrix", values: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", result: "R" }));
      f.appendChild(el("feColorMatrix", { in: "d", type: "matrix", values: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", result: "G" }));
      f.appendChild(el("feColorMatrix", { in: "d", type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0", result: "B" }));
      f.appendChild(el("feOffset", { in: "R", dx: String(spec.rgb), dy: "0", result: "Ro" }));
      f.appendChild(el("feOffset", { in: "B", dx: String(-spec.rgb), dy: "0", result: "Bo" }));
      f.appendChild(el("feBlend", { in: "Ro", in2: "G", mode: "screen", result: "RG" }));
      f.appendChild(el("feBlend", { in: "RG", in2: "Bo", mode: "screen" }));
    }
    root.appendChild(f);
  }
  function tulis(elemen, gaya) {
    if (!elemen || !gaya) return;
    for (var k in gaya) {
      var v = gaya[k];
      elemen.style[k] = typeof v === "number" ? String(v) : v;
    }
  }
  function terapkan(hasil, e) {
    e = e || {};
    pasangFilter("keluar", hasil.svg && hasil.svg.keluar);
    pasangFilter("masuk", hasil.svg && hasil.svg.masuk);
    tulis(e.wadah, hasil.wadah);
    tulis(e.keluar, hasil.keluar);
    tulis(e.masuk, hasil.masuk);
    if (e.overlay) {
      var ov = hasil.overlay || [], c = e.overlay;
      while (c.children.length < ov.length) c.appendChild(document.createElement("div"));
      for (var i = 0; i < c.children.length; i++) {
        var d = c.children[i];
        if (i < ov.length) { d.style.cssText = ""; tulis(d, ov[i]); d.style.display = ""; } else d.style.display = "none";
      }
    }
  }


  // ------------------------------------------------------------------- grain
  // Butiran film di kanvas kecil (diskalakan CSS dengan image-rendering:pixelated).
  // Murni: derau = f(seed, frame*hidup, x, y). hidup=0 -> derau diam (murah dikompres);
  // hidup=1 -> berubah tiap frame (menaikkan bitrate sekitar 7x; lihat docs/transisi-animasi.md).
  // Opsi: seed, hidup (0 = diam, bawaan; 1 = berubah tiap `tahan` frame), tahan (bawaan 1),
  // kekuatan (alfa, bawaan 0,08), jenisVideo (bila diberi dan efekBerat(jenisVideo) false,
  // grain hidup diturunkan menjadi diam), paksaEfekBerat.
  function grain(kanvas, frame, o) {
    o = o || {};
    var w = kanvas.width, h = kanvas.height, seed = o.seed == null ? 7 : o.seed;
    var hidup = o.hidup ? 1 : 0;
    if (hidup && o.jenisVideo != null && !o.paksaEfekBerat && !efekBerat(o.jenisVideo)) hidup = 0;
    var k = hidup ? Math.floor(frame / (o.tahan || 1)) : 0, kuat = o.kekuatan == null ? 0.08 : o.kekuatan;
    var ctx = kanvas.getContext("2d"), img = ctx.createImageData(w, h), d = img.data;
    for (var i = 0, n = w * h; i < n; i++) {
      var v = Math.floor(acak3(seed + (k * 7919), i, 11) * 255);
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = Math.round(255 * kuat);
    }
    ctx.putImageData(img, 0, 0);
    return { hidup: hidup === 1 };
  }

  // ----------------------------------------------------------- periksaKilatan
  // Pemeriksaan KONSERVATIF di tingkat rencana (bukan pengganti periksa.mjs pada video):
  // tiap kemunculan transisi dengan meta.kilat dihitung sebagai kilatan di titik tengahnya.
  // Lebih dari 3 dalam jendela 1 detik = galat; 3 = peringatan (tanpa margin).
  function periksaKilatan(daftar, fps) {
    fps = fps || 30;
    var ev = [], galatL = [], peringatan = [];
    daftar.forEach(function (t) {
      var nm = Array.isArray(t.jenis) ? t.jenis : [t.jenis];
      var n = 0;
      nm.forEach(function (x) { var q = typeof x === "object" ? x.jenis : x; if (T[q]) n += T[q].kilat; });
      var dur = durasiTransisi({ jenis: t.jenis, durasi: t.durasi, durasiMs: t.durasiMs, fps: fps, profil: t.profil, jenisVideo: t.jenisVideo, paksaEfekBerat: t.paksaEfekBerat });
      var pusat = (t.mulai || 0) + dur / 2;
      for (var i = 0; i < n; i++) ev.push(pusat);
      nm.forEach(function (x) {
        var q = typeof x === "object" ? x.jenis : x;
        if (q === "gangguan" && (t.intensitas || 1) > 1.5) peringatan.push("gangguan: intensitas > 1,5 meningkatkan area/variasi luminans; uji dengan periksa.mjs");
      });
    });
    ev.sort(function (a, b) { return a - b; });
    for (var i = 0; i < ev.length; i++) {
      var c = 0;
      for (var j = i; j < ev.length && ev[j] - ev[i] < fps; j++) c++;
      if (c > 3) { galatL.push("lebih dari 3 kilatan dalam 1 detik mulai frame " + Math.round(ev[i])); break; }
      if (c === 3) peringatan.push("3 kilatan dalam 1 detik mulai frame " + Math.round(ev[i]) + " (tanpa margin)");
    }
    return { ok: galatL.length === 0, galat: galatL, peringatan: peringatan, kilatan: ev.length };
  }

  // ------------------------------------------------------- preset per jenis video
  // Selaras data/jenis-video.json (token transisi) dan docs/konsep-jenis-alur.md. Nilai berupa
  // keputusan desain kecuali yang berasal dari token Material (lihat docs/transisi-animasi.md).
  // peran: antarAdegan | antarBagian | pembuka | penutup | penekanan
  var PRESET = {
    formal: { profil: "standar", antarAdegan: { jenis: "pudar", durasiMs: 300, easing: "standar" },
      antarBagian: { jenis: "pudarMelalui", durasiMs: 500, easing: "standar" },
      pembuka: { jenis: "pudar", durasiMs: 500 }, penutup: { jenis: "celup", durasiMs: 700 },
      masuk: "pudar", izin: ["potong", "pudar", "pudarMelalui", "celup"] },
    edukasi: { profil: "standar", antarAdegan: { jenis: "pudarMelalui", durasiMs: 300, easing: "standar" },
      antarBagian: { jenis: "geser", arah: "kiri", durasiMs: 400, easing: "standar" },
      pembuka: { jenis: "pudar", durasiMs: 500 }, penutup: { jenis: "pudar", durasiMs: 500 },
      masuk: "geser", izin: ["potong", "pudar", "pudarMelalui", "geser", "tumpuk", "balik"] },
    kreatif: { profil: "standar", antarAdegan: { jenis: "geser", durasiMs: 450, easing: "ditekankan" },
      antarBagian: { jenis: "iris", durasiMs: 600, easing: "ditekankan" },
      pembuka: { jenis: "pudar", durasiMs: 600 }, penutup: { jenis: "celup", durasiMs: 800 },
      masuk: "mantul", izin: Object.keys(T) },
    promo: { profil: "standar", antarAdegan: { jenis: "dorong", durasiMs: 250, easing: "kuat" },
      antarBagian: { jenis: "tirai", durasiMs: 500, easing: "kuat" },
      pembuka: { jenis: "potong" }, penutup: { jenis: "pudar", durasiMs: 400 },
      masuk: "mantul", izin: ["potong", "dorong", "geser", "zoom", "cambuk", "tirai", "sapu", "iris", "bentuk", "gangguan", "kilat", "pudar"] },
    produk: { profil: "standar", antarAdegan: { jenis: "pudarMelalui", durasiMs: 300 },
      antarBagian: { jenis: "tumpuk", durasiMs: 450, easing: "ditekankan" },
      pembuka: { jenis: "pudar", durasiMs: 400 }, penutup: { jenis: "pudar", durasiMs: 500 },
      masuk: "geser", izin: ["potong", "pudar", "pudarMelalui", "geser", "tumpuk", "sapu", "iris"] },
    panduan: { profil: "standar", antarAdegan: { jenis: "pudarMelalui", durasiMs: 150, easing: "standar" },
      antarBagian: { jenis: "geser", arah: "kiri", durasiMs: 300 },
      pembuka: { jenis: "pudar", durasiMs: 400 }, penutup: { jenis: "pudar", durasiMs: 400 },
      masuk: "geser", izin: ["potong", "pudar", "pudarMelalui", "geser", "tumpuk"] },
    dokumenter: { profil: "standar", antarAdegan: { jenis: "potong" },
      antarBagian: { jenis: "pudar", durasiMs: 500, easing: "masukKeluar" }, // penanda waktu boleh 800-1000 ms (gaya)
      pembuka: { jenis: "celup", durasiMs: 900 }, penutup: { jenis: "celup", durasiMs: 1000 },
      masuk: "pudar", izin: ["potong", "pudar", "celup", "pudarBlur", "kebocoran"] },
    sosial: { profil: "standar", antarAdegan: { jenis: "dorong", arah: "atas", durasiMs: 200, easing: "kuat" },
      antarBagian: { jenis: "zoom", durasiMs: 300, easing: "kuat" },
      pembuka: { jenis: "potong" }, penutup: { jenis: "pudar", durasiMs: 300 },
      masuk: "mantul", izin: ["potong", "dorong", "geser", "zoom", "cambuk", "tirai", "sapu", "bentuk", "gangguan", "kilat", "pudar"] },
    data: { profil: "standar", antarAdegan: { jenis: "pudarMelalui", durasiMs: 300 },
      antarBagian: { jenis: "pudarMelalui", durasiMs: 500 },
      pembuka: { jenis: "pudar", durasiMs: 400 }, penutup: { jenis: "pudar", durasiMs: 500 },
      masuk: "tumbuh", izin: ["potong", "pudar", "pudarMelalui", "geser", "kisi"] },
    testimoni: { profil: "standar", antarAdegan: { jenis: "pudar", durasiMs: 400, easing: "masukKeluar" },
      antarBagian: { jenis: "pudar", durasiMs: 600 },
      pembuka: { jenis: "pudar", durasiMs: 500 }, penutup: { jenis: "celup", durasiMs: 800 },
      masuk: "pudar", izin: ["potong", "pudar", "celup", "pudarBlur", "kebocoran"] },
    psa: { profil: "standar", antarAdegan: { jenis: "pudarMelalui", durasiMs: 300 },
      antarBagian: { jenis: "pudar", durasiMs: 500 },
      pembuka: { jenis: "potong" }, penutup: { jenis: "celup", durasiMs: 700 },
      masuk: "pudar", izin: ["potong", "pudar", "pudarMelalui", "celup", "geser"] },
    internal: { profil: "standar", antarAdegan: { jenis: "pudarMelalui", durasiMs: 300 },
      antarBagian: { jenis: "geser", arah: "kiri", durasiMs: 400 },
      pembuka: { jenis: "pudar", durasiMs: 400 }, penutup: { jenis: "pudar", durasiMs: 400 },
      masuk: "pudar", izin: ["potong", "pudar", "pudarMelalui", "geser"] },
    acara: { profil: "standar", antarAdegan: { jenis: "geser", durasiMs: 300, easing: "ditekankan" },
      antarBagian: { jenis: "belah", arah: "kiri", durasiMs: 600 },
      pembuka: { jenis: "belah", arah: "kiri", durasiMs: 700 }, penutup: { jenis: "pudar", durasiMs: 500 },
      masuk: "mantul", izin: ["potong", "geser", "dorong", "tirai", "belah", "iris", "bentuk", "kebocoran", "kilat", "gangguan", "pudar"] },
  };
  // Efek berbiaya tinggi (jenis `gangguan`, grain hidup) hanya bawaan-hidup untuk jenis video
  // ekspresif; untuk jenis lain mereka dimatikan kecuali opsi paksaEfekBerat (keputusan desain
  // berdasar biaya kompresi terukur, lihat docs/transisi-animasi.md).
  var EFEK_BERAT = { kreatif: true, promo: true, sosial: true, acara: true };
  function efekBerat(jenisVideo) {
    if (!PRESET[jenisVideo]) galat("jenis video tidak dikenal: " + jenisVideo);
    return EFEK_BERAT[jenisVideo] === true;
  }
  function presetJenisVideo(jenis, peran, audiens) {
    var p = PRESET[jenis];
    if (!p) galat("jenis video tidak dikenal: " + jenis);
    var t = p[peran || "antarAdegan"];
    if (!t) galat("peran tidak dikenal: " + peran);
    var hasil = {}; for (var k in t) hasil[k] = t[k];
    hasil.profil = audiens || p.profil;
    return hasil;
  }

  function katalog() {
    var a = [];
    Object.keys(T).forEach(function (n) {
      var d = T[n];
      a.push({ kategori: "transisi", nama: n, durMs: d.durMs, easing: typeof d.easing === "string" ? d.easing : "kustom",
        gerakBesar: d.gerakBesar, kilat: d.kilat, risiko: d.risiko, biaya: d.biaya, makna: d.makna, cocok: d.cocok, sumber: d.sumber });
    });
    Object.keys(A).forEach(function (n) {
      var d = A[n];
      a.push({ kategori: "animasi", nama: n, durMs: d.durMs, easing: d.easingMasuk, gerakBesar: d.gerakBesar, siklik: d.siklik,
        risiko: d.risiko, makna: d.makna });
    });
    return a;
  }

  var api = {
    transisi: transisi, durasiTransisi: durasiTransisi, daftarTransisi: daftarTransisi,
    animasi: animasi, animasiTeks: animasiTeks, daftarAnimasi: daftarAnimasi, sekunder: sekunder,
    pecahTeks: pecahTeks, ketik: ketik, angkaBergulir: angkaBergulir, jalur: jalur,
    kamera: kamera, paralaks: paralaks, bersama: bersama, susunAdegan: susunAdegan,
    terapkan: terapkan, periksaKilatan: periksaKilatan, gabungGaya: gabungGaya,
    easing: easing, profil: profil, presetJenisVideo: presetJenisVideo, katalog: katalog,
    acak3: acak3, grain: grain, efekBerat: efekBerat,
  };
  akar.Transisi = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
