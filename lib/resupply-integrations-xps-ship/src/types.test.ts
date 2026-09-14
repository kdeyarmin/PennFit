import { describe, expect, it } from "vitest";
import { parseRates, parseShipment } from "./types";

describe("carrier cost parsing", () => {
  it("excludes missing and malformed rates while preserving explicitly free rates", () => {
    const rates = parseRates({
      quotes: [undefined, "", "N/A", "7.00USD", -1, "-1", 0, "8.75"].map(
        (totalAmount, i) => ({
          carrierCode: "carrier",
          serviceCode: String(i),
          totalAmount,
        }),
      ),
    });
    expect(rates.map((r) => r.totalCents)).toEqual([0, 875]);
  });
  it("does not treat a blank booked cost as a zero-cost shipment", () => {
    expect(
      parseShipment({ bookNumber: "fixture", totalShippingCost: "" })
        ?.totalCostCents,
    ).toBeNull();
  });
});
