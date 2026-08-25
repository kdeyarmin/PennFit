// Behavioral tests for the stock-movement conversion.
//
// This is the one place the catalog page turns operator input into a
// number that changes inventory, and the two inputs mean different things:
// a physical COUNT is an absolute total, everything else is a quantity
// that moved. Conflating them silently corrupts on-hand, so each branch is
// exercised here rather than asserted by reading the page's source.

import { describe, expect, it } from "vitest";

import { InvalidMovementError, movementDelta } from "./catalog-movement";

describe("movementDelta — quantity reasons", () => {
  it("adds for stock arriving", () => {
    expect(movementDelta("receipt", 12, 3)).toBe(12);
    expect(movementDelta("return", 1, 3)).toBe(1);
  });

  it("subtracts for stock leaving", () => {
    expect(movementDelta("dispense", 2, 10)).toBe(-2);
    expect(movementDelta("adjustment", 5, 10)).toBe(-5);
  });

  it("ignores current stock for a quantity movement", () => {
    // The delta is what moved, not where it lands — the server does the
    // arithmetic under its lock, and duplicating it here would race.
    expect(movementDelta("receipt", 4, 0)).toBe(4);
    expect(movementDelta("receipt", 4, 999)).toBe(4);
    expect(movementDelta("receipt", 4, null)).toBe(4);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => movementDelta("receipt", 0, 5)).toThrow(InvalidMovementError);
    expect(() => movementDelta("dispense", -1, 5)).toThrow(
      InvalidMovementError,
    );
  });
});

describe("movementDelta — physical count", () => {
  it("rebases a count onto the delta that reaches it", () => {
    // Counted 8 with 10 on the book → two went missing.
    expect(movementDelta("count", 8, 10)).toBe(-2);
    // Counted 12 with 10 on the book → two were found.
    expect(movementDelta("count", 12, 10)).toBe(2);
  });

  it("allows counting down to zero", () => {
    expect(movementDelta("count", 0, 4)).toBe(-4);
  });

  it("treats an untracked SKU as starting from zero", () => {
    // The first count on an untracked SKU establishes the balance.
    expect(movementDelta("count", 7, null)).toBe(7);
  });

  it("refuses a count that matches the book", () => {
    // A zero delta is not a movement; the RPC rejects it too, so catching
    // it here gives the operator a sentence instead of a 500.
    expect(() => movementDelta("count", 10, 10)).toThrow(InvalidMovementError);
    expect(() => movementDelta("count", 0, null)).toThrow(InvalidMovementError);
  });

  it("refuses a negative count", () => {
    expect(() => movementDelta("count", -1, 5)).toThrow(InvalidMovementError);
  });
});

describe("movementDelta — input hygiene", () => {
  it("refuses a non-integer, including NaN from an empty field", () => {
    expect(() => movementDelta("receipt", 1.5, 0)).toThrow(
      InvalidMovementError,
    );
    // Number.parseInt("") is NaN — the empty-input path.
    expect(() => movementDelta("receipt", Number.NaN, 0)).toThrow(
      InvalidMovementError,
    );
  });

  it("never returns zero", () => {
    // Every reachable result must be a real movement, because the RPC
    // rejects a zero delta outright.
    for (const [reason, amount, stock] of [
      ["receipt", 3, 0],
      ["dispense", 3, 9],
      ["count", 1, 9],
      ["count", 9, 1],
    ] as const) {
      expect(movementDelta(reason, amount, stock)).not.toBe(0);
    }
  });
});
