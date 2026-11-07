#!/usr/bin/env bun
/**
 * awvd / kutipan.mjs — validator kebijakan kutipan wajar untuk video reaction, ulasan,
 * dan kritik yang memuat klip dari karya lain. Dipanggil oleh klip.mjs (sebelum ekstraksi
 * dan sebelum Chromium) dan audio.mjs (aturan audio kutipan); bisa juga dijalankan sendiri:
 *
 *   bun scripts/kutipan.mjs periksa <sumber.json>     # angka kebijakan, tanpa ekstraksi
 *   bun scripts/kutipan.mjs hash <sumber.json>        # hash gerbang hukum GH (sha256)
 *
 * Cakupan: setiap sumber di manifest yang berlisensi `KUTIPAN-WAJAR` atau yang memuat blok
 * `kutipan` (sumber CC yang memuat blok itu ikut diperiksa secara sukarela).
 *
 * Angka bawaan (kebijakan internal awvd yang disetujui pemilik 2026-11-07; hukum tidak
 * menetapkan angka). Proyek boleh memperketat, tidak boleh melonggarkan tanpa
 * `proyek.kebijakanKutipan.catatanIzinTertulis`:
 *   - tiap klip kutipan <= 15 detik;
 *   - total kutipan per sumber <= 45 detik atau <= 15% durasi sumber (mana yang lebih kecil);
 *   - total kutipan <= 25% durasi video baru;
 *   - komentar atau narasi asli aktif >= 90% dari durasi kutipan;
 *   - audio musik sumber dibisukan (musik dibahas: klip <= 10 detik).
 * Gerbang hukum GH (`proyek.gerbangHukum`) wajib disetujui untuk lisensi KUTIPAN-WAJAR;
 * hash GH mengikat manifest dan memo peninjau. Dasar dan batas: docs/pelajari-reaction.md.
 * Bukan nasihat hukum. Karya asli repo ini.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const KEBIJAKAN_BAWAAN = Object.freeze({
  klipMaksDetik: 15,
  sumberMaksDetik: 45,
  sumberMaksPersen: 15,
  videoMaksPersen: 25,
  komentarMinPersen: 90,
  musikDibahasMaksDetik: 10,
});
/** Klip lebih panjang dari ini (tetapi <= klipMaksDetik) memberi peringatan. */
export const KLIP_PERINGATAN_DETIK = 10;
export const TUJUAN_SAH = ["kritik", "ulasan", "pendidikan", "penelitian", "berita-aktual"];
export const CARA_PEROLEHAN_SAH = [
  "milik-sendiri", "izin-tertulis", "rilis-pemegang-hak", "lisensi-terbuka", "stok-berbayar", "arsip-publik",
  "berkas-sah-pengguna",
];
export const CARA_PEROLEHAN_TOLAK = ["unduh-platform", "rekam-layar-platform", "rip-stream"];
export const JENIS_KOMENTAR = ["narasi", "caption", "anotasi"];
export const ISI_AUDIO = ["musik", "ucapan", "tanpa"];
export const KODE_LISENSI = "KUTIPAN-WAJAR";

const EPS = 1e-6;
const adaTeks = (v) => typeof v === "string" && v.trim() !== "";
const angkaPositif = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const angka = (v) => typeof v === "number" && Number.isFinite(v);
const sah = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "") && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const mutlak = (dir, p) => (isAbsolute(p) ? p : resolve(dir, p));

/** Sumber dalam cakupan kebijakan: lisensi KUTIPAN-WAJAR atau memuat blok `kutipan`. */
export function dalamCakupan(s) {
  return s !== null && typeof s === "object" && (s.lisensi === KODE_LISENSI || (s.kutipan !== undefined && s.kutipan !== null));
}

// ---------------------------------------------------------------- kebijakan
/**
 * Kebijakan efektif = bawaan ditimpa `proyek.kebijakanKutipan`. Memperketat selalu boleh;
 * melonggarkan hanya dengan catatanIzinTertulis (teks atau nama berkas bukti izin).
 */
