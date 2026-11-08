/**
 * awvd / penyunting.js — halaman penyunting pratinjau (tampilan #54, penyuntingan dan ekspor #55; docs/penyunting.md).
 *
 * Dua bagian:
 *   1. Logika murni tanpa DOM (jepit, format waktu, tata sublajur, pointer JSON -> butir, langkah tik,
 *      navigasi grid): diekspor lewat `module.exports` agar bisa diuji di Bun (scripts/uji-penyunting.mjs).
 *   2. UI: scrubber, daftar track (role="grid"), panel properti dan masalah, serta iframe komposisi.
 *
 * Penyuntingan: operasi (pindah, ubah durasi, potong) dan riwayat urungkan ada di model.js (murni); halaman
 * hanya memanggilnya, menyimpan timeline kerja, lalu mengirimnya PENUH ke server (`POST /api/periksa` setelah
 * jeda 250 ms, satu permintaan pada satu waktu; server menjawab hasil validator dan menyimpan salinan kerja yang
 * dirender iframe, sehingga iframe dimuat ulang setelah jawaban terbaru). Ekspor (`POST /api/ekspor`) hanya aktif
 * dan hanya diterima server bila validator lolos; jalur keluaran tidak pernah dikirim dari sini. Semua operasi punya
 * jalur tanpa seret (kolom angka, tombol, papan ketik; SC 2.5.7); pintasan satu karakter (S) hanya di widget track
 * dan pintasan global memakai Ctrl (SC 2.1.4). Seret dengan penunjuk hanya tambahan: satu seretan = satu langkah.
 *
 * Frame TIDAK digambar di sini. Iframe memuat templat `templates/timeline/index.html` apa adanya dan
 * halaman hanya memanggil `iframe.contentWindow.video.renderFrame(n)` (protokol yang sama dengan render.mjs),
 * lalu menunggu font seperti `ambil` di render-sesi.mjs. Permintaan yang menumpuk saat menggeser digabung:
 * hanya yang terbaru dijalankan. `requestAnimationFrame` dan `performance.now` dipakai HANYA untuk
 * pemutaran di kerangka halaman ini (sama dengan pasangPratinjau di runtime.js), bukan di komposisi.
 * Tanpa CSS animation/transition. Semua teks dari timeline dipasang lewat textContent.
 * Karya asli repo ini.
 */
