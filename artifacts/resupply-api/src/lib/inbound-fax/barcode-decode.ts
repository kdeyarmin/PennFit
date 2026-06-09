// Inbound-fax barcode fast-path — read the PennFit signature-tracking code
// off a returned fax DETERMINISTICALLY, before falling back to the (paid,
// AI) vision scan in tracking-scan.ts.
//
// How it relates to the vision scan:
//   lib/fax/auto-file-signed calls tryDecodeTrackingBarcode() FIRST. On a
//   confident decode it uses that code and skips the model call entirely
//   (free, instant, deterministic). On any miss it returns null and the
//   caller falls through to scanFaxForTrackingCode() exactly as before — so
//   this is a pure optimization that can never reduce correctness.
//
// Rasterization (decoding needs pixels):
//   * PDF (Telnyx's default) — rasterized with the WASM PDFium build
//     (`@hyzyla/pdfium`, MIT, no native compile) at a fax-grade DPI, to
//     grayscale.
//   * Raster faxes (TIFF / image) — rasterized with `sharp` when present,
//     imported OPTIONALLY (a dynamic import that resolves to null when the
//     dependency isn't installed) so it stays a soft dependency.
//   Both rasterizers are loaded lazily + memoized and are fully fail-soft:
//   any error returns null and the caller uses the vision scan.
//
// This covers the CLEAN case (crisp bars). Real returned faxes are degraded
// ~200dpi scans; ones that don't decode here fall through to vision.
//
// Pure-ish: rasterizing is the only I/O. Never throws. PHI: operates on
// image bytes in memory and returns only the opaque tracking code.

import {
  isWellFormedTrackingCode,
  normalizeTrackingCode,
} from "../signature-tracking/service";
import { decodeCode128FromBinaryRow } from "../barcode/code128-decode";

export interface TryDecodeInput {
  bytes: Buffer;
  contentType: string;
}

/** Rows below this contrast carry no bars worth decoding — skip fast. */
const MIN_ROW_CONTRAST = 64;
/** Cap rows scanned on a tall page so the fast-path stays fast. */
const MAX_ROWS_SCANNED = 1600;
/** Don't bother on a strip narrower than a plausible barcode. */
const MIN_WIDTH = 24;
/** PDF render scale (1 = 72dpi). 4 ≈ 288dpi → a 1pt stamp module is ~4px. */
const PDF_RASTER_SCALE = 4;
/** Scan at most this many leading pages — the stamp is on page 1 of our
 *  outbound docs, but a returned fax may carry a cover page first. */
const MAX_PDF_PAGES = 3;

// ── Raster scanning (pure, unit-tested without any decoder) ─────────

/**
 * Decode one raster row (grayscale in the first channel) into a tracking
 * code, or null. Binarizes against the row's own midpoint so it adapts to a
 * faint fax, and only returns a code that is a well-formed PennFit handle.
 */
function decodeRowAt(
  data: Uint8Array | Buffer,
  width: number,
  channels: number,
  y: number,
): string | null {
  const gray = new Array<number>(width);
  let min = 255;
  let max = 0;
  const base = y * width * channels;
  for (let x = 0; x < width; x += 1) {
    const v = data[base + x * channels]!;
    gray[x] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < MIN_ROW_CONTRAST) return null; // near-uniform row
  const threshold = (min + max) / 2;
  const bin = gray.map((v) => v < threshold); // dark = bar
  const decoded = decodeCode128FromBinaryRow(bin);
  if (decoded && isWellFormedTrackingCode(decoded)) {
    return normalizeTrackingCode(decoded);
  }
  return null;
}

/**
 * Scan a raw grayscale bitmap for a well-formed tracking code, row by row
 * (the tracking stamp sits in the top margin, so a hit usually comes early).
 * Pure + synchronous so it can be unit-tested without an image decoder.
 */
export function scanGrayscaleForCode(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
): string | null {
  if (width < MIN_WIDTH || height < 1 || channels < 1) return null;
  const step = Math.max(1, Math.ceil(height / MAX_ROWS_SCANNED));
  for (let y = 0; y < height; y += step) {
    const code = decodeRowAt(data, width, channels, y);
    if (code) return code;
  }
  return null;
}

