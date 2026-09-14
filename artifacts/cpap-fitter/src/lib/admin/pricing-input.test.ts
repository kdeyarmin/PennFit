import { describe, expect, it } from "vitest";
import {
  parsePricingMoney,
  parsePricingPercent,
  pricingQuantity,
  formatPricingMoney,
  pricingExpiry,
} from "./pricing-input";

describe("pricing entry", () => {
  it("preserves an unknown amount separately from known zero", () => {
    expect(parsePricingMoney("")).toBeNull();
    expect(parsePricingMoney("0")).toBe(0);
    expect(formatPricingMoney(null)).toBe("Not available");
    expect(formatPricingMoney(0)).toBe("$0.00");
  });
  it("accepts exact cents without rounding a lower price into an approved amount", () => {
    expect(parsePricingMoney("95.27")).toBe(9527);
    expect(parsePricingMoney("95.269")).toBeNull();
    for (const input of ["95abc", "1e3", "-1", "Infinity", "0x10", "1,000.00"])
      expect(parsePricingMoney(input)).toBeNull();
  });
  it("validates margin percentages and whole item quantities", () => {
    expect(parsePricingPercent("40.01")).toBe(4001);
    expect(parsePricingPercent("100")).toBeNull();
    expect(pricingQuantity("2")).toBe(2);
    expect(pricingQuantity("2.9")).toBeNull();
    expect(pricingQuantity("0")).toBeNull();
  });
  it("keeps patient quantities capped while allowing explicitly bounded internal simulations", () => {
    expect(pricingQuantity("99")).toBe(99);
    expect(pricingQuantity("100")).toBeNull();
    expect(pricingQuantity("10000", 10_000)).toBe(10_000);
    expect(pricingQuantity("10001", 10_000)).toBeNull();
    expect(pricingQuantity("1.5", 10_000)).toBeNull();
  });
  it("refuses rolled-over calendar dates", () => {
    expect(pricingExpiry("2026-02-30")).toBeNull();
    expect(pricingExpiry("2026-02-28")).toBe("2026-02-28T23:59:59.999Z");
  });
});
