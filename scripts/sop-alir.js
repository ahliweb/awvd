/*!
 * awvd / sop-alir.js — perutean garis alir diagram swimlane (tanpa dependensi).
 *
 * Satu sumber kebenaran untuk dua pemakai: dokumen cetak (scripts/sop.mjs, satuan
 * milimeter) dan template video (templates/sop, satuan piksel). Murni dan
 * deterministik: hanya aritmetika, tanpa DOM, Date, atau Math.random. Karya asli repo ini.
 *
 * MODEL
 *   Satu langkah = satu baris, ditempatkan di lajur (kolom pelaksana) tertentu.
 *   Simbol (terminator, proses, keputusan) berpusat di tengah lajur dan di tengah
 *   baris; semua simbol selebar `simLebar`. Koordinat x berawal di tepi kiri lajur
 *   pertama, y berawal di tepi atas baris pertama (sistem koordinat global).
 *
 * ATURAN PERUTEAN (setiap garis berupa polyline sumbu-sejajar)
 *   1. Langkah berikutnya tepat di bawah, lajur sama: garis lurus dari tepi bawah
 *      simbol ke tepi atas simbol tujuan.
 *   2. Langkah berikutnya di bawah, lajur lain: keluar dari sisi simbol, mendatar
 *      ke tengah lajur tujuan, lalu turun ke tepi atas simbol tujuan.
 *   3. Selain itu (lompat maju, kembali ke langkah sebelumnya, atau ke baris yang
 *      sama): keluar dari sisi simbol, mendatar ke saluran vertikal di sisi lajur
 *      tujuan (di dalam talang lajur, tidak menabrak simbol), menyusuri saluran itu
 *      ke baris tujuan, lalu masuk ke sisi simbol tujuan. Dua garis yang keluar dari
 *      sisi yang sama pada satu simbol tidak dibiarkan menumpuk: garis kedua memakai
 *      sisi lain atau keluar lewat bawah.
 *
 * API
 *   SopAlir.rute({ langkah, lajurLebar, simLebar, tops, tinggi, setengah, setengahLebar, satuan })
 *     langkah   [{ jenis, lajur, ya?, tidak?, keluar? }]  ya/tidak = nomor langkah
 *               (1-based, berurutan 1..n); jenis: mulai | proses | keputusan | selesai
 *               | penghubung (segilima antar halaman; tanpa garis keluar bawaan).
 *               `keluar` [{ ke: indeks 0-based, label }] menggantikan perilaku bawaan
 *               (proses -> baris berikutnya; keputusan -> ya/tidak).
 *     lajurLebar lebar satu lajur; simLebar lebar simbol (< lajurLebar)
 *     setengahLebar (opsional) setengah lebar simbol tiap baris; bawaan simLebar / 2
 *     tops/tinggi/setengah  y atas, tinggi, dan setengah tinggi simbol tiap baris
 *     satuan    panjang rujukan (mis. 1 mm atau 1 px) untuk letak label
 *   -> [{ dari, ke, label, titik: [[x,y],...], kepala: {x,y,arah}, labelPos: {x,y,anchor} }]
 *   SopAlir.potongBaris(titik, tops, tinggi, lebih) -> { [barisIdx]: [polyline,...] }
 *     memotong polyline per baris (y relatif ke tepi atas baris; potongan yang
 *     bersambung digabung); dipakai dokumen cetak agar tiap baris tabel memuat
 *     potongan garisnya sendiri.
 *   SopAlir.panjang(titik) -> panjang polyline
 */
