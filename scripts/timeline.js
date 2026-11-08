/*!
 * timeline.js — penjadwal timeline.json sisi browser untuk awvd (templat templates/timeline).
 *
 * Dimuat komposisi setelah runtime.js dan transisi.js:
 *   <script src=".../scripts/runtime.js"></script>
 *   <script src=".../scripts/transisi.js"></script>
 *   <script src=".../scripts/timeline.js"></script>
 * lalu dipakai lewat window.Timeline. Juga dapat dimuat lewat require() (uji di Bun).
 *
 * Modul ini HANYA menghitung, tanpa menyentuh DOM: semua fungsi murni dari timeline dan nomor
 * frame (tanpa Date.now(), Math.random(), timer, CSS animation/transition). Gerak = fungsi frame,
 * jadi render rentang (--dari), still, dan render ulang menghasilkan keadaan yang sama.
 *
 * Sumber tunggal, tidak ada logika jadwal sendiri:
 *  - pemetaan waktu klip (trim, speed, ramp, reverse, freeze) dihitung runtime.js
 *    (`klipGambar` / `indeksFrameKlip` dengan opsi { waktu, dari, durasi }); modul ini hanya
 *    meneruskan `waktu` dari timeline.json apa adanya (`opsiKlip`);
 *  - transisi antar butir, animasi masuk/keluar/penekanan, dan profil gerak dihitung
 *    transisi.js (`transisi`, `animasi`, `animasiTeks`); tumpang tindih butir sama dengan
 *    `transisi.durasi` (aturan R05 validator scripts/timeline.mjs);
 *  - Ken Burns, ukuran teks, dan atribusi dihitung runtime.js (`kenBurns`, `ukuranTeks`,
 *    `kreditKlip`, `kreditAset`).
 *
 * API (rincian: docs/timeline.md):
 *   rencana(timeline) -> rencana       indeks butir per track, transisi masuk per butir (lawan = butir
 *                                      sebelumnya); melempar galat bila timeline tak sesuai skema 1
 *   keadaan(rencana, frame) -> { frame, butir[], transisi }   butir yang tampil di frame itu beserta
 *                                      gaya lapisan luar (transisi) dan hasil Transisi.transisi
 *   sifat(rencana, butir, lokal) -> { kotak, gaya, unit, kenBurns }   gaya lapisan dalam butir
 *                                      (tata, properti keyframe, animasi)
 *   opsiKlip(butir) -> { waktu, dari, durasi }   opsi untuk klipGambar/indeksFrameKlip
 *   teksKredit(rencana, props) -> string[]       atribusi akhir turunan manifest (klip dan aset)
 *   teksKreditLayar(butir, props) -> string      atribusi ringkas untuk kreditLayar
 *   nilaiProperti(nilai, lokal, bawaan) / lihatEasing(spec)   evaluasi keyframe (bukan jadwal)
 *
 * Bukan lingkup (issue lain): audio (#34), keyframe properti di runtime.js (#35; di sini
 * `nilaiProperti` memilih segmen lalu memanggil `interpolasi` runtime), penanda.
 * Karya asli repo ini.
 */
