import { describe, expect, it } from "vitest";
import {
  compareProposedSupplierCosts,
  PROVISIONAL_FEE_CATEGORIES,
  type ProvisionalSupplierComparison,
} from "./provisional-pricing";
const now = "2026-09-14T12:00:00Z";
function fixture(): ProvisionalSupplierComparison {
  return {
    currency: "USD",
    quantity: 5,
    destination: "17401",
    service: "Ground",
    suppliers: [
      {
        id: "supplier-a",
        supplierName: "Supplier A",
        source: "Supplier estimate",
        expiresAt: "2026-10-01T00:00:00Z",
        packCostCents: 1001,
        unitsPerPack: 3,
        minimumPacks: 1,
        availability: "available",
        leadTimeDays: 0,
        terms: "Unopened returns",
        fees: PROVISIONAL_FEE_CATEGORIES.map((category) => ({
          id: category,
          label: category,
          category,
          amountCents: 0,
          basis: "order",
          count: 1,
        })),
      },
    ],
  };
}
describe("provisional proposed item delivered cost", () => {
  it("compares actual whole-pack purchase outlay, surplus and per-order/parcel/pack fees without unit rounding", () => {
    const input = fixture(),
      supplier = input.suppliers[0];
    supplier.fees.find((f) => f.category === "dropship")!.amountCents = 300;
    Object.assign(supplier.fees.find((f) => f.category === "freight")!, {
      amountCents: 450,
      basis: "parcel",
      count: 2,
    });
    Object.assign(supplier.fees.find((f) => f.category === "handling")!, {
      amountCents: 100,
      basis: "pack",
    });
    input.suppliers.push({
      ...structuredClone(supplier),
      id: "supplier-b",
      supplierName: "Supplier B",
      packCostCents: 333,
      unitsPerPack: 1,
      minimumPacks: 6,
    });
    const result = compareProposedSupplierCosts(input, now);
    expect(result.suppliers[0]).toMatchObject({
      status: "estimated",
      packsToBuy: 2,
      purchasedUnits: 6,
      surplusUnits: 1,
      goodsCostCents: 2002,
      deliveredCostCents: 3402,
    });
    expect(result.suppliers[1]).toMatchObject({
      packsToBuy: 6,
      purchasedUnits: 6,
      surplusUnits: 1,
      goodsCostCents: 1998,
      deliveredCostCents: 3798,
    });
    expect(result).not.toHaveProperty("quote");
    expect(result).not.toHaveProperty("recommendedUnitPriceCents");
  });
  it("keeps missing or omitted delivery charges distinct from explicit known zero", () => {
    const input = fixture();
    input.suppliers[0].fees.find((f) => f.category === "freight")!.amountCents =
      null;
    expect(compareProposedSupplierCosts(input, now).suppliers[0]).toMatchObject(
      {
        status: "unknown",
        deliveredCostCents: null,
        knownDeliveredCostCents: 2002,
      },
    );
    input.suppliers[0].fees = input.suppliers[0].fees.filter(
      (f) => f.category !== "freight",
    );
    expect(
      compareProposedSupplierCosts(input, now).suppliers[0].missing,
    ).toContain("freight cost");
    input.suppliers[0].fees.push({
      id: "freight",
      label: "freight",
      category: "freight",
      amountCents: 0,
      basis: "order",
      count: 1,
    });
    expect(compareProposedSupplierCosts(input, now).suppliers[0]).toMatchObject(
      { status: "estimated", deliveredCostCents: 2002 },
    );
  });
  it("does not double count fees explicitly included in a purchase pack", () => {
    const input = fixture();
    Object.assign(
      input.suppliers[0].fees.find((f) => f.category === "freight")!,
      { amountCents: null, includedIn: "pack" },
    );
    const result = compareProposedSupplierCosts(input, now).suppliers[0];
    expect(result.deliveredCostCents).toBe(2002);
    expect(result.fees.find((f) => f.id === "freight")).toMatchObject({
      included: true,
      extendedCostCents: 0,
    });
  });
  it("never treats expired evidence or absent delivery assumptions as a complete current estimate", () => {
    const input = fixture();
    input.suppliers[0].expiresAt = now;
    expect(compareProposedSupplierCosts(input, now).suppliers[0]).toMatchObject(
      {
        status: "expired",
        deliveredCostCents: null,
        knownDeliveredCostCents: 2002,
      },
    );
    input.suppliers[0].expiresAt = null;
    input.destination = "";
    input.service = "";
    expect(
      compareProposedSupplierCosts(input, now).suppliers[0].missing,
    ).toEqual(
      expect.arrayContaining([
        "Evidence expiry",
        "Delivery destination",
        "Delivery service",
      ]),
    );
  });
  it("rejects fractional packs, duplicate fee identities and unsafe totals", () => {
    const input = fixture();
    input.suppliers[0].unitsPerPack = 1.5;
    expect(() => compareProposedSupplierCosts(input, now)).toThrow(
      "whole number",
    );
    input.suppliers[0].unitsPerPack = 1;
    input.suppliers[0].fees.push(input.suppliers[0].fees[0]);
    expect(() => compareProposedSupplierCosts(input, now)).toThrow(
      "unique charge",
    );
    input.suppliers[0].fees.pop();
    input.suppliers[0].packCostCents = Number.MAX_SAFE_INTEGER;
    expect(() => compareProposedSupplierCosts(input, now)).toThrow();
  });
});
