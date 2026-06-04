import { describe, expect, it } from "vitest";

import { defaultIconPng, defaultLogoPng } from "./assets";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Minimal IHDR reader — width/height/bit-depth/color-type. */
function readIhdr(png: Buffer) {
  // IHDR data starts at byte 16 (8 sig + 4 len + 4 "IHDR").
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
  };
}

describe("apple-wallet assets", () => {
  it("icon is a branded 87×87 RGBA PNG", () => {
    const png = defaultIconPng();
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    const ihdr = readIhdr(png);
    expect(ihdr).toMatchObject({
      width: 87,
      height: 87,
      bitDepth: 8,
      colorType: 6,
    });
    // Sanity: a real asset is more than a 1×1 placeholder.
    expect(png.length).toBeGreaterThan(200);
  });

  it("logo is a branded 120×120 RGBA PNG", () => {
    const png = defaultLogoPng();
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    const ihdr = readIhdr(png);
    expect(ihdr).toMatchObject({
      width: 120,
      height: 120,
      bitDepth: 8,
      colorType: 6,
    });
    expect(png.length).toBeGreaterThan(200);
  });

  it("icon and logo are distinct assets", () => {
    expect(defaultIconPng().equals(defaultLogoPng())).toBe(false);
  });
});
