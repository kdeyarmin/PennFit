import { describe, expect, it } from "vitest";

import {
  SHIP_GRACE_DAYS,
  resolveShipGraceDays,
} from "./resupply-cycle-sweep.js";

describe("resolveShipGraceDays", () => {
  it("uses the built-in default for a blank or unset value", () => {
    for (const raw of [null, "", "   "]) {
      expect(resolveShipGraceDays(raw)).toBe(SHIP_GRACE_DAYS);
    }
  });

  it("uses the built-in default for an unparseable value", () => {
    // A typo in System Configuration must not change the ladder.
    for (const raw of ["fourteen", "abc", "--", "NaN"]) {
      expect(resolveShipGraceDays(raw)).toBe(SHIP_GRACE_DAYS);
    }
  });

  it("accepts a value inside the range", () => {
    expect(resolveShipGraceDays("21")).toBe(21);
    expect(resolveShipGraceDays(" 7 ")).toBe(7);
  });

  it("floors a value that would call a normal turnaround a lost shipment", () => {
    // Below three days, a warehouse that batches picks overnight would
    // have every order "assumed shipped" before it actually ships.
    expect(resolveShipGraceDays("0")).toBe(3);
    expect(resolveShipGraceDays("-30")).toBe(3);
    expect(resolveShipGraceDays("1")).toBe(3);
  });

  it("caps a value that would leave a patient waiting months", () => {
    expect(resolveShipGraceDays("365")).toBe(90);
    expect(resolveShipGraceDays("100000")).toBe(90);
  });

  it("truncates a decimal rather than rejecting it", () => {
    expect(resolveShipGraceDays("14.9")).toBe(14);
  });
});
