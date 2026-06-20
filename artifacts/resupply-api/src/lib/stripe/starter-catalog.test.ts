import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import {
  STARTER_CATALOG,
  seedStarterCatalog,
  type StarterProduct,
} from "./starter-catalog";
import { SHOP_CATEGORIES } from "./products-meta";

const ONE: StarterProduct[] = [
  {
    sku: "test-mask",
    name: "Test Mask",
    description: "A test mask.",
    category: "mask",
    tagline: "Test",
    replacementHint: "Replace every 3 months",
    unitAmountCents: 9900,
  },
];

function makeStripe(
  opts: {
    existing?: { id: string; default_price: string | null };
    retrievedPrice?: Partial<Stripe.Price>;
  } = {},
) {
  const search = vi.fn(
    async (_query: unknown, _ro?: Stripe.RequestOptions) => ({
      data: opts.existing ? [opts.existing] : [],
    }),
  );
  const productCreate = vi.fn(
    async (_params: unknown, _ro?: Stripe.RequestOptions) => ({
      id: "prod_new",
      default_price: null,
    }),
  );
  const productUpdate = vi.fn(
    async (id: string, _params: unknown, _ro?: Stripe.RequestOptions) => ({
      id,
      default_price: opts.existing?.default_price ?? null,
    }),
  );
  const priceRetrieve = vi.fn(
    async (_id: string, _params?: unknown, _ro?: Stripe.RequestOptions) => ({
      active: true,
      unit_amount: 9900,
      currency: "usd",
      type: "one_time",
      ...opts.retrievedPrice,
    }),
  );
  const priceCreate = vi.fn(
    async (_params: unknown, _ro?: Stripe.RequestOptions) => ({
      id: "price_new",
    }),
  );
  const stripe = {
    products: { search, create: productCreate, update: productUpdate },
    prices: { retrieve: priceRetrieve, create: priceCreate },
  } as unknown as Stripe;
  return {
    stripe,
    search,
    productCreate,
    productUpdate,
    priceRetrieve,
    priceCreate,
  };
}

describe("seedStarterCatalog", () => {
  it("creates products + prices for a fresh account", async () => {
    const { stripe, productCreate, priceCreate } = makeStripe();
    const result = await seedStarterCatalog(stripe, { catalog: ONE });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      pricesCreated: 1,
      total: 1,
    });
    expect(productCreate).toHaveBeenCalledOnce();
    expect(priceCreate).toHaveBeenCalledOnce();
  });

  it("forwards the connected-account request options to every Stripe call", async () => {
    const ro = { stripeAccount: "acct_123" } as Stripe.RequestOptions;
    const { stripe, search, productCreate, productUpdate, priceCreate } =
      makeStripe();
    await seedStarterCatalog(stripe, { catalog: ONE, requestOptions: ro });
    expect(search).toHaveBeenCalledWith(expect.anything(), ro);
    expect(productCreate).toHaveBeenCalledWith(expect.anything(), ro);
    // default_price repoint after the new price is created.
    expect(productUpdate).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      ro,
    );
    expect(priceCreate).toHaveBeenCalledWith(expect.anything(), ro);
  });

  it("updates an existing SKU and reuses a still-matching price", async () => {
    const { stripe, productCreate, productUpdate, priceCreate } = makeStripe({
      existing: { id: "prod_x", default_price: "price_x" },
      retrievedPrice: { unit_amount: 9900 }, // matches ONE's amount
    });
    const result = await seedStarterCatalog(stripe, { catalog: ONE });
    expect(result).toEqual({
      created: 0,
      updated: 1,
      pricesCreated: 0,
      total: 1,
    });
    expect(productCreate).not.toHaveBeenCalled();
    // Only the metadata/name update — no default_price repoint.
    expect(productUpdate).toHaveBeenCalledOnce();
    expect(priceCreate).not.toHaveBeenCalled();
  });

  it("rotates the price when the amount changed", async () => {
    const { stripe, priceCreate, productUpdate } = makeStripe({
      existing: { id: "prod_x", default_price: "price_x" },
      retrievedPrice: { unit_amount: 1 }, // differs from ONE's 9900
    });
    const result = await seedStarterCatalog(stripe, { catalog: ONE });
    expect(result).toEqual({
      created: 0,
      updated: 1,
      pricesCreated: 1,
      total: 1,
    });
    expect(priceCreate).toHaveBeenCalledOnce();
    // metadata update + default_price repoint = two product updates.
    expect(productUpdate).toHaveBeenCalledTimes(2);
  });

  it("seeds the full default catalog when none is injected", async () => {
    const { stripe } = makeStripe();
    const result = await seedStarterCatalog(stripe);
    expect(result.total).toBe(STARTER_CATALOG.length);
    expect(result.created).toBe(STARTER_CATALOG.length);
  });
});

describe("STARTER_CATALOG", () => {
  it("is well-formed: unique SKUs, valid categories, positive prices", () => {
    expect(STARTER_CATALOG.length).toBeGreaterThanOrEqual(20);
    const skus = STARTER_CATALOG.map((p) => p.sku);
    expect(new Set(skus).size).toBe(skus.length);
    for (const p of STARTER_CATALOG) {
      expect(SHOP_CATEGORIES, p.sku).toContain(p.category);
      expect(p.unitAmountCents, p.sku).toBeGreaterThan(0);
      expect(p.name.length, p.sku).toBeGreaterThan(0);
      expect(p.description.length, p.sku).toBeGreaterThan(0);
    }
  });

  it("gives every bundle a contents list", () => {
    for (const p of STARTER_CATALOG.filter((x) => x.category === "bundle")) {
      expect(p.bundleContents?.length ?? 0, p.sku).toBeGreaterThan(0);
    }
  });

  it("stays brand-neutral (no manufacturer names in copy)", () => {
    // The starter catalog is shown to EVERY tenant, so it must not carry
    // any one brand's voice. Guard against the common CPAP brand names.
    const banned =
      /resmed|philips|respironics|react\s*health|airfit|airsense|dreamwear|fisher\s*&?\s*paykel|\bf&p\b/i;
    for (const p of STARTER_CATALOG) {
      const blob = `${p.name} ${p.description} ${p.tagline} ${(p.bundleContents ?? []).join(" ")}`;
      expect(banned.test(blob), `${p.sku} contains a brand name`).toBe(false);
    }
  });
});
