// Tests for the inbound-fax barcode fast-path. scanGrayscaleForCode is
// exercised against a synthetic grayscale bitmap (no image decoder needed);
// tryDecodeTrackingBarcode is checked for its fail-soft contract (sharp is
// not installed in the test env, so raster types resolve to null).

import { describe, it, expect } from "vitest";

import { encodeCode128B } from "../barcode/code128";
import {
  scanGrayscaleForCode,
  tryDecodeTrackingBarcode,
} from "./barcode-decode";

/** Render a value to a binarized row at `px` px/module, with quiet zones. */
function renderRow(value: string, px: number, quietModules = 12): boolean[] {
  const row: boolean[] = [];
  const pushN = (n: number, bar: boolean) => {
    for (let i = 0; i < n; i += 1) row.push(bar);
  };
  pushN(quietModules * px, false);
  for (const run of encodeCode128B(value)) pushN(run.modules * px, run.bar);
  pushN(quietModules * px, false);
  return row;
}

/** Build a single-channel grayscale bitmap (0 = black bar, 255 = white)
 *  whose rows all carry the barcode. */
function barcodeBitmap(
  code: string,
  px: number,
  height: number,
): { data: Uint8Array; width: number; height: number } {
  const row = renderRow(code, px);
  const width = row.length;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = row[x] ? 0 : 255;
    }
  }
  return { data, width, height };
}

describe("scanGrayscaleForCode", () => {
  it("finds and normalizes a well-formed tracking code in a bitmap", () => {
    const { data, width, height } = barcodeBitmap("PFS-7F3K2Q9X", 3, 24);
    expect(scanGrayscaleForCode(data, width, height, 1)).toBe("PFS-7F3K2Q9X");
  });

  it("decodes through a multi-channel (RGB) stride", () => {
    const { data: gray, width, height } = barcodeBitmap("PFS-ABCD2345", 3, 4);
    // Expand to 3 channels (R=G=B=gray) to mimic a non-grayscaled raster.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < gray.length; i += 1) {
      rgb[i * 3] = gray[i]!;
      rgb[i * 3 + 1] = gray[i]!;
      rgb[i * 3 + 2] = gray[i]!;
    }
    expect(scanGrayscaleForCode(rgb, width, height, 3)).toBe("PFS-ABCD2345");
  });

  it("returns null for a blank (near-uniform) image", () => {
    const data = new Uint8Array(400 * 10).fill(255);
    expect(scanGrayscaleForCode(data, 400, 10, 1)).toBeNull();
  });

  it("returns null for a too-narrow strip", () => {
    expect(scanGrayscaleForCode(new Uint8Array(10), 10, 1, 1)).toBeNull();
  });

  it("does not return a non-tracking Code 128 payload", () => {
    // A valid Code 128 barcode whose text is NOT a PennFit tracking code.
    const { data, width, height } = barcodeBitmap("HELLO-WORLD-123", 3, 6);
    expect(scanGrayscaleForCode(data, width, height, 1)).toBeNull();
  });
});

describe("tryDecodeTrackingBarcode — fail-soft", () => {
  it("returns null for a PDF (vision scan handles those)", async () => {
    expect(
      await tryDecodeTrackingBarcode({
        bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]),
        contentType: "application/pdf",
      }),
    ).toBeNull();
  });

  it("returns null for empty media", async () => {
    expect(
      await tryDecodeTrackingBarcode({
        bytes: Buffer.alloc(0),
        contentType: "image/tiff",
      }),
    ).toBeNull();
  });

  it("returns null (never throws) when no rasterizer is available", async () => {
    // sharp isn't a dependency in this env → the optional import resolves
    // to null → fall through to the vision scan.
    expect(
      await tryDecodeTrackingBarcode({
        bytes: Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x01, 0x02]),
        contentType: "image/tiff",
      }),
    ).toBeNull();
  });
});
