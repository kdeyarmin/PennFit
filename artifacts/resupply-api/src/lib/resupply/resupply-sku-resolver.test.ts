import { describe, expect, it } from "vitest";

import {
  type ProductCandidate,
  descriptionScore,
  suggestProductForSupply,
} from "./resupply-sku-resolver";

const CATALOG: ProductCandidate[] = [
  {
    id: "prod_n30i",
    name: "ResMed AirFit N30i Mask Cushion",
    category: "cushion",
  },
  {
    id: "prod_p10",
    name: "ResMed AirFit P10 Pillow Cushion",
    category: "cushion",
  },
  {
    id: "prod_filter",
    name: "AirSense 11 Standard Filter",
    category: "filter",
  },
  {
    id: "prod_tubing",
    name: "ClimateLineAir Heated Tubing",
    category: "tubing",
  },
];

describe("descriptionScore", () => {
  it("scores full token overlap as 1", () => {
    expect(
      descriptionScore("AirFit N30i", "ResMed AirFit N30i Mask Cushion"),
    ).toBe(1);
  });

  it("scores partial overlap as a fraction", () => {
    // tokens: airfit, n30i — only "airfit" present → 0.5
    expect(descriptionScore("AirFit N30i", "AirFit P10 Pillow")).toBe(0.5);
  });

  it("scores an empty/garbage description as 0", () => {
    expect(descriptionScore("", "AirFit N30i")).toBe(0);
    expect(descriptionScore("!!!", "AirFit N30i")).toBe(0);
  });
});

describe("suggestProductForSupply", () => {
  it("returns an exact match when the description clearly identifies a product", () => {
    const out = suggestProductForSupply(
      { category: "cushion", description: "AirFit N30i" },
      CATALOG,
    );
    expect(out).toEqual({
      productId: "prod_n30i",
      confidence: "exact",
      alternativeIds: [],
    });
  });

  it("falls back to the single product in the category when description is missing", () => {
    const out = suggestProductForSupply(
      { category: "filter", description: null },
      CATALOG,
    );
    expect(out).toEqual({
      productId: "prod_filter",
      confidence: "category",
      alternativeIds: [],
    });
  });

  it("returns ambiguous (no productId) when several products share the category and nothing disambiguates", () => {
    const out = suggestProductForSupply(
      { category: "cushion", description: null },
      CATALOG,
    );
    expect(out.productId).toBeNull();
    expect(out.confidence).toBe("ambiguous");
    expect(out.alternativeIds.sort()).toEqual(["prod_n30i", "prod_p10"]);
  });

  it("returns none when the catalog is empty", () => {
    expect(
      suggestProductForSupply(
        { category: "mask", description: "AirFit N30i" },
        [],
      ),
    ).toEqual({ productId: null, confidence: "none", alternativeIds: [] });
  });

  it("returns none when nothing in the category and the description doesn't match", () => {
    const out = suggestProductForSupply(
      { category: "humidifier_chamber", description: "Standard Water Tub" },
      CATALOG,
    );
    expect(out.productId).toBeNull();
    expect(out.confidence).toBe("none");
  });

  it("does not let a weak description override a clean category fallback's safety (stays conservative)", () => {
    // "Mask" alone overlaps several names weakly (< threshold) → no exact;
    // and there is no 'mask' category in the catalog → none, not a guess.
    const out = suggestProductForSupply(
      { category: "mask", description: "Mask" },
      CATALOG,
    );
    expect(out.productId).toBeNull();
  });
});
