/**
 * awvd / narasi-caption.mjs — skema tampilan caption di naskah.json: mode, posisi, zona
 * caption, dan jangkar penutur. Dipakai narasi.mjs saat validasi; hasilnya diteruskan ke
 * kata.json supaya komposisi dapat memanggil `rencanaCaption` (runtime.js) tanpa data lain.
 *
 * Nilai di sini hanya DIKENALI dan divalidasi; penempatan sebenarnya dilakukan helper
 * runtime (`rencanaCaption`, `keadaanCaption`, `captionHtml`). Daftar mode dan posisi harus
 * sama dengan `rencanaCaption.mode` dan `.posisi` di runtime.js (dijaga uji-caption.mjs).
 */

export const MODE_CAPTION = ["pop-on", "roll-up", "paint-on", "sorot-kata", "satu-kata"];
export const POSISI_CAPTION = ["bawah", "atas", "auto", "dekat-penutur"];

const adalahObjek = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const bulat = (x) => Number.isInteger(x);
const angka = (x) => typeof x === "number" && Number.isFinite(x);

/** `caption.mode` dan `caption.posisi` naskah. Mengembalikan { mode?, posisi? } (kunci yang ada saja). */
export function bacaTampilNaskah(cap, g) {
  const hasil = {};
  if (cap.mode !== undefined) {
    if (!MODE_CAPTION.includes(cap.mode)) g(`caption.mode harus salah satu dari ${MODE_CAPTION.join(", ")} (dapat ${JSON.stringify(cap.mode)})`);
    else hasil.mode = cap.mode;
  }
  if (cap.posisi !== undefined) {
    if (!POSISI_CAPTION.includes(cap.posisi)) g(`caption.posisi harus salah satu dari ${POSISI_CAPTION.join(", ")} (dapat ${JSON.stringify(cap.posisi)})`);
    else hasil.posisi = cap.posisi;
  }
  return hasil;
}

/**
 * `posisi`, `zonaCaption`, dan `jangkarPenutur` sebuah adegan. `posisiNaskah` = caption.posisi
 * naskah (bila ada). Mengembalikan { posisi?, zonaCaption?, jangkarPenutur? } ternormalisasi
 * (zona: [{ area, dari, sampai }] dalam frame relatif ke awal adegan; sampai null = akhir adegan).
 */
export function bacaTampilAdegan(a, nama, { ukuran, posisiNaskah }, g, w) {
  const hasil = {};
  if (a.posisi !== undefined) {
    if (!POSISI_CAPTION.includes(a.posisi)) g(`${nama}: posisi harus salah satu dari ${POSISI_CAPTION.join(", ")} (dapat ${JSON.stringify(a.posisi)})`);
    else hasil.posisi = a.posisi;
  }
  if (a.zonaCaption !== undefined) {
    if (!Array.isArray(a.zonaCaption)) g(`${nama}: zonaCaption harus daftar { area, dari, sampai }`);
    else {
      const zona = [];
      a.zonaCaption.forEach((z, i) => {
        const pz = `${nama}, zonaCaption[${i}]`;
        if (!adalahObjek(z)) { g(`${pz} harus objek { area, dari, sampai }`); return; }
        for (const k of Object.keys(z)) if (!["area", "dari", "sampai"].includes(k)) w(`${pz}: kunci "${k}" tidak dikenal dan diabaikan`);
        if (z.area !== "bawah" && z.area !== "atas") { g(`${pz}: area harus "bawah" atau "atas" (dapat ${JSON.stringify(z.area)})`); return; }
        const dari = z.dari ?? 0;
        if (!bulat(dari) || dari < 0) { g(`${pz}: dari harus bilangan bulat >= 0 (frame relatif ke awal adegan)`); return; }
        if (z.sampai !== undefined && (!bulat(z.sampai) || z.sampai <= dari)) { g(`${pz}: sampai harus bilangan bulat > dari (frame relatif ke awal adegan, tidak termasuk)`); return; }
        zona.push({ area: z.area, dari, sampai: z.sampai ?? null });
      });
      hasil.zonaCaption = zona;
    }
  }
  if (a.jangkarPenutur !== undefined) {
    const j = a.jangkarPenutur;
    if (!adalahObjek(j) || !angka(j.x) || !angka(j.y) || j.x < 0 || j.y < 0) g(`${nama}: jangkarPenutur harus { x, y } angka >= 0 (piksel; titik pusat kotak caption)`);
    else {
      for (const k of Object.keys(j)) if (!["x", "y"].includes(k)) w(`${nama}, jangkarPenutur: kunci "${k}" tidak dikenal dan diabaikan`);
      if (ukuran && (j.x > ukuran.lebar || j.y > ukuran.tinggi)) g(`${nama}: jangkarPenutur (${j.x}, ${j.y}) di luar ukuran ${ukuran.lebar}x${ukuran.tinggi}`);
      else hasil.jangkarPenutur = { x: j.x, y: j.y };
    }
  }
  const efektif = hasil.posisi ?? posisiNaskah;
  if (efektif === "bawah" && (hasil.zonaCaption ?? []).some((z) => z.area === "bawah")) {
    w(`${nama}: posisi "bawah" tetapi zonaCaption menandai area bawah; pakai posisi "auto" atau "atas"`);
  }
  if (efektif === "dekat-penutur" && !hasil.jangkarPenutur) {
    w(`${nama}: posisi "dekat-penutur" tanpa jangkarPenutur; komposisi akan jatuh ke posisi bawah`);
  }
  return hasil;
}

/** Bentuk kata.json satu adegan: zona diubah ke frame absolut (dipotong di akhir adegan). */
export function tampilKeKata(tampil, mulaiFrame, durasiFrame) {
  const hasil = {};
  if (!tampil) return hasil;
  if (tampil.posisi !== undefined) hasil.posisi = tampil.posisi;
  if (tampil.zonaCaption !== undefined) {
    const akhir = mulaiFrame + durasiFrame;
    hasil.zonaCaption = tampil.zonaCaption.map((z) => ({ area: z.area, dari: mulaiFrame + z.dari, sampai: z.sampai === null ? akhir : Math.min(mulaiFrame + z.sampai, akhir) }));
  }
  if (tampil.jangkarPenutur !== undefined) hasil.jangkarPenutur = { ...tampil.jangkarPenutur };
  return hasil;
}