(function (akar) {
  "use strict";

  // =================================================================== logika murni
  function angka(v, bawaan) { return typeof v === "number" && isFinite(v) ? v : bawaan; }
  function jepit(n, min, max) {
    n = Math.round(Number(n));
    if (!isFinite(n)) n = min;
    return n < min ? min : n > max ? max : n;
  }
  function koma(x, d) { return x.toFixed(d).replace(".", ","); }
  function detikTeks(n, fps) { return koma(n / fps, 2); }
  function nilaiTeks(n, fps) { return "frame " + n + ", " + detikTeks(n, fps) + " detik"; }

  /** "/track/3/butir/1/..." -> { track: 3, butir: 1 }; "/track/3" -> { track: 3, butir: null }; selain itu null. */
  function bacaPointer(lok) {
    var m = /^\/track\/(\d+)(?:\/butir\/(\d+))?(?:\/|$)/.exec(String(lok == null ? "" : lok));
    if (!m) return null;
    return { track: Number(m[1]), butir: m[2] === undefined ? null : Number(m[2]) };
  }

  /** Menempatkan butir (urutan waktu) ke sublajur pertama yang kosong; daftar = [{ mulai, akhir }] (satuan bebas: frame atau piksel, asal seragam). */
  function aturSublajur(daftar) {
    var akhirLajur = [], lajur = [];
    var urut = daftar.map(function (_, i) { return i; }).sort(function (a, b) { return daftar[a].mulai - daftar[b].mulai || a - b; });
    urut.forEach(function (i) {
      var k = 0;
      while (k < akhirLajur.length && akhirLajur[k] > daftar[i].mulai) k++;
      if (k === akhirLajur.length) akhirLajur.push(0);
      akhirLajur[k] = daftar[i].akhir;
      lajur[i] = k;
    });
    return { lajur: lajur, jumlah: Math.max(1, akhirLajur.length) };
  }

  /** Langkah tik penggaris (frame) agar jarak antartik >= minPx. */
  function langkahTik(ppf, fps, minPx) {
    var kandidat = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (var i = 0; i < kandidat.length; i++) {
      var f = Math.max(1, Math.round(kandidat[i] * fps));
      if (f * ppf >= (minPx || 70)) return f;
    }
    return Math.round(3600 * fps);
  }

  function namaButir(b, trackJenis) {
    var s = b.id + ", " + b.jenis + ", mulai frame " + b.mulai + ", durasi " + b.durasi + " frame";
    if (b.transisi && b.transisi.jenis) s += ", bertransisi " + b.transisi.jenis + (b.transisi.durasi !== undefined ? " " + b.transisi.durasi + " frame" : "");
    return s + (trackJenis ? ", track " + trackJenis : "");
  }

  /**
   * Butir tetangga untuk tombol navigasi grid (tanpa mode sunting).
   * model = { urut: number[][], mulai: number[][] } (urut = indeks butir menurut waktu per track);
   * indeks track lebih besar = lapisan atas = tampil di atas. Mengembalikan pos bila tak ada tujuan.
   */
  function tetangga(model, pos, tombol) {
    var u = model.urut[pos.t], i = u.indexOf(pos.b);
    if (tombol === "ArrowLeft") return i > 0 ? { t: pos.t, b: u[i - 1] } : pos;
    if (tombol === "ArrowRight") return i >= 0 && i < u.length - 1 ? { t: pos.t, b: u[i + 1] } : pos;
    if (tombol === "Home") return { t: pos.t, b: u[0] };
    if (tombol === "End") return { t: pos.t, b: u[u.length - 1] };
    if (tombol === "ArrowUp" || tombol === "ArrowDown") {
      var arah = tombol === "ArrowUp" ? 1 : -1, ref = model.mulai[pos.t][pos.b];
      for (var t = pos.t + arah; t >= 0 && t < model.urut.length; t += arah) {
        if (!model.urut[t].length) continue;
        var terbaik = null, jarak = Infinity;
        model.urut[t].forEach(function (b) {
          var d = Math.abs(model.mulai[t][b] - ref);
          if (d < jarak) { jarak = d; terbaik = b; }
        });
        return { t: t, b: terbaik };
      }
    }
    return pos;
  }

  /** Normalisasi defensif timeline apa pun (termasuk yang ditolak validator) menjadi bentuk yang aman digambar. */
  function normalisasi(t) {
    var P = t && typeof t.proyek === "object" && t.proyek ? t.proyek : {};
    var tracks = (t && Array.isArray(t.track) ? t.track : []).map(function (tr, i) {
      var raw = tr && typeof tr === "object" ? tr : {};
      var butir = [];
      (Array.isArray(raw.butir) ? raw.butir : []).forEach(function (b, j) {
        if (!b || typeof b !== "object") return;
        var mulai = Math.max(0, Math.round(angka(b.mulai, 0))), durasi = Math.max(1, Math.round(angka(b.durasi, 1)));
        butir.push({
          b: j, raw: b, id: typeof b.id === "string" ? b.id : "(tanpa id)", jenis: typeof b.jenis === "string" ? b.jenis : "?",
          mulai: mulai, durasi: durasi, akhir: mulai + durasi,
          transisi: b.transisi && typeof b.transisi === "object" ? b.transisi : null,
        });
      });
      return { t: i, raw: raw, id: typeof raw.id === "string" ? raw.id : "(tanpa id)", jenis: typeof raw.jenis === "string" ? raw.jenis : "?",
        nama: typeof raw.nama === "string" ? raw.nama : "", aktif: raw.aktif !== false, butir: butir };
    });
    var akhirMaks = 1;
    tracks.forEach(function (tr) { tr.butir.forEach(function (b) { if (b.akhir > akhirMaks) akhirMaks = b.akhir; }); });
    var fps = Math.round(angka(P.fps, 30)); if (fps < 1) fps = 30;
    var durasi = Math.round(angka(P.durasi, akhirMaks)); if (durasi < 1) durasi = akhirMaks;
    var penanda = (t && Array.isArray(t.penanda) ? t.penanda : []).filter(function (p) {
      return p && typeof p === "object" && Number.isInteger(p.pada) && p.pada >= 0 && typeof p.label === "string";
    });
    return {
      lebar: Math.round(angka(P.lebar, 1280)) || 1280, tinggi: Math.round(angka(P.tinggi, 720)) || 720,
      fps: fps, durasi: durasi, track: tracks, penanda: penanda, judul: typeof P.judul === "string" ? P.judul : "",
    };
  }

  var api = { jepit: jepit, koma: koma, detikTeks: detikTeks, nilaiTeks: nilaiTeks, bacaPointer: bacaPointer, aturSublajur: aturSublajur,
    langkahTik: langkahTik, namaButir: namaButir, tetangga: tetangga, normalisasi: normalisasi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;
  akar.Penyunting = api;

  // =================================================================== UI
  var GLIF = { video: "V", gambar: "G", warna: "W", teks: "T", kredit: "K", audio: "A" };
  var TINGGI_BARIS = 32;
  var BATAS_MASALAH = 200;
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    berkas: $("berkas"), status: $("status"), iframe: $("komposisi"), bingkai: $("bingkai"), gulirPratinjau: $("gulir-pratinjau"),
    galatPratinjau: $("galat-pratinjau"), putar: $("putar"), keAwal: $("ke-awal"), mundur: $("mundur"), maju: $("maju"), keAkhir: $("ke-akhir"),
    angka: $("frame-angka"), waktu: $("waktu"), penanda: $("penanda"), scrubber: $("scrubber"), zumKurang: $("zum-kurang"), zumLebih: $("zum-lebih"),
    zum: $("zum"), gulirTrack: $("gulir-track"), kanvas: $("kanvas"), penggaris: $("penggaris"), grid: $("grid"), playhead: $("playhead"),
    properti: $("isi-properti"), masalah: $("daftar-masalah"), hMasalah: $("h-masalah"),
    urungkan: $("urungkan"), ulangi: $("ulangi"), ekspor: $("ekspor"), eksporKetat: $("ekspor-ketat"), unduh: $("unduh"), alasanEkspor: $("alasan-ekspor"), galatEkspor: $("galat-ekspor"),
    sunting: $("sunting"), modeSunting: $("mode-sunting"), fMulai: $("f-mulai"), fDurasi: $("f-durasi"), fSisi: $("f-sisi"), alasanSisi: $("alasan-sisi"),
    geserMin: $("geser-min"), geserPlus: $("geser-plus"), durasiMin: $("durasi-min"), durasiPlus: $("durasi-plus"), potong: $("potong"), alasanPotong: $("alasan-potong"),
  };
  var token = new URLSearchParams(window.location.search).get("token") || "";
  var S = {
    sesi: null, M: null, frame: 0, pilih: null, zum: 1, ppf: 1, lebarKepala: 140, main: false, f0: 0, t0: 0, kilatSetuju: false,
    sel: new Map(), urut: [], mulaiPer: [], diminta: null, sibuk: false, siap: false, mode: "penuh",
    // penyuntingan: T = timeline kerja, R = riwayat, rev = nomor perubahan (0 = keadaan awal sesi)
    T: null, R: null, valid: null, rev: 0, revValid: 0, revIframe: 0, revEkspor: -1, ekspor: null, sunting: false, sisi: "kanan",
    timer: null, terbang: false, ulang: false, membangun: false, sesiKolom: 0, seret: null, galatBlokir: "", mengekspor: false,
  };

  function umumkan(teks) { el.status.textContent = teks; }
  function tampilGalatPratinjau(teks) { el.galatPratinjau.textContent = teks; el.galatPratinjau.hidden = !teks; }
  function buat(tag, kelas, teks) {
    var e = document.createElement(tag);
    if (kelas) e.className = kelas;
    if (teks !== undefined) e.textContent = teks;
    return e;
  }

  // ----------------------------------------------------------- frame
  function ke(n, opsi) {
    var M = S.M;
    S.frame = jepit(n, 0, M.durasi - 1);
    el.scrubber.value = String(S.frame);
    el.scrubber.setAttribute("aria-valuetext", nilaiTeks(S.frame, M.fps));
    el.angka.value = String(S.frame);
    el.waktu.textContent = "Frame " + S.frame + " / " + (M.durasi - 1) + " (" + detikTeks(S.frame, M.fps) + " s)";
    letakkanPlayhead(opsi && opsi.gulir !== false);
    tampil(S.frame);
    if (S.T) perbaruiPotong();
  }

  function siapkanFont(cw) {
    var fs = cw.document.fonts;
    var tunggu = fs ? Promise.allSettled(Array.from(fs).map(function (f) { return f.load(); })).then(function () { return fs.ready; }) : Promise.resolve();
    return tunggu.then(function () {
      var imgs = Array.from(cw.document.images);
      return Promise.all(imgs.map(function (im) {
        return im.complete ? null : new Promise(function (ok) { im.addEventListener("load", ok, { once: true }); im.addEventListener("error", ok, { once: true }); });
      })).then(function () {
        return Promise.all(imgs.map(function (im) { return im.decode ? im.decode().catch(function () {}) : null; }));
      });
    });
  }

  function renderSatu(n) {
    var cw = el.iframe.contentWindow;
    return cw.video.renderFrame(n).then(function () {
      // jaring pengaman yang sama dengan `ambil` di render-sesi.mjs: face font baru dimuat sebelum frame dianggap tampil
      var fs = cw.document.fonts;
      if (fs && fs.size) {
        var belum = Array.from(fs).filter(function (x) { return x.status === "unloaded" || x.status === "loading"; });
        var p = belum.length ? Promise.allSettled(belum.map(function (x) { return x.load(); })) : Promise.resolve();
        return p.then(function () { return fs.status === "loading" ? fs.ready : null; });
      }
      return null;
    });
  }

  function tampil(n) {
    S.diminta = n;
    if (!S.siap || S.sibuk) return;
    S.sibuk = true;
    (function jalan() {
      if (S.diminta === null) { S.sibuk = false; return; }
      var m = S.diminta;
      S.diminta = null;
      renderSatu(m).then(function () {
        el.iframe.setAttribute("data-frame-tampil", String(m));
        el.iframe.title = "Pratinjau frame " + m;
        tampilGalatPratinjau("");
      }, function (e) {
        tampilGalatPratinjau("Pratinjau frame " + m + " gagal: " + (e && e.message ? e.message : String(e)));
      }).then(jalan);
    })();
  }

  function siapIframe() {
    var cw = el.iframe.contentWindow;
    if (!cw || !cw.video || typeof cw.video.renderFrame !== "function") {
      tampilGalatPratinjau("Pratinjau tidak tersedia: komposisi gagal dimuat (timeline ditolak atau media tidak termuat). Lihat panel masalah.");
      return;
    }
    siapkanFont(cw).catch(function () {}).then(function () {
      S.siap = true;
      el.iframe.setAttribute("data-siap", "1");
      tampil(S.frame);
    });
  }

  function aturTampilan() {
    var M = S.M, skala = 1;
    if (S.mode === "panel") skala = Math.min(1, Math.max(0.05, el.gulirPratinjau.clientWidth / M.lebar));
    el.iframe.style.width = M.lebar + "px";
    el.iframe.style.height = M.tinggi + "px";
    el.iframe.style.transform = skala === 1 ? "none" : "scale(" + skala + ")";
    el.bingkai.style.width = Math.round(M.lebar * skala) + "px";
    el.bingkai.style.height = Math.round(M.tinggi * skala) + "px";
  }

  // ----------------------------------------------------------- pemutaran (hanya kerangka halaman)
  function adaKilatan() {
    return S.valid.peringatan.some(function (w) { return w.kode === "W06"; });
  }
  function berhenti(pesan) {
    S.main = false;
    el.putar.textContent = "Putar";
    if (pesan) umumkan(pesan);
  }
  function tick(now) {
    if (!S.main) return;
    var n = S.f0 + Math.floor(((now - S.t0) / 1000) * S.M.fps);
    if (n >= S.M.durasi - 1) { ke(S.M.durasi - 1); berhenti("Pemutaran selesai di frame " + (S.M.durasi - 1)); return; }
    if (n !== S.frame) ke(n);
    window.requestAnimationFrame(tick);
  }
  function putarJeda() {
    if (S.main) { berhenti("Jeda di frame " + S.frame); return; }
    if (adaKilatan() && !S.kilatSetuju) {
      S.kilatSetuju = true;
      umumkan("Peringatan W06: video berpotensi berkilat (WCAG 2.3.1). Tekan Putar sekali lagi untuk tetap memutar.");
      return;
    }
    if (S.frame >= S.M.durasi - 1) ke(0);
    S.main = true;
    el.putar.textContent = "Jeda";
    S.f0 = S.frame;
    S.t0 = performance.now(); // hanya kerangka penyunting; bukan bagian render()
    window.requestAnimationFrame(tick);
  }

  // ----------------------------------------------------------- track
  function lebarJalur() { return Math.max(1, Math.round(S.M.durasi * S.ppf)); }
  function xFrame(f) { return Math.round(f * S.ppf); }

  function bangunTrack() {
    var M = S.M;
    el.grid.textContent = "";
    S.sel = new Map();
    S.urut = M.track.map(function (tr) {
      return tr.butir.map(function (_, i) { return i; }).sort(function (a, b) { return tr.butir[a].mulai - tr.butir[b].mulai || a - b; }).map(function (i) { return tr.butir[i].b; });
    });
    S.mulaiPer = M.track.map(function (tr) { var p = {}; tr.butir.forEach(function (b) { p[b.b] = b.mulai; }); return p; });
    if (!M.track.length) { el.grid.appendChild(buat("p", "redup", "Timeline tidak memuat track.")); return; }
    for (var t = M.track.length - 1; t >= 0; t--) { // lapisan atas di atas
      var tr = M.track[t];
      var baris = buat("div", "baris"); baris.setAttribute("role", "row"); baris.setAttribute("data-track", String(t));
      var kepala = buat("div", "kepala"); kepala.setAttribute("role", "rowheader");
      kepala.appendChild(document.createTextNode((tr.nama || tr.id) + (tr.aktif ? "" : " (nonaktif)")));
      kepala.appendChild(buat("span", "jenis-track", tr.jenis));
      var jalur = buat("div", "jalur"); jalur.setAttribute("role", "presentation");
      jalur.setAttribute("data-track", String(t));
      tr.butir.forEach(function (b) {
        var c = buat("div", "butir" + (tr.aktif ? "" : " nonaktif"));
        c.setAttribute("role", "gridcell"); c.tabIndex = -1; c.setAttribute("aria-selected", "false");
        c.setAttribute("data-track", String(tr.t)); c.setAttribute("data-butir", String(b.b)); c.setAttribute("data-id", b.id);
        c.setAttribute("data-jenis", b.jenis); c.setAttribute("data-mulai", String(b.mulai)); c.setAttribute("data-durasi", String(b.durasi));
        c.setAttribute("aria-label", namaButir(b));
        var g = buat("span", "glif", GLIF[b.jenis] || "?"); g.setAttribute("aria-hidden", "true");
        c.appendChild(g);
        c.appendChild(buat("span", "", b.id));
        if (b.transisi && Number.isInteger(b.transisi.durasi)) {
          var tp = buat("span", "tumpang"); tp.setAttribute("aria-hidden", "true"); tp.setAttribute("data-durasi", String(b.transisi.durasi));
          c.insertBefore(tp, c.firstChild);
        }
        jalur.appendChild(c);
        S.sel.set(tr.t + "/" + b.b, c);
      });
      baris.appendChild(kepala); baris.appendChild(jalur);
      el.grid.appendChild(baris);
    }
    // satu sel dapat fokus (roving tabindex): butir pertama dari baris paling atas yang tak kosong
    for (var u = M.track.length - 1; u >= 0; u--) {
      if (S.urut[u].length) { S.sel.get(u + "/" + S.urut[u][0]).tabIndex = 0; break; }
    }
  }

  function tataUlang() {
    var M = S.M;
    var kepala = el.grid.querySelector(".kepala");
    S.lebarKepala = kepala ? kepala.offsetWidth : 140;
    var tersedia = Math.max(120, el.gulirTrack.clientWidth - S.lebarKepala - 2);
    S.ppf = (tersedia / M.durasi) * S.zum;
    var w = lebarJalur();
    M.track.forEach(function (tr) {
      var jalur = el.grid.querySelector('.jalur[data-track="' + tr.t + '"]');
      if (!jalur) return;
      // sublajur dihitung dalam piksel dengan lebar tampil (minimum 24 px, SC 2.5.8), bukan dalam frame:
      // butir pendek yang melebar ke 24 px dipisah dari tetangganya, posisi waktu (left) tidak digeser
      var sub = aturSublajur(tr.butir.map(function (b) { var x = xFrame(b.mulai); return { mulai: x, akhir: x + Math.max(24, xFrame(b.durasi)) }; }));
      jalur.style.width = w + "px";
      jalur.style.height = sub.jumlah * TINGGI_BARIS + "px";
      tr.butir.forEach(function (b, i) {
        var c = S.sel.get(tr.t + "/" + b.b);
        c.style.left = xFrame(b.mulai) + "px";
        c.style.width = Math.max(24, xFrame(b.durasi)) + "px";
        c.style.top = sub.lajur[i] * TINGGI_BARIS + "px";
        var tp = c.querySelector(".tumpang");
        if (tp) tp.style.width = Math.max(1, Math.min(xFrame(Number(tp.getAttribute("data-durasi"))), xFrame(b.durasi))) + "px";
      });
    });
    el.kanvas.style.width = S.lebarKepala + w + "px";
    // penggaris
    el.penggaris.textContent = "";
    el.penggaris.style.width = w + "px";
    var langkah = langkahTik(S.ppf, M.fps, 70);
    for (var f = 0; f < M.durasi; f += langkah) {
      var d = f / M.fps;
      var tik = buat("span", "tik", (Math.round(d * 100) / 100) + " s");
      tik.style.left = xFrame(f) + "px";
      el.penggaris.appendChild(tik);
    }
    M.penanda.forEach(function (p) {
      if (p.pada >= M.durasi) return;
      var tanda = buat("span", "tanda"); tanda.setAttribute("data-penanda", p.id);
      tanda.style.left = xFrame(p.pada) + "px";
      el.penggaris.appendChild(tanda);
    });
    el.zum.textContent = Math.round(S.zum * 100) + "%";
    letakkanPlayhead(false);
  }

  function letakkanPlayhead(gulir) {
    var x = S.lebarKepala + xFrame(S.frame);
    el.playhead.style.left = x + "px";
    if (gulir) {
      var g = el.gulirTrack;
      if (x < g.scrollLeft + S.lebarKepala || x > g.scrollLeft + g.clientWidth - 8) g.scrollLeft = Math.max(0, x - g.clientWidth / 2);
    }
  }

  function ubahZum(arah) {
    var baru = Math.min(32, Math.max(1, arah > 0 ? S.zum * 2 : S.zum / 2));
    if (baru === S.zum) { umumkan(arah > 0 ? "Zum sudah maksimum (3200%)" : "Zum sudah minimum (100%)"); return; }
    S.zum = baru;
    tataUlang();
    umumkan("Zum " + Math.round(S.zum * 100) + "%");
  }

  // ----------------------------------------------------------- seleksi dan properti
  function baris(dl, k, v) {
    dl.appendChild(buat("dt", "", k));
    dl.appendChild(buat("dd", "", v));
  }
  function isiProperti() {
    el.properti.textContent = "";
    if (!S.pilih) { el.properti.appendChild(buat("p", "redup", "Pilih butir di daftar track.")); return; }
    var tr = S.M.track[S.pilih.t], b = tr.butir.filter(function (x) { return x.b === S.pilih.b; })[0];
    var dl = buat("dl");
    baris(dl, "Id", b.id);
    baris(dl, "Jenis", b.jenis);
    baris(dl, "Track", (tr.nama || tr.id) + " (" + tr.jenis + ")");
    baris(dl, "Mulai", b.mulai + " frame (" + detikTeks(b.mulai, S.M.fps) + " s)");
    baris(dl, "Durasi", b.durasi + " frame (" + detikTeks(b.durasi, S.M.fps) + " s)");
    baris(dl, "Akhir", b.akhir + " (eksklusif; hanya baca)");
    if (b.transisi) baris(dl, "Transisi", (b.transisi.jenis || "?") + (b.transisi.durasi !== undefined ? " " + b.transisi.durasi + " frame" : ""));
    var r = b.raw;
    if (typeof r.klip === "string") baris(dl, "Klip", r.klip);
    if (typeof r.aset === "string") baris(dl, "Aset", r.aset);
    if (typeof r.warna === "string") baris(dl, "Warna", r.warna);
    if (typeof r.isi === "string") baris(dl, "Isi", r.isi.length > 120 ? r.isi.slice(0, 117) + "..." : r.isi);
    if (!tr.aktif) baris(dl, "Status", "track nonaktif (dilewati render)");
    el.properti.appendChild(dl);
    var sama = daftarMasalah().filter(function (m) { var p = bacaPointer(m.lok); return p && p.track === S.pilih.t && p.butir === S.pilih.b; }).length;
    el.properti.appendChild(buat("p", "redup", "Masalah terkait: " + sama));
    var tombol = buat("button", "", "Ke awal butir");
    tombol.type = "button";
    tombol.addEventListener("click", function () { ke(b.mulai); umumkan("Playhead di awal butir " + b.id + " (frame " + b.mulai + ")"); });
    el.properti.appendChild(tombol);
  }

  function pilihButir(t, b, opsi) {
    var c = S.sel.get(t + "/" + b);
    if (!c) return;
    S.sel.forEach(function (x) {
      x.setAttribute("aria-selected", "false"); x.tabIndex = -1;
      var lama = x.querySelector(".gagang");
      if (lama) lama.remove();
    });
    c.setAttribute("aria-selected", "true");
    c.tabIndex = 0;
    S.pilih = { t: t, b: b };
    var g = document.createElement("span");
    g.className = "gagang"; g.setAttribute("aria-hidden", "true");
    c.appendChild(g);
    if (opsi && opsi.fokus) c.focus();
    isiProperti();
    isiForm();
  }

  function pada(ev) {
    var c = ev.target.closest && ev.target.closest('[role="gridcell"]');
    return c ? { t: Number(c.getAttribute("data-track")), b: Number(c.getAttribute("data-butir")), el: c } : null;
  }
  function pasangGrid() {
    el.grid.addEventListener("click", function (ev) {
      var p = pada(ev);
      if (p) pilihButir(p.t, p.b, { fokus: true });
    });
    el.grid.addEventListener("keydown", function (ev) {
      var p = pada(ev);
      if (!p || ev.ctrlKey || ev.metaKey) return;
      var k = ev.key;
      var kiriKanan = k === "ArrowLeft" || k === "ArrowRight";
      var arah = k === "ArrowRight" ? 1 : -1;
      var langkah = ev.shiftKey ? S.M.fps : 1; // Shift = 1 detik
      if (ev.altKey) {
        if (S.sunting && kiriKanan) { ev.preventDefault(); sesuaikanDurasi(arah * langkah, "kanan"); }
        return;
      }
      if (S.sunting && kiriKanan) { ev.preventDefault(); geserButir(arah * langkah); return; }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].indexOf(k) >= 0) {
        ev.preventDefault();
        var tuju = tetangga({ urut: S.urut, mulai: S.mulaiPer }, { t: p.t, b: p.b }, k);
        pilihButir(tuju.t, tuju.b, { fokus: true });
      } else if (k === "Enter") {
        ev.preventDefault();
        pilihButir(p.t, p.b, { fokus: true });
        var mulai = Number(p.el.getAttribute("data-mulai"));
        ke(mulai);
        masukSunting("Playhead di awal butir " + p.el.getAttribute("data-id") + " (frame " + mulai + "). ");
      } else if (k === "F2") {
        ev.preventDefault();
        pilihButir(p.t, p.b, { fokus: true });
        masukSunting("");
      } else if (k === "Escape" && S.sunting) {
        ev.preventDefault();
        keluarSunting("Keluar dari mode sunting.");
      } else if (k === "s" || k === "S") {
        ev.preventDefault();
        pilihButir(p.t, p.b, { fokus: true });
        potongDiPlayhead();
      }
    });
    el.grid.addEventListener("focusout", function (ev) {
      if (S.membangun || !S.sunting) return;
      if (!ev.relatedTarget || !el.grid.contains(ev.relatedTarget)) keluarSunting("");
    });
    el.grid.addEventListener("pointerdown", mulaiSeret);
    el.grid.addEventListener("pointermove", gerakSeret);
    el.grid.addEventListener("pointerup", akhiriSeret);
    el.grid.addEventListener("pointercancel", batalSeret);
    el.penggaris.addEventListener("click", function (ev) {
      var r = el.penggaris.getBoundingClientRect();
      ke(Math.round((ev.clientX - r.left) / S.ppf));
    });
  }

  // ----------------------------------------------------------- penyuntingan
  var Mod = akar.PenyuntingModel;
  function refPilih() { return S.pilih ? { track: S.pilih.t, butir: S.pilih.b } : null; }
  function butirPilih() {
    if (!S.pilih) return null;
    var tr = S.M.track[S.pilih.t];
    return tr ? tr.butir.filter(function (x) { return x.b === S.pilih.b; })[0] || null : null;
  }
  function masukSunting(awalan) {
    if (!S.pilih) return;
    S.sunting = true;
    el.grid.setAttribute("data-mode-sunting", "1");
    el.modeSunting.hidden = false;
    umumkan(awalan + "Mode sunting butir " + butirPilih().id + ": panah menggeser 1 frame (Shift 1 detik), Alt dan panah mengubah durasi, S memotong, Esc keluar.");
  }
  function keluarSunting(pesan) {
    if (!S.sunting) return;
    S.sunting = false;
    el.grid.removeAttribute("data-mode-sunting");
    el.modeSunting.hidden = true;
    if (pesan) umumkan(pesan);
  }

  /** Menerapkan hasil model: gagal -> umumkan alasan; tanpa perubahan -> umumkan; berubah -> riwayat dan muat ulang. */
  function terapkan(res, opsi) {
    if (!res.ok) { umumkan(res.alasan); return false; }
    if (!res.berubah) { umumkan(res.ringkas); return false; }
    if (S.main) berhenti();
    S.R.terapkan(res.timeline, opsi && opsi.gabung);
    ubahTimeline(res.timeline, res.ref, res.ringkas);
    return true;
  }

  function ubahTimeline(t, pilih, pesan) {
    var fokusGrid = el.grid.contains(document.activeElement);
    var gulirX = el.gulirTrack.scrollLeft, gulirY = el.gulirTrack.scrollTop;
    S.membangun = true;
    S.T = t;
    S.M = normalisasi(t);
    S.rev++;
    cacheMasalah = null;
    bangunTrack();
    tataUlang();
    el.gulirTrack.scrollLeft = gulirX; el.gulirTrack.scrollTop = gulirY;
    if (pilih && S.sel.has(pilih.track + "/" + pilih.butir)) pilihButir(pilih.track, pilih.butir, { fokus: fokusGrid });
    else { S.pilih = null; keluarSunting(""); isiProperti(); isiForm(); }
    S.membangun = false;
    bangunMasalah();
    if (pesan) umumkan(pesan);
    jadwalPeriksa();
  }

  function geserButir(delta) {
    var b = butirPilih();
    if (!b) return;
    terapkan(Mod.pindah(S.T, refPilih(), b.mulai + delta));
  }
  function sesuaikanDurasi(delta, sisi) {
    var b = butirPilih();
    if (!b) return;
    terapkan(Mod.ubahDurasi(S.T, refPilih(), b.durasi + delta, sisi || S.sisi));
  }
  function potongDiPlayhead() {
    if (!S.pilih) { umumkan("Pilih butir di daftar track lebih dulu."); return; }
    var res = Mod.potong(S.T, refPilih(), S.frame);
    if (!res.ok) { umumkan("Tidak dapat memotong: " + res.alasan); return; }
    terapkan(res);
  }

  function urungkan() {
    if (!S.R.bisaUrungkan()) { umumkan("Tidak ada langkah yang dapat diurungkan."); return; }
    if (S.main) berhenti();
    var t = S.R.urungkan();
    ubahTimeline(t, refPilih(), "Diurungkan. Sisa " + S.R.jumlahUrungkan() + " langkah urungkan, " + S.R.jumlahUlangi() + " langkah ulangi.");
  }
  function ulangi() {
    if (!S.R.bisaUlangi()) { umumkan("Tidak ada langkah yang dapat diulangi."); return; }
    if (S.main) berhenti();
    var t = S.R.ulangi();
    ubahTimeline(t, refPilih(), "Diulangi. Sisa " + S.R.jumlahUrungkan() + " langkah urungkan, " + S.R.jumlahUlangi() + " langkah ulangi.");
  }

  // ----- form properti (jalur tanpa seret)
  function isiForm() {
    var b = butirPilih();
    el.sunting.hidden = !b;
    if (!b) { perbaruiTombol(); return; }
    el.fMulai.value = String(b.mulai);
    el.fMulai.max = String(Math.max(0, S.M.durasi - b.durasi));
    el.fDurasi.value = String(b.durasi);
    el.fDurasi.max = String(Math.max(1, S.M.durasi - b.mulai));
    var kiri = Mod.bolehSisiKiri(S.T, refPilih());
    el.fSisi.querySelector('option[value="kiri"]').disabled = !kiri.boleh;
    if (!kiri.boleh && S.sisi === "kiri") S.sisi = "kanan";
    el.fSisi.value = S.sisi;
    el.alasanSisi.hidden = kiri.boleh;
    el.alasanSisi.textContent = kiri.boleh ? "" : "Sisi awal dinonaktifkan: " + kiri.alasan;
    perbaruiPotong();
    perbaruiTombol();
  }
  function perbaruiPotong() {
    var b = butirPilih();
    if (!b) return;
    var p = Mod.bolehPotong(S.T, refPilih(), S.frame);
    el.potong.setAttribute("aria-disabled", p.boleh ? "false" : "true");
    el.alasanPotong.textContent = p.boleh ? "Memotong butir " + b.id + " di frame " + S.frame + " menjadi dua butir." : "Potong dinonaktifkan: " + p.alasan;
  }

  function nilaiKolom(input) {
    var v = input.value.trim();
    if (v === "" || !isFinite(Number(v))) { umumkan("Isi angka frame yang valid."); isiForm(); return null; }
    return Number(v);
  }

  // ----- seret (tambahan; satu seretan = satu langkah, diterapkan saat tombol dilepas)
  function mulaiSeret(ev) {
    var c = ev.target.closest && ev.target.closest(".butir");
    if (!c || ev.button !== 0 || !S.T) return;
    var t = Number(c.getAttribute("data-track")), b = Number(c.getAttribute("data-butir"));
    var mulai = Number(c.getAttribute("data-mulai")), durasi = Number(c.getAttribute("data-durasi"));
    S.seret = { mode: ev.target.closest(".gagang") ? "durasi" : "pindah", x0: ev.clientX, t: t, b: b, mulai: mulai, durasi: durasi, aktif: false, df: 0, el: c, id: ev.pointerId };
    try { c.setPointerCapture(ev.pointerId); } catch (e) { /* tanpa capture */ }
  }
  function gerakSeret(ev) {
    var d = S.seret;
    if (!d || ev.pointerId !== d.id) return;
    var dx = ev.clientX - d.x0;
    if (!d.aktif && Math.abs(dx) < 4) return;
    d.aktif = true;
    d.df = Math.round(dx / S.ppf);
    if (d.mode === "pindah") d.el.style.left = xFrame(jepit(d.mulai + d.df, 0, Math.max(0, S.M.durasi - d.durasi))) + "px";
    else d.el.style.width = Math.max(24, xFrame(jepit(d.durasi + d.df, 1, Math.max(1, S.M.durasi - d.mulai)))) + "px";
  }
  function akhiriSeret(ev) {
    var d = S.seret;
    if (!d || ev.pointerId !== d.id) return;
    S.seret = null;
    try { d.el.releasePointerCapture(ev.pointerId); } catch (e) { /* sudah lepas */ }
    if (!d.aktif) return;
    pilihButir(d.t, d.b, { fokus: true });
    var ref = { track: d.t, butir: d.b };
    var rev = S.rev;
    if (d.mode === "pindah") terapkan(Mod.pindah(S.T, ref, d.mulai + d.df));
    else terapkan(Mod.ubahDurasi(S.T, ref, d.durasi + d.df, "kanan"));
    if (rev === S.rev) tataUlang(); // operasi ditolak atau tanpa perubahan: kembalikan posisi visual
  }
  function batalSeret() {
    if (!S.seret) return;
    S.seret = null;
    tataUlang();
  }

  // ----- periksa dan ekspor
  function kirim(rute, badan) {
    return fetch(rute, { method: "POST", headers: { "Content-Type": "application/json", "X-Awvd-Token": token }, body: JSON.stringify(badan), cache: "no-store" })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); });
  }

  function jadwalPeriksa() {
    if (S.timer !== null) window.clearTimeout(S.timer);
    S.timer = window.setTimeout(kirimPeriksa, 250);
    perbaruiTombol();
  }
  function kirimPeriksa() {
    S.timer = null;
    if (S.terbang) { S.ulang = true; return; }
    S.terbang = true;
    var rev = S.rev;
    kirim("/api/periksa", { timeline: S.T }).then(function (h) {
      S.terbang = false;
      if (h.status !== 200) { umumkan("Pemeriksaan gagal: " + (h.j && h.j.galat ? h.j.galat : "HTTP " + h.status)); return; }
      if (rev === S.rev) {
        S.valid = h.j.validasi; S.revValid = rev; cacheMasalah = null;
        bangunMasalah();
        isiProperti();
        umumkan(ringkasHasil());
        muatUlangIframe(rev);
      }
    }, function (e) {
      S.terbang = false;
      umumkan("Pemeriksaan gagal: " + (e && e.message ? e.message : String(e)));
    }).then(function () {
      // perubahan yang datang selama permintaan berjalan dikirim setelah yang berjalan selesai (urutan tetap)
      if (S.ulang && S.timer === null) { S.ulang = false; kirimPeriksa(); }
      perbaruiTombol();
    });
  }
  function ringkasHasil() {
    var v = S.valid;
    return (v.lolos ? "Lolos validator (" + v.galat.length + " galat, " + v.peringatan.length + " peringatan)"
      : "Ditolak validator: " + v.galat.length + " galat, " + v.peringatan.length + " peringatan") + ".";
  }
  function muatUlangIframe(rev) {
    if (S.revIframe === rev) return;
    S.revIframe = rev; S.siap = false;
    el.iframe.setAttribute("data-siap", "0");
    el.iframe.setAttribute("data-frame-tampil", "");
    el.iframe.setAttribute("data-revisi", String(rev));
    tampilGalatPratinjau("");
    el.iframe.src = "/komposisi.html?r=" + rev;
  }

  function aturTombol(tombol, aktif) { tombol.setAttribute("aria-disabled", aktif ? "false" : "true"); }
  function perbaruiTombol() {
    aturTombol(el.urungkan, S.R.bisaUrungkan());
    aturTombol(el.ulangi, S.R.bisaUlangi());
    var alasan, boleh = false, ketatBoleh = false;
    if (S.revValid !== S.rev || S.timer !== null || S.terbang) alasan = "Memeriksa timeline; ekspor aktif setelah validator selesai.";
    else if (!S.valid.lolos) {
      alasan = "Ekspor dinonaktifkan: validator menemukan " + S.valid.galat.length + " galat (lihat panel Masalah).";
    } else {
      boleh = true;
      ketatBoleh = S.valid.peringatan.length === 0;
      alasan = "Ekspor menulis " + S.ekspor.berkas + (S.ekspor.timpa ? " (menimpa sumber)" : "") + "." +
        (ketatBoleh ? "" : " Ekspor ketat dinonaktifkan: ada " + S.valid.peringatan.length + " peringatan.") +
        (S.revEkspor === S.rev ? " Keadaan ini sudah diekspor." : "");
    }
    aturTombol(el.ekspor, boleh && !S.mengekspor);
    aturTombol(el.eksporKetat, ketatBoleh && !S.mengekspor);
    el.alasanEkspor.textContent = alasan;
    // galat yang memblokir ekspor diumumkan sebagai alert (SC 4.1.3), hanya saat keadaan berubah
    var blokir = !boleh && S.revValid === S.rev && !S.valid.lolos ? alasan : "";
    if (blokir !== S.galatBlokir) { S.galatBlokir = blokir; el.galatEkspor.textContent = blokir; el.galatEkspor.hidden = blokir === ""; }
  }

  function komitKolomAktif() {
    var a = document.activeElement;
    if (a === el.fMulai) kolomMulai();
    else if (a === el.fDurasi) kolomDurasi();
  }
  function eksporSekarang(ketat) {
    komitKolomAktif();
    var tombol = ketat ? el.eksporKetat : el.ekspor;
    if (tombol.getAttribute("aria-disabled") === "true") { umumkan(el.alasanEkspor.textContent); return; }
    var rev = S.rev;
    S.mengekspor = true;
    perbaruiTombol();
    kirim("/api/ekspor", { timeline: S.T, ketat: !!ketat }).then(function (h) {
      S.mengekspor = false;
      if (h.status === 200) {
        S.revEkspor = rev;
        umumkan("Diekspor ke " + h.j.berkas + " (" + h.j.byte + " byte)" + (ketat ? ", ekspor ketat" : "") + (h.j.draf ? "; mode draf: periksa dengan --draf" : "") + (rev !== S.rev ? "; perubahan setelahnya belum diekspor" : "") + ".");
      } else {
        el.galatEkspor.hidden = false;
        el.galatEkspor.textContent = "Ekspor ditolak: " + (h.j && h.j.galat ? h.j.galat : "HTTP " + h.status);
        S.galatBlokir = el.galatEkspor.textContent;
        if (h.j && h.j.validasi && rev === S.rev) { S.valid = h.j.validasi; S.revValid = rev; cacheMasalah = null; bangunMasalah(); }
      }
      perbaruiTombol();
    }, function (e) {
      S.mengekspor = false;
      umumkan("Ekspor gagal: " + (e && e.message ? e.message : String(e)));
      perbaruiTombol();
    });
  }

  /**
   * Unduhan cadangan: teks dari `Mod.serialisasi` (sama dengan yang ditulis server saat ekspor), tanpa lewat server.
   * Tidak diblokir validator; hasil validasi terakhir (atau ketiadaannya) diumumkan sebagai peringatan.
   */
  function unduhCadangan() {
    komitKolomAktif();
    var teks = Mod.serialisasi(S.T);
    var byte = new Blob([teks]).size;
    var nama = (S.ekspor && S.ekspor.unduh) || "timeline.sunting.json";
    var url = URL.createObjectURL(new Blob([teks], { type: "application/json" }));
    var a = document.createElement("a");
    a.href = url; a.download = nama; a.hidden = true;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    var v = S.valid, segar = S.revValid === S.rev && S.timer === null && !S.terbang;
    var pesan = "Cadangan diunduh: " + nama + " (" + byte + " byte). ";
    if (!segar) pesan += "Peringatan: perubahan terakhir belum diperiksa validator; berkas ini belum tentu lolos.";
    else if (!v.lolos) pesan += "Peringatan: timeline ini DITOLAK validator (" + v.galat.length + " galat, lihat panel Masalah); berkas ini tidak akan lolos bun run timeline periksa.";
    else pesan += "Lolos validator (" + v.galat.length + " galat, " + v.peringatan.length + " peringatan).";
    if (byte > 5000000) pesan += " Peringatan: melebihi batas 5 MB yang diterima validator.";
    umumkan(pesan);
  }

  function pasangSunting() {
    var aksi = function (tombol, fn) {
      tombol.addEventListener("click", function () {
        if (tombol.getAttribute("aria-disabled") === "true") {
          umumkan(tombol === el.potong ? el.alasanPotong.textContent : tombol === el.urungkan ? "Tidak ada langkah yang dapat diurungkan." : tombol === el.ulangi ? "Tidak ada langkah yang dapat diulangi." : el.alasanEkspor.textContent);
          return;
        }
        fn();
      });
    };
    aksi(el.urungkan, urungkan);
    aksi(el.ulangi, ulangi);
    aksi(el.ekspor, function () { eksporSekarang(false); });
    aksi(el.eksporKetat, function () { eksporSekarang(true); });
    el.unduh.addEventListener("click", unduhCadangan);
    aksi(el.potong, potongDiPlayhead);
    el.geserMin.addEventListener("click", function () { geserButir(-1); });
    el.geserPlus.addEventListener("click", function () { geserButir(1); });
    el.durasiMin.addEventListener("click", function () { sesuaikanDurasi(-1); });
    el.durasiPlus.addEventListener("click", function () { sesuaikanDurasi(1); });
    el.fSisi.addEventListener("change", function () { S.sisi = el.fSisi.value; umumkan("Durasi diubah dari sisi " + (S.sisi === "kiri" ? "awal (kiri)" : "akhir (kanan)") + "."); });
    // satu rangkaian ketikan atau putaran panah di kolom angka = satu langkah riwayat (digabung selama fokus tetap di kolom)
    [el.fMulai, el.fDurasi].forEach(function (k) {
      k.addEventListener("focus", function () { S.sesiKolom++; });
      k.addEventListener("blur", function () { S.R.putus(); });
    });
    el.fMulai.addEventListener("change", kolomMulai);
    el.fDurasi.addEventListener("change", kolomDurasi);
    document.addEventListener("keydown", function (ev) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || !S.T) return;
      var k = ev.key.toLowerCase();
      var a = ev.target, teks = !!a && (a.tagName === "TEXTAREA" || a.tagName === "SELECT" || (a.tagName === "INPUT" && ["range", "radio", "checkbox", "button"].indexOf(a.type) < 0));
      if (k === "z" && !ev.shiftKey) { if (teks) return; ev.preventDefault(); urungkan(); }
      else if ((k === "z" && ev.shiftKey) || k === "y") { if (teks) return; ev.preventDefault(); ulangi(); }
      else if (k === "s" && !ev.shiftKey) { ev.preventDefault(); eksporSekarang(false); }
    });
  }
  function kolomMulai() {
    var n = nilaiKolom(el.fMulai);
    if (n !== null && S.pilih) terapkan(Mod.pindah(S.T, refPilih(), n), { gabung: "kolom-mulai:" + S.sesiKolom });
    else isiForm();
  }
  function kolomDurasi() {
    var n = nilaiKolom(el.fDurasi);
    if (n !== null && S.pilih) terapkan(Mod.ubahDurasi(S.T, refPilih(), n, S.sisi), { gabung: "kolom-durasi:" + S.sesiKolom + ":" + S.sisi });
    else isiForm();
  }

  // ----------------------------------------------------------- masalah
  var cacheMasalah = null;
  function daftarMasalah() {
    if (cacheMasalah) return cacheMasalah;
    var v = S.valid;
    cacheMasalah = []
      .concat(v.galat.map(function (x) { return { jenis: "galat", kode: x.kode, lok: x.lok, pesan: x.pesan }; }))
      .concat(S.sesi.masalahMuat.map(function (x) { return { jenis: "galat", kode: x.kode, lok: x.lok, pesan: x.pesan }; }))
      .concat(v.peringatan.map(function (x) { return { jenis: "peringatan", kode: x.kode, lok: x.lok, pesan: x.pesan }; }));
    return cacheMasalah;
  }
  function bangunMasalah() {
    var semua = daftarMasalah();
    el.hMasalah.textContent = "Masalah (" + semua.length + ")";
    el.masalah.textContent = "";
    if (!semua.length) { var li0 = buat("li"); li0.appendChild(buat("p", "isi", "Tidak ada galat atau peringatan.")); el.masalah.appendChild(li0); return; }
    semua.slice(0, BATAS_MASALAH).forEach(function (m) {
      var li = buat("li");
      var p = bacaPointer(m.lok);
      var terkait = p && p.butir !== null && S.sel.has(p.track + "/" + p.butir) ? p : null;
      var isi = terkait ? buat("button") : buat("div", "isi");
      if (terkait) isi.type = "button";
      var glif = buat("span", "sev-" + m.jenis, (m.jenis === "galat" ? "✖ galat" : "⚠ peringatan"));
      isi.appendChild(glif);
      isi.appendChild(document.createTextNode(" [" + m.kode + "] " + (m.lok === "" ? "(akar)" : m.lok) + ": " + m.pesan));
      if (terkait) isi.addEventListener("click", function () { pilihButir(terkait.track, terkait.butir, { fokus: true }); });
      li.appendChild(isi);
      el.masalah.appendChild(li);
    });
    if (semua.length > BATAS_MASALAH) { var li = buat("li"); li.appendChild(buat("p", "isi", "... dan " + (semua.length - BATAS_MASALAH) + " masalah lagi (pakai bun run timeline periksa --json untuk semuanya).")); el.masalah.appendChild(li); }
  }

  function ringkasStatus() {
    var v = S.valid, nm = S.sesi.masalahMuat.length;
    var s = v.lolos ? "Lolos validator (" + v.galat.length + " galat, " + v.peringatan.length + " peringatan)"
      : "Ditolak validator: " + v.galat.length + " galat, " + v.peringatan.length + " peringatan";
    if (nm) s += "; " + nm + " masalah muat";
    if (S.sesi.draf) s += "; mode draf";
    return s + ". Pilih butir lalu tekan Enter atau F2 untuk menyunting.";
  }

  // ----------------------------------------------------------- mulai
  function pasangKontrol() {
    var M = S.M;
    el.scrubber.max = String(M.durasi - 1);
    el.angka.max = String(M.durasi - 1);
    M.penanda.slice().sort(function (a, b) { return a.pada - b.pada; }).forEach(function (p) {
      var o = buat("option", "", p.label + " (frame " + p.pada + ")");
      o.value = String(p.pada);
      el.penanda.appendChild(o);
    });
    if (!M.penanda.length) el.penanda.disabled = true;

    el.scrubber.addEventListener("input", function () {
      if (S.main) berhenti();
      ke(Number(el.scrubber.value), { gulir: true });
    });
    el.scrubber.addEventListener("keydown", function (ev) {
      if (ev.key === "PageUp" || ev.key === "PageDown") {
        ev.preventDefault();
        if (S.main) berhenti();
        ke(S.frame + (ev.key === "PageUp" ? 10 : -10));
        // PageUp = naik (maju), PageDown = turun (mundur), sama dengan elemen range natif
      } else if (ev.key === " " || ev.key === "Spacebar") {
        ev.preventDefault();
        putarJeda();
      }
    });
    el.angka.addEventListener("change", function () {
      var mentah = Number(el.angka.value), n = jepit(mentah, 0, M.durasi - 1);
      if (S.main) berhenti();
      ke(n);
      if (!isFinite(mentah) || mentah !== n) umumkan("Frame dijepit ke " + n + " (jangkauan 0.." + (M.durasi - 1) + ")");
    });
    el.putar.addEventListener("click", putarJeda);
    el.keAwal.addEventListener("click", function () { if (S.main) berhenti(); ke(0); });
    el.keAkhir.addEventListener("click", function () { if (S.main) berhenti(); ke(M.durasi - 1); });
    el.mundur.addEventListener("click", function () { if (S.main) berhenti(); ke(S.frame - 1); });
    el.maju.addEventListener("click", function () { if (S.main) berhenti(); ke(S.frame + 1); });
    el.penanda.addEventListener("change", function () {
      if (el.penanda.value === "") return;
      var n = Number(el.penanda.value);
      var label = el.penanda.options[el.penanda.selectedIndex].textContent;
      if (S.main) berhenti();
      ke(n);
      umumkan("Lompat ke penanda " + label);
      el.penanda.value = "";
    });
    el.zumLebih.addEventListener("click", function () { ubahZum(1); });
    el.zumKurang.addEventListener("click", function () { ubahZum(-1); });
    document.querySelectorAll('input[name="tampilan"]').forEach(function (r) {
      r.addEventListener("change", function () { if (r.checked) { S.mode = r.value; aturTampilan(); } });
    });
    pasangGrid();
    pasangSunting();
    if (typeof window.ResizeObserver === "function") {
      var lebarTerakhir = 0;
      new window.ResizeObserver(function () {
        var w = el.gulirTrack.clientWidth;
        if (Math.abs(w - lebarTerakhir) >= 1) { lebarTerakhir = w; tataUlang(); }
        if (S.mode === "panel") aturTampilan();
      }).observe(el.gulirTrack);
    }
  }

  function mulaiHalaman(sesi) {
    S.sesi = sesi;
    S.T = sesi.timeline;
    S.R = Mod.buatRiwayat(S.T);
    S.valid = sesi.validasi;
    S.ekspor = sesi.ekspor;
    S.M = normalisasi(sesi.timeline);
    document.title = (S.M.judul ? S.M.judul + " - " : "") + "Penyunting awvd";
    el.berkas.textContent = sesi.berkas;
    pasangKontrol();
    bangunTrack();
    bangunMasalah();
    aturTampilan();
    tataUlang();
    ke(0, { gulir: false });
    isiForm();
    umumkan(ringkasStatus());
    el.iframe.addEventListener("load", siapIframe);
    el.iframe.setAttribute("data-revisi", "0");
    el.iframe.src = "/komposisi.html?r=0";
  }

  fetch("/api/sesi", { headers: { "X-Awvd-Token": token }, cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(mulaiHalaman)
    .catch(function (e) {
      el.status.setAttribute("role", "alert");
      umumkan("Sesi tidak dapat dimuat (" + e.message + "). Buka ulang URL lengkap (dengan token) yang dicetak di terminal.");
    });
})(typeof window !== "undefined" ? window : globalThis);
