/**
 * awvd / aset-svg.js — pemeriksa dan pembersih SVG berbasis daftar-izin (fail-closed).
 *
 * Tidak ada DOM di Bun dan tidak ada dependensi: tokenizer XML kecil yang menolak apa pun
 * yang tidak dipahaminya, lalu penelusur pohon yang hanya meloloskan elemen, atribut, dan
 * nilai yang ada di daftar izin. Karya asli repo ini.
 *
 *   periksaSvg(teks)   -> { galat[], peringatan[], rasio, viewBox, lebar, tinggi }
 *   bersihkanSvg(teks) -> { svg | null, dibuang[], galat[] }
 *
 * Galat = keamanan (skrip, jaringan, XXE, tautan) atau determinisme (SMIL, animasi CSS).
 * Peringatan = hal yang dibuang bersih oleh `bersihkanSvg` (metadata editor) atau yang perlu
 * perhatian. `bersihkanSvg` membuang elemen/atribut terlarang, lalu memeriksa ulang keluarannya
 * dan menolak (svg = null) bila masih ada galat. Kerusakan struktural (DOCTYPE/ENTITY, instruksi
 * pemrosesan, XML tak sah, melebihi batas) tidak diperbaiki, tetapi ditolak.
 *
 * Mengapa perlu: SVG yang dimuat lewat <img> tidak menjalankan skrip dan tidak memuat sumber
 * luar, tetapi SVG yang disisipkan inline ke halaman komposisi menjalankan skrip dan memuat
 * sumber luar (uji lokal Chromium headless). Komposisi sering menyisipkan SVG inline demi
 * `fill: currentColor`, dan renderer awvd memblokir jaringan sebagai lapis kedua.
 *
 * Batasan (jujur): bukan pengganti pustaka matang untuk SVG tak tepercaya dari internet; belum
 * diuji dengan korpus XSS publik; tidak menilai kerumitan filter/pola (CPU) selain ledakan <use>;
 * data URI gambar di <image> tidak dibedah isinya.
 */

export const BATAS_SVG = { byte: 1_000_000, elemen: 20_000, kedalaman: 64, atribut: 200, ekspansiUse: 50_000 };

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const ELEMEN_AMAN = new Set([
  "svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "title", "desc", "image", "linearGradient", "radialGradient", "stop", "pattern",
  "clipPath", "mask", "marker", "filter", "style",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feFuncR", "feFuncG", "feFuncB", "feFuncA", "feComposite",
  "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood",
  "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting",
  "feSpotLight", "feTile", "feTurbulence",
]);

// Elemen yang dikenal berbahaya: pesan khusus (selain itu "tidak ada di daftar izin").
const ELEMEN_TERLARANG = {
  script: "skrip dilarang (berjalan bila SVG disisipkan inline)",
  foreignObject: "<foreignObject> menyisipkan HTML/CSS dan dapat memuat sumber luar",
  iframe: "bingkai dilarang", object: "<object> dilarang", embed: "<embed> dilarang",
  a: "tautan dilarang (navigasi, javascript:)", feImage: "<feImage> memuat berkas luar",
  video: "dilarang", audio: "dilarang", canvas: "dilarang", html: "dilarang", body: "dilarang",
  link: "memuat CSS luar", cursor: "memuat berkas luar", "font-face-uri": "font luar dilarang",
  handler: "dilarang", listener: "dilarang",
  animate: "SMIL: gerak harus dari nomor frame (determinisme)", animateTransform: "SMIL (determinisme)",
  animateMotion: "SMIL (determinisme)", set: "SMIL (determinisme)", mpath: "SMIL (determinisme)",
  discard: "SMIL (determinisme)",
};

// Awalan namespace dan elemen buatan editor grafis: tidak berbahaya, dibuang dengan peringatan.
const NS_EDITOR = new Set(["inkscape", "sodipodi", "dc", "cc", "rdf", "sketch", "serif", "i", "ai", "x"]);
const ELEMEN_EDITOR = new Set(["metadata", "namedview", "perceptualparams"]);