export function kebijakanEfektif(proyek) {
  const galat = [], peringatan = [];
  const kebijakan = { ...KEBIJAKAN_BAWAAN };
  const ov = proyek?.kebijakanKutipan;
  if (ov === undefined || ov === null) return { kebijakan, galat, peringatan };
  if (typeof ov !== "object" || Array.isArray(ov)) {
    return { kebijakan, galat: ["proyek.kebijakanKutipan harus objek"], peringatan };
  }
  const adaIzin = adaTeks(ov.catatanIzinTertulis);
  const longgar = [];
  for (const [k, v] of Object.entries(ov)) {
    if (k === "catatanIzinTertulis") continue;
    if (!(k in KEBIJAKAN_BAWAAN)) { galat.push(`proyek.kebijakanKutipan.${k}: kunci tidak dikenal (${Object.keys(KEBIJAKAN_BAWAAN).join(", ")})`); continue; }
    if (!angkaPositif(v)) { galat.push(`proyek.kebijakanKutipan.${k}: harus angka > 0`); continue; }
    // komentarMinPersen: nilai LEBIH KECIL berarti lebih longgar; yang lain: lebih besar = longgar
    const lebihLonggar = k === "komentarMinPersen" ? v < KEBIJAKAN_BAWAAN[k] : v > KEBIJAKAN_BAWAAN[k];
    if (lebihLonggar) {
      if (!adaIzin) galat.push(`proyek.kebijakanKutipan.${k}=${v} melonggarkan bawaan ${KEBIJAKAN_BAWAAN[k]} tanpa proyek.kebijakanKutipan.catatanIzinTertulis`);
      else longgar.push(`${k}=${v} (bawaan ${KEBIJAKAN_BAWAAN[k]})`);
    }
    kebijakan[k] = v;
  }
  if (longgar.length) peringatan.push(`kebijakan kutipan dilonggarkan dengan catatan izin tertulis: ${longgar.join(", ")}; pastikan izin tertulis benar-benar ada dan tersimpan`);
  if (kebijakan.komentarMinPersen > 100) galat.push("proyek.kebijakanKutipan.komentarMinPersen maksimum 100");
  return { kebijakan, galat, peringatan };
}

// ------------------------------------------------------------------ interval
/** Gabungkan interval [a,b] yang tumpang tindih; hasil terurut. */
export function gabungInterval(daftar) {
  const urut = daftar.filter((x) => x[1] > x[0]).map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  const hasil = [];
  for (const x of urut) {
    const akhir = hasil[hasil.length - 1];
    if (akhir && x[0] <= akhir[1] + EPS) akhir[1] = Math.max(akhir[1], x[1]);
    else hasil.push(x);
  }
  return hasil;
}
/** Panjang irisan [a,b] dengan gabungan interval. */
export function panjangIrisan(a, b, gabungan) {
  let t = 0;
  for (const [x, y] of gabungan) t += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return t;
}

// -------------------------------------------------------------- hash gerbang
function kanonis(x) {
  if (Array.isArray(x)) return `[${x.map(kanonis).join(",")}]`;
  if (x !== null && typeof x === "object") {
    return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${kanonis(x[k])}`).join(",")}}`;
  }
  return JSON.stringify(x ?? null);
}
/**
 * Hash gerbang hukum GH: sha256 dari isi manifest (proyek tanpa gerbangHukum, sumber, klip,
 * dalam bentuk kanonis) digabung sha256 berkas memo peninjau. Mengubah satu karakter di
 * manifest atau memo membatalkan persetujuan lama (perubahan = pengesahan ulang).
 */
export function hashGerbang(manifest, dirManifest) {
  const { gerbangHukum, ...proyek } = manifest.proyek ?? {};
  const memo = gerbangHukum?.berkas;
  if (!adaTeks(memo)) return { galat: "gerbangHukum.berkas (memo peninjau) wajib untuk menghitung hash" };
  const p = mutlak(dirManifest, memo);
  if (!existsSync(p) || !statSync(p).isFile()) return { galat: `memo peninjau tidak ditemukan: ${memo}` };
  const hashMemo = createHash("sha256").update(readFileSync(p)).digest("hex");
  const hash = createHash("sha256")
    .update(`${kanonis({ proyek, sumber: manifest.sumber, klip: manifest.klip })}\n${hashMemo}`)
    .digest("hex");
  return { hash, hashMemo };
}

