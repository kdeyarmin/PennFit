// Code 128 (subset B) barcode encoder + pdfkit drawer.
//
// Why a hand-rolled encoder
// -------------------------
// Signature-tracking documents (prescription requests, signable manual
// documents) print a short tracking code as a barcode so a signed copy
// faxed back can be scanned and filed against the right document. We need
// to render that as crisp vector bars inside the same pdfkit PDFs the
// rest of the app produces. A from-scratch Code 128B encoder is small,
// deterministic, and avoids pulling a new runtime dependency (the repo's
// lockfile is supply-chain gated) — and a fax-grade 1D symbology only
// needs Set B, which covers every character our tracking codes use
// (uppercase A–Z, digits, and "-").
//
// Pure module — no I/O, no DB, no PHI. The drawer takes a pdfkit document
// and writes vector rectangles; the encoder is unit-tested in isolation.
//
// Symbology reference: Code 128, code set B. Each symbol is 11 modules
// (6 alternating bar/space widths, bar first) except the Stop symbol
// which is 13 (7 widths). Checksum = (startB + Σ value_i·position_i) mod
// 103, positions 1-based over the data symbols.

import type PDFKit from "pdfkit";

// The 107 Code 128 symbol patterns (values 0..106) plus the stop bar.
// Each entry is the alternating bar/space module widths, bar first.
// Index 104 = Start Code B, 106 = Stop (the literal 13-module stop bar,
// "2331112", already includes its trailing 2-module bar).
//
// Exported so the matching decoder (code128-decode.ts) builds its reverse
// lookup from the SAME table — the encoder and decoder can never drift.
export const PATTERNS: readonly string[] = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
] as const;

export const START_B = 104;
export const STOP = 106;
/** Recommended clear space on each side of the symbol, in modules. */
export const QUIET_ZONE_MODULES = 10;

/** Lowest / highest printable ASCII char Code 128 set B can encode. */
export const MIN_CHAR = 32; // space
const MAX_CHAR = 126; // ~

/**
 * Map an input string to Code 128B symbol VALUES (not yet patterns):
 * the Start B symbol, one value per character, the mod-103 checksum, and
 * the Stop symbol. Throws on a character set B can't represent so a bad
 * tracking code fails loudly at render time rather than printing an
 * unscannable barcode.
 */
export function encodeCode128BValues(value: string): number[] {
  if (value.length === 0) {
    throw new Error("code128: cannot encode an empty string");
  }
  const symbols: number[] = [START_B];
  let checksum = START_B;
  let position = 1;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < MIN_CHAR || code > MAX_CHAR) {
      throw new Error(
        `code128: character ${JSON.stringify(ch)} is outside code set B`,
      );
    }
    const symbolValue = code - MIN_CHAR; // set B value = ASCII - 32
    symbols.push(symbolValue);
    checksum += symbolValue * position;
    position += 1;
  }
  symbols.push(checksum % 103);
  symbols.push(STOP);
  return symbols;
}

/**
 * A run of consecutive modules of one colour. `bar` true = ink (black),
 * false = paper (white). `modules` is the run width in modules.
 */
export interface BarcodeModuleRun {
  bar: boolean;
  modules: number;
}

/**
 * Encode a string to the flat list of bar/space runs (bar first), ready
 * to draw. Use {@link code128ModuleCount} for the total width.
 */
export function encodeCode128B(value: string): BarcodeModuleRun[] {
  const runs: BarcodeModuleRun[] = [];
  for (const symbol of encodeCode128BValues(value)) {
    const pattern = PATTERNS[symbol]!;
    for (let i = 0; i < pattern.length; i += 1) {
      // Even index = bar, odd = space; patterns always start with a bar.
      runs.push({ bar: i % 2 === 0, modules: Number(pattern[i]) });
    }
  }
  return runs;
}

/** Total module count of the symbol body (excludes quiet zones). */
export function code128ModuleCount(value: string): number {
  return encodeCode128B(value).reduce((sum, run) => sum + run.modules, 0);
}

export interface DrawCode128Options {
  /** Left edge of the quiet zone, in pdfkit points. */
  x: number;
  /** Top edge of the bars, in pdfkit points. */
  y: number;
  /** Bar height in points. Default 28. */
  height?: number;
  /** Module (narrowest bar) width in points. Default 1. */
  moduleWidth?: number;
  /** Include the standard 10-module quiet zone each side. Default true. */
  quietZone?: boolean;
}

/**
 * Draw a Code 128B barcode into a pdfkit document as vector bars.
 * Returns the total drawn width in points (including quiet zones) so the
 * caller can place a caption / position the next element. Does not move
 * pdfkit's text cursor (bars are absolute-positioned rectangles).
 */
export function drawCode128(
  doc: PDFKit.PDFDocument,
  value: string,
  opts: DrawCode128Options,
): number {
  const moduleWidth = opts.moduleWidth ?? 1;
  const height = opts.height ?? 28;
  const quiet = opts.quietZone === false ? 0 : QUIET_ZONE_MODULES;
  const runs = encodeCode128B(value);

  let cursorX = opts.x + quiet * moduleWidth;
  doc.save();
  doc.fillColor("#000000");
  for (const run of runs) {
    const runWidth = run.modules * moduleWidth;
    if (run.bar) {
      doc.rect(cursorX, opts.y, runWidth, height).fill();
    }
    cursorX += runWidth;
  }
  doc.restore();

  const bodyModules = runs.reduce((sum, run) => sum + run.modules, 0);
  return (bodyModules + quiet * 2) * moduleWidth;
}
