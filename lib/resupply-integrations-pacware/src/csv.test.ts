import { describe, it, expect } from "vitest";

import { parseCsv, toCsv, safeCsvCell, normalizeHeader } from "./csv";

describe("parseCsv", () => {
  it("parses a simple grid", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas and quotes", () => {
    expect(parseCsv('name,note\n"Doe, John","said ""hi"""')).toEqual([
      ["name", "note"],
      ["Doe, John", 'said "hi"'],
    ]);
  });

  it("handles embedded newlines inside quotes", () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  it("normalises CRLF, LF, and lone CR line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r3,4\n5,6")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("strips a leading UTF-8 BOM", () => {
    expect(parseCsv("﻿a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("ignores a trailing newline (no phantom row)", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns [] for empty / whitespace-only input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("   \n  ")).toEqual([]);
    expect(parseCsv("﻿")).toEqual([]);
  });

  it("preserves empty trailing cells", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("safeCsvCell", () => {
  it("neutralises formula-injection prefixes", () => {
    expect(safeCsvCell("=1+1")).toBe("'=1+1");
    expect(safeCsvCell("+49")).toBe("'+49");
    expect(safeCsvCell("-3")).toBe("'-3");
    expect(safeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // The `"` inside also triggers RFC 4180 quoting, so the guarded
    // value is wrapped and its inner quotes doubled.
    expect(safeCsvCell('=HYPERLINK("http://evil")')).toBe(
      `"'=HYPERLINK(""http://evil"")"`,
    );
  });

  it("quotes cells with commas, quotes, or newlines", () => {
    expect(safeCsvCell("a,b")).toBe('"a,b"');
    expect(safeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(safeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("returns empty string for null/undefined", () => {
    expect(safeCsvCell(null)).toBe("");
    expect(safeCsvCell(undefined)).toBe("");
  });

  it("stringifies numbers and dates", () => {
    expect(safeCsvCell(42)).toBe("42");
    expect(safeCsvCell(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
});

describe("toCsv", () => {
  it("emits CRLF-terminated rows with a trailing CRLF", () => {
    const out = toCsv(["a", "b"], [["1", "2"]]);
    expect(out).toBe("a,b\r\n1,2\r\n");
  });

  it("round-trips through parseCsv", () => {
    const csv = toCsv(["name", "note"], [["Doe, John", 'said "hi"']]);
    expect(parseCsv(csv)).toEqual([
      ["name", "note"],
      ["Doe, John", 'said "hi"'],
    ]);
  });
});

describe("normalizeHeader", () => {
  it("lowercases and strips non-alphanumerics", () => {
    expect(normalizeHeader("Pacware ID")).toBe("pacwareid");
    expect(normalizeHeader("pacware_id")).toBe("pacwareid");
    expect(normalizeHeader("PacwareID")).toBe("pacwareid");
    expect(normalizeHeader("Postal Code")).toBe("postalcode");
  });
});
