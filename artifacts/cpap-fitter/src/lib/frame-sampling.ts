/**
 * Pixel sampling for the scan-quality checks.
 *
 * `scan-quality.ts` is deliberately pure — it takes plain numbers so it can
 * be unit-tested without a camera or a WASM runtime. Something still has to
 * produce those numbers from an actual frame, and that is this module: the
 * one place that touches pixels.
 *
 * PHI boundary: everything here runs in the patient's browser, reads from a
 * canvas that never leaves it, and returns **scalars only** — mean luma and
 * a sharpness variance. No pixels, no crops, no data URLs are returned,
 * stored, or transmitted. The repo's "camera images never leave the
 * browser" rule is a hard rule (see CLAUDE.md); keep every addition here on
 * the scalar side of it.
 */

import type { Point2D } from "./scan-quality";

export interface FrameSample {
  /** Mean luma (0..255) over the face bounding box. */
  faceLuma: number;
  /** Mean luma of the left and right halves of that box. */
  faceLumaLeft: number;
  faceLumaRight: number;
  /** Variance of Laplacian over a downscaled face crop; higher is sharper. */
  sharpness: number;
}

/** A neutral sample, used when the canvas is unreadable (see `sampleFrame`). */
export const UNKNOWN_FRAME_SAMPLE: FrameSample = {
  faceLuma: 135,
  faceLumaLeft: 135,
  faceLumaRight: 135,
  sharpness: 120,
};

/** The face bounding box in pixels, from normalised landmarks. */
function faceBox(
  landmarks: readonly Point2D[],
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  if (landmarks.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of landmarks) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  const x = Math.max(0, Math.floor(minX * width));
  const y = Math.max(0, Math.floor(minY * height));
  const w = Math.min(width - x, Math.ceil((maxX - minX) * width));
  const h = Math.min(height - y, Math.ceil((maxY - minY) * height));
  if (w < 8 || h < 8) return null;
  return { x, y, w, h };
}

/** Rec. 601 luma. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Variance of the Laplacian over a grayscale buffer — the standard
 * cheap focus measure. A blurred frame has little high-frequency energy,
 * so the second derivative is small everywhere and its variance collapses.
 */
function varianceOfLaplacian(gray: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * gray[i]! -
        gray[i - 1]! -
        gray[i + 1]! -
        gray[i - w]! -
        gray[i + w]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Sample luma + sharpness from a decoded frame.
 *
 * Returns `UNKNOWN_FRAME_SAMPLE` rather than throwing when the canvas is
 * unavailable or tainted: a patient mid-fitting must never lose their
 * recommendation because a quality probe failed. The neutral values score
 * mid-range, so an unreadable canvas degrades confidence toward "we don't
 * know" instead of inventing a good or a bad scan.
 */
export function sampleFrame(
  image: CanvasImageSource & { width: number; height: number },
  landmarks: readonly Point2D[],
): FrameSample {
  try {
    const box = faceBox(landmarks, image.width, image.height);
    if (!box) return UNKNOWN_FRAME_SAMPLE;

    // Downscale the crop: the checks are statistical, and a fixed small
    // raster keeps the cost constant regardless of camera resolution.
    const TARGET = 96;
    const scale = Math.min(1, TARGET / Math.max(box.w, box.h));
    const cw = Math.max(3, Math.round(box.w * scale));
    const ch = Math.max(3, Math.round(box.h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return UNKNOWN_FRAME_SAMPLE;
    ctx.drawImage(image, box.x, box.y, box.w, box.h, 0, 0, cw, ch);

    const { data } = ctx.getImageData(0, 0, cw, ch);
    const gray = new Float32Array(cw * ch);
    let total = 0;
    let leftTotal = 0;
    let leftN = 0;
    let rightTotal = 0;
    let rightN = 0;
    const mid = cw / 2;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        const p = i * 4;
        const v = luma(data[p]!, data[p + 1]!, data[p + 2]!);
        gray[i] = v;
        total += v;
        if (x < mid) {
          leftTotal += v;
          leftN++;
        } else {
          rightTotal += v;
          rightN++;
        }
      }
    }
    const n = cw * ch;
    return {
      faceLuma: total / n,
      faceLumaLeft: leftN > 0 ? leftTotal / leftN : total / n,
      faceLumaRight: rightN > 0 ? rightTotal / rightN : total / n,
      sharpness: varianceOfLaplacian(gray, cw, ch),
    };
  } catch {
    // Tainted canvas, zero-sized source, or a browser that refuses
    // getImageData. Neutral, never fatal.
    return UNKNOWN_FRAME_SAMPLE;
  }
}