/** Status gerbang GH: { perlu, disetujui, pesan }. Hanya perlu bila ada sumber KUTIPAN-WAJAR. */
export function statusGerbang(manifest, dirManifest) {
  const perlu = (Array.isArray(manifest.sumber) ? manifest.sumber : []).some((s) => s?.lisensi === KODE_LISENSI);
  if (!perlu) return { perlu: false, disetujui: true, pesan: "" };
  const g = manifest.proyek?.gerbangHukum;
  if (g === undefined || g === null) return { perlu, disetujui: false, pesan: "gerbang hukum GH belum ada: isi proyek.gerbangHukum { status, oleh, tanggal, berkas, hash }" };
  if (typeof g !== "object" || Array.isArray(g)) return { perlu, disetujui: false, pesan: "proyek.gerbangHukum harus objek" };
  if (g.status !== "disetujui") return { perlu, disetujui: false, pesan: `gerbang hukum GH berstatus ${JSON.stringify(g.status ?? "menunggu")}, belum disetujui` };
  const kurang = [];
  if (!adaTeks(g.oleh)) kurang.push('"oleh"');
  if (!sah(g.tanggal)) kurang.push('"tanggal" (YYYY-MM-DD)');
  if (!/^[0-9a-f]{64}$/.test(g.hash ?? "")) kurang.push('"hash" (sha256 dari `bun run kutipan -- hash`)');
  if (kurang.length) return { perlu, disetujui: false, pesan: `gerbang hukum GH disetujui tetapi tidak lengkap: ${kurang.join(", ")}` };
  const h = hashGerbang(manifest, dirManifest);
  if (h.galat) return { perlu, disetujui: false, pesan: `gerbang hukum GH: ${h.galat}` };
  if (h.hash !== g.hash) {
    return { perlu, disetujui: false, pesan: "gerbang hukum GH tidak berlaku: hash tidak cocok (manifest atau memo berubah setelah persetujuan); perubahan berarti pengesahan ulang" };
  }
  return { perlu, disetujui: true, pesan: `GH disetujui oleh ${g.oleh} pada ${g.tanggal}` };
}

// ------------------------------------------------------------ pemeriksaan inti
/**
 * Periksa kebijakan kutipan. `durasiSumber` = { idSumber: detik } dari ffprobe (atau
 * `kutipan.durasiSumberDetik` bila tidak ada). Murni: tidak membaca media.
 * Mengembalikan { galat[], peringatan[], gerbang, ringkasan|null, kebijakan }.
 * Pelanggaran angka dan isi TIDAK dapat dilewati; hanya gerbang GH yang bisa ditunda
 * (klip.mjs --draf).
 */