(function () {
  "use strict";

  var g = typeof window !== "undefined" ? window : globalThis;

  function rute(opt) {
    var langkah = opt.langkah;
    var W = opt.lajurLebar;
    var simW = opt.simLebar;
    var tops = opt.tops;
    var tinggi = opt.tinggi;
    var setengah = opt.setengah;
    var u = opt.satuan || 1;
    var hw = simW / 2;
    var hwi = opt.setengahLebar || [];
    function hwOf(i) { return hwi[i] != null ? hwi[i] : hw; }
    var gt = (W - simW) / 2; // lebar talang di tiap sisi simbol
    var geserLangkah = gt / 8;
    var n = langkah.length;

    function xc(l) { return (l + 0.5) * W; }
    function cy(i) { return tops[i] + tinggi[i] / 2; }
    var kanal = {}; // pemakaian saluran: kunci -> jumlah
    function xKanal(sisi, t) {
      var dasar = sisi === "kiri" ? t * W + gt / 2 : (t + 1) * W - gt / 2;
      var kunci = sisi + ":" + t;
      var c = kanal[kunci] || 0;
      kanal[kunci] = c + 1;
      var geser = Math.min(c, 3) * geserLangkah;
      return sisi === "kiri" ? dasar - geser : dasar + geser;
    }

    var pakaiKeluar = []; // sisi simbol yang sudah dipakai garis keluar: {kiri, kanan, bawah}
    var pakaiMasuk = [];  // sisi samping simbol yang sudah dimasuki garis: {kiri, kanan}
    for (var z = 0; z < n; z++) { pakaiKeluar.push({}); pakaiMasuk.push({}); }
    var hasil = [];
    var saluran = []; // garis aturan 3, diselesaikan setelah semua garis aturan 1-2

    // tahap 1: aturan 1 dan 2 (sisi keluar ditentukan oleh letak tujuan)
    for (var i = 0; i < n; i++) {
      var s = langkah[i];
      var a = s.lajur;
      var keluar = s.keluar
        ? s.keluar
        : s.jenis === "selesai" || s.jenis === "penghubung" ? []
          : s.jenis === "keputusan"
            ? [{ ke: s.ya - 1, label: "Ya" }, { ke: s.tidak - 1, label: "Tidak" }]
            : [{ ke: i + 1, label: null }];
      for (var k = 0; k < keluar.length; k++) {
        var o = keluar[k];
        var j = o.ke;
        var t = langkah[j].lajur;
        if (j === i + 1) {
          if (a === t) {
            var y1 = cy(i) + setengah[i];
            var y2 = cy(j) - setengah[j];
            hasil.push({
              dari: i, ke: j, label: o.label,
              titik: [[xc(a), y1], [xc(t), y2]],
              kepala: { x: xc(t), y: y2, arah: "bawah" },
              // label di tengah celah antara dua simbol, di kanan garis
              labelPos: { x: xc(a) + 0.7 * u, y: (y1 + y2) / 2 + 0.6 * u, anchor: "start" },
            });
            pakaiKeluar[i].bawah = true;
          } else {
            var sisi = t > a ? "kanan" : "kiri";
            var xs = xc(a) + (sisi === "kanan" ? hwOf(i) : -hwOf(i));
            hasil.push({
              dari: i, ke: j, label: o.label,
              titik: [[xs, cy(i)], [xc(t), cy(i)], [xc(t), cy(j) - setengah[j]]],
              kepala: { x: xc(t), y: cy(j) - setengah[j], arah: "bawah" },
              labelPos: {
                x: xs + (sisi === "kanan" ? 0.8 : -0.8) * u, y: cy(i) - 0.6 * u,
                anchor: sisi === "kanan" ? "start" : "end",
              },
            });
            pakaiKeluar[i][sisi] = true;
          }
        } else {
          saluran.push({ i: i, j: j, t: t, a: a, label: o.label });
        }
      }
    }

    // tahap 2a: sisi keluar garis saluran; sisi alami yang sudah dipakai diganti
    // sisi lain bila ada, atau keluar lewat bawah dengan jalur mendatar pendek
    saluran.forEach(function (e) {
      var pilihan = e.t > e.a ? ["kanan"] : e.t < e.a ? ["kiri"] : ["kanan", "kiri"];
      e.arahKeluar = pilihan[0];
      e.bawah = false;
      var bebas = null;
      for (var p = 0; p < pilihan.length; p++) {
        if (!pakaiKeluar[e.i][pilihan[p]]) { bebas = pilihan[p]; break; }
      }
      if (bebas) {
        e.keluar = bebas;
        e.arahKeluar = bebas;
        pakaiKeluar[e.i][bebas] = true;
      } else if (!pakaiKeluar[e.i].bawah) {
        e.keluar = "bawah";
        e.bawah = true;
        pakaiKeluar[e.i].bawah = true;
      } else {
        e.keluar = pilihan[0];
      }
    });

    // tahap 2b: sisi masuk di simbol tujuan; hindari sisi yang dipakai garis keluar
    // simbol itu atau garis masuk lain
    saluran.forEach(function (e) {
      var opsi; // sisi simbol tujuan yang dimasuki (saluran di sisi yang sama)
      if (e.arahKeluar === "kanan") opsi = e.t > e.a ? ["kiri", "kanan"] : ["kanan"];
      else opsi = e.t < e.a ? ["kanan", "kiri"] : ["kiri"];
      var terbaik = null, skor = Infinity;
      opsi.forEach(function (sisi, idx) {
        var nilai = idx * 0.1 + (pakaiKeluar[e.j][sisi] ? 10 : 0) + (pakaiMasuk[e.j][sisi] ? 5 : 0);
        if (nilai < skor) { skor = nilai; terbaik = sisi; }
      });
      pakaiMasuk[e.j][terbaik] = true;
      var xch = xKanal(terbaik, e.t);
      var masukKanan = terbaik === "kanan"; // masuk dari sisi kanan simbol tujuan
      var xt = xc(e.t) + (masukKanan ? hwOf(e.j) : -hwOf(e.j));
      var titik, labelPos;
      if (e.bawah) {
        var yb = cy(e.i) + setengah[e.i];
        var yStub = yb + (tinggi[e.i] / 2 - setengah[e.i]) / 2;
        titik = [[xc(e.a), yb], [xc(e.a), yStub], [xch, yStub], [xch, cy(e.j)], [xt, cy(e.j)]];
        labelPos = { x: xc(e.a) + 0.7 * u, y: yb + 2 * u, anchor: "start" };
      } else {
        var xs2 = xc(e.a) + (e.keluar === "kanan" ? hwOf(e.i) : -hwOf(e.i));
        titik = [[xs2, cy(e.i)], [xch, cy(e.i)], [xch, cy(e.j)], [xt, cy(e.j)]];
        labelPos = {
          x: xs2 + (e.keluar === "kanan" ? 0.8 : -0.8) * u, y: cy(e.i) - 0.6 * u,
          anchor: e.keluar === "kanan" ? "start" : "end",
        };
      }
      hasil.push({
        dari: e.i, ke: e.j, label: e.label, titik: titik,
        kepala: { x: xt, y: cy(e.j), arah: masukKanan ? "kiri" : "kanan" }, labelPos: labelPos,
      });
    });
    hasil.sort(function (p, q) { return p.dari - q.dari || p.ke - q.ke; });
    return hasil;
  }

  function panjang(titik) {
    var n = 0;
    for (var i = 1; i < titik.length; i++) {
      n += Math.abs(titik[i][0] - titik[i - 1][0]) + Math.abs(titik[i][1] - titik[i - 1][1]);
    }
    return n;
  }

  // Potong polyline sumbu-sejajar per baris. `lebih` = perpanjangan tiap potongan
  // vertikal melewati batas baris (menutup celah anti-alias). y relatif ke atas baris.
  function potongBaris(titik, tops, tinggi, lebih) {
    var ext = lebih || 0;
    var hasil = {};
    function baris(y) {
      for (var r = tops.length - 1; r >= 0; r--) if (y >= tops[r] - 1e-9) return r;
      return 0;
    }
    function taruh(r, x1, y1, x2, y2) {
      if (!hasil[r]) hasil[r] = [];
      var daftar = hasil[r];
      var akhir = daftar.length ? daftar[daftar.length - 1] : null;
      var lokal1 = [x1, y1 - tops[r]];
      if (akhir && akhir[akhir.length - 1][0] === lokal1[0] && akhir[akhir.length - 1][1] === lokal1[1]) {
        akhir.push([x2, y2 - tops[r]]); // sambung ke polyline sebelumnya
      } else {
        daftar.push([lokal1, [x2, y2 - tops[r]]]);
      }
    }
    for (var i = 1; i < titik.length; i++) {
      var x1 = titik[i - 1][0], y1 = titik[i - 1][1], x2 = titik[i][0], y2 = titik[i][1];
      if (x1 === x2 && y1 !== y2) {
        var lo = Math.min(y1, y2), hi = Math.max(y1, y2);
        var r1 = baris(lo), r2 = baris(hi - 1e-9);
        for (var r = r1; r <= r2; r++) {
          var a = Math.max(lo, tops[r]);
          var b = Math.min(hi, tops[r] + tinggi[r]);
          if (b - a < 1e-9) continue;
          var atas = a > lo ? a - ext : a;
          var bawah = b < hi ? b + ext : b;
          // pertahankan arah asli (dari y1 ke y2)
          if (y1 < y2) taruh(r, x1, atas, x2, bawah); else taruh(r, x1, bawah, x2, atas);
        }
      } else {
        taruh(baris(y1), x1, y1, x2, y2);
      }
    }
    return hasil;
  }

  var api = { rute: rute, potongBaris: potongBaris, panjang: panjang };
  g.SopAlir = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
