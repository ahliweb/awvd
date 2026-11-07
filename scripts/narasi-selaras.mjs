/**
 * awvd / narasi-selaras.mjs — estimasi stempel waktu kata dari teks narasi dan WAV terukur.
 *
 * Tanpa dependensi dan deterministik (hanya aritmetika; tanpa Date, tanpa Math.random).
 * Dipakai scripts/narasi.mjs; dasar dan hasil ukur di docs/narasi-caption.md.
 *
 * Gagasan: waktu bicara tiap kata dibagi menurut bobot (suku kata, huruf, jeda tanda baca),
 * tetapi tanda baca dijangkarkan ke JEDA SENYAP NYATA di audio. Jeda dideteksi dari energi
 * (RMS) lalu dipasangkan ke tanda baca lewat pemrograman dinamis monoton, kalimat lebih
 * dulu, baru klausa di dalam kalimat. Kata di antara dua jangkar dibagi proporsional pada
 * "waktu bersuara" segmen itu. Bila tidak ada jeda yang cocok, hasilnya jatuh ke
 * pembagian proporsional murni (tanpa galat).
 *
 * Karya asli repo ini. Bobot suku kata Indonesia adalah pendekatan sederhana buatan sendiri.
 */
import { readFileSync } from "node:fs";

// ------------------------------------------------------------------ audio
function uraiWavLangsung(b) {
  if (b.length < 12 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return null;
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4), n = b.readUInt32LE(p + 4);
    if (id === "fmt " && p + 24 <= b.length) {
      fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bit: b.readUInt16LE(p + 22) };
    }
    if (id === "data") { data = b.subarray(p + 8, Math.min(b.length, p + 8 + n)); break; }
    p += 8 + n + (n & 1);
  }
  if (!fmt || !data || fmt.tag !== 1 || fmt.bit !== 16 || fmt.ch < 1 || fmt.sr < 1) return null;
  const n = Math.floor(data.length / (2 * fmt.ch));
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * 2);
    s[i] = a / fmt.ch / 32768;
  }
  return { sampel: s, sr: fmt.sr, durasi: n / fmt.sr };
}

/** WAV PCM 16-bit dibaca langsung (mono atau rata-rata kanal); format lain null. */
export function bacaWav(jalur) {
  return uraiWavLangsung(readFileSync(jalur));
}

/**
 * Sampel mono Float32 dari berkas audio. PCM 16-bit WAV dibaca langsung; format lain
 * (float, 24-bit, MP3, dll.) didekode ffmpeg ke 16 kHz mono PCM 16-bit.
 * Mengembalikan { sampel, sr, durasi } atau melempar galat berpesan jelas.
 */
export async function bacaAudio(jalur) {
  const langsung = bacaWav(jalur);
  if (langsung) return langsung;
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", jalur, "-vn", "-ac", "1", "-ar", "16000",
    "-f", "s16le", "-acodec", "pcm_s16le", "-"], { stdout: "pipe", stderr: "pipe" });
  const [buf, err, kode] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (kode !== 0) throw new Error(`audio tidak terbaca (${jalur}): ${err.trim() || `ffmpeg kode ${kode}`}`);
  const dv = new DataView(buf);
  const n = Math.floor(buf.byteLength / 2);
  if (n === 0) throw new Error(`audio kosong: ${jalur}`);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = dv.getInt16(i * 2, true) / 32768;
  return { sampel: s, sr: 16000, durasi: n / 16000 };
}

// ------------------------------------------------------------------ energi dan jeda
/** RMS dB per langkah (jendela 25 ms, langkah 10 ms). */
export function profilEnergi(wav, langkah = 0.01, jendela = 0.025) {
  const { sampel, sr } = wav;
  const h = Math.max(1, Math.round(langkah * sr)), w = Math.max(1, Math.round(jendela * sr));
  const db = [];
  for (let a = 0; a + w <= sampel.length; a += h) {
    let e = 0;
    for (let i = a; i < a + w; i++) e += sampel[i] * sampel[i];
    db.push(10 * Math.log10(e / w + 1e-12));
  }
  return { db, langkah };
}