export function periksaKutipan(manifest, dirManifest, durasiSumber = {}) {
  const galat = [], peringatan = [];
  const hasil = (extra = {}) => ({ galat, peringatan, gerbang: { perlu: false, disetujui: true, pesan: "" }, ringkasan: null, kebijakan: { ...KEBIJAKAN_BAWAAN }, ...extra });
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return hasil();
  const sumber = Array.isArray(manifest.sumber) ? manifest.sumber : [];
  const dalam = sumber.filter((s) => dalamCakupan(s) && adaTeks(s.id));
  if (dalam.length === 0) return hasil();
  const proyek = manifest.proyek && typeof manifest.proyek === "object" ? manifest.proyek : {};

  const kb = kebijakanEfektif(proyek);
  galat.push(...kb.galat);
  peringatan.push(...kb.peringatan);
  const K = kb.kebijakan;
  const gerbang = statusGerbang(manifest, dirManifest);
  const adaWajar = sumber.some((s) => s?.lisensi === KODE_LISENSI);

  // ---- per sumber: isi blok kutipan, perolehan, komersial
  for (const s of dalam) {
    const nama = `sumber "${s.id}"`;
    const g = (p) => galat.push(`${nama}: ${p}`);
    const wajar = s.lisensi === KODE_LISENSI;
    const q = s.kutipan;
    if (q === undefined || q === null || typeof q !== "object" || Array.isArray(q)) {
      g(`lisensi ${KODE_LISENSI} wajib punya blok "kutipan" (tujuan, isiAudio, bukanBagianKhas, menyasarKarya, ...)`);
      continue;
    }
    if (!TUJUAN_SAH.includes(q.tujuan)) g(`kutipan.tujuan ${JSON.stringify(q.tujuan)} ditolak; yang sah: ${TUJUAN_SAH.join(", ")} (hiburan, promosi, dan iklan bukan tujuan kutipan)`);
    if (q.isiAudio !== undefined && !ISI_AUDIO.includes(q.isiAudio)) g(`kutipan.isiAudio ${JSON.stringify(q.isiAudio)} tidak dikenal (${ISI_AUDIO.join(", ")}); bawaan "musik" (dibisukan)`);
    if (q.menyasarKarya !== true) g("kutipan.menyasarKarya harus true: komentar harus menyasar isi klip, bukan memakainya sebagai latar");
    if (q.bukanBagianKhas !== true) g('kutipan.bukanBagianKhas harus true: peninjau menyatakan klip bukan klimaks, punchline, atau "bagian paling penting dan khas" karya (Penjelasan UU 28/2014 Pasal 44)');
    if (q.perubahanMakna !== false) g("kutipan.perubahanMakna harus false: tidak boleh memutarbalikkan fakta atau identitas karya (UU 28/2014 Pasal 5 ayat 1 huruf e)");
    if (q.orangDikenali === true) {
      const izin = q.izinPotret === "tertulis-ada";
      const publik = q.kepentinganPublik === true && gerbang.disetujui && gerbang.perlu;
      if (!izin && !publik) g('kutipan.orangDikenali true wajib izinPotret "tertulis-ada", atau kepentinganPublik true dengan gerbang hukum GH disetujui');
      if (q.sintetis === true) g("kutipan.sintetis true pada orang yang dapat dikenali ditolak (deepfake dilarang)");
    } else if (q.sintetis === true) {
      peringatan.push(`${nama}: konten sintetis; beri label konten AI/sintetis pada video`);
    }
    if (q.musikDibahas === true && q.isiAudio !== "musik" && q.isiAudio !== undefined) {
      peringatan.push(`${nama}: musikDibahas true tetapi isiAudio ${JSON.stringify(q.isiAudio)}; periksa isian`);
    }
    if (wajar) {
      if (CARA_PEROLEHAN_TOLAK.includes(s.caraPerolehan)) {
        g(`caraPerolehan ${JSON.stringify(s.caraPerolehan)} ditolak: awvd tidak menerima berkas hasil unduhan platform, rekam layar, atau rip stream (ketentuan layanan platform, UU 28/2014 Pasal 52)`);
      } else if (!CARA_PEROLEHAN_SAH.includes(s.caraPerolehan)) {
        g(`caraPerolehan wajib salah satu dari ${CARA_PEROLEHAN_SAH.join(", ")} (dapat ${JSON.stringify(s.caraPerolehan ?? null)})`);
      } else if (s.caraPerolehan === "berkas-sah-pengguna") {
        if (!adaTeks(s.buktiPerolehan)) g('caraPerolehan "berkas-sah-pengguna" wajib disertai "buktiPerolehan" (berkas bukti)');
        peringatan.push(`${nama}: caraPerolehan "berkas-sah-pengguna" tidak dapat diverifikasi awvd; tanggung jawab pengguna dan peninjau hukum`);
      }
      if (adaTeks(s.buktiPerolehan) && !/^https?:\/\//i.test(s.buktiPerolehan) && !existsSync(mutlak(dirManifest, s.buktiPerolehan))) {
        g(`buktiPerolehan tidak ditemukan: ${s.buktiPerolehan}`);
      }
      if (!adaTeks(s.tanggalAkses) || !sah(s.tanggalAkses)) g('"tanggalAkses" (YYYY-MM-DD) wajib untuk KUTIPAN-WAJAR');
    } else if (s.caraPerolehan !== undefined && CARA_PEROLEHAN_TOLAK.includes(s.caraPerolehan)) {
      g(`caraPerolehan ${JSON.stringify(s.caraPerolehan)} ditolak`);
    }
  }
  if (adaWajar) {
    if (proyek.iklan === true) galat.push("proyek.iklan true: KUTIPAN-WAJAR ditolak mutlak untuk iklan; pakai izin tertulis atau sumber berlisensi");
    if (proyek.tujuan === "komersial") {
      const g = proyek.gerbangHukum;
      if (!(g && g.status === "disetujui" && g.komersialDitinjau === true && adaTeks(g.catatan))) {
        galat.push('proyek.tujuan "komersial" dengan KUTIPAN-WAJAR wajib gerbang hukum GH disetujui dengan komersialDitinjau true dan catatan peninjau; atau pakai izin tertulis');
      }
    }
  }

  // ---- angka kebijakan
  const durVideo = proyek.durasiVideoDetik;
  if (!angkaPositif(durVideo)) {
    galat.push("proyek.durasiVideoDetik wajib (angka > 0, durasi video baru) untuk menghitung proporsi kutipan");
    return hasil({ gerbang, kebijakan: K });
  }
  const klipAll = Array.isArray(manifest.klip) ? manifest.klip : [];
  const idDalam = new Map(dalam.map((s) => [s.id, s]));
  const klipKutip = [];
  const perSumber = new Map();
  for (const k of klipAll) {
    const s = idDalam.get(k?.sumber);
    if (!s) continue;
    const nama = `klip "${k.id}"`;
    const dur = durasiSumber[s.id] ?? s.kutipan?.durasiSumberDetik;
    if (!angkaPositif(dur)) {
      galat.push(`${nama}: durasi sumber "${s.id}" tidak diketahui (ffprobe gagal, atau isi kutipan.durasiSumberDetik)`);
      continue;
    }
    const dari = k.dari ?? 0;
    const panjang = Math.min(k.panjang ?? Infinity, Math.max(0, dur - dari));
    if (!(panjang > 0)) { galat.push(`${nama}: panjang kutipan 0 (dari=${dari}, durasi sumber ${f2(dur)} s)`); continue; }
    if (panjang > K.klipMaksDetik + EPS) {
      galat.push(`${nama}: panjang kutipan ${f2(panjang)} s melebihi batas ${K.klipMaksDetik} s per klip`);
    } else if (panjang > KLIP_PERINGATAN_DETIK + EPS) {
      peringatan.push(`${nama}: panjang kutipan ${f2(panjang)} s di atas ${KLIP_PERINGATAN_DETIK} s; ringkas bila bisa (Bern 10(1): sejauh dibenarkan tujuan)`);
    }
    klipKutip.push({ id: k.id, sumber: s.id, panjang, mulaiVideo: k.mulaiVideo });
    const a = perSumber.get(s.id) ?? { total: 0, durasi: dur };
    a.total += panjang;
    perSumber.set(s.id, a);
  }
  if (klipKutip.length === 0) {
    galat.push("tidak ada klip dari sumber dalam cakupan kutipan (manifest.klip merujuk sumber lain)");
    return hasil({ gerbang, kebijakan: K });
  }

  const batasSumber = [];
  for (const [id, a] of perSumber) {
    const batas = Math.min(K.sumberMaksDetik, (a.durasi * K.sumberMaksPersen) / 100);
    batasSumber.push({ id, total: a.total, durasiSumber: a.durasi, batas });
    if (a.total > batas + EPS) {
      galat.push(`sumber "${id}": total kutipan ${f2(a.total)} s melebihi batas ${f2(batas)} s (lebih kecil dari ${K.sumberMaksDetik} s atau ${K.sumberMaksPersen}% dari ${f2(a.durasi)} s)`);
    }
  }
  const totalKutipan = klipKutip.reduce((t, x) => t + x.panjang, 0);
  const persenVideo = (totalKutipan / durVideo) * 100;
  if (persenVideo > K.videoMaksPersen + EPS) {
    galat.push(`total kutipan ${f2(totalKutipan)} s = ${f2(persenVideo)}% dari video ${f2(durVideo)} s, melebihi batas ${K.videoMaksPersen}%`);
  }

  // ---- komentar aktif
  const komentar = proyek.komentar;
  let gabungan = [];
  if (!Array.isArray(komentar) || komentar.length === 0) {
    galat.push('proyek.komentar wajib: daftar { mulai, akhir, jenis } (detik pada timeline video; jenis narasi|caption|anotasi) yang menutupi klip kutipan');
  } else {
    const interval = [];
    for (const [i, c] of komentar.entries()) {
      const p = `proyek.komentar[${i}]`;
      if (c === null || typeof c !== "object" || !angka(c.mulai) || !angka(c.akhir) || c.mulai < 0 || c.akhir <= c.mulai || c.akhir > durVideo + EPS) {
        galat.push(`${p}: mulai dan akhir harus angka 0 <= mulai < akhir <= durasi video (${f2(durVideo)} s)`);
        continue;
      }
      if (!JENIS_KOMENTAR.includes(c.jenis)) { galat.push(`${p}.jenis harus salah satu dari ${JENIS_KOMENTAR.join(", ")}`); continue; }
      interval.push([c.mulai, c.akhir]);
    }
    gabungan = gabungInterval(interval);
  }
  let tertutup = 0;
  const posisi = [];
  for (const x of klipKutip) {
    if (!angka(x.mulaiVideo) || x.mulaiVideo < 0) {
      galat.push(`klip "${x.id}": mulaiVideo (detik pada timeline video) wajib untuk klip kutipan`);
      continue;
    }
    if (x.mulaiVideo + x.panjang > durVideo + EPS) {
      galat.push(`klip "${x.id}": mulaiVideo ${x.mulaiVideo} + panjang ${f2(x.panjang)} s melewati durasi video ${f2(durVideo)} s`);
      continue;
    }
    const akhirVideo = x.mulaiVideo + x.panjang;
    const t = panjangIrisan(x.mulaiVideo, akhirVideo, gabungan);
    tertutup += t;
    posisi.push([x.mulaiVideo, akhirVideo, x.id]);
    const persen = (t / x.panjang) * 100;
    if (t <= EPS) galat.push(`klip "${x.id}": tidak ada komentar aktif selama klip tampil (minimal satu elemen komentar per klip)`);
    else if (persen < K.komentarMinPersen - EPS) peringatan.push(`klip "${x.id}": komentar aktif ${f2(persen)}% selama klip tampil (target ${K.komentarMinPersen}%)`);
  }
  const persenKomentar = (tertutup / totalKutipan) * 100;
  if (posisi.length === klipKutip.length && persenKomentar < K.komentarMinPersen - EPS) {
    galat.push(`komentar atau narasi asli aktif ${f2(persenKomentar)}% dari durasi kutipan, di bawah batas ${K.komentarMinPersen}%`);
  }

  // ---- kutipan beruntun: klip bersambung tanpa jeda tidak boleh melebihi batas per klip
  posisi.sort((a, b) => a[0] - b[0]);
  let rantai = null;
  for (const p of posisi) {
    if (rantai && p[0] <= rantai.akhir + EPS) { rantai.akhir = Math.max(rantai.akhir, p[1]); rantai.id.push(p[2]); } else {
      if (rantai && rantai.akhir - rantai.mulai > K.klipMaksDetik + EPS) galat.push(`klip ${rantai.id.join(" + ")} bersambung ${f2(rantai.akhir - rantai.mulai)} s tanpa jeda, melebihi ${K.klipMaksDetik} s`);
      rantai = { mulai: p[0], akhir: p[1], id: [p[2]] };
    }
  }
  if (rantai && rantai.akhir - rantai.mulai > K.klipMaksDetik + EPS) galat.push(`klip ${rantai.id.join(" + ")} bersambung ${f2(rantai.akhir - rantai.mulai)} s tanpa jeda, melebihi ${K.klipMaksDetik} s`);

  return {
    galat, peringatan, gerbang, kebijakan: K,
    ringkasan: {
      jumlahKlip: klipKutip.length, totalKutipanDetik: totalKutipan, durasiVideoDetik: durVideo,
      persenVideo, persenKomentar, perSumber: batasSumber,
    },
  };
}