// ── PDF rasterizer (WASM PDFium, lazy + memoized) ───────────────────
interface PdfiumPage {
  render(opts: {
    scale?: number;
    colorSpace?: "Gray" | "BGRA";
  }): Promise<{ width: number; height: number; data: Uint8Array }>;
}
interface PdfiumDoc {
  getPageCount(): number;
  getPage(index: number): PdfiumPage;
  destroy(): void;
}
interface PdfiumLib {
  loadDocument(buffer: Uint8Array): Promise<PdfiumDoc>;
}

let pdfiumPromise: Promise<PdfiumLib | null> | undefined;

/** Initialize the WASM PDFium library once per process; null on failure. */
async function loadPdfium(): Promise<PdfiumLib | null> {
  if (!pdfiumPromise) {
    pdfiumPromise = (async () => {
      try {
        const mod = await import(/* @vite-ignore */ "@hyzyla/pdfium");
        const lib = await mod.PDFiumLibrary.init();
        return lib as unknown as PdfiumLib;
      } catch {
        return null;
      }
    })();
  }
  return pdfiumPromise;
}

/** Rasterize the leading pages of a PDF and scan each for a tracking code. */
async function decodePdf(bytes: Buffer): Promise<string | null> {
  const lib = await loadPdfium();
  if (!lib) return null;
  let doc: PdfiumDoc | null = null;
  try {
    doc = await lib.loadDocument(new Uint8Array(bytes));
    const pages = Math.min(doc.getPageCount(), MAX_PDF_PAGES);
    for (let i = 0; i < pages; i += 1) {
      const { data, width, height } = await doc
        .getPage(i)
        .render({ scale: PDF_RASTER_SCALE, colorSpace: "Gray" });
      const code = scanGrayscaleForCode(data, width, height, 1);
      if (code) return code;
    }
    return null;
  } finally {
    doc?.destroy();
  }
}

// ── Raster-image rasterizer (sharp, optional + memoized) ────────────
interface SharpRawResult {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}
interface SharpInstance {
  grayscale(): SharpInstance;
  raw(): SharpInstance;
  toBuffer(opts: { resolveWithObject: true }): Promise<SharpRawResult>;
}
type SharpFactory = (
  input: Buffer,
  opts?: { failOn?: string },
) => SharpInstance;

let sharpFactoryPromise: Promise<SharpFactory | null> | undefined;

/** Resolve `sharp` if installed, else null (it is a soft dependency). */
async function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpFactoryPromise) {
    sharpFactoryPromise = (async () => {
      try {
        const moduleName = "sharp";
        const mod: unknown = await import(/* @vite-ignore */ moduleName);
        const candidate =
          (mod as { default?: unknown }).default ?? (mod as unknown);
        return typeof candidate === "function"
          ? (candidate as SharpFactory)
          : null;
      } catch {
        return null;
      }
    })();
  }
  return sharpFactoryPromise;
}

/** Rasterize a raster-image fax (TIFF/PNG/JPEG) and scan it. */
async function decodeRasterImage(bytes: Buffer): Promise<string | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const { data, info } = await sharp(bytes, { failOn: "none" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return scanGrayscaleForCode(data, info.width, info.height, info.channels);
}

/**
 * Deterministically read the PennFit tracking code off a fax, or null.
 * Never throws — any error (unsupported type, missing rasterizer, decode
 * miss) returns null so the caller falls back to the vision scan.
 */
export async function tryDecodeTrackingBarcode(
  input: TryDecodeInput,
): Promise<string | null> {
  try {
    const ct = (input.contentType ?? "").toLowerCase().split(";")[0]!.trim();
    if (!ct || input.bytes.length === 0) return null;
    if (ct.includes("pdf")) return await decodePdf(input.bytes);
    return await decodeRasterImage(input.bytes);
  } catch {
    return null;
  }
}
