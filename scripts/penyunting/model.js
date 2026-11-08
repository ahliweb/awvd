/**
 * awvd / penyunting/model.js — model suntingan murni untuk penyunting pratinjau (#55; docs/penyunting.md).
 *
 * UMD tanpa DOM, tanpa jaringan, tanpa dependensi: dimuat halaman penyunting (global `PenyuntingModel`) dan
 * diuji di Bun (scripts/uji-penyunting.mjs). Semua operasi MURNI: masukan tidak pernah diubah, hasilnya
 * timeline baru (salinan JSON), sehingga urungkan cukup menyimpan rujukan ke snapshot sebelumnya.
 *
 * Operasi dasar (frame = bilangan bulat; rentang setengah terbuka [mulai, mulai + durasi)):
 *   pindah(t, ref, mulaiBaru)            mengubah `mulai`, dijepit ke 0..proyek.durasi - durasi
 *   ubahDurasi(t, ref, durasi, sisi)     sisi "kanan" (bawaan) mengubah `durasi`; sisi "kiri" memajukan `mulai`
 *                                        dan (video) `dari`, hanya untuk butir yang aman (lihat alasanSisiKiri)
 *   potong(t, ref, frame)                membagi butir di `frame` menjadi dua (hanya butir sederhana, lihat alasanPotong)
 * `ref` = id butir (string) atau { track, butir } (indeks). Id ganda (timeline yang ditolak validator) hanya
 * dapat dirujuk lewat indeks. Hasil: { ok:true, berubah, timeline, ref, id, ringkas, catatan[], dijepit } atau
 * { ok:false, alasan }.
 *
 * Sinkronisasi transisi (aturan R05: transisi.durasi = tumpang tindih dengan butir sebelumnya di track):
 * setelah pindah atau ubahDurasi, butir bertransisi yang tumpang tindihnya BERUBAH disetel ulang ke tumpang
 * tindih baru; tumpang tindih 0 menghapus `transisi` (dicatat di `catatan`, dapat diurungkan). Butir yang
 * tumpang tindihnya tidak berubah tidak disentuh, termasuk yang sudah menyimpang sebelumnya. Pelanggaran lain
 * (tumpang tindih tanpa transisi, butir di luar batas lain, R10) sengaja TIDAK dicegah: "sunting longgar,
 * ekspor ketat"; validator di server yang memutuskan (docs/penyunting.md).
 *
 * Riwayat urungkan/ulangi: tumpukan snapshot (maks. 100 langkah); `gabung` menggabungkan langkah berturut-turut
 * berkunci sama (satu seretan atau satu rangkaian ketikan = satu langkah). Tanpa Date.now dan Math.random.
 * Karya asli repo ini.
 */