// Atribut tanpa awalan yang diizinkan (presentasi, geometri, referensi lokal).
const ATRIBUT_AMAN = new Set(`
 id class style width height viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry d points transform
 fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray
 stroke-dashoffset stroke-opacity opacity color display visibility overflow clip-path clip-rule mask filter
 font-family font-size font-weight font-style font-variant letter-spacing word-spacing text-anchor text-decoration
 dominant-baseline alignment-baseline baseline-shift dx dy rotate textLength lengthAdjust startOffset
 offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr href
 patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits
 markerWidth markerHeight markerUnits refX refY orient marker-start marker-mid marker-end
 filterUnits primitiveUnits in in2 result stdDeviation mode type values operator k1 k2 k3 k4 flood-color flood-opacity
 order kernelMatrix divisor bias targetX targetY edgeMode kernelUnitLength preserveAlpha tableValues slope intercept
 amplitude exponent scale xChannelSelector yChannelSelector radius baseFrequency numOctaves seed stitchTiles
 surfaceScale diffuseConstant specularConstant specularExponent azimuth elevation z pointsAtX pointsAtY pointsAtZ
 limitingConeAngle lighting-color color-interpolation color-interpolation-filters shape-rendering
 text-rendering image-rendering vector-effect paint-order mix-blend-mode isolation version role
 aria-label aria-labelledby aria-describedby aria-hidden focusable zoomAndPan baseProfile
 `.split(/\s+/).filter(Boolean));

const POLA_DATA_GAMBAR = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;
const SKEMA_TERLARANG = /(?:javascript|vbscript|livescript|data|https?|file|ftp|blob):|^\/\//;
// Fungsi CSS yang memuat sumber lewat jalur selain url().
const FUNGSI_CSS_SUMBER = /(?:^|[^\w-])(?:-webkit-)?(?:image-set|cross-fade|image|element|paint|src)\s*\(/i;

// ------------------------------------------------------------------ entitas dan CSS
function titikKode(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : null;
}

/** Dekode entitas XML. Entitas tak dikenal atau referensi karakter tak sah dicatat sebagai galat. */
function dekodeEntitas(nilai, g, konteks) {
  return nilai.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (_, e) => {
    if (e[0] === "#") {
      const c = titikKode(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      if (c === null) g(`${konteks}: referensi karakter &${e}; tak sah`);
      return c ?? "";
    }
    const t = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e];
    if (t === undefined) {
      g(`${konteks}: entitas &${e}; tak terdefinisi (hanya lt, gt, amp, quot, apos)`);
      return "";
    }
    return t;
  });
}
const adaAmpersandLiar = (t) => /&(?!(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);)/.test(t);

/** Buang komentar dan dekode escape CSS (\75 rl -> url) agar penyamaran tertangkap. */
function normalisasiCss(css) {
  const buangKomentar = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  let s = buangKomentar(css);
  s = s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_, h, c) => (h ? titikKode(parseInt(h, 16)) ?? "�" : c));
  return buangKomentar(s).replace(/[\u0000-\u001f\u007f]/g, "");
}

