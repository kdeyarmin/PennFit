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
// Rasterization posture:
//   Decoding needs pixels. Raster faxes (TIFF / image) are rasterized with
//   `sharp` when it is installed — imported OPTIONALLY (a dynamic import that
//   resolves to null when the dependency isn't present), so this module adds
//   no hard dependency and is fully fail-soft. PDF faxes (Telnyx's default)
//   are NOT rasterized here — the prebuilt sharp binary can't render PDF —
//   so they transparently use the vision scan. Wiring a PDF rasterizer
//   (pdfjs + a canvas) is a future extension behind the same null-returning
//   boundary; it needs validation against real fax samples.
//
// Pure-ish: the rasterize step is the only I/O. Never throws. PHI: operates
// on image bytes in memory and returns only the opaque tracking code.

import {
  isWellFormedTrackingCode,
  normalizeTrackingCode,
} from "../signature-tracking/service";
import { decodeCode128FromBinaryRow } from "../barcode/code128-decode";

export interface TryDecodeInput {
  bytes: Buffer;
  contentType: string;
}

// ── Optional sharp loader ───────────────────────────────────────────
// Minimal structural types for the slice of sharp we use — avoids a hard
// dependency on @types/sharp while keeping the code `any`-free.
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

/** Resolve `sharp` if installed, else null. Memoized so a missing dep is
 *  probed once per process, not on every fax. */
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

/** Rows below this contrast carry no bars worth decoding — skip fast. */
const MIN_ROW_CONTRAST = 64;
/** Cap rows scanned on a tall fax so the fast-path stays fast. */
const MAX_ROWS_SCANNED = 1600;
/** Don't bother on a strip narrower than a plausible barcode. */
const MIN_WIDTH = 24;

/**
 * Decode one raster row (grayscale, first channel) into a tracking code, or
 * null. Binarizes against the row's own midpoint so it adapts to a faint
 * fax, and only returns a code that is a well-formed PennFit handle.
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
    // PDF is the common fax format but the prebuilt sharp binary can't
    // rasterize it — fall through to the vision scan.
    if (!ct || ct.includes("pdf")) return null;
    if (input.bytes.length === 0) return null;

    const sharp = await loadSharp();
    if (!sharp) return null;

    const { data, info } = await sharp(input.bytes, { failOn: "none" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return scanGrayscaleForCode(data, info.width, info.height, info.channels);
  } catch {
    return null;
  }
}