/** Teks satu baris untuk ringkasan hasil pemeriksaan. */
export function barisRingkasan(r) {
  const s = r.ringkasan;
  if (!s) return "";
  const sumber = s.perSumber.map((x) => `${x.id} ${f2(x.total)}/${f2(x.batas)} s`).join(", ");
  return `kutipan: ${s.jumlahKlip} klip, ${f2(s.totalKutipanDetik)} s = ${f2(s.persenVideo)}% dari video ${f2(s.durasiVideoDetik)} s (maks ${r.kebijakan.videoMaksPersen}%); komentar aktif ${f2(s.persenKomentar)}% (min ${r.kebijakan.komentarMinPersen}%); per sumber: ${sumber}`;
}

// -------------------------------------------------------------------- audio
/**
 * Aturan audio kutipan untuk audio.mjs. `klipRencana` = klip rencana audio yang sudah
 * divalidasi ({ id, mode, mulai, akhir }); `klipProps` = daftar klip-props.json, yang
 * memuat `kutipan: { isiAudio, musikDibahas }` untuk sumber dalam cakupan kutipan.
 * Musik sumber dibisukan secara bawaan (isiAudio bawaan "musik"); ucapan boleh bergantian
 * atau campur; musikDibahas membolehkan musik terdengar hanya sampai musikDibahasMaksDetik.
 */
