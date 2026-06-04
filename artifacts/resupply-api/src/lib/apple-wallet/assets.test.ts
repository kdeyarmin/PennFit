import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { defaultIconPng, defaultLogoPng } from "./assets";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function idatPayload(png: Buffer): Buffer {
  let offset = 8; // after signature
  const parts: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > png.length) break;
    if (type === "IDAT") parts.push(png.subarray(dataStart, dataEnd));
    offset = dataEnd + 4; // skip CRC
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}

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

function expectDecodesAsNonBlankPng(png: Buffer) {
  // Helps catch truncated base64 pastes and all-transparent placeholders.
  expect(png.subarray(-12)).toEqual(PNG_IEND);
  const idat = idatPayload(png);
  expect(idat.length).toBeGreaterThan(0);
  const raw = inflateSync(idat);
  expect(raw.some((b) => b !== 0)).toBe(true);
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
    expectDecodesAsNonBlankPng(png);
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
