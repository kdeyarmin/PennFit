import { describe, it, expect, vi } from "vitest";

import {
  code128ModuleCount,
  drawCode128,
  encodeCode128B,
  encodeCode128BValues,
} from "./code128";

describe("encodeCode128BValues", () => {
  it("emits Start B, per-char values, mod-103 checksum, and Stop", () => {
    // "AB": A=65→val33 (pos1), B=66→val34 (pos2).
    // checksum = (104 + 33*1 + 34*2) % 103 = 205 % 103 = 102.
    expect(encodeCode128BValues("AB")).toEqual([104, 33, 34, 102, 106]);
  });

  it("encodes digits and the dash used by tracking codes", () => {
    // Smoke test: the symbology must cover the whole PFS-XXXX alphabet.
    expect(() => encodeCode128BValues("PFS-7F3K2Q9X")).not.toThrow();
  });

  it("throws on an empty string", () => {
    expect(() => encodeCode128BValues("")).toThrow();
  });

  it("throws on a character outside code set B", () => {
    // Tab (ASCII 9) is below the printable range set B encodes.
    expect(() => encodeCode128BValues("A\tB")).toThrow(/code set B/);
  });
});

describe("code128ModuleCount", () => {
  it("is (symbols-1)*11 + 13 — every symbol is 11 modules, Stop is 13", () => {
    // "AB" → 5 symbols (start, 2 data, checksum, stop) → 4*11 + 13 = 57.
    expect(code128ModuleCount("AB")).toBe(57);
    // "PFS-7F3K2Q9X" (12 chars) → 15 symbols → 14*11 + 13 = 167.
    expect(code128ModuleCount("PFS-7F3K2Q9X")).toBe(167);
  });
});

describe("encodeCode128B", () => {
  it("starts with a bar and alternates bar/space within each symbol", () => {
    const runs = encodeCode128B("AB");
    expect(runs[0]!.bar).toBe(true);
    // Within a symbol's 6 widths, colour alternates bar,space,bar,...
    expect(runs[1]!.bar).toBe(false);
    expect(runs[2]!.bar).toBe(true);
  });
});

describe("drawCode128", () => {
  it("draws only the bar runs and returns total width incl. quiet zones", () => {
    const rect = vi.fn().mockReturnThis();
    const fill = vi.fn().mockReturnThis();
    const fakeDoc = {
      save: vi.fn().mockReturnThis(),
      restore: vi.fn().mockReturnThis(),
      fillColor: vi.fn().mockReturnThis(),
      rect,
      fill,
    };

    const width = drawCode128(
      fakeDoc as unknown as Parameters<typeof drawCode128>[0],
      "AB",
      { x: 0, y: 0, moduleWidth: 1 },
    );

    // 57 body modules + 2*10 quiet-zone modules at moduleWidth 1.
    expect(width).toBe(77);
    // One rect+fill per bar run. "AB" has 5 symbols: 4 six-width symbols
    // (3 bars each) + the 7-width stop (4 bars) = 16 bar runs.
    expect(rect).toHaveBeenCalledTimes(16);
    expect(fill).toHaveBeenCalledTimes(16);
  });
});