(function (akar) {
  "use strict";

  function galat(pesan) { throw new Error("timeline.js: " + pesan); }
  var adaObjek = function (v) { return v !== null && typeof v === "object" && !Array.isArray(v); };

  // Ketergantungan dimuat malas: di browser lewat global (urutan <script> bebas selama sebelum
  // render), di Bun/Node lewat require().
  var cacheRT = null, cacheTR = null;
  function RT() {
    if (cacheRT) return cacheRT;
    cacheRT = akar.VideoTerprogram || (typeof require === "function" ? require("./runtime.js") : null);
    if (!cacheRT) galat("muat scripts/runtime.js lebih dulu");
    return cacheRT;
  }
  function TR() {
    if (cacheTR) return cacheTR;
    cacheTR = akar.Transisi || (typeof require === "function" ? require("./transisi.js") : null);
    if (!cacheTR) galat("muat scripts/transisi.js lebih dulu");
    return cacheTR;
  }

  function bulat(n, d) {
    var k = Math.pow(10, d);
    var v = Math.round(n * k) / k;
    return v === 0 ? 0 : v; // hindari -0
  }
  function px(n) { return bulat(n, 2) + "px"; }

  var JENIS_VISUAL = { video: true, overlay: true, teks: true };
  // peran teks -> peran ukuran runtime (sama dengan validator W01)
  var PERAN_UKURAN = { judul: "judul", subjudul: "subjudul", isi: "isi", caption: "caption", keterangan: "keterangan", anotasi: "isi", kredit: "keterangan" };
  var BOBOT_PERAN = { judul: 800, subjudul: 600, isi: 400, caption: 600, keterangan: 400, anotasi: 400, kredit: 400 };

  // Gaya lapisan luar di luar jendela transisi (identitas penuh; sama dengan keadaan bersih transisi.js).
  function identitasLuar(z) {
    return {
      display: "", opacity: 1, transform: "none", transformOrigin: "50% 50%", clipPath: "none",
      filter: "none", maskImage: "none", webkitMaskImage: "none", backfaceVisibility: "visible", zIndex: z,
    };
  }

  // =================================================================== rencana
  /**
   * Membangun rencana dari timeline.json (objek). Tidak memvalidasi seluruh aturan; itu tugas
   * `bun run timeline periksa`. Yang dijaga di sini hanya yang dibutuhkan penjadwal: bentuk dasar,
   * tumpang tindih sama dengan transisi.durasi, dan butir tak bertumpuk tanpa transisi.
   */
  function rencana(t) {
    if (!adaObjek(t) || !adaObjek(t.proyek) || !Array.isArray(t.track)) {
      galat("timeline tidak valid: butuh objek { proyek, track[] } (jalankan bun run timeline periksa)");
    }
    if (t.skema !== 1) galat("skema timeline " + JSON.stringify(t.skema) + " tidak dikenal; hanya skema 1");
    var P = t.proyek;
    ["lebar", "tinggi", "fps", "durasi"].forEach(function (k) {
      if (!(Number.isInteger(P[k]) && P[k] > 0)) galat("proyek." + k + " harus bilangan bulat positif");
    });
    var track = [];
    t.track.forEach(function (tr, i) {
      if (!adaObjek(tr) || !Array.isArray(tr.butir)) galat("track " + i + " tidak valid");
      var butir = tr.butir.map(function (b, j) {
        if (!adaObjek(b) || !Number.isInteger(b.mulai) || !Number.isInteger(b.durasi) || b.durasi < 1) {
          galat("butir " + i + "/" + j + " tidak valid (mulai dan durasi harus bilangan bulat)");
        }
        var c = {}; for (var k in b) c[k] = b[k];
        c.akhir = b.mulai + b.durasi;
        c.urutan = j;
        return c;
      }).sort(function (a, b) { return a.mulai - b.mulai || a.urutan - b.urutan; });
      var jendela = tr.jenis === "video";
      var akhirTerjauh = null; // butir dengan akhir terbesar di antara yang sudah lewat
      butir.forEach(function (b, n) {
        var lawan = akhirTerjauh && akhirTerjauh.akhir > b.mulai ? akhirTerjauh : null;
        var tumpang = lawan ? lawan.akhir - b.mulai : 0;
        if (b.transisi) {
          if (!jendela) galat("butir \"" + b.id + "\": transisi hanya untuk track video");
          if (n === 0 || !lawan) galat("butir \"" + b.id + "\": transisi tanpa butir sebelumnya yang bertumpuk");
          if (tumpang !== b.transisi.durasi) {
            galat("butir \"" + b.id + "\": transisi.durasi (" + b.transisi.durasi + ") harus sama dengan tumpang tindih (" + tumpang + ")");
          }
          b.lawan = lawan.id;
          b.tumpang = tumpang;
        } else if (tumpang > 0) {
          galat("butir \"" + b.id + "\" bertumpuk " + tumpang + " frame dengan \"" + lawan.id + "\" tanpa transisi");
        }
        if (!akhirTerjauh || b.akhir > akhirTerjauh.akhir) akhirTerjauh = b;
      });
      track.push({ id: tr.id, jenis: tr.jenis, indeks: i, aktif: tr.aktif !== false, butir: butir });
    });
    return {
      proyek: {
        lebar: P.lebar, tinggi: P.tinggi, fps: P.fps, durasi: P.durasi,
        jenisVideo: P.jenisVideo, profil: P.profil || "standar", latar: P.latar || "#000000",
      },
      track: track,
    };
  }

  // =================================================================== keadaan per frame
  /**
   * Butir yang tampil di `frame` dan gaya lapisan luarnya. Satu transisi aktif per frame
   * (aturan R06). Hasil: { frame, butir[], transisi }, dengan
   *   butir[i] = { butir, track, lokal, peran: "diam"|"keluar"|"masuk", gayaLuar }
   *   transisi = null | { track, indeksTrack, keluar, masuk, hasil }  (hasil = Transisi.transisi)
   * Urutan butir: indeks track naik (0 paling bawah), lalu waktu mulai.
   */
  function keadaan(r, frame) {
    if (!Number.isInteger(frame) || frame < 0 || frame >= r.proyek.durasi) {
      galat("frame " + frame + " di luar 0.." + (r.proyek.durasi - 1));
    }
    var P = r.proyek, daftar = [], transisi = null;
    r.track.forEach(function (tr) {
      if (!tr.aktif || !JENIS_VISUAL[tr.jenis]) return;
      var tampil = tr.butir.filter(function (b) { return frame >= b.mulai && frame < b.akhir; });
      var pasang = null;
      tr.butir.forEach(function (b) {
        if (!b.transisi || !(frame >= b.mulai && frame < b.mulai + b.tumpang)) return;
        if (transisi || pasang) galat("lebih dari satu transisi aktif di frame " + frame + " (aturan R06 validator)");
        var keluar = tr.butir.filter(function (x) { return x.id === b.lawan; })[0];
        var opsi = {};
        for (var k in b.transisi) opsi[k] = b.transisi[k];
        opsi.mulai = b.mulai; opsi.durasi = b.tumpang;
        opsi.fps = P.fps; opsi.lebar = P.lebar; opsi.tinggi = P.tinggi;
        opsi.profil = P.profil; opsi.jenisVideo = P.jenisVideo;
        // adegan dengan tata (kotak lebih kecil dari bingkai) tidak opak
        opsi.tembus = !!(b.tata || keluar.tata);
        var hasil = TR().transisi(frame, opsi);
        pasang = { track: tr, indeksTrack: tr.indeks, keluar: keluar, masuk: b, hasil: hasil };
      });
      if (pasang) transisi = pasang;
      tampil.forEach(function (b) {
        var peran = "diam", gaya = identitasLuar(1);
        if (pasang && b === pasang.keluar) { peran = "keluar"; gaya = pasang.hasil.keluar; }
        else if (pasang && b === pasang.masuk) { peran = "masuk"; gaya = pasang.hasil.masuk; }
        daftar.push({ butir: b, track: tr, lokal: frame - b.mulai, peran: peran, gayaLuar: gaya });
      });
    });
    return { frame: frame, butir: daftar, transisi: transisi };
  }

  // =================================================================== keyframe properti
  function lihatEasing(spec) {
    var E = RT().easing;
    if (spec == null) return E.linear;
    if (Array.isArray(spec) && spec.length === 4) return E.bezier(spec[0], spec[1], spec[2], spec[3]);
    if (typeof spec === "string" && typeof E[spec] === "function" && spec !== "bezier") return E[spec];
    return galat("easing tidak dikenal: " + JSON.stringify(spec));
  }

  /**
   * Nilai properti pada frame lokal: angka tetap, atau keyframe `[{ pada, nilai, easing? }]`
   * (pada naik tegas; easing = kurva segmen yang dimulai di titik itu; sebelum titik pertama dan
   * sesudah terakhir nilai ditahan). Interpolasinya `interpolasi` runtime.js.
   */
  function nilaiProperti(v, lokal, bawaan) {
    if (v === undefined) return bawaan;
    if (typeof v === "number") return v;
    if (!Array.isArray(v) || v.length < 2) galat("properti harus angka atau keyframe minimal 2 titik");
    if (lokal <= v[0].pada) return v[0].nilai;
    if (lokal >= v[v.length - 1].pada) return v[v.length - 1].nilai;
    var i = 0;
    while (i < v.length - 2 && lokal >= v[i + 1].pada) i++;
    var a = v[i], b = v[i + 1];
    return RT().interpolasi(lokal, [a.pada, b.pada], [a.nilai, b.nilai], { easing: lihatEasing(a.easing) });
  }

  // =================================================================== animasi
  function bersih(gaya) {
    var o = {};
    for (var k in gaya) if (k !== "peringatan") o[k] = gaya[k];
    return o;
  }
  function durasiBawaanAnimasi(jenis, fps) {
    var k = TR().katalog().filter(function (x) { return x.kategori === "animasi" && x.nama === jenis; })[0];
    if (!k) galat("jenis animasi tidak dikenal: " + jenis);
    return Math.max(1, Math.round(k.durMs * fps / 1000));
  }
  function opsiAnimasi(a, fps, profil) {
    var o = { jenis: a.jenis, fps: fps, profil: profil };
    ["durasi", "easing", "arah", "jarak", "intensitas", "stagger"].forEach(function (k) { if (a[k] !== undefined) o[k] = a[k]; });
    return o;
  }

  // =================================================================== sifat butir (lapisan dalam)
  /**
   * Gaya lapisan dalam butir pada frame lokal `lokal` (0 = frame pertama butir):
   *   kotak    { x, y, w, h, fit }  kotak tata (piksel komposisi; bawaan seluruh bingkai, teks
   *            dan kredit memakai area aman grafis)
   *   gaya     CSS objek: left/top/width/height, opacity, transform, filter, clipPath
   *            (tata + properti keyframe + animasi masuk/keluar/penekanan; transform dalam urutan
   *            properti lalu animasi, opacity dikalikan)
   *   unit     untuk teks dengan animasi.masuk.mode: [{ teks, spasi, gaya }] dari animasiTeks
   *            (animasi masuk dipindah ke tiap huruf atau kata), selain itu null
   *   kenBurns nilai CSS transform untuk gambar (null bila bukan gambar atau tanpa kenBurns)
   */
  function sifat(r, b, lokal) {
    var P = r.proyek, fps = P.fps, profil = P.profil, rt = RT(), tr = TR();
    if (!(Number.isInteger(lokal) && lokal >= 0 && lokal < b.durasi)) galat("frame lokal " + lokal + " di luar butir \"" + b.id + "\" (0.." + (b.durasi - 1) + ")");

    var teksJenis = b.jenis === "teks" || b.jenis === "kredit";
    var kotak;
    if (b.tata) {
      kotak = { x: b.tata.x === undefined ? 0 : b.tata.x, y: b.tata.y === undefined ? 0 : b.tata.y,
        w: b.tata.lebar === undefined ? P.lebar : b.tata.lebar, h: b.tata.tinggi === undefined ? P.tinggi : b.tata.tinggi,
        fit: b.tata.fit || "cover" };
    } else if (teksJenis) {
      var A = rt.areaAman(P.lebar, P.tinggi).grafis;
      kotak = { x: A.x, y: A.y, w: A.w, h: A.h, fit: "cover" };
    } else {
      kotak = { x: 0, y: 0, w: P.lebar, h: P.tinggi, fit: "cover" };
    }

    // properti keyframe: translasi, rotasi, skala di sekitar pusat kotak, opasitas
    var pr = b.properti || {};
    var dx = nilaiProperti(pr.x, lokal, 0), dy = nilaiProperti(pr.y, lokal, 0);
    var skala = nilaiProperti(pr.skala, lokal, 1), rot = nilaiProperti(pr.rotasi, lokal, 0);
    var op = nilaiProperti(pr.opasitas, lokal, 1);
    var bagian = [];
    if (dx !== 0 || dy !== 0) bagian.push("translate(" + px(dx) + "," + px(dy) + ")");
    if (rot !== 0) bagian.push("rotate(" + bulat(rot, 3) + "deg)");
    if (skala !== 1) bagian.push("scale(" + bulat(skala, 4) + ")");
    var dasar = {
      opacity: bulat(Math.min(1, Math.max(0, op)), 4),
      transform: bagian.length ? bagian.join(" ") : "none",
    };

    // animasi masuk, keluar, penekanan (transisi.js; profil kurangiGerak ditangani di sana)
    var unit = null, lapis = [dasar];
    var an = b.animasi;
    if (an) {
      if (an.masuk) {
        var om = opsiAnimasi(an.masuk, fps, profil); om.mulai = 0;
        if (teksJenis && an.masuk.mode) {
          om.mode = an.masuk.mode;
          unit = tr.animasiTeks(lokal, b.isi === undefined ? "" : b.isi, om);
        } else lapis.push(bersih(tr.animasi(lokal, om)));
      }
      if (an.keluar) {
        var dk = an.keluar.durasi !== undefined ? an.keluar.durasi : durasiBawaanAnimasi(an.keluar.jenis, fps);
        var ok = opsiAnimasi(an.keluar, fps, profil);
        // keluar = kebalikan fungsi tampak yang sama: masuk dianggap sudah selesai (mulai jauh di
        // belakang), lalu v turun lewat keluarMulai/keluarDurasi (easing keluar dari `easing`).
        delete ok.durasi; delete ok.easing;
        ok.mulai = lokal - 1000000; ok.durasi = dk;
        ok.keluarMulai = b.durasi - dk; ok.keluarDurasi = dk;
        if (an.keluar.easing !== undefined) ok.easingKeluar = an.keluar.easing;
        lapis.push(bersih(tr.animasi(lokal, ok)));
      }
      (an.penekanan || []).forEach(function (pk) {
        var op2 = { jenis: pk.jenis, mulai: pk.mulai, durasi: pk.durasi, fps: fps, profil: profil };
        if (pk.intensitas !== undefined) op2.intensitas = pk.intensitas;
        lapis.push(bersih(tr.animasi(lokal, op2)));
      });
    }
    var gaya = tr.gabungGaya.apply(null, lapis);
    gaya.left = px(kotak.x); gaya.top = px(kotak.y); gaya.width = px(kotak.w); gaya.height = px(kotak.h);
    gaya.transformOrigin = "50% 50%";

    // Ken Burns hanya untuk gambar; profil kurangiGerak menahannya di `dari` (pola kamera mati)
    var kb = null;
    if (b.jenis === "gambar" && b.kenBurns) {
      var k = b.kenBurns;
      kb = rt.kenBurns(lokal, {
        mulai: 0, durasi: b.durasi, dari: k.dari,
        ke: profil === "kurangiGerak" ? k.dari : k.ke,
      });
    }
    return { kotak: kotak, gaya: gaya, unit: unit, kenBurns: kb };
  }

  /** Gaya teks dasar dari butir teks/kredit (ukuran, bobot, warna, rata, latar); font = id aset. */
  function gayaTeks(r, b) {
    var P = r.proyek, rt = RT(), g = b.gaya || {};
    var peran = b.jenis === "kredit" ? "kredit" : b.peran;
    var ukuran = g.ukuran !== undefined ? g.ukuran : rt.ukuranTeks(P.tinggi, PERAN_UKURAN[peran]).px;
    return {
      fontSize: px(ukuran),
      fontWeight: String(g.bobot !== undefined ? g.bobot : BOBOT_PERAN[peran]),
      color: g.warna || "#ffffff",
      background: g.latar || "transparent",
      textAlign: g.rata === "tengah" ? "center" : g.rata === "kanan" ? "right" : "left",
      lineHeight: String(g.tinggiBaris !== undefined ? g.tinggiBaris : 1.25),
      fontId: g.font, // id aset font (bila ada); pemasang memakainya untuk pasangFont dan fontFamily
    };
  }

  // =================================================================== klip
  /**
   * Opsi untuk `klipGambar(target, klip, lokal, opsi)` dan `indeksFrameKlip`: `waktu` dari
   * timeline.json diteruskan apa adanya (runtime.js yang memetakan; `habis` ikut), `dari` = frame
   * klip tempat butir mulai membaca, `durasi` = durasi butir (wajib untuk reverse).
   */
  function opsiKlip(b) {
    if (b.jenis !== "video") galat("opsiKlip: butir \"" + b.id + "\" bukan butir video");
    var w = {};
    if (b.waktu) for (var k in b.waktu) w[k] = b.waktu[k];
    return { waktu: w, dari: b.dari === undefined ? 0 : b.dari, durasi: b.durasi };
  }

  // =================================================================== atribusi
  function klipPerId(props) {
    var peta = {};
    (props && props.klip || []).forEach(function (k) { peta[k.id] = k; });
    return peta;
  }
  /**
   * Teks kredit akhir yang diturunkan dari manifest: satu baris per sumber klip yang dipakai butir
   * video (urutan kemunculan; format TASL lengkap `kreditKlip`), lalu atribusi aset yang
   * `atribusiTampil`-nya `layar` atau `akhir` (`kreditAset("semua")`). props = { klip[], aset }.
   */
  function teksKredit(r, props) {
    var rt = RT(), peta = klipPerId(props), semua = [], baris = [], lihat = {};
    r.track.forEach(function (tr) {
      if (!tr.aktif) return;
      tr.butir.forEach(function (b) { if (b.jenis === "video") semua.push(b); });
    });
    semua.sort(function (a, b) { return a.mulai - b.mulai; });
    semua.forEach(function (b) {
      var k = peta[b.klip];
      if (!k) galat("klip \"" + b.klip + "\" tidak ada di props.klip (jalankan templates/timeline/siapkan.mjs)");
      if (lihat[k.sumber]) return;
      lihat[k.sumber] = true;
      baris.push(rt.kreditKlip(k, { ringkas: false }));
    });
    if (props && props.aset) {
      var t = rt.kreditAset("semua", { props: props, ringkas: false });
      if (t) t.split("\n").forEach(function (x) { if (x) baris.push(x); });
    }
    return baris;
  }
  /** Atribusi ringkas satu baris untuk `kreditLayar: true` (butir video atau gambar). */
  function teksKreditLayar(b, props) {
    var rt = RT();
    if (b.jenis === "video") {
      var k = klipPerId(props)[b.klip];
      if (!k) galat("klip \"" + b.klip + "\" tidak ada di props.klip");
      return rt.kreditKlip(k, { ringkas: true });
    }
    if (b.jenis === "gambar") return rt.kreditAset(b.aset, { props: props, ringkas: true });
    return "";
  }

  var api = {
    rencana: rencana, keadaan: keadaan, sifat: sifat, gayaTeks: gayaTeks, opsiKlip: opsiKlip,
    teksKredit: teksKredit, teksKreditLayar: teksKreditLayar, nilaiProperti: nilaiProperti, lihatEasing: lihatEasing,
  };
  akar.Timeline = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
