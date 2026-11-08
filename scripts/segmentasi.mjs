#!/usr/bin/env bun
/**
 * awvd / segmentasi.mjs — pemeriksa lingkungan segmentasi latar lokal (docs/segmentasi-latar.md).
 *
 *   bun scripts/segmentasi.mjs daftar [--registri BERKAS] [--json]
 *   bun scripts/segmentasi.mjs periksa [--model ID] [--jalur BERKAS] [--registri BERKAS]
 *
 * `daftar` mencetak registri model (id, lisensi, sha256, tautan unduh). `periksa` memastikan
 * onnxruntime (AWVD_ORT) dapat dimuat dan, dengan --model, bahwa bobot ada, ukuran dan sha256-nya
 * cocok dengan registri, dan sesi dapat dibuat. Tidak ada keluaran standar bila gagal.
 *
 * Kode keluar: 0 siap; 1 lingkungan belum lengkap (ORT atau bobot tidak ada, ORT gagal memuat);
 * 2 validasi gagal (registri, sha256, ukuran, argumen). Integrasi ke klip ada di issue lain.
 * Karya asli repo ini; logikanya ada di segmentasi-lib.js.
 */
import { parseArgs } from "node:util";
import { GalatSegmentasi, buatSegmenter, muatRegistri, pastikanOrt } from "./segmentasi-lib.js";

const PETUNJUK = `awvd segmentasi (lingkungan hapus latar lokal)

  bun run segmentasi daftar [--registri BERKAS] [--json]
  bun run segmentasi periksa [--model ID] [--jalur BERKAS] [--registri BERKAS]

Lingkungan: AWVD_ORT (folder paket onnxruntime-node), AWVD_MODEL_DIR (folder bobot),
AWVD_REGISTRI_SEGMENTASI (registri kustom, opsional). Rincian: docs/segmentasi-latar.md.
Kode keluar: 0 siap; 1 lingkungan belum lengkap; 2 validasi gagal.`;

export async function utama(argv, env = process.env) {
  let nilai, posisi;
  try {
    ({ values: nilai, positionals: posisi } = parseArgs({ args: argv, allowPositionals: true, options: {
      model: { type: "string" }, jalur: { type: "string" }, registri: { type: "string" }, json: { type: "boolean" }, bantuan: { type: "boolean", short: "h" },
    } }));
  } catch (e) { console.error(`${e.message}\n\n${PETUNJUK}`); return 2; }
  if (nilai.bantuan || posisi.length === 0) { console.log(PETUNJUK); return nilai.bantuan ? 0 : 2; }
  const perintah = posisi[0];
  try {
    if (posisi.length > 1) throw new GalatSegmentasi(`argumen berlebih: ${posisi.slice(1).join(" ")}`, "opsi-tidak-valid");
    const reg = muatRegistri({ kustom: nilai.registri ?? null, env });
    if (perintah === "daftar") {
      if (nilai.json) { console.log(JSON.stringify(reg.model, null, 2)); return 0; }
      for (const [id, m] of Object.entries(reg.model)) {
        console.log(`${id}\t${m.nama}\tkode ${m.lisensiKode}, bobot ${m.lisensiBobot}\t${m.kustom ? "kustom" : "registri"}\tsha256 ${m.sha256 ?? "-"}\t${m.berkas}`);
      }
      for (const p of reg.peringatan) console.error(`peringatan: ${p}`);
      return 0;
    }
    if (perintah === "periksa") {
      if (!nilai.model) {
        const o = pastikanOrt(env);
        console.log(`onnxruntime siap: ${o.jalur} (versi ${o.versi})`);
        return 0;
      }
      const peringatan = [];
      const s = await buatSegmenter({ model: nilai.model, jalur: nilai.jalur ?? null, env, registriKustom: nilai.registri ?? null, peringatan });
      await s.tutup();
      console.log(`siap: model ${s.info.model} (${s.info.nama}), sha256 ${s.info.sha256}, onnxruntime ${s.info.versiOrt}${s.info.kustom ? ", KUSTOM" : ""}`);
      for (const p of peringatan) console.error(`peringatan: ${p}`);
      return 0;
    }
    throw new GalatSegmentasi(`perintah tidak dikenal: ${perintah} (daftar | periksa)`, "opsi-tidak-valid");
  } catch (e) {
    if (e instanceof GalatSegmentasi) { console.error(`segmentasi: ${e.message}`); return e.keluar; }
    throw e;
  }
}

if (import.meta.main) process.exit(await utama(process.argv.slice(2)));
