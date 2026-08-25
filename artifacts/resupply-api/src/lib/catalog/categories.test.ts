import { describe, expect, it } from "vitest";

import {
  CATEGORY_CADENCE_DAYS,
  SUPPLY_CATEGORIES,
  isSupplyCategory,
} from "./categories";

describe("supply categories", () => {
  it("accepts every listed category", () => {
    for (const c of SUPPLY_CATEGORIES) expect(isSupplyCategory(c)).toBe(true);
  });

  it("rejects unknown values and non-strings", () => {
    expect(isSupplyCategory("widget")).toBe(false);
    expect(isSupplyCategory("")).toBe(false);
    expect(isSupplyCategory(null)).toBe(false);
    expect(isSupplyCategory(3)).toBe(false);
    // Case matters — the column stores what the API validated.
    expect(isSupplyCategory("Cushion")).toBe(false);
  });

  it("only defines cadences for categories that exist", () => {
    for (const key of Object.keys(CATEGORY_CADENCE_DAYS)) {
      expect(isSupplyCategory(key)).toBe(true);
    }
  });

  it("gives every defined cadence a positive day count", () => {
    for (const days of Object.values(CATEGORY_CADENCE_DAYS)) {
      expect(days).toBeGreaterThan(0);
    }
  });
});
