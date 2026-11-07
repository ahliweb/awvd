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
 *   Helper generik (semuanya fungsi murni, tanpa Date/Math.random/timer):
 *   easing.{standar, percepat, perlambat, ditekankanMasuk, ditekankanKeluar}
 *                                  preset kurva bezier (token Material Design 3)
 *   durasi.{pendek, sedang, panjang, sangatPanjang, masuk, keluar}  (milidetik)
 *   ms(milidetik, fps) -> jumlah frame (dibulatkan, minimal 1 bila input > 0)
 *   berjenjang(frame, indeks, { mulai = 0, jeda = 6 }) -> frame lokal elemen ke-indeks
 *   areaAman(lebar, tinggi) -> { aksi: {x,y,w,h}, grafis: {x,y,w,h} }  (EBU R 95)
 *   luminansRelatif(warna), kontras(a, b), pilihTeksKontras(latar)     (WCAG 2.2 SC 1.4.3)
 *                                  warna = [r,g,b] 0..255 atau "#rgb"/"#rrggbb"
 *   paletOkabeIto                  8 warna Okabe-Ito (array hex)
 *   simulasiButaWarna(warna, jenis, keparahan = 1) -> [r,g,b]  (Machado 2009;
 *                                  jenis: protanopia | deuteranopia | tritanopia)
 *   keLab(warna) -> [L,a,b]; bedaLab(lab1, lab2), bedaWarna(a, b) -> delta E CIEDE2000
 *   periksaPalet(palet, { ambang = 10, latar, kontrasMin = 3 })
 *                                  -> { lolos, minPerKondisi, pasangan[], lemahKontras[] }
 *   ukuranTeks(tinggiFrame, peran = "isi", audiens = "umum", konteks = "ponselLanskap")
 *                                  -> { px, persenTinggi, tinggiXDerajat }
 *   durasiBaca(teks, { cps = 17, min = 5/6, maks = 7, fps }) -> { detik[, frame] }
 *   pecahBaris(teks, { maks = 42, baris = 2 }) -> array baris; properti .melebihi
 *   captionAktif(cues, frame, fps) -> cue aktif atau null
 *   parseVtt(teks), parseSrt(teks) -> [{ mulai, akhir, teks }] (detik)
 *   presetJenis(nama) -> salinan preset jenis video (formal, edukasi, promo, ...);
 *                                  butuh <script src=".../preset-jenis.js"> dimuat lebih dulu
 *
 *   Video di dalam video (frame klip diekstrak ffmpeg oleh scripts/klip.mjs, lalu
 *   digambar per nomor frame; elemen <video> tidak dipakai):
 *   gambarKosong                   data: URI GIF 1x1 transparan (src awal <img>)
 *   indeksFrameKlip(klip, frameLokal, { ulang = false, kecepatan = 1 }) -> indeks | -1
 *   jalurFrameKlip(klip, frameLokal, opsi) -> URL frame, atau null bila belum mulai
 *   klipGambar(canvas|img, klip, frameLokal, opsi) -> Promise<boolean> (menunggu decode lalu menggambar)
 *   kreditKlip(klip, { ringkas = true }) -> teks atribusi TASL
 *
 *   Aset (dari aset-props.json, bun run aset periksa; opsi bersama { props|ctx, akar }; docs/aset.md):
 *   asetGambar(id, { props|ctx, target, teksAlternatif }) -> Promise<{ url, lebar, tinggi, rasio,
 *                                  fokus, alt, dekoratif, ... }>; gagal keras bila id tak ada atau
 *                                  aset informatif tanpa teksAlternatif
 *   pasangGambar(<img>, deskriptor) -> Promise<true>  satu-satunya jalur DOM; hanya <img>, tanpa inline
 *   logo(id, posisi, { ukuran = 10, opacity, latar, varian }) -> { x, y, w, h, url, alt, ... } di area
 *                                  aman grafis; menegakkan ukuranMinPx, clearSpace, tanpa rotasi/regang
 *   ikon(id, { ukuran = 24, warna: "putih"|"hitam" }) -> { w, h, url, alt, filter, ... }
 *   kreditAset(ids|"semua", { ringkas = true, tampil }) -> teks atribusi per aset (sesuai manifest)
 *   pasangFont(ids|"semua", { props|ctx }) -> Promise<string[]>  FontFace + load; gagal = galat
 *   angka(n, { desimal }), persen(n, { desimal }), rupiah(n, { desimal = 0 })  (format id-ID)
 *   kenBurns(frame, { mulai, durasi, dari, ke, easing }) -> nilai CSS transform
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

  // Preset easing bernama (token easing Material Design 3), dibangun dari bezier di atas.
  easing.standar = easing.bezier(0.2, 0, 0, 1);
  easing.percepat = easing.bezier(0.3, 0, 1, 1);
  easing.perlambat = easing.bezier(0, 0, 0, 1);
  easing.ditekankanMasuk = easing.bezier(0.05, 0.7, 0.1, 1);
  easing.ditekankanKeluar = easing.bezier(0.3, 0, 0.8, 0.15);

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

  // ------------------------------------------------------- waktu: ms, durasi
  function cekPositif(fn, nama, v) {
    if (typeof v !== "number" || !isFinite(v) || v <= 0) {
      throw new Error(fn + ": '" + nama + "' harus angka positif");
    }
  }

  // Milidetik -> jumlah frame (dibulatkan ke terdekat). Input > 0 selalu menghasilkan
  // minimal 1 frame; input 0 menghasilkan 0.
  function ms(milidetik, fps) {
    cekPositif("ms", "fps", fps);
    var n = Math.round((milidetik * fps) / 1000);
    if (milidetik > 0 && n < 1) n = 1;
    return n || 0; // hindari -0
  }

  // Preset durasi gerak dalam milidetik. pendek..sangatPanjang mengikuti token durasi
  // Material Design 3 (150/300/500/800); masuk sedikit lebih lama dari keluar
  // (NN/g, Laubheimer 2020). Pakai bersama ms(): ms(durasi.sedang, ctx.fps).
  var durasi = {
    pendek: 150,
    sedang: 300,
    panjang: 500,
    sangatPanjang: 800,
    masuk: 300,
    keluar: 200,
  };

  // Frame lokal elemen ke-`indeks` pada animasi berjenjang (stagger satu ide per beat).
  function berjenjang(frame, indeks, opsi) {
    opsi = opsi || {};
    var mulai = opsi.mulai == null ? 0 : opsi.mulai;
    var jeda = opsi.jeda == null ? 6 : opsi.jeda;
    return frame - mulai - indeks * jeda;
  }

  // ------------------------------------------------------------- area aman
  // EBU R 95 v1.1 (2017) catatan 5: area aksi 93% (margin 3,5% per sisi) dan area
  // grafis 90% (margin 5% per sisi), dipusatkan. Margin tiap sisi dibulatkan ke piksel
  // bulat terdekat (setengah naik) dengan aritmetika bilangan bulat (lebar*35/1000), lalu
  // diterapkan simetris: x = margin, w = lebar - 2*margin (idem y, h). Contoh 1920x1080:
  // aksi {x:67, y:38, w:1786, h:1004}; grafis {x:96, y:54, w:1728, h:972}.
  function areaAman(lebar, tinggi) {
    cekPositif("areaAman", "lebar", lebar);
    cekPositif("areaAman", "tinggi", tinggi);
    function kotak(permil) {
      var mx = Math.round((lebar * permil) / 1000);
      var my = Math.round((tinggi * permil) / 1000);
      return { x: mx, y: my, w: lebar - 2 * mx, h: tinggi - 2 * my };
    }
    return { aksi: kotak(35), grafis: kotak(50) };
  }

  // ---------------------------------------------------------------- kontras
  // WCAG 2.2 SC 1.4.3. Warna: [r,g,b] 0..255 atau string "#rgb" / "#rrggbb".
  function uraiWarna(w, fn) {
    if (Array.isArray(w) && w.length >= 3) {
      var rgb = [w[0], w[1], w[2]];
      for (var i = 0; i < 3; i++) {
        if (typeof rgb[i] !== "number" || !isFinite(rgb[i]) || rgb[i] < 0 || rgb[i] > 255) {
          throw new Error(fn + ": komponen warna harus angka 0..255");
        }
      }
      return rgb;
    }
    if (typeof w === "string") {
      var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(w.trim());
      if (m) {
        var h = m[1];
        if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
    }
    throw new Error(fn + ": warna harus [r,g,b] 0..255 atau '#rgb'/'#rrggbb'");
  }

  function linierSrgb(c) {
    var v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  // Luminansi relatif 0..1: L = 0,2126 R + 0,7152 G + 0,0722 B (komponen sudah linier).
  function luminansRelatif(warna) {
    var c = uraiWarna(warna, "luminansRelatif");
    return 0.2126 * linierSrgb(c[0]) + 0.7152 * linierSrgb(c[1]) + 0.0722 * linierSrgb(c[2]);
  }

  // Rasio kontras 1..21: (L terang + 0,05) / (L gelap + 0,05). Tidak dibulatkan.
  function kontras(a, b) {
    var la = luminansRelatif(a), lb = luminansRelatif(b);
    var terang = Math.max(la, lb), gelap = Math.min(la, lb);
    return (terang + 0.05) / (gelap + 0.05);
  }

  // "#000000" atau "#ffffff", mana yang rasio kontrasnya lebih tinggi terhadap `latar`.
  function pilihTeksKontras(latar) {
    return kontras(latar, "#000000") > kontras(latar, "#ffffff") ? "#000000" : "#ffffff";
  }

  // ------------------------------------------------- warna: buta warna, beda warna
  // Palet 8 warna Okabe & Ito (aman untuk buta warna merah-hijau pada pemakaian wajar).
  // Nilai hex mengikuti praktik umum; belum diverifikasi dari teks primer (halaman jfly
  // hanya memuat gambar palet). Urutan: hitam, jingga, biru muda, hijau kebiruan, kuning,
  // biru, merah jingga (vermilion), ungu kemerahan.
  var paletOkabeIto = ["#000000", "#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2",
    "#D55E00", "#CC79A7"];

  // Machado, Oliveira & Fernandes (2009), IEEE TVCG 15(6):1291-1298; matriks keparahan 1,0
  // (dikromasi) untuk RGB linear. Baris tiap matriks berjumlah 1, jadi putih tetap putih.
  var MATRIKS_BUTA_WARNA = {
    protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
    tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
  };
  var JENIS_BUTA_WARNA = ["protanopia", "deuteranopia", "tritanopia"];

  function keSrgb(v) { // linier 0..1 -> sRGB 0..255
    v = clampNum(v, 0, 1);
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  }

  // Simulasi buta warna: [r,g,b] 0..255 (float, tidak dibulatkan). `jenis`: "protanopia",
  // "deuteranopia", atau "tritanopia". `keparahan` 0..1 (bawaan 1) diinterpolasi linear
  // terhadap matriks identitas; pada 1 hasilnya persis model Machado. Pendekatan: paper
  // menyediakan matriks tersendiri per 0,1, dan model ini hanya memodelkan dikromasi.
  function simulasiButaWarna(warna, jenis, keparahan) {
    var M = MATRIKS_BUTA_WARNA[jenis];
    if (!M) throw new Error("simulasiButaWarna: 'jenis' harus salah satu dari " + JENIS_BUTA_WARNA.join(", "));
    var s = keparahan == null ? 1 : keparahan;
    if (typeof s !== "number" || !isFinite(s) || s < 0 || s > 1) {
      throw new Error("simulasiButaWarna: 'keparahan' harus angka 0..1");
    }
    var c = uraiWarna(warna, "simulasiButaWarna").map(linierSrgb);
    return M.map(function (baris, i) {
      var v = 0;
      for (var j = 0; j < 3; j++) v += ((1 - s) * (i === j ? 1 : 0) + s * baris[j]) * c[j];
      return keSrgb(v);
    });
  }

  // sRGB -> CIELAB (iluminan D65, titik putih 0,95047 / 1 / 1,08883): [L, a, b].
  function keLab(warna) {
    var c = uraiWarna(warna, "keLab").map(linierSrgb);
    var x = 0.4124564 * c[0] + 0.3575761 * c[1] + 0.1804375 * c[2];
    var y = 0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2];
    var z = 0.0193339 * c[0] + 0.119192 * c[1] + 0.9503041 * c[2];
    function f(t) { return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116; }
    var fx = f(x / 0.95047), fy = f(y), fz = f(z / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // CIEDE2000 antara dua warna Lab [L, a, b] (Sharma, Wu & Dalal 2005, Color Research &
  // Application 30(1):21-30). Diuji terhadap data uji Sharma (scripts/uji-visual.mjs).
  function bedaLab(lab1, lab2) {
    function rad(d) { return (d * Math.PI) / 180; }
    function der(r) { return (r * 180) / Math.PI; }
    function sudut(b, a) { return b === 0 && a === 0 ? 0 : (der(Math.atan2(b, a)) + 360) % 360; }
    var c25 = Math.pow(25, 7);
    var C1 = Math.hypot(lab1[1], lab1[2]), C2 = Math.hypot(lab2[1], lab2[2]);
    var Cb7 = Math.pow((C1 + C2) / 2, 7);
    var G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + c25)));
    var a1 = (1 + G) * lab1[1], a2 = (1 + G) * lab2[1];
    var C1p = Math.hypot(a1, lab1[2]), C2p = Math.hypot(a2, lab2[2]);
    var h1p = sudut(lab1[2], a1), h2p = sudut(lab2[2], a2);
    var dL = lab2[0] - lab1[0], dC = C2p - C1p;
    var dh = 0;
    if (C1p * C2p !== 0) {
      dh = h2p - h1p;
      if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
    }
    var dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
    var Lb = (lab1[0] + lab2[0]) / 2, Cb = (C1p + C2p) / 2;
    var hb = h1p + h2p;
    if (C1p * C2p !== 0) {
      hb = Math.abs(h1p - h2p) <= 180 ? hb / 2 : (hb + (hb < 360 ? 360 : -360)) / 2;
    }
    var T = 1 - 0.17 * Math.cos(rad(hb - 30)) + 0.24 * Math.cos(rad(2 * hb)) +
      0.32 * Math.cos(rad(3 * hb + 6)) - 0.2 * Math.cos(rad(4 * hb - 63));
    var dTheta = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2));
    var Cb7p = Math.pow(Cb, 7);
    var Rc = 2 * Math.sqrt(Cb7p / (Cb7p + c25));
    var Sl = 1 + (0.015 * Math.pow(Lb - 50, 2)) / Math.sqrt(20 + Math.pow(Lb - 50, 2));
    var Sc = 1 + 0.045 * Cb, Sh = 1 + 0.015 * Cb * T;
    var Rt = -Math.sin(rad(2 * dTheta)) * Rc;
    var tl = dL / Sl, tc = dC / Sc, th = dH / Sh;
    return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
  }

  // Selisih warna CIEDE2000 (delta E00) antara dua warna sRGB. 0 = identik; 1 kira-kira
  // selisih nyaris terlihat; hitam-putih = 100.
  function bedaWarna(a, b) {
    return bedaLab(keLab(a), keLab(b));
  }

  // Memeriksa palet kategorikal. Untuk tiap pasangan warna, delta E00 dihitung dalam
  // penglihatan normal dan di bawah simulasi protanopia, deuteranopia, dan tritanopia;
  // pasangan dengan selisih < `ambang` dilaporkan. Bila `latar` diberikan, tiap warna juga
  // harus berkontras >= `kontrasMin` terhadapnya (WCAG 2.2 SC 1.4.11 objek grafis: 3:1).
  // `ambang` bawaan 10 adalah KEPUTUSAN DESAIN awvd, bukan standar; 3:1 adalah standar.
  // Hasil: { lolos, minPerKondisi: {normal, protanopia, ...}, pasangan: [{a, b, warnaA,
  // warnaB, kondisi, deltaE}], lemahKontras: [{i, warna, kontras}] }. Warna tidak boleh
  // menjadi satu-satunya pembeda informasi (WCAG 1.4.1): tambahkan label, ikon, atau pola.
  function periksaPalet(palet, opsi) {
    opsi = opsi || {};
    if (!Array.isArray(palet) || palet.length < 2) {
      throw new Error("periksaPalet: 'palet' harus array berisi >= 2 warna");
    }
    var ambang = opsi.ambang == null ? 10 : opsi.ambang;
    var kontrasMin = opsi.kontrasMin == null ? 3 : opsi.kontrasMin;
    cekPositif("periksaPalet", "ambang", ambang);
    cekPositif("periksaPalet", "kontrasMin", kontrasMin);
    var kondisi = ["normal"].concat(JENIS_BUTA_WARNA);
    var lab = {};
    kondisi.forEach(function (k) {
      lab[k] = palet.map(function (w) {
        return keLab(k === "normal" ? uraiWarna(w, "periksaPalet") : simulasiButaWarna(w, k));
      });
    });
    var minPer = {}, pasangan = [];
    kondisi.forEach(function (k) { minPer[k] = Infinity; });
    for (var i = 0; i < palet.length; i++) {
      for (var j = i + 1; j < palet.length; j++) {
        for (var n = 0; n < kondisi.length; n++) {
          var k = kondisi[n];
          var d = bedaLab(lab[k][i], lab[k][j]);
          if (d < minPer[k]) minPer[k] = d;
          if (d < ambang) {
            pasangan.push({ a: i, b: j, warnaA: palet[i], warnaB: palet[j], kondisi: k, deltaE: Math.round(d * 10) / 10 });
          }
        }
      }
    }
    var lemah = [];
    if (opsi.latar != null) {
      palet.forEach(function (w, i) {
        var r = kontras(w, opsi.latar);
        if (r < kontrasMin) lemah.push({ i: i, warna: w, kontras: Math.round(r * 100) / 100 });
      });
    }
    kondisi.forEach(function (k) { minPer[k] = Math.round(minPer[k] * 10) / 10; });
    return { lolos: pasangan.length === 0 && lemah.length === 0, minPerKondisi: minPer, pasangan: pasangan, lemahKontras: lemah };
  }

  // ------------------------------------------------------------- ukuran teks
  // Ukuran teks minimum dari sudut pandang, bukan piksel tetap. Dasar: ukuran cetak kritis
  // (critical print size) ~0,2 derajat tinggi-x untuk pembaca berpenglihatan normal
  // (Legge & Bigelow 2011, J Vision 11(5):8). Geometri perangkat (ASUMSI tipikal) dan
  // pengali audiens/peran (KEPUTUSAN DESAIN; arahnya didukung W3C WAI "older users" dan
  // WCAG 1.4.6, besarnya tidak) harus dibaca sebagai titik awal, bukan temuan.
  var CPS_DERAJAT = 0.2;
  var RASIO_TINGGI_X = 0.52; // tinggi-x / ukuran font sans-serif umum (Arial ~0,519; Roboto ~0,528)
  function sudutBingkai(tinggiCm, jarakCm) {
    return (2 * Math.atan(tinggiCm / 2 / jarakCm) * 180) / Math.PI;
  }
  // Tinggi bingkai video pada layar dan jarak mata: tv = layar 3 tinggi layar (jarak
  // rujukan VMAF 1080p); laptop = video 16:9 ~10 cm pada 55 cm; ponselLanskap = video
  // 16:9 layar-penuh ~6,5 cm pada 35 cm; ponselVertikalPenuh = video 9:16 layar-penuh
  // ~15 cm pada 33 cm; ponselPotret169 = video 16:9 tersemat lebar-penuh pada ponsel
  // potret (~3,9 cm) pada 34 cm (jarak ponsel 32-36 cm: Bababekova dkk. 2011).
  var KONTEKS_TONTON = {
    tv: { sudut: sudutBingkai(1, 3), keterangan: "TV atau monitor, jarak 3 tinggi layar (asumsi)" },
    laptop: { sudut: sudutBingkai(10, 55), keterangan: "video 16:9 ~10 cm tinggi pada 55 cm (asumsi)" },
    ponselLanskap: { sudut: sudutBingkai(6.5, 35), keterangan: "ponsel layar-penuh lanskap (asumsi)" },
    ponselVertikalPenuh: { sudut: sudutBingkai(15, 33), keterangan: "video 9:16 layar-penuh pada ponsel (asumsi)" },
    ponselPotret169: { sudut: sudutBingkai(3.9, 34), keterangan: "video 16:9 tersemat pada ponsel potret (asumsi)" },
  };
  // Pengali terhadap tinggi-x minimum; sama dengan data/audiens.json (dijaga uji-visual.mjs).
  var PENGALI_AUDIENS = { umum: 1, remaja: 1, anak: 1.2, lansia: 1.5, lowVision: 2 };
  var PERAN_TEKS = { judul: 2.2, subjudul: 1.5, isi: 1.25, caption: 1.25, keterangan: 1 };

  // ukuranTeks(tinggiFrame, peran = "isi", audiens = "umum", konteks = "ponselLanskap")
  //   -> { px, persenTinggi, tinggiXDerajat }
  // px = ukuran font minimum (dibulatkan) pada bingkai setinggi `tinggiFrame` piksel.
  // `audiens` = nama profil (umum, remaja, anak, lansia, lowVision) atau pengali angka > 0.
  // Teks yang lebih kecil dari ini tidak terbaca nyaman pada konteks tonton itu.
  function ukuranTeks(tinggiFrame, peran, audiens, konteks) {
    cekPositif("ukuranTeks", "tinggiFrame", tinggiFrame);
    peran = peran == null ? "isi" : peran;
    audiens = audiens == null ? "umum" : audiens;
    konteks = konteks == null ? "ponselLanskap" : konteks;
    var p = PERAN_TEKS[peran], k = KONTEKS_TONTON[konteks];
    var a = typeof audiens === "number" ? audiens : PENGALI_AUDIENS[audiens];
    if (p == null) throw new Error("ukuranTeks: 'peran' harus salah satu dari " + Object.keys(PERAN_TEKS).join(", "));
    if (k == null) throw new Error("ukuranTeks: 'konteks' harus salah satu dari " + Object.keys(KONTEKS_TONTON).join(", "));
    if (typeof a !== "number" || !isFinite(a) || a <= 0) {
      throw new Error("ukuranTeks: 'audiens' harus salah satu dari " + Object.keys(PENGALI_AUDIENS).join(", ") + " atau pengali angka > 0");
    }
    var tinggiX = CPS_DERAJAT * a * p;
    var pecahan = tinggiX / RASIO_TINGGI_X / k.sudut;
    return {
      px: Math.round(pecahan * tinggiFrame),
      persenTinggi: Math.round(pecahan * 1000) / 10,
      tinggiXDerajat: Math.round(tinggiX * 100) / 100,
    };
  }
  ukuranTeks.konteks = KONTEKS_TONTON;
  ukuranTeks.pengaliAudiens = PENGALI_AUDIENS;
  ukuranTeks.peran = PERAN_TEKS;
  ukuranTeks.cpsDerajat = CPS_DERAJAT;
  ukuranTeks.rasioTinggiX = RASIO_TINGGI_X;

  // ------------------------------------------------------------ teks / caption
  // Karakter dihitung per code point; spasi berurutan dan pinggir dirapikan dulu.
  function rapikan(teks) {
    return String(teks == null ? "" : teks).replace(/\s+/g, " ").trim();
  }
  function panjangTeks(s) {
    return Array.from(s).length;
  }

  // Lama tampil caption dari kecepatan baca: karakter (termasuk spasi) / cps, dijepit ke
  // [min, maks] detik. Pedoman Netflix Timed Text Style Guide menghitung karakter dan
  // untuk bahasa Indonesia membatasi subtitle 17 cps (dewasa) dan 13 cps (anak); SDH
  // (caption untuk tuli dan sulit dengar) 20 dan 17 cps. Bawaan 17 = subtitle dewasa.
  // Bila opsi.fps diberikan, hasil memuat `frame`.
  function durasiBaca(teks, opsi) {
    opsi = opsi || {};
    var cps = opsi.cps == null ? 17 : opsi.cps;
    var min = opsi.min == null ? 5 / 6 : opsi.min;
    var maks = opsi.maks == null ? 7 : opsi.maks;
    cekPositif("durasiBaca", "cps", cps);
    if (!(min >= 0 && maks >= min)) throw new Error("durasiBaca: butuh 0 <= min <= maks");
    var detik = clampNum(panjangTeks(rapikan(teks)) / cps, min, maks);
    var hasil = { detik: detik };
    if (opsi.fps != null) {
      cekPositif("durasiBaca", "fps", opsi.fps);
      hasil.frame = Math.max(1, Math.round(detik * opsi.fps));
    }
    return hasil;
  }

  var KATA_SAMBUNG = ["dan", "atau", "tetapi", "yang", "untuk", "dengan", "di", "ke",
    "dari", "karena", "agar", "sehingga"];

  // Memecah teks menjadi baris caption. Mengembalikan ARRAY string; array itu selalu
  // punya properti `melebihi` (boolean): true bila teks tidak muat dalam `baris` baris
  // berisi <= `maks` karakter. Dalam kasus itu array berisi seluruh teks yang dibungkus
  // greedy (jumlah elemen bisa > `baris`; kata tunggal terpanjang dari `maks` tetap
  // satu baris), sehingga tidak ada teks yang hilang. Teks kosong -> [].
  // Bila muat satu baris -> satu elemen. Selain itu dipakai jumlah baris minimum, dan
  // titik potong (di spasi) dipilih lewat urutan prioritas berikut (leksikografis):
  //   1. semua baris <= maks (syarat mutlak);
  //   2. baris atas tidak hanya 1-2 kata (bila ada alternatif);
  //   3. sedikit potongan "biasa": potongan baik = setelah tanda baca , . ; : ? !
  //      atau sebelum kata sambung (dan, atau, tetapi, yang, untuk, dengan, di, ke,
  //      dari, karena, agar, sehingga);
  //   4. sedikit pelanggaran piramida terbalik (baris bawah >= baris atas);
  //   5. baris terpanjang sependek mungkin (seimbang); seri -> potong paling awal.
  function pecahBaris(teks, opsi) {
    opsi = opsi || {};
    var maks = opsi.maks == null ? 42 : opsi.maks;
    var nBaris = opsi.baris == null ? 2 : opsi.baris;
    cekPositif("pecahBaris", "maks", maks);
    if (typeof nBaris !== "number" || nBaris < 1 || nBaris % 1 !== 0) {
      throw new Error("pecahBaris: 'baris' harus bilangan bulat >= 1");
    }
    function tandai(arr, melebihi) { arr.melebihi = melebihi; return arr; }

    var rapi = rapikan(teks);
    if (rapi === "") return tandai([], false);
    var kata = rapi.split(" ");
    var n = kata.length;
    if (panjangTeks(rapi) <= maks) return tandai([rapi], false);

    var awal = [0]; // awal[i] = jumlah karakter kata 0..i-1 beserta spasi pemisahnya
    var terpanjang = 0;
    for (var i = 0; i < n; i++) {
      var p = panjangTeks(kata[i]);
      if (p > terpanjang) terpanjang = p;
      awal.push(awal[i] + p + 1);
    }
    function lebarBaris(a, b) { return awal[b] - awal[a] - 1; } // kata a..b-1
    function gabung(a, b) { return kata.slice(a, b).join(" "); }

    // Bungkus greedy: jumlah baris minimum (juga cadangan saat tidak muat).
    var greedy = [];
    for (var s = 0; s < n;) {
      var e = s + 1;
      while (e < n && lebarBaris(s, e + 1) <= maks) e++;
      greedy.push(gabung(s, e));
      s = e;
    }
    var m = greedy.length;
    if (m > nBaris || terpanjang > maks) return tandai(greedy, true);

    function potonganBaik(j) { // potong sebelum kata ke-j?
      if (/[,.;:?!]$/.test(kata[j - 1])) return true;
      var berikut = kata[j].toLowerCase().replace(/^[^a-z0-9]+/, "");
      return KATA_SAMBUNG.indexOf(berikut) >= 0;
    }
    function kunci(titik) { // titik: indeks awal tiap baris, dimulai 0
      var batas = titik.concat([n]);
      var biasa = 0, pir = 0, panjangMaks = 0, prev = -1;
      for (var k = 0; k < m; k++) {
        var w = lebarBaris(batas[k], batas[k + 1]);
        if (w > panjangMaks) panjangMaks = w;
        if (k > 0) {
          if (!potonganBaik(batas[k])) biasa++;
          if (w < prev) pir++;
        }
        prev = w;
      }
      var pendek = m > 1 && batas[1] <= 2 ? 1 : 0;
      return [pendek, biasa, pir, panjangMaks];
    }
    function lebihBaik(a, b) { // a lebih baik dari b (b boleh null)?
      if (!b) return true;
      for (var k = 0; k < a.length; k++) {
        if (a[k] !== b[k]) return a[k] < b[k];
      }
      return false;
    }

    var terbaik = null, kunciTerbaik = null;
    function telusuri(pos, sisa, titik) {
      if (sisa === 1) {
        if (lebarBaris(pos, n) > maks) return;
        var kk = kunci(titik);
        if (lebihBaik(kk, kunciTerbaik)) { kunciTerbaik = kk; terbaik = titik.slice(); }
        return;
      }
      for (var j = pos + 1; j <= n - (sisa - 1); j++) {
        if (lebarBaris(pos, j) > maks) break;
        titik.push(j);
        telusuri(j, sisa - 1, titik);
        titik.pop();
      }
    }
    telusuri(0, m, [0]);
    if (!terbaik) return tandai(greedy, true); // tidak terjadi; jaga-jaga
    var hasil = [], batasAkhir = terbaik.concat([n]);
    for (var q = 0; q < m; q++) hasil.push(gabung(batasAkhir[q], batasAkhir[q + 1]));
    return tandai(hasil, false);
  }

  // Cue aktif pada `frame`: mulai <= t < akhir dengan t = frame / fps (detik). Bila
  // beberapa cue tumpang tindih, yang pertama dalam array. Tidak ada -> null.
  function captionAktif(cues, frame, fps) {
    cekPositif("captionAktif", "fps", fps);
    var t = frame / fps;
    for (var i = 0; i < cues.length; i++) {
      if (cues[i].mulai <= t && t < cues[i].akhir) return cues[i];
    }
    return null;
  }

  // Timestamp "hh:mm:ss.mmm" / "mm:ss.mmm" (VTT) atau dengan koma (SRT) -> milidetik
  // bilangan bulat, atau null. Detik dihitung dari milidetik bulat (ms / 1000) agar
  // perbandingan di captionAktif tidak kena galat penjumlahan desimal.
  function uraiWaktu(str) {
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(str);
    if (!m) return null;
    var frak = parseInt((m[4] + "00").slice(0, 3), 10);
    return ((parseInt(m[1] || "0", 10) * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + frak;
  }
  var POLA_WAKTU = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

  // Penguraian bersama VTT/SRT: berkas dipecah menjadi blok (dipisah baris kosong);
  // dalam tiap blok, baris berisi "-->" adalah baris waktu (pengaturan cue sesudah
  // waktu akhir diabaikan), baris sebelumnya (nomor/id) diabaikan, baris sesudahnya
  // adalah teks. Blok tanpa "-->" (header WEBVTT, NOTE, STYLE, REGION) dilewati.
  // Tag penanda seperti <i>, <v Nama>, <00:00:01.000> dibuang dari teks.
  function uraiCue(teks, entitas) {
    var blok = String(teks == null ? "" : teks).replace(/^﻿/, "").split(/\r?\n[ \t]*\r?\n/);
    var cues = [];
    for (var b = 0; b < blok.length; b++) {
      var baris = blok[b].split(/\r?\n/);
      for (var i = 0; i < baris.length; i++) {
        if (baris[i].indexOf("-->") < 0) continue;
        var m = POLA_WAKTU.exec(baris[i]);
        if (m) {
          var t1 = uraiWaktu(m[1]), t2 = uraiWaktu(m[2]);
          var isi = baris.slice(i + 1).join("\n")
            .replace(/<\/?[A-Za-z][^<>]*>|<\d+:\d{2}[.,]\d{1,3}>/g, "");
          if (entitas) {
            isi = isi.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&");
          }
          isi = isi.replace(/^\s+|\s+$/g, "");
          if (t1 != null && t2 != null && t2 > t1 && isi !== "") {
            cues.push({ mulai: t1 / 1000, akhir: t2 / 1000, teks: isi });
          }
        }
        break;
      }
    }
    return cues;
  }
  function parseVtt(teks) { return uraiCue(teks, true); }
  function parseSrt(teks) { return uraiCue(teks, false); }

  // ---------------------------------------------------- video di dalam video
  // Klip tertanam: scripts/klip.mjs mengekstrak frame klip (ffmpeg, pada fps komposisi)
  // ke cache dan menulis klip-props.json. Komposisi menggambar frame ke-n klip sebagai
  // fungsi murni dari nomor frame: tidak ada <video>, tidak ada seek saat render.
  // Bentuk objek `klip` (dari klip-props.json): { id, akar, folder, ekstensi, digit,
  // jumlah, atribusi: { judul, pencipta, sumberUrl, lisensi, urlLisensi, perubahan,
  // tanpaJudul, penciptaAnonim } }.

  // GIF 1x1 transparan. Renderer menolak <img> tanpa gambar termuat saat halaman dibuka,
  // jadi bila memakai target <img>, beri src awal ini lalu biarkan klipGambar menggantinya.
  // (Target <canvas> tidak membutuhkannya.)
  var gambarKosong = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  // Indeks frame sumber untuk frame lokal klip (0 = frame pertama klip). Negatif -> -1
  // (belum mulai). Lewat akhir: ditahan di frame terakhir, atau diulang bila ulang:true.
  // kecepatan memetakan frame lokal ke frame sumber (frame diekstrak pada fps komposisi,
  // jadi kecepatan <> 1 menduplikasi atau melewati frame, tanpa interpolasi).
  function indeksFrameKlip(klip, frameLokal, opsi) {
    opsi = opsi || {};
    var jumlah = klip && klip.jumlah;
    if (typeof jumlah !== "number" || !(jumlah >= 1) || jumlah % 1 !== 0) {
      throw new Error("indeksFrameKlip: klip.jumlah harus bilangan bulat >= 1");
    }
    var kecepatan = opsi.kecepatan == null ? 1 : opsi.kecepatan;
    if (typeof kecepatan !== "number" || !(kecepatan > 0) || !isFinite(kecepatan)) {
      throw new Error("indeksFrameKlip: kecepatan harus angka positif");
    }
    if (typeof frameLokal !== "number" || !isFinite(frameLokal)) {
      throw new Error("indeksFrameKlip: frameLokal harus angka");
    }
    if (frameLokal < 0) return -1;
    var i = Math.floor(frameLokal * kecepatan);
    return opsi.ulang ? i % jumlah : Math.min(i, jumlah - 1);
  }

  // URL gambar frame untuk frame lokal klip; null bila klip belum mulai.
  function jalurFrameKlip(klip, frameLokal, opsi) {
    var i = indeksFrameKlip(klip, frameLokal, opsi);
    if (i < 0) return null;
    if (!klip.folder || !klip.ekstensi) throw new Error("jalurFrameKlip: klip.folder dan klip.ekstensi wajib ada");
    var digit = klip.digit == null ? 6 : klip.digit;
    var nomor = String(i);
    while (nomor.length < digit) nomor = "0" + nomor;
    var akar = klip.akar ? String(klip.akar).replace(/\/+$/, "") + "/" : "";
    return akar + klip.folder + "/" + nomor + "." + klip.ekstensi;
  }

  // Menggambar frame klip ke `target` lalu menunggu sampai siap, sehingga
  // `await klipGambar(...)` di dalam render menjamin frame klip sudah tergambar sebelum
  // screenshot. Mengembalikan false (tanpa menyentuh target) bila klip belum mulai;
  // melempar galat bila berkas frame tidak termuat.
  //   - target <canvas> (DIANJURKAN): frame didekode lewat Image lepas (img.decode()) lalu
  //     digambar sinkron dengan drawImage pada ukuran aslinya. Hasilnya deterministik.
  //   - target <img>: src diganti lalu img.decode() ditunggu. Chromium dapat mengecat
  //     gambar yang baru didekode secara asinkron, sehingga screenshot kadang masih
  //     memuat frame sebelumnya (tidak deterministik); pakai <canvas> untuk render.
  var gambarLepas = typeof WeakMap === "function" ? new WeakMap() : null;
  function klipGambar(target, klip, frameLokal, opsi) {
    var url;
    try { url = jalurFrameKlip(klip, frameLokal, opsi); } catch (e) { return Promise.reject(e); }
    if (url == null) return Promise.resolve(false);
    var galat = function () { throw new Error("klipGambar: frame klip gagal dimuat: " + url); };
    if (typeof target.getContext !== "function") {
      var sekarang = typeof target.getAttribute === "function" ? target.getAttribute("src") : target.src;
      if (sekarang !== url) target.src = url;
      return Promise.resolve(target.decode()).then(function () { return true; }, galat);
    }
    var im = gambarLepas && gambarLepas.get(target);
    if (!im) {
      im = new g.Image();
      if (gambarLepas) gambarLepas.set(target, im);
    }
    if (im.getAttribute ? im.getAttribute("src") !== url : im.src !== url) im.src = url;
    return Promise.resolve(im.decode()).then(function () {
      var w = im.naturalWidth, h = im.naturalHeight;
      if (target.width !== w) target.width = w;
      if (target.height !== h) target.height = h;
      var c = target.getContext("2d");
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, w, h);
      c.drawImage(im, 0, 0);
      return true;
    }, galat);
  }

  // Nama tampil lisensi dari kode: "CC-BY-4.0" -> "CC BY 4.0", "CC0-1.0" -> "CC0 1.0".
  function namaLisensi(kode) {
    kode = String(kode == null ? "" : kode);
    var m = /^CC-BY((?:-NC)?(?:-SA)?(?:-ND)?)-(\d\.\d)$/.exec(kode);
    if (m) return "CC BY" + m[1] + " " + m[2];
    m = /^(CC0|PDM)-(\d\.\d)$/.exec(kode);
    if (m) return (m[1] === "CC0" ? "CC0 " : "Public Domain Mark ") + m[2];
    if (kode.indexOf("STOK:") === 0) return "Lisensi stok " + kode.slice(5);
    return kode;
  }

  // Atribusi TASL (Title, Author, Source, License; Creative Commons, praktik terbaik
  // atribusi). ringkas (bawaan) untuk ditampilkan di layar:
  //   "Judul" oleh Pencipta · CC BY 4.0 · diubah
  // ringkas:false = baris lengkap (sumber, tautan lisensi, perubahan) untuk kredit akhir:
  //   "Judul" oleh Pencipta. Sumber: URL. Lisensi: CC BY 4.0 (URL). Diubah: ....
  function kreditKlip(klip, opsi) {
    var a = klip && klip.atribusi;
    if (!a) throw new Error("kreditKlip: klip.atribusi wajib ada");
    var ringkas = !opsi || opsi.ringkas !== false;
    var nama = namaLisensi(a.lisensi);
    var t = "";
    if (!a.tanpaJudul && a.judul) t = '"' + a.judul + '"';
    if (!a.penciptaAnonim && a.pencipta) t += (t ? " oleh " : "") + a.pencipta;
    var perubahan = String(a.perubahan == null ? "" : a.perubahan).replace(/[.\s]+$/, "");
    if (ringkas) {
      var p = [];
      if (t) p.push(t);
      p.push(nama);
      if (perubahan) p.push("diubah");
      return p.join(" · ");
    }
    var b = [];
    if (t) b.push(t);
    b.push("Sumber: " + a.sumberUrl);
    b.push("Lisensi: " + nama + (a.urlLisensi ? " (" + a.urlLisensi + ")" : ""));
    if (perubahan) b.push("Diubah: " + perubahan);
    return b.join(". ") + ".";
  }

  // ------------------------------------------------------------------- aset
  // Helper untuk aset yang sudah lolos `bun run aset periksa` (docs/aset.md). Sumbernya
  // `props` yang memuat kunci `aset` (id -> entri): aset-props.json apa adanya, atau
  // ctx.props bila digabung dengan `aset periksa --gabung`. Semua fungsi murni dari
  // argumen, kecuali pasangGambar/pasangFont (menyentuh hanya elemen/DOM yang diberikan).
  // Pelanggaran aturan = galat (melempar atau promise ditolak), bukan fallback senyap.
  //
  // opsi bersama: { props, ctx, akar }
  //   ctx   = argumen kedua render(); jalan pintas: props = ctx.props, lebar = ctx.width,
  //           tinggi = ctx.height (nilai eksplisit di opsi menang)
  //   akar  = awalan URL untuk entri.jalur (jalur di props relatif terhadap folder manifest)

  var FORMAT_FONT = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };
  var POSISI_LOGO = ["kiri-atas", "kanan-atas", "kiri-bawah", "kanan-bawah", "tengah"];
  // Keputusan desain (bukan standar): ukuran logo bawaan 10% lebar frame (rentang bug logo
  // 8-12% dari praktik penyiaran, tidak ada angka baku terverifikasi) dan kontras minimum
  // logo terhadap latar 3:1 (WCAG 2.2 SC 1.4.11 untuk objek grafis).
  var UKURAN_LOGO_PERSEN = 10;
  var KONTRAS_LOGO_MIN = 3;

  function gabungCtx(opsi) {
    opsi = opsi || {};
    var c = opsi.ctx;
    if (!c) return opsi;
    var o = {};
    Object.keys(opsi).forEach(function (k) { o[k] = opsi[k]; });
    if (o.props == null) o.props = c.props;
    if (o.lebar == null) o.lebar = c.width;
    if (o.tinggi == null) o.tinggi = c.height;
    return o;
  }

  function petaAset(opsi, fn) {
    var p = opsi && opsi.props;
    if (!p || typeof p !== "object" || !p.aset || typeof p.aset !== "object") {
      throw new Error(fn + ": opsi.props wajib memuat kunci 'aset' (aset-props.json, atau ctx.props " +
        "hasil `aset periksa --gabung`); lewatkan { props } atau { ctx }");
    }
    return p.aset;
  }

  function entriAset(id, opsi, fn, jenisBoleh) {
    var peta = petaAset(opsi, fn);
    if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(peta, id)) {
      throw new Error(fn + ': aset "' + id + '" tidak ada di aset-props (id yang ada: ' +
        (Object.keys(peta).join(", ") || "tidak ada") + ")");
    }
    var e = peta[id];
    if (!e || typeof e !== "object") throw new Error(fn + ': entri aset "' + id + '" tidak valid');
    if (jenisBoleh && jenisBoleh.indexOf(e.jenis) < 0) {
      throw new Error(fn + ': aset "' + id + '" berjenis ' + e.jenis + ", bukan " + jenisBoleh.join(" atau "));
    }
    return e;
  }

  // URL dari entri.jalur: hanya berkas lokal relatif (tanpa skema, jalur mutlak, atau "..").
  function urlAset(e, id, akar, fn) {
    var j = e.jalur;
    if (typeof j !== "string" || j === "" || /^[a-z][a-z0-9+.\-]*:/i.test(j) || j.charAt(0) === "/" ||
        j.indexOf("\\") >= 0 || j.split("/").indexOf("..") >= 0) {
      throw new Error(fn + ': jalur aset "' + id + '" harus berkas lokal relatif (dapat ' + JSON.stringify(j) + ")");
    }
    return (akar ? String(akar).replace(/\/+$/, "") + "/" : "") + j;
  }

  // Teks alternatif (WCAG 1.1.1). Aset informatif wajib punya teks; aset dekoratif mendapat
  // alt="" dan aria-hidden. Peran dari manifest tidak bisa diubah per pemakaian. Ikon tanpa
  // peran di manifest dianggap dekoratif kecuali ada teksAlternatif (keputusan desain: ikon
  // lazimnya mendampingi teks); gambar, logo, dan svg tanpa peran dianggap informatif.
  function teksAlternatifAset(e, id, opsi, fn) {
    var alt = opsi.teksAlternatif != null ? opsi.teksAlternatif : e.teksAlternatif;
    var ada = typeof alt === "string" && alt.trim() !== "";
    var peran = e.peran || (!ada && e.jenis === "ikon" ? "dekoratif" : "informatif");
    if (peran === "dekoratif") return { alt: "", dekoratif: true };
    if (!ada) {
      throw new Error(fn + ': aset "' + id + '" informatif tetapi tanpa teksAlternatif (WCAG 1.1.1): ' +
        'isi teksAlternatif di aset.json, atau tandai peran "dekoratif"');
    }
    return { alt: alt, dekoratif: false };
  }

  function rasioAset(e, id, fn) {
    var r = typeof e.rasio === "number" && e.rasio > 0 ? e.rasio
      : (e.lebar > 0 && e.tinggi > 0 ? e.lebar / e.tinggi : 0);
    if (!(r > 0)) throw new Error(fn + ': aset "' + id + '" tanpa lebar/tinggi di aset-props (jalankan bun run aset periksa)');
    return r;
  }

  function posisiFokus(f) {
    if (!f || typeof f.x !== "number" || typeof f.y !== "number") return null;
    return Math.round(f.x * 10000) / 100 + "% " + Math.round(f.y * 10000) / 100 + "%";
  }

  // asetGambar(id, { props|ctx, akar, teksAlternatif, target }) -> Promise
  // Menyelesaikan { id, jenis, url, lebar, tinggi, rasio, fokus, fit, objectPosition, alt,
  // dekoratif }. Gagal keras bila id tak ada atau aset informatif tanpa teksAlternatif.
  // Dengan `target` (elemen <img>), gambar dipasang lewat pasangGambar dan promise
  // menunggu decode. Aset hanya pernah dimuat lewat <img>; tidak ada jalur SVG inline.
  function asetGambar(id, opsi) {
    var o = gabungCtx(opsi), d;
    try {
      var e = entriAset(id, o, "asetGambar", ["gambar", "svg", "logo", "ikon"]);
      var t = teksAlternatifAset(e, id, o, "asetGambar");
      d = {
        id: id, jenis: e.jenis, url: urlAset(e, id, o.akar, "asetGambar"),
        lebar: e.lebar == null ? null : e.lebar, tinggi: e.tinggi == null ? null : e.tinggi,
        rasio: e.rasio > 0 ? e.rasio : (e.lebar > 0 && e.tinggi > 0 ? e.lebar / e.tinggi : null),
        fokus: e.fokus || null, fit: (e.tampil && e.tampil.fit) || null,
        objectPosition: posisiFokus(e.fokus), alt: t.alt, dekoratif: t.dekoratif,
      };
    } catch (err) { return Promise.reject(err); }
    if (!o.target) return Promise.resolve(d);
    return pasangGambar(o.target, d).then(function () { return d; });
  }

  // pasangGambar(target, deskriptor) -> Promise<true>
  // Satu-satunya jalur DOM untuk aset gambar: memasang deskriptor (dari asetGambar, logo,
  // atau ikon) ke elemen <img> dan menunggu decode. Target selain <img> ditolak, jadi logo
  // dan SVG tidak pernah disisipkan inline (inline menjalankan skrip dan memuat sumber luar).
  function pasangGambar(target, d) {
    try {
      if (!target || String(target.tagName).toUpperCase() !== "IMG") {
        throw new Error("pasangGambar: target harus elemen <img> (aset tidak pernah disisipkan inline)");
      }
      if (!d || typeof d.url !== "string" || typeof d.alt !== "string") {
        throw new Error("pasangGambar: deskriptor tidak valid (pakai hasil asetGambar, logo, atau ikon)");
      }
    } catch (e) { return Promise.reject(e); }
    var skrg = typeof target.getAttribute === "function" ? target.getAttribute("src") : target.src;
    if (skrg !== d.url) target.src = d.url;
    target.setAttribute("alt", d.alt);
    if (d.dekoratif) target.setAttribute("aria-hidden", "true");
    else if (typeof target.removeAttribute === "function") target.removeAttribute("aria-hidden");
    var s = target.style;
    if (typeof d.x === "number" && typeof d.y === "number") {
      s.position = "absolute";
      s.left = d.x + "px";
      s.top = d.y + "px";
    }
    if (typeof d.w === "number" && typeof d.h === "number") {
      s.width = d.w + "px";
      s.height = d.h + "px";
    }
    if (d.fit) s.objectFit = d.fit;
    if (d.objectPosition) s.objectPosition = d.objectPosition;
    if (typeof d.opacity === "number") s.opacity = String(d.opacity);
    if (d.filter) s.filter = d.filter;
    var galat = function () { throw new Error("pasangGambar: gambar gagal dimuat: " + d.url); };
    return Promise.resolve(typeof target.decode === "function" ? target.decode() : null)
      .then(function () { return true; }, galat);
  }

  // logo(id, posisi, { props|ctx, lebar, tinggi, ukuran = 10, opacity = 1, latar, varian, akar })
  //   -> { id, jenis, url, x, y, w, h, opacity, alt, dekoratif, rasio, posisi, clearSpace,
  //        fit: "contain", ukuranMinPx }  (px komposisi; pasang lewat pasangGambar)
  // posisi: kiri-atas | kanan-atas | kiri-bawah | kanan-bawah | tengah, di dalam area grafis
  // aman (areaAman, EBU R 95). `ukuran` = persen lebar frame. Rasio dikunci dari aset-props:
  // tidak ada parameter rotasi atau regang. Aturan merek (merek.aturan) dipaksakan sebagai galat:
  // lebar < ukuranMinPx; clearSpace ditambahkan sebagai margin dari tepi area aman; logo + clearSpace
  // harus muat di area aman; "transparansi" di larangan menolak opacity < 1. `latar` (warna
  // latar) memeriksa kontras >= 3 terhadap setidaknya satu warna di warnaDiizinkan dan memilih
  // varian: varian = { diLatarTerang: id, diLatarGelap: id } (latar terang bila kontras dengan
  // hitam >= dengan putih); tanpa kunci yang cocok dipakai `id`.
  function logo(id, posisi, opsi) {
    var o = gabungCtx(opsi);
    if (POSISI_LOGO.indexOf(posisi) < 0) {
      throw new Error("logo: posisi harus salah satu dari " + POSISI_LOGO.join(", ") + " (dapat " + posisi + ")");
    }
    ["rotasi", "regang", "miring"].forEach(function (k) {
      if (o[k] != null) throw new Error("logo: opsi '" + k + "' tidak ada; logo tidak boleh diputar, diregangkan, atau dimiringkan");
    });
    var lebar = o.lebar, tinggi = o.tinggi;
    if (typeof lebar !== "number" || !(lebar > 0) || typeof tinggi !== "number" || !(tinggi > 0)) {
      throw new Error("logo: ukuran frame wajib (opsi.lebar dan opsi.tinggi, atau opsi.ctx)");
    }
    var pilih = id;
    if (o.latar != null && o.varian) {
      var terang = kontras(o.latar, "#000000") >= kontras(o.latar, "#ffffff");
      var v = terang ? o.varian.diLatarTerang : o.varian.diLatarGelap;
      if (typeof v === "string") pilih = v;
    }
    var e = entriAset(pilih, o, "logo", ["logo"]);
    var t = teksAlternatifAset(e, pilih, o, "logo");
    var rasio = rasioAset(e, pilih, "logo");
    var aturan = (e.merek && e.merek.aturan) || {};
    var ukuran = o.ukuran == null ? UKURAN_LOGO_PERSEN : o.ukuran;
    if (typeof ukuran !== "number" || !(ukuran > 0 && ukuran <= 100)) throw new Error("logo: ukuran harus persen lebar frame (0..100]");
    var w = Math.round(lebar * ukuran / 100);
    var h = Math.max(1, Math.round(w / rasio));
    if (aturan.ukuranMinPx > 0 && w < aturan.ukuranMinPx) {
      throw new Error('logo: "' + pilih + '" selebar ' + w + " px, di bawah ukuran minimum pedoman merek (" +
        aturan.ukuranMinPx + " px); naikkan opsi.ukuran");
    }
    var opacity = o.opacity == null ? 1 : o.opacity;
    if (typeof opacity !== "number" || !(opacity > 0 && opacity <= 1)) throw new Error("logo: opacity harus di (0, 1]");
    if (opacity < 1 && aturan.larangan && aturan.larangan.indexOf("transparansi") >= 0) {
      throw new Error('logo: pedoman merek "' + pilih + '" melarang transparansi (merek.aturan.larangan)');
    }
    if (o.latar != null && aturan.warnaDiizinkan && aturan.warnaDiizinkan.length) {
      var terbaik = 0;
      aturan.warnaDiizinkan.forEach(function (c) { terbaik = Math.max(terbaik, kontras(c, o.latar)); });
      if (terbaik < KONTRAS_LOGO_MIN) {
        throw new Error('logo: "' + pilih + '" berkontras ' + terbaik.toFixed(2) + ":1 terhadap latar, di bawah " +
          KONTRAS_LOGO_MIN + ":1 (WCAG 2.2 SC 1.4.11); pakai varian lain (opsi.varian)");
      }
    }
    var cs = 0;
    if (aturan.clearSpace && aturan.clearSpace.nilai > 0) {
      cs = Math.ceil(aturan.clearSpace.nilai * (aturan.clearSpace.satuan === "lebar" ? w : h));
    }
    var A = areaAman(lebar, tinggi).grafis;
    if (w + 2 * cs > A.w || h + 2 * cs > A.h) {
      throw new Error('logo: "' + pilih + '" ' + w + "x" + h + " px dengan clear space " + cs + " px tidak muat di area aman grafis " +
        A.w + "x" + A.h + " px; kecilkan opsi.ukuran");
    }
    var x, y;
    if (posisi === "tengah") {
      x = A.x + Math.round((A.w - w) / 2);
      y = A.y + Math.round((A.h - h) / 2);
    } else {
      x = posisi.indexOf("kiri") === 0 ? A.x + cs : A.x + A.w - cs - w;
      y = posisi.slice(-4) === "atas" ? A.y + cs : A.y + A.h - cs - h;
    }
    return {
      id: pilih, jenis: "logo", url: urlAset(e, pilih, o.akar, "logo"), x: x, y: y, w: w, h: h,
      opacity: opacity, alt: t.alt, dekoratif: t.dekoratif, rasio: rasio, posisi: posisi,
      clearSpace: cs, fit: "contain", ukuranMinPx: aturan.ukuranMinPx > 0 ? aturan.ukuranMinPx : null,
    };
  }

  // ikon(id, { props|ctx, ukuran = 24, warna, akar, teksAlternatif })
  //   -> { id, jenis, url, w, h, alt, dekoratif, rasio, filter, fit: "contain" }
  // `ukuran` = sisi terpanjang (px); sisi lain mengikuti rasio. Dimuat lewat <img>
  // (pasangGambar), tanpa SVG inline. `warna` hanya "putih" atau "hitam" (filter CSS
  // brightness/invert pada <img>); warna lain tidak disediakan karena butuh SVG inline atau
  // CSS mask: pakai berkas ikon yang sudah berwarna itu (keputusan desain).
  function ikon(id, opsi) {
    var o = gabungCtx(opsi);
    var e = entriAset(id, o, "ikon", ["ikon"]);
    var t = teksAlternatifAset(e, id, o, "ikon");
    var rasio = rasioAset(e, id, "ikon");
    var ukuran = o.ukuran == null ? 24 : o.ukuran;
    if (typeof ukuran !== "number" || !(ukuran > 0)) throw new Error("ikon: ukuran harus angka positif (px)");
    var w = rasio >= 1 ? ukuran : Math.max(1, Math.round(ukuran * rasio));
    var h = rasio >= 1 ? Math.max(1, Math.round(ukuran / rasio)) : ukuran;
    var filter = null;
    if (o.warna != null) {
      if (o.warna === "putih") filter = "brightness(0) invert(1)";
      else if (o.warna === "hitam") filter = "brightness(0)";
      else throw new Error('ikon: warna harus "putih" atau "hitam" (dapat ' + JSON.stringify(o.warna) + ")");
    }
    return {
      id: id, jenis: "ikon", url: urlAset(e, id, o.akar, "ikon"), w: w, h: h, alt: t.alt,
      dekoratif: t.dekoratif, rasio: rasio, filter: filter, fit: "contain",
    };
  }

  // Nama lisensi untuk kredit aset: sama dengan aset-lib (namaLisensi + milik sendiri/izin tertulis).
  function namaLisensiAsetRt(kode) {
    kode = String(kode == null ? "" : kode);
    if (kode === "MILIK-SENDIRI") return "Milik sendiri";
    if (kode.indexOf("IZIN-TERTULIS:") === 0) return "Izin tertulis " + kode.slice(14);
    return namaLisensi(kode);
  }

  function kreditAsetRingkas(a) {
    var t = "";
    if (!a.tanpaJudul && a.judul) t = '"' + a.judul + '"';
    if (!a.penciptaAnonim && a.pencipta) t += (t ? " oleh " : "") + a.pencipta;
    var perubahan = String(a.perubahan == null ? "" : a.perubahan).replace(/[.\s]+$/, "");
    var p = [];
    if (t) p.push(t);
    p.push(namaLisensiAsetRt(a.lisensi));
    if (perubahan && !/^tidak ada/i.test(perubahan)) p.push("diubah");
    return p.join(" · ");
  }

  // Cadangan bila entri tidak membawa atribusi.kredit; format sama dengan aset-lib (uji menjaganya).
  function kreditAsetLengkap(a) {
    var t = "";
    if (!a.tanpaJudul && a.judul) t = '"' + a.judul + '"';
    if (!a.penciptaAnonim && a.pencipta) t += (t ? " oleh " : "") + a.pencipta;
    var perubahan = String(a.perubahan == null ? "" : a.perubahan).replace(/[.\s]+$/, "");
    var b = [];
    if (t) b.push(t);
    if (a.sumberUrl) b.push("Sumber: " + a.sumberUrl);
    b.push("Lisensi: " + namaLisensiAsetRt(a.lisensi) + (a.urlLisensi ? " (" + a.urlLisensi + ")" : ""));
    if (perubahan && !/^tidak ada$/i.test(perubahan)) b.push("Diubah: " + perubahan);
    return b.join(". ") + ".";
  }

  // kreditAset(ids, { props|ctx, ringkas = true, tampil }) -> teks, satu baris per aset ("\n")
  // ids: "semua" (aset yang atribusi.tampil-nya "layar" atau "akhir", urutan manifest; `tampil`
  // menyaring salah satunya), satu id, atau array id (urutan array = urutan baris, id ganda
  // dibuang; untuk kredit akhir urut kemunculan, beri array berurut). Id tak ada = galat.
  // ringkas:true (layar): "Judul" oleh Pencipta · CC BY 4.0 · diubah.
  // ringkas:false (kredit akhir): atribusi.kredit dari manifest apa adanya, sama dengan baris
  // di atribusi.txt. Hasil kosong ("") bila tidak ada aset yang perlu dikreditkan.
  function kreditAset(ids, opsi) {
    var o = gabungCtx(opsi);
    var peta = petaAset(o, "kreditAset");
    var ringkas = !o || o.ringkas !== false;
    var daftar;
    if (ids === "semua") {
      daftar = Object.keys(peta).filter(function (k) {
        var tp = peta[k] && peta[k].atribusi && peta[k].atribusi.tampil;
        return o.tampil ? tp === o.tampil : (tp === "layar" || tp === "akhir");
      });
    } else if (typeof ids === "string") daftar = [ids];
    else if (Array.isArray(ids)) daftar = ids;
    else throw new Error('kreditAset: ids harus "semua", satu id, atau array id');
    var terlihat = {}, baris = [];
    daftar.forEach(function (id) {
      if (terlihat[id]) return;
      terlihat[id] = true;
      var e = entriAset(id, o, "kreditAset");
      var a = e.atribusi;
      if (!a || typeof a !== "object") throw new Error('kreditAset: aset "' + id + '" tanpa atribusi di aset-props');
      baris.push(ringkas ? kreditAsetRingkas(a)
        : (typeof a.kredit === "string" && a.kredit !== "" ? a.kredit : kreditAsetLengkap(a)));
    });
    return baris.join("\n");
  }

  // pasangFont(ids, { props|ctx, akar }) -> Promise<string[]> (famili yang termuat)
  // Mendaftarkan font aset (jenis font) lewat FontFace + document.fonts dan menunggu face.load();
  // melempar bila font gagal dimuat (bukan font cadangan diam-diam). Aman dipanggil di tiap
  // render (idempoten per famili/bobot/gaya/url). ids: "semua", satu id, atau array id. Alternatif
  // statis: muat font-face.css dari `aset periksa` lewat <link rel="stylesheet">.
  var fontTerpasang = {};
  function pasangFont(ids, opsi) {
    var o = gabungCtx(opsi), daftar, tugas = [];
    try {
      var peta = petaAset(o, "pasangFont");
      if (ids === "semua") {
        daftar = Object.keys(peta).filter(function (k) { return peta[k] && peta[k].jenis === "font"; });
      } else if (typeof ids === "string") daftar = [ids];
      else if (Array.isArray(ids)) daftar = ids;
      else throw new Error('pasangFont: ids harus "semua", satu id, atau array id');
      if (!g.FontFace || typeof document === "undefined" || !document.fonts) {
        throw new Error("pasangFont: FontFace/document.fonts tidak tersedia (dijalankan di luar browser)");
      }
      daftar.forEach(function (id) {
        var e = entriAset(id, o, "pasangFont", ["font"]);
        var f = e.font;
        if (!f || typeof f.famili !== "string" || f.famili === "" || !FORMAT_FONT[f.format]) {
          throw new Error('pasangFont: aset "' + id + '" tanpa font.famili dan font.format (woff2, woff, ttf, otf) di aset-props');
        }
        var url = urlAset(e, id, o.akar, "pasangFont");
        var bobot = f.bobot == null ? 400 : f.bobot, gaya = f.gaya || "normal";
        var kunci = [f.famili, bobot, gaya, url].join("|");
        if (!fontTerpasang[kunci]) {
          var muka = new g.FontFace(f.famili, 'url("' + url + '") format("' + FORMAT_FONT[f.format] + '")',
            { weight: String(bobot), style: gaya, display: "block" });
          document.fonts.add(muka);
          fontTerpasang[kunci] = Promise.resolve(muka.load()).then(function () { return f.famili; }, function () {
            delete fontTerpasang[kunci];
            if (typeof document.fonts.delete === "function") document.fonts.delete(muka);
            throw new Error('pasangFont: font gagal dimuat: "' + f.famili + '" (' + url + ")");
          });
        }
        tugas.push(fontTerpasang[kunci]);
      });
    } catch (err) { return Promise.reject(err); }
    return Promise.all(tugas);
  }

  // ------------------------------------------------------------ format id-ID
  // Format angka Indonesia ditulis manual (bukan Intl) agar hasil sama di semua mesin
  // dan versi mesin JS: pemisah ribuan titik, desimal koma. Pembulatan setengah naik
  // (menjauhi nol) pada representasi desimal terpendek angka, jadi 1.005 -> "1,01".
  function bulatDesimal(abs, d) {
    if (abs >= 1e21) throw new Error("angka: nilai terlalu besar");
    var s = String(abs), r;
    if (/e/i.test(s)) return abs.toFixed(d);
    r = Math.round(Number(s + "e" + d));
    if (!(r <= 9007199254740991)) return abs.toFixed(d);
    var rs = String(r);
    while (rs.length < d + 1) rs = "0" + rs;
    return d > 0 ? rs.slice(0, rs.length - d) + "." + rs.slice(rs.length - d) : rs;
  }
  function formatId(n, desimal, maks, nama) {
    if (typeof n !== "number" || !isFinite(n)) throw new Error(nama + ": n harus bilangan hingga");
    var tetap = desimal != null;
    var d = tetap ? desimal : maks;
    if (typeof d !== "number" || d % 1 !== 0 || d < 0 || d > 20) {
      throw new Error(nama + ": desimal harus bilangan bulat 0..20");
    }
    var s = bulatDesimal(Math.abs(n), d).split(".");
    var bulat = s[0], pecah = s[1] || "";
    if (!tetap) pecah = pecah.replace(/0+$/, "");
    var neg = n < 0 && /[1-9]/.test(bulat + pecah);
    bulat = bulat.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return (neg ? "-" : "") + bulat + (pecah ? "," + pecah : "");
  }
  // angka(1234567.891) = "1.234.567,891"; tanpa desimal: sampai 3 desimal tanpa nol berekor.
  // desimal:2 -> tepat 2 desimal ("1.234,50").
  function angka(n, opsi) {
    return formatId(n, opsi && opsi.desimal, 3, "angka");
  }
  // n pecahan: persen(0.256) = "25,6%" (tanpa spasi). Aturan desimal seperti angka.
  function persen(n, opsi) {
    if (typeof n !== "number" || !isFinite(n)) throw new Error("persen: n harus bilangan hingga");
    return formatId(Number((n * 100).toPrecision(15)), opsi && opsi.desimal, 3, "persen") + "%";
  }
  // rupiah(1500000) = "Rp1.500.000" (tanpa spasi setelah Rp, sesuai EYD; sumber sekunder,
  // dokumen EYD Edisi V belum dibaca langsung). Negatif: "-Rp1.000". desimal bawaan 0.
  function rupiah(n, opsi) {
    var s = formatId(n, opsi && opsi.desimal != null ? opsi.desimal : 0, 0, "rupiah");
    return s.charAt(0) === "-" ? "-Rp" + s.slice(1) : "Rp" + s;
  }

  // ---------------------------------------------------------------- kenBurns
  // Pan dan zoom foto diam sebagai nilai CSS transform. x,y = titik pusat tampilan
  // (0..1 dari lebar/tinggi gambar; 0.5 = tengah); skala >= 1. Kedua ujung diinterpolasi
  // sepanjang [mulai, mulai + durasi] dengan easing (bawaan linear); sebelum mulai =
  // `dari`, sesudah selesai = `ke`. Pusat dijepit agar tepi gambar tidak terbuka.
  // Pakai pada elemen di dalam wadah overflow:hidden, transform-origin bawaan (tengah).
  // Murni dari frame. Gaya estetika: tidak ditemukan bukti eksperimen bahwa efek ini
  // memengaruhi pemahaman atau atensi; parameter (zoom 1,0 -> 1,1..1,3) adalah praktik.
  function kenBurns(frame, opsi) {
    opsi = opsi || {};
    var mulai = opsi.mulai == null ? 0 : opsi.mulai;
    var dari = opsi.dari || {}, ke = opsi.ke || {};
    var d0 = { x: dari.x == null ? 0.5 : dari.x, y: dari.y == null ? 0.5 : dari.y, skala: dari.skala == null ? 1 : dari.skala };
    var d1 = { x: ke.x == null ? 0.5 : ke.x, y: ke.y == null ? 0.5 : ke.y, skala: ke.skala == null ? 1.2 : ke.skala };
    cekPositif("kenBurns", "durasi", opsi.durasi);
    [d0, d1].forEach(function (p) {
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.skala) || p.skala < 1) {
        throw new Error("kenBurns: x, y harus angka dan skala >= 1");
      }
    });
    var p = interpolasi(frame, [mulai, mulai + opsi.durasi], [0, 1], { easing: opsi.easing });
    var s = d0.skala + (d1.skala - d0.skala) * p;
    var jepit = function (c) { return clampNum(c, 0.5 / s, 1 - 0.5 / s); };
    var x = jepit(d0.x + (d1.x - d0.x) * p);
    var y = jepit(d0.y + (d1.y - d0.y) * p);
    var f = function (v, n) { return v.toFixed(n).replace(/^-(0\.0+)$/, "$1"); };
    return "translate(" + f((0.5 - x) * s * 100, 4) + "%, " + f((0.5 - y) * s * 100, 4) + "%) scale(" + f(s, 6) + ")";
  }

  // ------------------------------------------------------------ preset jenis
  // Preset jenis video untuk komposisi. Runtime berjalan di browser tanpa fetch berkas
  // data, jadi datanya dimuat lewat <script src=".../preset-jenis.js"> (dihasilkan dari
  // data/jenis-video.json oleh `bun run konsep -- sinkron-preset`; global
  // PRESET_JENIS_DATA). Mengembalikan salinan dalam (mengubahnya tidak memengaruhi
  // pemanggilan berikutnya), ditambah `kunci`. Murni: tanpa Date/Math.random/timer.
  function presetJenis(nama) {
    var data = g.PRESET_JENIS_DATA;
    if (!data || !data.jenis) {
      throw new Error("presetJenis: muat scripts/preset-jenis.js lebih dulu (<script src=\".../preset-jenis.js\">)");
    }
    if (typeof nama !== "string" || !Object.prototype.hasOwnProperty.call(data.jenis, nama)) {
      throw new Error("presetJenis: jenis tidak dikenal '" + nama + "'; pilihan: " + Object.keys(data.jenis).join(", "));
    }
    var salinan = JSON.parse(JSON.stringify(data.jenis[nama]));
    salinan.kunci = nama;
    return salinan;
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
    ms: ms,
    durasi: durasi,
    berjenjang: berjenjang,
    areaAman: areaAman,
    luminansRelatif: luminansRelatif,
    kontras: kontras,
    pilihTeksKontras: pilihTeksKontras,
    paletOkabeIto: paletOkabeIto,
    simulasiButaWarna: simulasiButaWarna,
    keLab: keLab,
    bedaLab: bedaLab,
    bedaWarna: bedaWarna,
    periksaPalet: periksaPalet,
    ukuranTeks: ukuranTeks,
    durasiBaca: durasiBaca,
    pecahBaris: pecahBaris,
    captionAktif: captionAktif,
    parseVtt: parseVtt,
    parseSrt: parseSrt,
    gambarKosong: gambarKosong,
    indeksFrameKlip: indeksFrameKlip,
    jalurFrameKlip: jalurFrameKlip,
    klipGambar: klipGambar,
    kreditKlip: kreditKlip,
    asetGambar: asetGambar,
    pasangGambar: pasangGambar,
    logo: logo,
    ikon: ikon,
    kreditAset: kreditAset,
    pasangFont: pasangFont,
    angka: angka,
    persen: persen,
    rupiah: rupiah,
    kenBurns: kenBurns,
    presetJenis: presetJenis,
  };
  g.VideoTerprogram = api;
  Object.keys(api).forEach(function (k) { g[k] = api[k]; });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
