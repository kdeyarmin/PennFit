import { describe, expect, it } from "vitest";

import { isDocumentPageRangeValid } from "./admin-referral-reviews";

// Regression coverage for the referral-accept page-range guard: an
// included document must carry a sane range (both bounds >= 1 and the
// last page no earlier than the first). Before the fix an inverted range
// (e.g. 10–3) passed the per-bound `>= 1` filter and was sent to the API.
describe("isDocumentPageRangeValid", () => {
  it("accepts a normal forward range", () => {
    expect(
      isDocumentPageRangeValid({ include: true, pageStart: "1", pageEnd: "4" }),
    ).toBe(true);
  });

  it("accepts a single-page range (start === end)", () => {
    expect(
      isDocumentPageRangeValid({ include: true, pageStart: "3", pageEnd: "3" }),
    ).toBe(true);
  });

  it("rejects an inverted range (end < start)", () => {
    expect(
      isDocumentPageRangeValid({
        include: true,
        pageStart: "10",
        pageEnd: "3",
      }),
    ).toBe(false);
  });

  it("rejects a zero / sub-1 page bound", () => {
    expect(
      isDocumentPageRangeValid({ include: true, pageStart: "0", pageEnd: "2" }),
    ).toBe(false);
  });

  it("rejects a blank / non-numeric bound", () => {
    expect(
      isDocumentPageRangeValid({ include: true, pageStart: "", pageEnd: "2" }),
    ).toBe(false);
    expect(
      isDocumentPageRangeValid({
        include: true,
        pageStart: "abc",
        pageEnd: "2",
      }),
    ).toBe(false);
  });

  it("treats an excluded document as valid regardless of its range", () => {
    // Not included → never sent to the API, so its (possibly garbage)
    // range must not block accept.
    expect(
      isDocumentPageRangeValid({
        include: false,
        pageStart: "10",
        pageEnd: "3",
      }),
    ).toBe(true);
  });
});
