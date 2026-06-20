import { describe, it, expect } from "vitest";

import { formatUsPhone } from "./format-phone";

describe("formatUsPhone — empty / blank inputs", () => {
  it("returns empty string for empty input", () => {
    expect(formatUsPhone("")).toBe("");
  });
  it("returns empty string for non-numeric input", () => {
    expect(formatUsPhone("abc")).toBe("");
  });
});

describe("formatUsPhone — international prefix passthrough", () => {
  it("passes through a leading + untouched", () => {
    expect(formatUsPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
  });
  it("passes through +1 numbers untouched", () => {
    expect(formatUsPhone("+15551234567")).toBe("+15551234567");
  });
});

describe("formatUsPhone — progressive formatting of 10-digit US numbers", () => {
  it.each([
    ["5", "(5"],
    ["555", "(555"],
    ["5551", "(555) 1"],
    ["555123", "(555) 123"],
    ["5551234", "(555) 123-4"],
    ["5551234567", "(555) 123-4567"],
    ["(555) 123-4567", "(555) 123-4567"],
    ["555-123-4567", "(555) 123-4567"],
  ])("formats %s → %s", (input, expected) => {
    expect(formatUsPhone(input)).toBe(expected);
  });
});

describe("formatUsPhone — 11-digit numbers with leading '1' country code", () => {
  it("drops the leading 1 and formats the local 10 digits", () => {
    expect(formatUsPhone("15551234567")).toBe("(555) 123-4567");
  });
});

describe("formatUsPhone — boundary: extra digits truncate to 10", () => {
  it("keeps only the first 10 digits", () => {
    expect(formatUsPhone("9991234567890")).toBe("(999) 123-4567");
  });
});
