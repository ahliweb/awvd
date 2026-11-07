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
  // membatasi 20 cps (dewasa) / 17 cps (anak); untuk bahasa Indonesia belum ada angka
  // primer, jadi bawaan konservatif 17. Bila opsi.fps diberikan, hasil memuat `frame`.
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
