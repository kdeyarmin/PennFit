// Tests for shop-inventory-api.ts — the price-edit slice.
//
// Coverage:
//   parsePriceDraftToCents — dollars-string → cents contract (string
//     math, no float rounding), bounds mirror the server schema
//   centsToPriceDraft      — canonical two-decimal draft, inverse of
//     the parser for in-bounds values
//   patchShopProductPrice  — URL/method/body wire shape, 503 →
//     InventoryUnavailableError, response row parsing

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  centsToPriceDraft,
  InventoryUnavailableError,
  parsePriceDraftToCents,
  patchShopProductPrice,
} from "./shop-inventory-api";

describe("parsePriceDraftToCents", () => {
  test.each([
    ["19.99", 1999],
    ["$19.99", 1999],
    ["1,299.50", 129950],
    ["49", 4900],
    ["49.5", 4950],
    ["0.50", 50],
    [" 12.00 ", 1200],
    ["100000", 10_000_000],
  ])("parses %s to %i cents", (draft, cents) => {
    expect(parsePriceDraftToCents(draft)).toEqual({ ok: true, cents });
  });

  // The reason parsing is string math: parseFloat("1.15") * 100 is
  // 114.99999999999999, which truncates to the wrong price.
  test("never loses a cent to float rounding", () => {
    expect(parsePriceDraftToCents("1.15")).toEqual({ ok: true, cents: 115 });
    expect(parsePriceDraftToCents("4.01")).toEqual({ ok: true, cents: 401 });
  });

  test.each([["abc"], [""], ["19.999"], ["-5"], ["12.3.4"], ["$"]])(
    "rejects malformed input %s",
    (draft) => {
      const parsed = parsePriceDraftToCents(draft);
      expect(parsed.ok).toBe(false);
    },
  );

  test("rejects amounts below the Stripe $0.50 minimum", () => {
    const parsed = parsePriceDraftToCents("0.49");
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.reason).toContain("$0.50");
  });

  test("rejects amounts above the $100,000 cap", () => {
    const parsed = parsePriceDraftToCents("100000.01");
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.reason).toContain("$100,000");
  });
});

describe("centsToPriceDraft", () => {
  test.each([
    [1999, "19.99"],
    [50, "0.50"],
    [4900, "49.00"],
    [null, ""],
  ])("renders %s cents as %s", (cents, draft) => {
    expect(centsToPriceDraft(cents)).toBe(draft);
  });

  test("round-trips through the parser", () => {
    for (const cents of [50, 199, 1999, 129950, 10_000_000]) {
      const draft = centsToPriceDraft(cents);
      expect(parsePriceDraftToCents(draft)).toEqual({ ok: true, cents });
    }
  });
});

describe("patchShopProductPrice", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  test("PATCHes the price endpoint with { unitAmountCents }", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        product: {
          id: "prod_x",
          name: "Test SKU",
          category: "mask",
          price: { unitAmount: 2499, currency: "usd" },
          stockCount: 3,
          lowStockThreshold: null,
        },
      }),
    });

    const row = await patchShopProductPrice("prod_x", 2499);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/products/prod_x/price");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ unitAmountCents: 2499 });
    // Response parses to the same row shape the table renders.
    expect(row).toEqual({
      id: "prod_x",
      name: "Test SKU",
      category: "mask",
      priceCents: 2499,
      currency: "usd",
      stockCount: 3,
      lowStockThreshold: null,
    });
  });

  test("throws InventoryUnavailableError on 503 (preview mode)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "stripe_not_configured" }),
    });

    await expect(patchShopProductPrice("prod_x", 2499)).rejects.toBeInstanceOf(
      InventoryUnavailableError,
    );
  });

  test("throws ApiError on other failures", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      url: "/resupply-api/admin/shop/products/prod_x/price",
      json: async () => ({ error: "product_not_in_catalog" }),
    });

    await expect(patchShopProductPrice("prod_x", 2499)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