(function (akar) {
  "use strict";

  var MAKS_ID = 64;
  var BATAS_RIWAYAT = 100;

  function salin(o) { return JSON.parse(JSON.stringify(o)); }
  function jepit(n, min, max) { return n < min ? min : n > max ? max : n; }
  function adaObjek(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function gagal(alasan) { return { ok: false, alasan: alasan }; }

  /** Posisi butir: { track, butir, b } atau { galat }. */
  function cari(t, ref) {
    if (!adaObjek(t) || !Array.isArray(t.track)) return { galat: "Timeline tidak memuat track." };
    if (typeof ref === "string") {
      var temu = [];
      t.track.forEach(function (tr, i) {
        if (!adaObjek(tr) || !Array.isArray(tr.butir)) return;
        tr.butir.forEach(function (b, j) { if (adaObjek(b) && b.id === ref) temu.push({ track: i, butir: j, b: b }); });
      });
      if (temu.length === 0) return { galat: 'Butir "' + ref + '" tidak ditemukan.' };
      if (temu.length > 1) return { galat: 'Id "' + ref + '" dipakai ' + temu.length + " butir; rujuk lewat indeks." };
      return temu[0];
    }
    if (ref && Number.isInteger(ref.track) && Number.isInteger(ref.butir)) {
      var tr = t.track[ref.track], b = tr && Array.isArray(tr.butir) ? tr.butir[ref.butir] : null;
      if (adaObjek(b)) return { track: ref.track, butir: ref.butir, b: b };
    }
    return { galat: "Rujukan butir tidak valid." };
  }

  /** Pesan galat bila butir tidak punya mulai dan durasi bilangan bulat yang masuk akal (operasi tidak boleh menebak). */
  function butirTakSah(b) {
    return Number.isInteger(b.mulai) && Number.isInteger(b.durasi) && b.mulai >= 0 && b.durasi >= 1 ? null : "Butir tidak punya mulai dan durasi bilangan bulat yang valid; perbaiki di JSON.";
  }

  function durasiProyek(t) {
    var d = adaObjek(t.proyek) ? t.proyek.durasi : null;
    return Number.isInteger(d) && d >= 1 ? d : null;
  }

  function nilaiBulat(v) {
    var n = Math.round(Number(v));
    return isFinite(n) ? n : null;
  }

  /**
   * Tumpang tindih masuk tiap butir (frame) menurut aturan R04/R05 validator: butir diurut menurut mulai lalu
   * indeks; lawannya = butir yang masih berjalan dan paling lambat berakhir. Mengembalikan peta indeks -> frame.
   */
  function hitungTumpang(butir) {
    var urut = butir.map(function (b, j) { return { b: b, j: j }; }).sort(function (p, q) { return p.b.mulai - q.b.mulai || p.j - q.j; });
    var berjalan = [], hasil = {};
    urut.forEach(function (x) {
      berjalan = berjalan.filter(function (y) { return y.b.mulai + y.b.durasi > x.b.mulai; });
      var lawan = null;
      berjalan.forEach(function (y) { if (lawan === null || y.b.mulai + y.b.durasi > lawan.b.mulai + lawan.b.durasi) lawan = y; });
      hasil[x.j] = lawan ? lawan.b.mulai + lawan.b.durasi - x.b.mulai : 0;
      berjalan.push(x);
    });
    return hasil;
  }

  /** Menyetel ulang transisi butir yang tumpang tindihnya berubah (butir lama -> butir baru, indeks sama). */
  function sinkronTransisi(butirLama, butirBaru, catatan) {
    var sebelum = hitungTumpang(butirLama), sesudah = hitungTumpang(butirBaru);
    butirBaru.forEach(function (b, j) {
      if (!adaObjek(b) || !adaObjek(b.transisi) || sebelum[j] === sesudah[j]) return;
      if (sesudah[j] > 0) {
        if (b.transisi.durasi !== sesudah[j]) catatan.push("Transisi " + b.id + " disesuaikan ke " + sesudah[j] + " frame.");
        b.transisi.durasi = sesudah[j];
      } else {
        delete b.transisi;
        catatan.push("Transisi " + b.id + " dihapus karena tidak lagi bertumpang tindih dengan butir sebelumnya.");
      }
    });
  }

  function waktuIdentitas(w) {
    if (w === undefined || w === null) return true;
    if (!adaObjek(w)) return false;
    return Object.keys(w).every(function (k) {
      return (k === "kecepatan" && w[k] === 1) || k === "habis" || ((k === "balik" || k === "bekukan") && w[k] === false);
    });
  }

  /** null bila sisi kiri boleh diubah; selain itu alasan tertulis. */
  function alasanSisiKiri(b) {
    if (b.jenis === "audio") return "Butir audio tidak dapat dipangkas dari awal (offset berkas dan fade ditentukan audio.mjs); ubah durasi sisi kanan atau sunting JSON.";
    if (b.jenis === "video" && !waktuIdentitas(b.waktu)) return "Butir video ber-waktu (kecepatan, balik, atau bekukan) tidak dapat dipangkas dari awal karena offset klip tidak lagi sama dengan offset timeline; ubah durasi sisi kanan atau sunting JSON.";
    return null;
  }

  /** null bila butir boleh dipotong; selain itu alasan tertulis. Frame opsional (diperiksa bila diberikan). */
  function alasanPotong(b, frame) {
    if (b.jenis === "audio") return "Butir audio tidak dapat dipotong (narasi tidak boleh dipotong, musik satu butir); sunting JSON.";
    var pakai = ["waktu", "properti", "animasi", "kenBurns"].filter(function (k) { return b[k] !== undefined; });
    if (pakai.length) return "Butir memakai " + pakai.join(", ") + "; membagi keyframe dan peta waktu belum didukung di v1; sunting JSON.";
    if (frame !== undefined) {
      var f = nilaiBulat(frame);
      if (f === null || f <= b.mulai || f >= b.mulai + b.durasi) return "Playhead (frame " + frame + ") harus berada di dalam butir, antara frame " + (b.mulai + 1) + " dan " + (b.mulai + b.durasi - 1) + ".";
    }
    return null;
  }

  function bolehPotong(t, ref, frame) {
    var c = cari(t, ref);
    if (c.galat) return { boleh: false, alasan: c.galat };
    var a = alasanPotong(c.b, frame);
    return { boleh: a === null, alasan: a };
  }
  function bolehSisiKiri(t, ref) {
    var c = cari(t, ref);
    if (c.galat) return { boleh: false, alasan: c.galat };
    var a = alasanSisiKiri(c.b);
    return { boleh: a === null, alasan: a };
  }

  function hasil(t, c, ref, ringkas, catatan, dijepit, berubah) {
    return { ok: true, berubah: berubah, timeline: t, ref: ref, id: c.b.id, ringkas: ringkas, catatan: catatan, dijepit: dijepit };
  }

  function pindah(t, ref, mulaiBaru) {
    var c = cari(t, ref);
    if (c.galat) return gagal(c.galat);
    var rusak = butirTakSah(c.b);
    if (rusak) return gagal(rusak);
    var total = durasiProyek(t);
    if (total === null) return gagal("proyek.durasi tidak valid.");
    var n = nilaiBulat(mulaiBaru);
    if (n === null) return gagal("Nilai mulai bukan angka.");
    var maks = Math.max(0, total - c.b.durasi);
    var akhirnya = jepit(n, 0, maks), dijepit = akhirnya !== n;
    var rujukan = { track: c.track, butir: c.butir };
    if (akhirnya === c.b.mulai) {
      return hasil(t, c, rujukan, dijepit ? "Butir " + c.b.id + " sudah di batas (mulai frame " + akhirnya + ")." : "Butir " + c.b.id + " tetap di frame " + akhirnya + ".", [], dijepit, false);
    }
    var baru = salin(t), butirBaru = baru.track[c.track].butir, catatan = [];
    butirBaru[c.butir].mulai = akhirnya;
    sinkronTransisi(t.track[c.track].butir, butirBaru, catatan);
    var ringkas = "Butir " + c.b.id + " dipindah ke mulai frame " + akhirnya + (dijepit ? " (dijepit ke batas)" : "") + ".";
    return hasil(baru, c, rujukan, [ringkas].concat(catatan).join(" "), catatan, dijepit, true);
  }

  function ubahDurasi(t, ref, durasiBaru, sisi) {
    var c = cari(t, ref);
    if (c.galat) return gagal(c.galat);
    var rusak = butirTakSah(c.b);
    if (rusak) return gagal(rusak);
    var total = durasiProyek(t);
    if (total === null) return gagal("proyek.durasi tidak valid.");
    var n = nilaiBulat(durasiBaru);
    if (n === null) return gagal("Nilai durasi bukan angka.");
    var kiri = sisi === "kiri";
    if (sisi !== undefined && sisi !== "kiri" && sisi !== "kanan") return gagal('Sisi harus "kanan" atau "kiri".');
    var b = c.b, akhir = b.mulai + b.durasi, rujukan = { track: c.track, butir: c.butir };
    var mulaiAkhirnya = b.mulai, durasiAkhirnya;
    if (kiri) {
      var alasan = alasanSisiKiri(b);
      if (alasan) return gagal(alasan);
      var dari = b.jenis === "video" && Number.isInteger(b.dari) ? b.dari : 0;
      var mulaiMin = b.jenis === "video" ? Math.max(0, b.mulai - dari) : 0; // dari tidak boleh negatif
      durasiAkhirnya = jepit(n, 1, akhir - mulaiMin);
      mulaiAkhirnya = akhir - durasiAkhirnya;
    } else {
      durasiAkhirnya = jepit(n, 1, Math.max(1, total - b.mulai));
    }
    var dijepit = durasiAkhirnya !== n;
    if (durasiAkhirnya === b.durasi) {
      return hasil(t, c, rujukan, "Durasi " + b.id + " tetap " + durasiAkhirnya + " frame" + (dijepit ? " (sudah di batas)" : "") + ".", [], dijepit, false);
    }
    var baru = salin(t), butirBaru = baru.track[c.track].butir, catatan = [], x = butirBaru[c.butir];
    x.durasi = durasiAkhirnya;
    if (kiri) {
      var geser = mulaiAkhirnya - b.mulai;
      x.mulai = mulaiAkhirnya;
      if (b.jenis === "video") {
        var d0 = Number.isInteger(b.dari) ? b.dari : 0;
        if (b.dari !== undefined || d0 + geser !== 0) x.dari = d0 + geser;
      }
    }
    sinkronTransisi(t.track[c.track].butir, butirBaru, catatan);
    var ringkas = "Durasi " + b.id + " menjadi " + durasiAkhirnya + " frame" + (kiri ? " (sisi kiri; mulai frame " + mulaiAkhirnya + ")" : "") + (dijepit ? ", dijepit ke batas" : "") + ".";
    return hasil(baru, c, rujukan, [ringkas].concat(catatan).join(" "), catatan, dijepit, true);
  }

  var SUFIKS = "bcdefghijklmnopqrstuvwxyz".split("");
  /** Id baru yang belum dipakai butir mana pun: <id>-b, -c, ... lalu -b1, -b2 ...; dipangkas agar <= 64 karakter. */
  function idBaru(t, asal) {
    var dipakai = {};
    t.track.forEach(function (tr) { if (adaObjek(tr) && Array.isArray(tr.butir)) tr.butir.forEach(function (b) { if (adaObjek(b)) dipakai[b.id] = true; }); });
    for (var k = 0; ; k++) {
      var akhiran = "-" + (k < SUFIKS.length ? SUFIKS[k] : "b" + (k - SUFIKS.length + 1));
      var kandidat = String(asal).slice(0, MAKS_ID - akhiran.length) + akhiran;
      if (!dipakai[kandidat]) return kandidat;
    }
  }

  function potong(t, ref, frame) {
    var c = cari(t, ref);
    if (c.galat) return gagal(c.galat);
    var rusak = butirTakSah(c.b);
    if (rusak) return gagal(rusak);
    var a = alasanPotong(c.b, frame);
    if (a) return gagal(a);
    var f = nilaiBulat(frame), b = c.b, akhir = b.mulai + b.durasi;
    var baru = salin(t), butirBaru = baru.track[c.track].butir;
    var pertama = butirBaru[c.butir], kedua = salin(b);
    delete kedua.transisi; // transisi masuk tetap di butir pertama
    var id2 = idBaru(t, b.id);
    kedua.id = id2;
    kedua.mulai = f;
    kedua.durasi = akhir - f;
    if (b.jenis === "video") kedua.dari = (Number.isInteger(b.dari) ? b.dari : 0) + (f - b.mulai);
    pertama.durasi = f - b.mulai;
    butirBaru.splice(c.butir + 1, 0, kedua);
    var ringkas = "Butir " + b.id + " dipotong di frame " + f + " menjadi " + b.id + " (frame " + b.mulai + " sampai " + (f - 1) + ") dan " + id2 + " (frame " + f + " sampai " + (akhir - 1) + ").";
    var res = hasil(baru, c, { track: c.track, butir: c.butir }, ringkas, [], false, true);
    res.ref2 = { track: c.track, butir: c.butir + 1 };
    res.id2 = id2;
    return res;
  }

  // ---------------------------------------------------------------- riwayat urungkan / ulangi
  function buatRiwayat(awal, maks) {
    var batas = Number.isInteger(maks) && maks > 0 ? maks : BATAS_RIWAYAT;
    var undo = [], redo = [], kini = awal, kunci = null;
    return {
      kini: function () { return kini; },
      /** Menetapkan timeline baru; `gabung` (string) menggabungkan dengan langkah sebelumnya bila kuncinya sama. */
      terapkan: function (baru, gabung) {
        if (gabung !== undefined && gabung !== null && kunci === gabung && undo.length > 0) {
          kini = baru;
          return;
        }
        undo.push(kini);
        if (undo.length > batas) undo.shift();
        redo = [];
        kini = baru;
        kunci = gabung === undefined ? null : gabung;
      },
      urungkan: function () { if (!undo.length) return null; redo.push(kini); kini = undo.pop(); kunci = null; return kini; },
      ulangi: function () { if (!redo.length) return null; undo.push(kini); kini = redo.pop(); kunci = null; return kini; },
      /** Memutus penggabungan (mis. kolom angka kehilangan fokus). */
      putus: function () { kunci = null; },
      bisaUrungkan: function () { return undo.length > 0; },
      bisaUlangi: function () { return redo.length > 0; },
      jumlahUrungkan: function () { return undo.length; },
      jumlahUlangi: function () { return redo.length; },
    };
  }

  var api = {
    pindah: pindah, ubahDurasi: ubahDurasi, potong: potong, bolehPotong: bolehPotong, bolehSisiKiri: bolehSisiKiri,
    alasanPotong: alasanPotong, alasanSisiKiri: alasanSisiKiri, hitungTumpang: hitungTumpang, buatRiwayat: buatRiwayat, cari: cari,
    BATAS_RIWAYAT: BATAS_RIWAYAT,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else akar.PenyuntingModel = api;
})(typeof window !== "undefined" ? window : globalThis);
