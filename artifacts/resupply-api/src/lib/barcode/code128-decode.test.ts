// Round-trip tests for the Code 128 decoder. Rows are rendered from the
// encoder (the source of truth) and decoded back, including reversed,
// corrupted, and sub-pixel-stretched scans — no image dependency needed.

import { describe, it, expect } from "vitest";

import { encodeCode128B } from "./code128";
import { decodeCode128FromBinaryRow } from "./code128-decode";

/** Render a value to a binarized row at `px` pixels/module, with quiet zones. */
function renderRow(value: string, px: number, quietModules = 10): boolean[] {
  const row: boolean[] = [];
  const pushN = (n: number, bar: boolean) => {
    for (let i = 0; i < n; i += 1) row.push(bar);
  };
  pushN(quietModules * px, false);
  for (const run of encodeCode128B(value)) pushN(run.modules * px, run.bar);
  pushN(quietModules * px, false);
  return row;
}

/** Nearest-neighbour resample to a (possibly fractional) scale — simulates
 *  a scan where bars don't land on whole-pixel module boundaries. */
function resample(row: boolean[], factor: number): boolean[] {
  const out: boolean[] = [];
  const n = Math.round(row.length * factor);
  for (let i = 0; i < n; i += 1) {
    out.push(row[Math.min(row.length - 1, Math.floor(i / factor))]!);
  }
  return out;
}

const CODES = [
  "PFS-7F3K2Q9X",
  "PFS-ABCD2345",
  "PFS-WXYZ6789",
  "A",
  "HELLO-WORLD-123",
];

describe("decodeCode128FromBinaryRow", () => {
  it("round-trips encoded codes at 1–4 px/module", () => {
    for (const code of CODES) {
      for (const px of [1, 2, 3, 4]) {
        expect(decodeCode128FromBinaryRow(renderRow(code, px))).toBe(code);
      }
    }
  });

  it("decodes a reversed row (fax placed/scanned backwards)", () => {
    const code = "PFS-7F3K2Q9X";
    const reversed = [...renderRow(code, 3)].reverse();
    expect(decodeCode128FromBinaryRow(reversed)).toBe(code);
  });

  it("decodes a sub-pixel-stretched scan (non-integer module width)", () => {
    const code = "PFS-7F3K2Q9X";
    const stretched = resample(renderRow(code, 4), 1.37);
    expect(decodeCode128FromBinaryRow(stretched)).toBe(code);
  });

  it("returns null for a blank row (no barcode)", () => {
    expect(decodeCode128FromBinaryRow(new Array(200).fill(false))).toBeNull();
    expect(decodeCode128FromBinaryRow(new Array(200).fill(true))).toBeNull();
  });

  it("returns null (never a wrong code) when the symbol is corrupted", () => {
    const row = renderRow("PFS-7F3K2Q9X", 4);
    // Blank a 40px band through the middle of the bars — destroys the
    // run structure so no valid Code 128 symbol can be read.
    const mid = Math.floor(row.length / 2);
    for (let i = mid - 20; i < mid + 20; i += 1) row[i] = false;
    expect(decodeCode128FromBinaryRow(row)).toBeNull();
  });

  it("returns null for an empty row", () => {
    expect(decodeCode128FromBinaryRow([])).toBeNull();
  });
});
