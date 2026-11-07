/*!
 * video-terprogram / runtime.js — runtime komposisi (tanpa dependensi).
 *
 * Dimuat komposisi lewat <script src=".../runtime.js"></script>. Karya asli
 * repo ini; tidak diturunkan dari proyek video-programatik manapun.
 *
 * KONSEP
 *   Sebuah video adalah fungsi murni dari nomor frame: render(frame, ctx)
 *   menggambar ulang DOM untuk frame itu. Renderer (render.mjs) memanggil
 *   window.video.renderFrame(n) untuk n = 0..durationInFrames-1, mengambil
 *   screenshot, lalu menyusunnya menjadi MP4.
 *
 * ATURAN DETERMINISME (wajib, kalau tidak video akan berkedip/berbeda tiap render)
 *   - Seluruh gerak HANYA berasal dari nomor `frame` (atau ctx.detik).
 *   - JANGAN pakai Date.now(), performance.now(), setTimeout/setInterval,
 *     requestAnimationFrame untuk menggerakkan animasi.
 *   - JANGAN pakai Math.random(); pakai acak(seed) (PRNG ber-seed) di bawah.
 *   - JANGAN pakai CSS animation / transition. Runtime menyuntikkan aturan
 *     yang mematikannya agar hasil pratinjau = hasil render.
 *   - Semua aset (font, gambar) harus sudah termuat sebelum frame pertama;
 *     renderer menunggu document.fonts.ready dan semua <img>.
 *
 * API (semua juga tersedia sebagai global dan di window.VideoTerprogram)
 *   defineVideo({ width, height, fps, durationInFrames, render(frame, ctx) })
 *   interpolasi(frame, masukan[], keluaran[], { clamp = true, easing })
 *   easing.{linear, masukQuad, keluarQuad, masukKeluarQuad, masukCubic,
 *           keluarCubic, masukKeluarCubic, masukBack, keluarBack,
 *           keluarElastis, bezier(x1, y1, x2, y2)}
 *   pegas(frame, fps, { dari = 0, ke = 1, kekakuan = 100, redaman = 10,
 *                       massa = 1, tunda = 0 })
 *   urutan(frame, { dari = 0, durasi = Infinity }) -> { aktif, lokal, progres }
 *   fade(frame, durasiTotal, { masuk = 15, keluar = 15 }) -> opasitas 0..1
 *   acak(seed) -> fungsi () => angka [0,1) deterministik
 *
 * MODE
 *   Tanpa query  : diam menunggu renderer (dipakai render.mjs).
 *   ?preview     : putar real-time (rAF, fps komposisi) + slider + play/pause.
 *   ?frame=N     : tampilkan satu frame N lalu berhenti.
 *   ?props={...} : props JSON untuk pratinjau (renderer memakai window.videoProps).
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;

  // ---------------------------------------------------------------- utilitas
  function clampNum(x, a, b) {
    return Math.min(b, Math.max(a, x));
  }

  // ----------------------------------------------------------------- easing
  var easing = {
    linear: function (t) { return t; },
    masukQuad: function (t) { return t * t; },
    keluarQuad: function (t) { return 1 - (1 - t) * (1 - t); },
    masukKeluarQuad: function (t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    },
    masukCubic: function (t) { return t * t * t; },
    keluarCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    masukKeluarCubic: function (t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },
    masukBack: function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      return c3 * t * t * t - c1 * t * t;
    },
    keluarBack: function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    keluarElastis: function (t) {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
    // Kurva Bezier kubik ala CSS cubic-bezier(x1, y1, x2, y2); x1,x2 di [0,1].
    bezier: function (x1, y1, x2, y2) {
      function sampel(a, b, t) {
        return 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
      }
      return function (x) {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        var lo = 0, hi = 1, t = x;
        for (var i = 0; i < 40; i++) { // bisection: pasti konvergen & deterministik
          t = (lo + hi) / 2;
          var sx = sampel(x1, x2, t);
          if (Math.abs(sx - x) < 1e-7) break;
          if (sx < x) lo = t; else hi = t;
        }
        return sampel(y1, y2, t);
      };
    },
  };

  // ------------------------------------------------------------ interpolasi
  // Pemetaan piecewise-linear dari rentang `masukan` (naik monoton) ke `keluaran`.
  function interpolasi(frame, masukan, keluaran, opsi) {
    opsi = opsi || {};
    var clamp = opsi.clamp !== false;
    var ease = opsi.easing || easing.linear;
    var n = masukan.length;
    if (n < 2 || keluaran.length !== n) {
      throw new Error("interpolasi: masukan dan keluaran harus sama panjang dan >= 2 titik");
    }
    for (var k = 1; k < n; k++) {
      if (!(masukan[k] > masukan[k - 1])) {
        throw new Error("interpolasi: rentang masukan harus naik tegas");
      }
    }
    var i = 0;
    while (i < n - 2 && frame > masukan[i + 1]) i++;
    var a = masukan[i], b = masukan[i + 1];
    var t = (frame - a) / (b - a);
    if (clamp) {
      if (frame <= masukan[0]) return keluaran[0];
      if (frame >= masukan[n - 1]) return keluaran[n - 1];
    }
    // easing hanya di dalam segmen; di luar (clamp=false) ekstrapolasi linear.
    var te = t >= 0 && t <= 1 ? ease(t) : t;
    return keluaran[i] + (keluaran[i + 1] - keluaran[i]) * te;
  }

  // ------------------------------------------------------------------ pegas
  // Pegas teredam dengan solusi bentuk-tertutup, mulai diam: x(0)=dari, v(0)=0.
  // Murni fungsi dari frame -> deterministik (tanpa integrasi numerik).
  function pegas(frame, fps, opsi) {
    opsi = opsi || {};
    var dari = opsi.dari == null ? 0 : opsi.dari;
    var ke = opsi.ke == null ? 1 : opsi.ke;
    var k = opsi.kekakuan == null ? 100 : opsi.kekakuan;
    var c = opsi.redaman == null ? 10 : opsi.redaman;
    var m = opsi.massa == null ? 1 : opsi.massa;
    var tunda = opsi.tunda || 0;
    var t = (frame - tunda) / fps;
    if (t <= 0) return dari;
    var w0 = Math.sqrt(k / m);
    var zeta = c / (2 * Math.sqrt(k * m));
    var u; // sisa perpindahan ternormalisasi: 1 -> 0
    if (zeta < 1) {
      var wd = w0 * Math.sqrt(1 - zeta * zeta);
      u = Math.exp(-zeta * w0 * t) *
        (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    } else if (zeta === 1) {
      u = Math.exp(-w0 * t) * (1 + w0 * t);
    } else {
      var s = w0 * Math.sqrt(zeta * zeta - 1);
      var r1 = -zeta * w0 + s, r2 = -zeta * w0 - s;
      u = (r1 * Math.exp(r2 * t) - r2 * Math.exp(r1 * t)) / (r1 - r2);
    }
    return ke + (dari - ke) * u;
  }

  // ----------------------------------------------------------------- urutan
  // Segmen waktu: aktif di [dari, dari+durasi); `lokal` = frame relatif segmen.
  function urutan(frame, opsi) {
    opsi = opsi || {};
    var dari = opsi.dari || 0;
    var durasi = opsi.durasi == null ? Infinity : opsi.durasi;
    var lokal = frame - dari;
    var aktif = lokal >= 0 && lokal < durasi;
    var progres = isFinite(durasi) && durasi > 0 ? clampNum(lokal / durasi, 0, 1) : 0;
    return { aktif: aktif, lokal: lokal, progres: progres };
  }

  // ------------------------------------------------------------------- fade
  // Opasitas 0..1: naik selama `masuk` frame pertama, turun selama `keluar` frame terakhir.
  function fade(frame, durasiTotal, opsi) {
    opsi = opsi || {};
    var masuk = opsi.masuk == null ? 15 : opsi.masuk;
    var keluar = opsi.keluar == null ? 15 : opsi.keluar;
    var naik = masuk > 0 ? clampNum(frame / masuk, 0, 1) : 1;
    var turun = keluar > 0 ? clampNum((durasiTotal - frame) / keluar, 0, 1) : 1;
    return Math.min(naik, turun);
  }

  // ------------------------------------------------------------------- acak
  // Atribusi: algoritma PRNG mulberry32 oleh Tommy Ettinger (2017), didedikasikan ke
  // domain publik (CC0-style); hash string memakai FNV-1a (domain publik).
  // PRNG mulberry32 ber-seed. Seed sama -> urutan sama.
  function acak(seed) {
    var a = (typeof seed === "string" ? hashString(seed) : seed | 0) >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // ------------------------------------------------------------ defineVideo
  function injectBaseStyle() {
    if (typeof document === "undefined") return;
    var st = document.createElement("style");
    st.setAttribute("data-video-terprogram", "");
    st.textContent =
      "*,*::before,*::after{animation:none!important;transition:none!important;" +
      "caret-color:transparent!important}html{scrollbar-width:none}";
    (document.head || document.documentElement).appendChild(st);
  }

  function defineVideo(config) {
    if (!config || typeof config.render !== "function") {
      throw new Error("defineVideo: 'render' (fungsi) wajib ada");
    }
    ["width", "height", "fps", "durationInFrames"].forEach(function (k) {
      var v = config[k];
      if (typeof v !== "number" || !isFinite(v) || v <= 0) {
        throw new Error("defineVideo: '" + k + "' harus angka positif");
      }
    });
    if (config.durationInFrames % 1 !== 0) {
      throw new Error("defineVideo: durationInFrames harus bilangan bulat");
    }
    injectBaseStyle();

    var query = new URLSearchParams(g.location ? g.location.search : "");
    var props = g.videoProps;
    if (props == null && query.has("props")) {
      try { props = JSON.parse(query.get("props")); } catch (e) { props = null; }
    }
    if (props == null) props = {};
    g.videoProps = props;

    var antrean = Promise.resolve(); // serialisasi: satu render pada satu waktu
    function renderFrame(frame) {
      var n = Math.round(Number(frame));
      if (!(n >= 0 && n < config.durationInFrames)) {
        return Promise.reject(new Error(
          "renderFrame: frame " + frame + " di luar 0.." + (config.durationInFrames - 1)));
      }
      var hasil = antrean.then(function () {
        return config.render(n, {
          fps: config.fps,
          durationInFrames: config.durationInFrames,
          width: config.width,
          height: config.height,
          props: props,
          detik: n / config.fps,
        });
      }).then(function () {
        return document.fonts && document.fonts.ready;
      }).then(function () { return n; });
      antrean = hasil.catch(function () {});
      return hasil;
    }

    var video = {
      width: config.width,
      height: config.height,
      fps: config.fps,
      durationInFrames: config.durationInFrames,
      renderFrame: renderFrame,
    };
    g.video = video;

    if (typeof document !== "undefined") {
      var mulai = function () {
        if (query.has("preview")) pasangPratinjau(video);
        else if (query.has("frame")) {
          renderFrame(clampNum(parseInt(query.get("frame"), 10) || 0, 0, config.durationInFrames - 1))
            .catch(function (e) { console.error(e); });
        }
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mulai);
      else mulai();
    }
    return video;
  }

  // -------------------------------------------------------------- pratinjau
  function pasangPratinjau(video) {
    var bar = document.createElement("div");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Kontrol pratinjau video");
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;gap:12px;" +
      "align-items:center;padding:8px 12px;background:rgba(0,0,0,.8);color:#fff;" +
      "font:14px system-ui,sans-serif";
    var tombol = document.createElement("button");
    tombol.type = "button";
    tombol.textContent = "Putar";
    tombol.style.cssText = "min-width:72px;padding:4px 10px;font:inherit";
    var slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(video.durationInFrames - 1);
    slider.value = "0";
    slider.step = "1";
    slider.style.cssText = "flex:1";
    slider.setAttribute("aria-label", "Posisi frame");
    var label = document.createElement("span");
    label.style.cssText = "min-width:120px;text-align:right;font-variant-numeric:tabular-nums";
    bar.appendChild(tombol);
    bar.appendChild(slider);
    bar.appendChild(label);
    document.body.appendChild(bar);

    var frameKini = 0, main = false, t0 = 0, f0 = 0, sibuk = false, tertunda = null;

    function tampil(n) {
      frameKini = n;
      slider.value = String(n);
      label.textContent = n + " / " + (video.durationInFrames - 1) +
        "  (" + (n / video.fps).toFixed(2) + " s)";
      if (sibuk) { tertunda = n; return; }
      sibuk = true;
      video.renderFrame(n).catch(function (e) { console.error(e); }).then(function () {
        sibuk = false;
        if (tertunda != null) { var t = tertunda; tertunda = null; if (t !== n) tampil(t); }
      });
    }
    function tick(now) {
      if (!main) return;
      var n = (f0 + Math.floor(((now - t0) / 1000) * video.fps)) % video.durationInFrames;
      if (n !== frameKini) tampil(n);
      requestAnimationFrame(tick);
    }
    function setMain(v) {
      main = v;
      tombol.textContent = v ? "Jeda" : "Putar";
      if (v) {
        f0 = frameKini;
        t0 = performance.now(); // hanya untuk pratinjau; bukan bagian render()
        requestAnimationFrame(tick);
      }
    }
    tombol.addEventListener("click", function () { setMain(!main); });
    slider.addEventListener("input", function () {
      if (main) setMain(false);
      tampil(parseInt(slider.value, 10));
    });
    tampil(0);
  }

  // ----------------------------------------------------------------- ekspor
  var api = {
    defineVideo: defineVideo,
    interpolasi: interpolasi,
    easing: easing,
    pegas: pegas,
    urutan: urutan,
    fade: fade,
    acak: acak,
  };
  g.VideoTerprogram = api;
  Object.keys(api).forEach(function (k) { g[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
