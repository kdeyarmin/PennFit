// Tests for the Stripe → Postgres catalog projection.
//
// This runs once per tenant at cutover, and a mistake here is expensive:
// a dropped row is a SKU that stops decrementing on fulfillment, and a
// mis-parsed count is a stock balance that starts wrong and then accrues
// ledgered movements on top of the error.

import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { projectStripeProduct } from "./import-stripe-catalog";

function product(over: Partial<Stripe.Product> = {}): Stripe.Product {
  return {
    id: "prod_abc",
    name: "Nasal cushion (M)",
    description: "Replacement cushion",
    active: true,
    metadata: { shop_sku: "CUSH-M", category: "cushion" },
    ...over,
  } as Stripe.Product;
}

describe("projectStripeProduct — identity", () => {
  it("keys on metadata.shop_sku, the warehouse identifier", () => {
    // This is the value fulfillments.item_sku / product_hcpcs_map /
    // shop_backorders all join on — not the Stripe product id.
    expect(projectStripeProduct(product())!.sku).toBe("CUSH-M");
  });

  it("falls back to the Stripe id rather than dropping an unlabelled row", () => {
    const p = product({ metadata: { category: "cushion" } });
    expect(projectStripeProduct(p)!.sku).toBe("prod_abc");
  });

  it("treats a whitespace-only sku as absent", () => {
    const p = product({ metadata: { shop_sku: "   " } });
    expect(projectStripeProduct(p)!.sku).toBe("prod_abc");
  });
});

describe("projectStripeProduct — stock", () => {
  it("carries a tracked count across", () => {
    const p = product({ metadata: { shop_sku: "S", stock_count: "12" } });
    expect(projectStripeProduct(p)!.stock_count).toBe(12);
  });

  it("keeps zero as zero, not untracked", () => {
    // 0 is "we have none", which is very different from "we don't count
    // this" — conflating them would silence a genuine stockout.
    const p = product({ metadata: { shop_sku: "S", stock_count: "0" } });
    expect(projectStripeProduct(p)!.stock_count).toBe(0);
  });

  it("maps a missing or unparseable count to untracked", () => {
    for (const raw of [undefined, "", "abc", "-3"]) {
      const p = product({
        metadata: {
          shop_sku: "S",
          ...(raw === undefined ? {} : { stock_count: raw }),
        },
      });
      expect(projectStripeProduct(p)!.stock_count).toBeNull();
    }
  });

  it("carries the reorder point, including an explicit zero", () => {
    const p = product({
      metadata: { shop_sku: "S", low_stock_threshold: "0" },
    });
    expect(projectStripeProduct(p)!.low_stock_threshold).toBe(0);
  });
});

describe("projectStripeProduct — descriptive fields", () => {
  it("carries manufacturer, model and category", () => {
    const p = product({
      metadata: {
        shop_sku: "S",
        category: "filter",
        manufacturer: "ResMed",
        model_number: "63052",
      },
    });
    const row = projectStripeProduct(p)!;
    expect(row.category).toBe("filter");
    expect(row.manufacturer).toBe("ResMed");
    expect(row.model_number).toBe("63052");
  });

  it("imports an archived product as inactive rather than skipping it", () => {
    // A backorder or substitution rule can still reference a retired SKU;
    // dropping it would leave those rows pointing at nothing.
    const row = projectStripeProduct(product({ active: false }))!;
    expect(row.active).toBe(false);
    expect(row.sku).toBe("CUSH-M");
  });

  it("nulls empty optional strings instead of storing blanks", () => {
    const p = product({
      description: null,
      metadata: { shop_sku: "S", manufacturer: "  ", category: "" },
    });
    const row = projectStripeProduct(p)!;
    expect(row.description).toBeNull();
    expect(row.manufacturer).toBeNull();
    expect(row.category).toBeNull();
  });
});