export function periksaAudioKutipan(klipRencana, klipProps, fps, kebijakan = KEBIJAKAN_BAWAAN) {
  const galat = [], peringatan = [];
  for (const k of klipRencana) {
    if (k.mode === "bisu") continue;
    const p = (klipProps ?? []).find((x) => x.id === k.id);
    const q = p?.kutipan;
    if (!q) continue;
    const isi = q.isiAudio ?? "musik";
    const detik = (k.akhir - k.mulai) / fps;
    const nama = `klip "${k.id}"`;
    if (isi === "tanpa") {
      peringatan.push(`${nama}: kutipan.isiAudio "tanpa" tetapi mode "${k.mode}"; gunakan "bisu"`);
    } else if (isi === "musik") {
      if (q.musikDibahas !== true) {
        galat.push(`${nama}: audio sumber kutipan berisi musik dan harus mode "bisu" (kebijakan kutipan; bawaan dibisukan). Bila musik itu sendiri objek ulasan, set kutipan.musikDibahas true di manifest (maks ${kebijakan.musikDibahasMaksDetik} s)`);
      } else if (detik > kebijakan.musikDibahasMaksDetik + 1e-6) {
        galat.push(`${nama}: musik dibahas boleh terdengar maksimum ${kebijakan.musikDibahasMaksDetik} s (rentang ${detik.toFixed(2)} s)`);
      } else {
        peringatan.push(`${nama}: musik sumber terdengar (${detik.toFixed(2)} s) karena dibahas; risiko Content ID dan hak terkait fonogram tetap ada`);
      }
    }
  }
  return { galat, peringatan };
}