function persentil(arr, q) {
  const s = Array.from(arr).sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/**
 * Menemukan rentang bicara dan jeda senyap internal.
 * Mengembalikan { mulai, akhir, jeda: [{ a, b }], ada } (detik); `ada` false bila tak ada
 * bagian bersuara (semua senyap). Jeda = senyap internal sepanjang >= minJeda.
 */
export function deteksiBicara(wav, { minJeda = 0.12, selisihDb = 28, minBicara = 0.06 } = {}) {
  const { db, langkah } = profilEnergi(wav);
  if (db.length === 0) return { mulai: 0, akhir: wav.durasi, jeda: [], ada: false };
  const puncak = persentil(db, 0.98), lantai = persentil(db, 0.05);
  // Lantai mutlak -60 dBFS: audio digital senyap tidak dianggap ucapan. Bila rentang dinamis
  // < 10 dB (ucapan menerus tanpa jeda), lantai relatif dilewati agar semuanya tetap bersuara.
  const ambang = Math.max(-60, puncak - selisihDb, puncak - lantai >= 10 ? lantai + 10 : -Infinity);
  const aktif = db.map((v) => v >= ambang);
  const lari = [];
  let a = null;
  for (let i = 0; i <= aktif.length; i++) {
    if (i < aktif.length && aktif[i]) { if (a === null) a = i; }
    else if (a !== null) { lari.push([a, i]); a = null; }
  }
  const gabung = []; // tutup lubang < 30 ms
  for (const r of lari) {
    if (gabung.length && (r[0] - gabung[gabung.length - 1][1]) * langkah < 0.03) gabung[gabung.length - 1][1] = r[1];
    else gabung.push(r.slice());
  }
  const bersuara = gabung.filter((r) => (r[1] - r[0]) * langkah >= minBicara);
  if (!bersuara.length) return { mulai: 0, akhir: wav.durasi, jeda: [], ada: false };
  const jeda = [];
  for (let i = 1; i < bersuara.length; i++) {
    const ja = bersuara[i - 1][1] * langkah, jb = bersuara[i][0] * langkah;
    if (jb - ja >= minJeda) jeda.push({ a: ja, b: jb });
  }
  return { mulai: bersuara[0][0] * langkah, akhir: bersuara[bersuara.length - 1][1] * langkah, jeda, ada: true };
}

// ------------------------------------------------------------------ teks ke token
/**
 * Jumlah suku kata (pendekatan bahasa Indonesia): tiap vokal adalah satu suku, diftong
 * ai/au/oi di akhir kata dihitung satu. Digit tidak dibacakan: naskah menulis angka dengan
 * huruf (atau memberi `bacaan`).
 */
export function sukuKata(kata) {
  const k = kata.toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return 0;
  let n = 0;
  for (const c of k) if ("aiueo".includes(c)) n++;
  if (/(ai|au|oi)$/.test(k)) n--;
  return Math.max(1, n);
}

export const BOBOT_BAWAAN = { perSuku: 0.115, perHuruf: 0.022, tetap: 0.05, koma: 0.2, titik: 0.55 };

/**
 * Teks -> token [{ teks, tampil, tp }]. `tampil` = kata apa adanya (dengan tanda baca dan
 * kutip) untuk caption; `teks` = intinya; `tp` = "" | "koma" | "titik" menurut tanda baca
 * penutup. Potongan tanpa huruf (mis. "—" atau "...") digabung ke kata sebelumnya agar
 * tidak ada teks yang hilang.
 */
export function tokenisasi(teks) {
  const hasil = [];
  for (const mentah of String(teks).replace(/\s+/g, " ").trim().split(" ")) {
    if (!mentah) continue;
    const m = /^([("'“‘]*)(.*?)([)"'”’]*)([,;:.!?…]*)$/u.exec(mentah);
    const inti = m[2], tp = m[4];
    const jenisTP = /[.!?…]/.test(tp) ? "titik" : /[,;:]/.test(tp) ? "koma" : "";
    if (!/[\p{L}\p{N}]/u.test(inti)) {
      if (hasil.length) {
        const akhir = hasil[hasil.length - 1];
        akhir.tampil += " " + mentah;
        if (jenisTP) akhir.tp = jenisTP;
      } else hasil.push({ teks: mentah, tampil: mentah, tp: jenisTP });
      continue;
    }
    hasil.push({ teks: inti, tampil: mentah, tp: jenisTP });
  }
  return hasil;
}

function bobotKata(t, bw) {
  const huruf = Array.from(t.teks.replace(/[^\p{L}]/gu, "")).length;
  return bw.tetap + bw.perSuku * sukuKata(t.teks) + bw.perHuruf * huruf;
}
function bobotJeda(t, bw) { return t.tp === "titik" ? bw.titik : t.tp === "koma" ? bw.koma : 0; }

// ------------------------------------------------------------------ estimasi
/**
 * Stempel waktu kata (detik, relatif ke awal audio) dari token dan audio.
 *
 * `kalibrasi` ({ awal, akhir }, detik): koreksi tetap karena batas akustik (energi) tidak
 * sama dengan batas artikulasi. Onset suara terdeteksi LEBIH LAMBAT dari awal artikulasi
 * (penutupan plosif, frikatif lemah) dan akhir kata terdeteksi lebih awal. `awal`
 * memajukan awal bicara dan akhir tiap jeda; `akhir` memundurkan akhir bicara dan awal
 * tiap jeda. Nilai harus dikalibrasi per sumber audio.
 *
 * Mengembalikan { kata, jeda, mulai, akhir, jangkar, titikJangkar, ada } dengan `jeda`
 * = jeda senyap hasil deteksi (belum dikalibrasi), `jangkar` = jumlah tanda baca yang
 * berhasil dipasangkan, `titikJangkar` = jumlah tanda baca yang bisa dijangkarkan.
 */
export function selaraskanToken(tok, wav, { mode = "jangkar", bobot = BOBOT_BAWAAN, deteksi = {}, kalibrasi = { awal: 0, akhir: 0 } } = {}) {
  if (tok.length === 0) return { kata: [], jeda: [], mulai: 0, akhir: 0, jangkar: 0, titikJangkar: 0, ada: false };
  const sp0 = deteksiBicara(wav, deteksi);
  const kal = { awal: 0, akhir: 0, ...kalibrasi };
  const sp = {
    mulai: Math.max(0, sp0.mulai - kal.awal),
    akhir: sp0.akhir + kal.akhir,
    jeda: sp0.jeda.map((g) => ({ a: g.a + kal.akhir, b: g.b - kal.awal })).filter((g) => g.b > g.a),
  };
  const bw = { ...BOBOT_BAWAAN, ...bobot };
  const w = tok.map((t) => bobotKata(t, bw));
  const j = tok.map((t) => bobotJeda(t, bw));
  j[j.length - 1] = 0; // rentang bicara berakhir di kata terakhir
  const total = w.reduce((x, y) => x + y, 0) + j.reduce((x, y) => x + y, 0);
  const rentang = Math.max(1e-3, sp.akhir - sp.mulai);
  const titikJangkar = tok.reduce((n, t, i) => n + (t.tp && i < tok.length - 1 ? 1 : 0), 0);
  const keluaran = (kata, jangkar) => ({ kata, jeda: sp0.jeda, mulai: sp.mulai, akhir: sp.akhir, jangkar, titikJangkar, ada: sp0.ada });

  const proporsional = () => {
    const skala = rentang / total;
    let t = sp.mulai;
    return tok.map((k, i) => {
      const mulai = t, akhir = t + w[i] * skala;
      t = akhir + j[i] * skala;
      return { ...k, mulai, akhir };
    });
  };
  if (mode === "proporsional" || !sp.jeda.length || titikJangkar === 0) return keluaran(proporsional(), 0);

  const prop = proporsional();
  const G = sp.jeda;
  const pasang = new Map(); // indeks token -> jeda
  const prediksiJeda = (i, P) => (P[i].akhir + (P[i + 1] ? P[i + 1].mulai : P[i].akhir)) / 2;

  // DP monoton: tiap jangkar dipasangkan ke satu jeda atau dilewati; jeda boleh tak terpakai.
  function cocokkan(jangkar, gaps, { sigma, lewat, takTerpakai, minTitik }) {
    const K = jangkar.length, M = gaps.length, INF = 1e18;
    const dp = Array.from({ length: K + 1 }, () => new Array(M + 1).fill(INF));
    const asal = Array.from({ length: K + 1 }, () => new Array(M + 1).fill(null));
    dp[0][0] = 0;
    const biaya = (a, g) => {
      const d = g.b - g.a, gm = (g.a + g.b) / 2;
      const pen = a.jenis === "titik" ? Math.max(0, minTitik - d) * 6 : Math.max(0, 0.12 - d) * 3;
      return Math.abs(a.pred - gm) / sigma + pen;
    };
    const biayaTak = (g) => ((g.b - g.a) >= minTitik ? takTerpakai : 0.02);
    for (let k = 0; k <= K; k++) for (let m = 0; m <= M; m++) {
      const cur = dp[k][m];
      if (cur >= INF) continue;
      if (k < K && cur + lewat < dp[k + 1][m]) { dp[k + 1][m] = cur + lewat; asal[k + 1][m] = [k, m, -1]; }
      if (m < M && cur + biayaTak(gaps[m]) < dp[k][m + 1]) { dp[k][m + 1] = cur + biayaTak(gaps[m]); asal[k][m + 1] = [k, m, -2]; }
      if (k < K && m < M) {
        const c = cur + biaya(jangkar[k], gaps[m]);
        if (c < dp[k + 1][m + 1]) { dp[k + 1][m + 1] = c; asal[k + 1][m + 1] = [k, m, m]; }
      }
    }
    const hasil = [];
    let k = K, m = M;
    while (k > 0 || m > 0) {
      const a = asal[k][m];
      if (!a) break;
      if (a[2] >= 0) hasil.push([jangkar[a[0]].i, gaps[a[2]]]);
      k = a[0]; m = a[1];
    }
    return hasil;
  }

  const rataKata = rentang / tok.length;
  // Tahap 1: batas kalimat <-> jeda panjang.
  const jangkarKalimat = [];
  tok.forEach((k, i) => { if (k.tp === "titik" && i < tok.length - 1) jangkarKalimat.push({ i, jenis: "titik", pred: prediksiJeda(i, prop) }); });
  for (const [i, g] of cocokkan(jangkarKalimat, G, { sigma: rataKata * 10, lewat: 1.5, takTerpakai: 0.7, minTitik: 0.45 })) pasang.set(i, g);

  // Tahap 2: klausa di dalam tiap kalimat; prediksi diskalakan ulang di dalam rentang kalimat.
  const batasKal = [-1, ...[...pasang.keys()].sort((x, y) => x - y), tok.length - 1];
  for (let s = 0; s + 1 < batasKal.length; s++) {
    const i0 = batasKal[s] + 1, i1 = batasKal[s + 1];
    const t0 = s === 0 ? sp.mulai : pasang.get(batasKal[s]).b;
    const t1 = s + 2 === batasKal.length ? sp.akhir : pasang.get(batasKal[s + 1]).a;
    let tot = 0;
    for (let i = i0; i <= i1; i++) tot += w[i] + (i < i1 ? j[i] : 0);
    const sk = (t1 - t0) / tot;
    let t = t0;
    const lokal = [];
    for (let i = i0; i <= i1; i++) { const a = t, b = t + w[i] * sk; lokal[i] = { mulai: a, akhir: b }; t = b + (i < i1 ? j[i] * sk : 0); }
    const jang = [];
    for (let i = i0; i < i1; i++) if (tok[i].tp === "koma") jang.push({ i, jenis: "koma", pred: prediksiJeda(i, lokal) });
    const terpakai = [...pasang.values()];
    const gaps = G.filter((x) => x.a >= t0 && x.b <= t1 && !terpakai.includes(x));
    for (const [i, g] of cocokkan(jang, gaps, { sigma: rataKata * 4, lewat: 0.8, takTerpakai: 0.05, minTitik: 0.45 })) pasang.set(i, g);
  }

  // Sumbu "waktu bersuara": buang semua senyap internal >= minJeda dari garis waktu.
  // Segmen = deretan token di antara jangkar; tiap segmen menempati rentang bersuara
  // antara jeda-jangkar sebelumnya dan sesudahnya.
  const pecah = [-1, ...[...pasang.keys()].sort((x, y) => x - y), tok.length - 1];
  const terpakaiSemua = [...pasang.values()];
  const hasil = new Array(tok.length);
  for (let s = 0; s + 1 < pecah.length; s++) {
    const i0 = pecah[s] + 1, i1 = pecah[s + 1];
    const t0 = s === 0 ? sp.mulai : pasang.get(pecah[s]).b;
    const t1 = s + 2 === pecah.length ? sp.akhir : pasang.get(pecah[s + 1]).a;
    const dalam = G.filter((x) => x.a >= t0 && x.b <= t1 && !terpakaiSemua.includes(x));
    const bersuara = (t) => {
      let hilang = 0;
      for (const x of dalam) { if (t >= x.b) hilang += x.b - x.a; else if (t > x.a) hilang += t - x.a; }
      return t - t0 - hilang;
    };
    const panjang = bersuara(t1);
    const kembali = (u) => {
      let t = t0 + u;
      for (const x of dalam) { if (t >= x.a) t += x.b - x.a; }
      return t;
    };
    let bobotSeg = 0;
    for (let i = i0; i <= i1; i++) bobotSeg += w[i] + (i < i1 ? j[i] * 0.35 : 0); // jeda tanpa senyap nyata dibuat kecil
    const skala = panjang / bobotSeg;
    let u = 0;
    for (let i = i0; i <= i1; i++) {
      const ua = u, ub = u + w[i] * skala;
      hasil[i] = { ...tok[i], mulai: kembali(ua), akhir: kembali(ub) };
      u = ub + (i < i1 ? j[i] * 0.35 * skala : 0);
    }
  }
  // Pengaman: stempel harus monoton dan tak negatif; bila tidak, pakai proporsional murni.
  let sah = hasil.every((k) => k && Number.isFinite(k.mulai) && Number.isFinite(k.akhir) && k.akhir >= k.mulai);
  for (let i = 1; sah && i < hasil.length; i++) if (hasil[i].mulai < hasil[i - 1].mulai - 1e-9) sah = false;
  if (!sah) return keluaran(prop, 0);
  return keluaran(hasil, pasang.size);
}

/**
 * Stempel dari penanda mesin TTS ([{ teks, mulai, durasi }] detik, relatif ke awal audio).
 * Hanya dipakai bila jumlah penanda sama dengan jumlah token; selain itu null (pemanggil
 * jatuh ke estimasi).
 */
export function kataDariPenanda(tok, penanda) {
  if (!Array.isArray(penanda) || penanda.length !== tok.length) return null;
  const hasil = [];
  for (let i = 0; i < tok.length; i++) {
    const p = penanda[i];
    if (!p || !Number.isFinite(p.mulai) || !Number.isFinite(p.durasi) || p.mulai < 0 || p.durasi < 0) return null;
    if (i > 0 && p.mulai < hasil[i - 1].mulai - 1e-9) return null;
    hasil.push({ ...tok[i], mulai: p.mulai, akhir: p.mulai + p.durasi });
  }
  return hasil;
}

/**
 * Menyebarkan token tampilan ke rentang [mulai, akhir] menurut bobot kata. Dipakai saat
 * `bacaan` kalimat berbeda dari `teks` (jumlah token tidak sama).
 */
export function sebarkanTampil(tokTampil, mulai, akhir, bobot = BOBOT_BAWAAN) {
  const bw = { ...BOBOT_BAWAAN, ...bobot };
  const w = tokTampil.map((t) => bobotKata(t, bw));
  const total = w.reduce((x, y) => x + y, 0) || 1;
  let t = mulai;
  return tokTampil.map((k, i) => {
    const a = t, b = t + ((akhir - mulai) * w[i]) / total;
    t = b;
    return { ...k, mulai: a, akhir: b };
  });
}

// ------------------------------------------------------------------ frame
/** Menambahkan mulaiFrame/akhirFrame (bilangan bulat; mulai tidak mundur, akhir >= mulai + 1). */
export function keFrame(kata, fps) {
  const hasil = [];
  let prev = 0;
  for (const k of kata) {
    const a = Math.max(prev, Math.round(k.mulai * fps));
    const b = Math.max(a + 1, Math.round(k.akhir * fps));
    hasil.push({ ...k, mulaiFrame: a, akhirFrame: b });
    prev = a;
  }
  for (let i = 0; i + 1 < hasil.length; i++) {
    if (hasil[i].akhirFrame > hasil[i + 1].mulaiFrame) hasil[i].akhirFrame = Math.max(hasil[i].mulaiFrame + 1, hasil[i + 1].mulaiFrame);
  }
  return hasil;
}