function periksaCss(css, konteks, g) {
  const s = normalisasiCss(css);
  const tolak = (re, pesan) => { if (re.test(s)) g(`${konteks}: ${pesan}`); };
  tolak(/@/, "at-rule CSS (@import, @font-face, @keyframes, ...) dilarang; font dipasang lewat HTML komposisi");
  tolak(/animation|transition/i, "animasi/transisi CSS dilarang (determinisme)");
  tolak(/expression\s*\(|behavior\s*:|-moz-binding|javascript:|vbscript:/i, "konstruk CSS berbahaya");
  tolak(FUNGSI_CSS_SUMBER, "fungsi CSS pemuat sumber (image-set, cross-fade, element, paint, src, ...) dilarang");
  for (const m of s.matchAll(/url\s*\(\s*(['"]?)\s*([^)'"]*)/gi)) {
    if (!m[2].startsWith("#")) g(`${konteks}: url(${m[2].slice(0, 40)}) bukan referensi lokal (#id)`);
  }
  tolak(/https?:|ftp:|file:|\/\//i, "URL jaringan atau berkas dalam CSS");
}

// ------------------------------------------------------------------ tokenizer -> pohon
const RE_NAMA = /[A-Za-z_][\w.:-]*/y;
const RE_ATTR = /([^\s=/>"'<]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const RE_SPASI = /\s*/y;
const RE_TUTUP = /<\/([A-Za-z_][\w.:-]*)\s*>/y;
const RE_DEKLARASI = /^xml\s+version="1\.[01]"(?:\s+encoding="[A-Za-z0-9._-]+")?(?:\s+standalone="(?:yes|no)")?\s*$/;

function pisahNama(nama) {
  const i = nama.indexOf(":");
  return i < 0 ? ["", nama] : [nama.slice(0, i), nama.slice(i + 1)];
}

/** @returns {{ akar, adaDeklarasi } | { galat: string }} */
function urai(teks) {
  const n = teks.length;
  let i = 0, adaDeklarasi = false, akar = null, jumlahElemen = 0;
  const tumpukan = [];
  const galat = (p) => ({ galat: p });
  const sticky = (re, pos) => { re.lastIndex = pos; return re.exec(teks); };
  const teksDi = (dari, sampai) => {
    const v = teks.slice(dari, sampai);
    if (!v) return null;
    if (!tumpukan.length) return v.trim() ? galat("teks di luar elemen akar") : null;
    if (adaAmpersandLiar(v)) return galat('"&" mentah di teks (XML tak sah; tulis &amp;)');
    tumpukan.at(-1).anak.push({ t: "teks", v });
    return null;
  };

  while (i < n) {
    const lt = teks.indexOf("<", i);
    const sisa = teksDi(i, lt < 0 ? n : lt);
    if (sisa) return sisa;
    if (lt < 0) break;
    i = lt;

    if (teks.startsWith("<!--", i)) {
      const e = teks.indexOf("-->", i + 4);
      if (e < 0) return galat("komentar tak ditutup");
      i = e + 3;
    } else if (teks.startsWith("<![CDATA[", i)) {
      const e = teks.indexOf("]]>", i);
      if (e < 0) return galat("CDATA tak ditutup");
      if (!tumpukan.length) return galat("CDATA di luar elemen akar");
      tumpukan.at(-1).anak.push({ t: "cdata", v: teks.slice(i + 9, e) });
      i = e + 3;
    } else if (teks[i + 1] === "!") {
      return galat("DOCTYPE/ENTITY ditolak (XXE, ekspansi entitas)");
    } else if (teks[i + 1] === "?") {
      const e = teks.indexOf("?>", i);
      if (e < 0) return galat("instruksi pemrosesan tak ditutup");
      const isi = teks.slice(i + 2, e);
      if (i === 0 && RE_DEKLARASI.test(isi)) adaDeklarasi = true;
      else return galat(`instruksi pemrosesan <?${isi.split(/\s/)[0]} ...?> ditolak (deklarasi XML hanya boleh di awal berkas; xml-stylesheet memuat CSS luar)`);
      i = e + 2;
    } else if (teks[i + 1] === "/") {
      const m = sticky(RE_TUTUP, i);
      if (!m) return galat("tag penutup tak sah");
      const atas = tumpukan.pop();
      if (!atas || atas.nama !== m[1]) return galat(`tag </${m[1]}> tak seimbang`);
      i += m[0].length;
    } else {
      RE_NAMA.lastIndex = i + 1;
      const mn = RE_NAMA.exec(teks);
      if (!mn || mn.index !== i + 1) return galat(`tag tak sah dekat posisi ${i}`);
      const el = { t: "el", nama: mn[0], attrs: [], anak: [] };
      [el.pre, el.lokal] = pisahNama(el.nama);
      let j = i + 1 + mn[0].length;
      for (;;) {
        const sp = sticky(RE_SPASI, j)[0].length;
        j += sp;
        if (teks[j] === ">") { j++; break; }
        if (teks.startsWith("/>", j)) { j += 2; el.kosong = true; break; }
        if (sp === 0) return galat(`atribut tanpa pemisah pada <${el.nama}>`);
        const ma = sticky(RE_ATTR, j);
        if (!ma) return galat(`atribut tak sah atau tak bertanda kutip pada <${el.nama}> (XML wajib berkutip)`);
        const nilai = ma[2] ?? ma[3];
        if (nilai.includes("<")) return galat(`nilai atribut ${ma[1]} memuat "<" mentah (XML tak sah)`);
        if (adaAmpersandLiar(nilai)) return galat(`nilai atribut ${ma[1]} memuat "&" mentah (XML tak sah; tulis &amp;)`);
        if (el.attrs.some(([nm]) => nm === ma[1])) return galat(`atribut ganda ${ma[1]} pada <${el.nama}>`);
        if (el.attrs.length >= BATAS_SVG.atribut) return galat(`atribut > ${BATAS_SVG.atribut} pada <${el.nama}>`);
        el.attrs.push([ma[1], nilai]);
        j += ma[0].length;
      }
      if (++jumlahElemen > BATAS_SVG.elemen) return galat(`elemen > ${BATAS_SVG.elemen}`);
      if (tumpukan.length) tumpukan.at(-1).anak.push(el);
      else if (akar) return galat("lebih dari satu elemen akar");
      else akar = el;
      if (!el.kosong) {
        tumpukan.push(el);
        if (tumpukan.length > BATAS_SVG.kedalaman) return galat(`kedalaman > ${BATAS_SVG.kedalaman}`);
      }
      i = j;
    }
  }
  if (tumpukan.length) return galat("tag tak ditutup");
  if (!akar) return galat("tidak ada elemen <svg>");
  return { akar, adaDeklarasi };
}

// ------------------------------------------------------------------ penyaringan
function saringAtribut(el, g, w) {
  const hasil = [];
  const konteksEl = `<${el.lokal}`;
  for (const [nm, mentah] of el.attrs) {
    const konteks = `${konteksEl} ${nm}>`;
    const v = dekodeEntitas(mentah, g, konteks);
    const bersihSkema = v.replace(/[\u0000- \u007f]/g, "").toLowerCase();

    if (/^on/i.test(nm)) { g(`${konteks}: penanganan peristiwa (on*) dilarang`); continue; }

    if (nm === "xmlns" || nm.startsWith("xmlns:")) {
      if ((nm === "xmlns" && v === SVG_NS) || (nm === "xmlns:xlink" && v === XLINK_NS)) hasil.push([nm, mentah]);
      else if (nm.startsWith("xmlns:") && NS_EDITOR.has(nm.slice(6))) w(`deklarasi ${nm} (editor) dibuang bersih`);
      else { g(`${konteks}: namespace tak dikenal "${v.slice(0, 60)}" (mis. XHTML) ditolak`); return null; }
      continue;
    }
    if (nm === "xml:space" || nm === "xml:lang") { hasil.push([nm, mentah]); continue; }
    if (nm.includes(":") && nm !== "xlink:href") {
      const awalan = nm.split(":")[0];
      if (NS_EDITOR.has(awalan)) w(`atribut editor ${nm} dibuang bersih`);
      else g(`${konteks}: atribut berawalan ${awalan}: ditolak`);
      continue;
    }
    if (nm === "href" || nm === "xlink:href") {
      const t = v.trim();
      if (el.lokal === "use") {
        if (!t.startsWith("#")) { g(`${konteks}: <use> hanya boleh merujuk #id lokal (dapat "${t.slice(0, 60)}")`); continue; }
      } else if (el.lokal === "image") {
        if (!POLA_DATA_GAMBAR.test(t)) { g(`${konteks}: <image> hanya boleh data:image/(png|jpeg|webp);base64 (dapat "${t.slice(0, 40)}...")`); continue; }
      } else if (!t.startsWith("#")) { g(`${konteks}: href selain #id lokal ditolak`); continue; }
      hasil.push([nm, mentah]);
      continue;
    }
    if (!ATRIBUT_AMAN.has(nm)) { g(`${konteks}: atribut tidak ada di daftar izin`); continue; }
    if (nm !== "style" && SKEMA_TERLARANG.test(bersihSkema)) { g(`${konteks}: nilai berisi skema/URL terlarang`); continue; }
    if (nm === "style" || /url\s*\(/i.test(v)) {
      const lokal = [];
      periksaCss(v, konteks, (p) => lokal.push(p));
      if (lokal.length) { lokal.forEach(g); continue; }
    }
    hasil.push([nm, mentah]);
  }
  return hasil;
}

/** Mengembalikan salinan elemen yang disaring, atau null bila seluruh subpohon dibuang. */
function saringElemen(el, konteks, adaRoot) {
  const { g, w, perbaiki } = konteks;
  if (el.pre) {
    if (NS_EDITOR.has(el.pre)) w(`elemen editor <${el.nama}> dibuang bersih`);
    else g(`elemen berawalan namespace <${el.nama}> ditolak`);
    return null;
  }
  if (ELEMEN_EDITOR.has(el.lokal)) { w(`elemen <${el.lokal}> (metadata editor) dibuang bersih`); return null; }
  if (ELEMEN_TERLARANG[el.lokal]) { g(`<${el.lokal}>: ${ELEMEN_TERLARANG[el.lokal]}`); return null; }
  if (!ELEMEN_AMAN.has(el.lokal)) { g(`elemen <${el.lokal}> tidak ada di daftar izin`); return null; }

  let attrs = saringAtribut(el, g, w);
  if (attrs === null) return null; // namespace asing: seluruh subpohon dibuang
  if (adaRoot) {
    const sudah = attrs.find(([n]) => n === "xmlns");
    if (!sudah) {
      if (perbaiki) { w('xmlns="http://www.w3.org/2000/svg" ditambahkan'); attrs = [["xmlns", SVG_NS], ...attrs]; }
      else g('<svg> wajib memuat xmlns="http://www.w3.org/2000/svg" (tanpa itu SVG tidak tampil sebagai gambar)');
    }
  }

  if (el.lokal === "style") {
    let css = "";
    for (const a of el.anak) {
      if (a.t === "teks") css += dekodeEntitas(a.v, g, "<style>");
      else if (a.t === "cdata") css += a.v;
      else { g("<style>: elemen di dalam <style> ditolak"); return null; }
    }
    const tipe = el.attrs.find(([n]) => n === "type")?.[1];
    const lokal = [];
    if (tipe && tipe.trim() !== "text/css") lokal.push("<style type> selain text/css ditolak");
    periksaCss(css, "<style>", (p) => lokal.push(p));
    if (lokal.length) { lokal.forEach(g); return null; }
  }
  if (el.lokal === "text" || el.lokal === "tspan") {
    w("<text> bergantung pada font yang terpasang; ubah teks logo menjadi kurva (path) agar tampilan identik di semua mesin");
  }

  const anak = [];
  for (const a of el.anak) {
    if (a.t === "el") {
      const s = saringElemen(a, konteks, false);
      if (s) anak.push(s);
    } else {
      if (a.t === "teks") dekodeEntitas(a.v, g, "teks");
      anak.push(a);
    }
  }
  return { ...el, attrs, anak };
}

function kumpulkan(el, per, hasil = []) {
  if (el.t !== "el") return hasil;
  if (per(el)) hasil.push(el);
  for (const a of el.anak) kumpulkan(a, per, hasil);
  return hasil;
}

/** Ledakan <use>: hitung ukuran ekspansi (memoisasi), tolak siklus dan ekspansi berlebih. */
function periksaUse(akar, g) {
  const peta = new Map();
  for (const e of kumpulkan(akar, (x) => x.attrs.some(([n]) => n === "id"))) peta.set(e.attrs.find(([n]) => n === "id")[1], e);
  const memo = new Map(), sedang = new Set();
  let siklus = false;
  const ukuran = (el) => {
    if (memo.has(el)) return memo.get(el);
    if (sedang.has(el)) { siklus = true; return 0; }
    sedang.add(el);
    let total = 1;
    if (el.lokal === "use") {
      const ref = el.attrs.find(([n]) => n === "href" || n === "xlink:href")?.[1].trim().slice(1);
      const target = ref ? peta.get(ref) : null;
      if (target) total += ukuran(target);
    }
    for (const a of el.anak) if (a.t === "el") total += ukuran(a);
    sedang.delete(el);
    memo.set(el, total);
    return total;
  };
  const u = ukuran(akar);
  if (siklus) g("<use> melingkar (merujuk dirinya sendiri secara langsung atau tidak langsung)");
  else if (u > BATAS_SVG.ekspansiUse) g(`<use> bersarang menggandakan elemen menjadi ${u} (> ${BATAS_SVG.ekspansiUse}): risiko ledakan render`);
}

function analisis(teks, perbaiki) {
  const galat = [], peringatan = [];
  const g = (p) => galat.push(p), w = (p) => peringatan.push(p);
  if (teks.charCodeAt(0) === 0xfeff) teks = teks.slice(1);
  if (Buffer.byteLength(teks) > BATAS_SVG.byte) return { struktural: `ukuran > ${BATAS_SVG.byte} byte`, galat, peringatan };
  const u = urai(teks);
  if (u.galat) return { struktural: u.galat, galat, peringatan };
  const { akar, adaDeklarasi } = u;
  if (akar.lokal !== "svg" || akar.pre) return { struktural: `elemen akar harus <svg> (dapat <${akar.nama}>)`, galat, peringatan };
  const bersih = saringElemen(akar, { g, w, perbaiki }, true);
  if (!bersih) return { struktural: "elemen akar ditolak", galat, peringatan };
  periksaUse(bersih, g);

  const at = Object.fromEntries(bersih.attrs.map(([n, v]) => [n, dekodeEntitas(v, () => {}, "")]));
  let viewBox = at.viewBox?.trim().split(/[\s,]+/).map(Number) ?? null;
  if (viewBox && (viewBox.length !== 4 || viewBox.some((x) => !Number.isFinite(x)) || viewBox[2] <= 0 || viewBox[3] <= 0)) {
    g("viewBox tak valid (harus empat angka, lebar dan tinggi > 0)");
    viewBox = null;
  }
  if (!viewBox) w("viewBox tidak ada: ukuran intrinsik dan rasio tak pasti; tambahkan viewBox");
  return {
    galat, peringatan, bersih, adaDeklarasi, viewBox,
    lebar: viewBox ? viewBox[2] : null, tinggi: viewBox ? viewBox[3] : null,
    rasio: viewBox ? viewBox[2] / viewBox[3] : null,
  };
}

const unik = (a) => [...new Set(a)];

export function periksaSvg(teks) {
  const a = analisis(teks, false);
  const galat = a.struktural ? [a.struktural, ...a.galat] : a.galat;
  return {
    galat: unik(galat), peringatan: unik(a.peringatan),
    rasio: a.rasio ?? null, viewBox: a.viewBox ?? null, lebar: a.lebar ?? null, tinggi: a.tinggi ?? null,
  };
}

const keAtribut = (v) => v.replace(/"/g, "&quot;");
function serialisasi(el) {
  const attrs = el.attrs.map(([n, v]) => ` ${n}="${keAtribut(v)}"`).join("");
  if (el.kosong && !el.anak.length) return `<${el.nama}${attrs}/>`;
  const isi = el.anak.map((a) => (a.t === "el" ? serialisasi(a) : a.t === "cdata" ? `<![CDATA[${a.v}]]>` : a.v)).join("");
  return `<${el.nama}${attrs}>${isi}</${el.nama}>`;
}

/**
 * Membuang elemen/atribut terlarang dan metadata editor, lalu memeriksa ulang keluaran.
 * `dibuang` memuat setiap konstruk yang dibuang (galat dan peringatan). svg = null bila
 * berkas rusak secara struktural atau keluaran masih bergalat (galat berisi alasannya).
 */
export function bersihkanSvg(teks) {
  const a = analisis(teks, true);
  if (a.struktural) return { svg: null, dibuang: unik([...a.galat, ...a.peringatan]), galat: [a.struktural, ...a.galat] };
  if (a.galat.some((p) => p.startsWith("<use>"))) return { svg: null, dibuang: [], galat: unik(a.galat) };
  const svg = `${a.adaDeklarasi ? '<?xml version="1.0" encoding="UTF-8"?>\n' : ""}${serialisasi(a.bersih)}\n`;
  const ulang = periksaSvg(svg);
  if (ulang.galat.length) return { svg: null, dibuang: unik([...a.galat, ...a.peringatan]), galat: ulang.galat };
  return { svg, dibuang: unik([...a.galat, ...a.peringatan]), galat: [] };
}