// ----------------------------------------------------------------------- CLI
async function durasiBerkas(berkas) {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", berkas], { stdout: "pipe", stderr: "pipe" });
  const [out, kode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const d = Number(out.trim());
  return kode === 0 && Number.isFinite(d) ? d : undefined;
}

function gagal(pesan, kode = 1) {
  console.error(`kutipan.mjs: ${pesan}`);
  process.exit(kode);
}

const PETUNJUK = `Pemakaian:
  bun scripts/kutipan.mjs periksa <sumber.json>   periksa angka kebijakan kutipan (durasi sumber lewat ffprobe)
  bun scripts/kutipan.mjs hash <sumber.json>      cetak hash gerbang hukum GH (isi proyek.gerbangHukum.hash)
Kode keluar 0 lolos, 2 pelanggaran atau argumen tidak valid, 1 galat. Gerbang GH belum disetujui
dilaporkan sebagai peringatan oleh perintah ini; klip.mjs yang menolaknya (atau memberi tanda draf).`;

async function utama() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
  } catch (e) {
    gagal(`${e.message}\n${PETUNJUK}`, 2);
  }
  const [perintah, berkas] = args.positionals;
  if (args.values.help) { console.log(PETUNJUK); return; }
  if (!["periksa", "hash"].includes(perintah) || !berkas || args.positionals.length !== 2) gagal(`perintah tidak valid.\n${PETUNJUK}`, 2);
  const jalur = resolve(berkas);
  if (!existsSync(jalur)) gagal(`manifest tidak ditemukan: ${berkas}`, 2);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(jalur, "utf8"));
  } catch (e) {
    gagal(`manifest bukan JSON valid: ${e.message}`, 2);
  }
  const dir = dirname(jalur);
  if (perintah === "hash") {
    const h = hashGerbang(manifest, dir);
    if (h.galat) gagal(h.galat, 2);
    console.log(h.hash);
    return;
  }
  const durasi = {};
  for (const s of Array.isArray(manifest?.sumber) ? manifest.sumber : []) {
    if (dalamCakupan(s) && adaTeks(s.berkas) && existsSync(mutlak(dir, s.berkas))) {
      const d = await durasiBerkas(mutlak(dir, s.berkas));
      if (d !== undefined) durasi[s.id] = d;
    }
  }
  const r = periksaKutipan(manifest, dir, durasi);
  for (const p of r.peringatan) console.error(`peringatan: ${p}`);
  if (r.gerbang.perlu && !r.gerbang.disetujui) console.error(`peringatan: ${r.gerbang.pesan}`);
  if (r.galat.length) {
    console.error(`kutipan.mjs: kebijakan kutipan dilanggar (${r.galat.length} pelanggaran):`);
    for (const g of r.galat) console.error(`  - ${g}`);
    process.exit(2);
  }
  console.log(r.ringkasan ? barisRingkasan(r) : "tidak ada sumber dalam cakupan kebijakan kutipan");
  if (r.gerbang.perlu) console.log(r.gerbang.pesan);
}

if (import.meta.main) await utama();
