// Unit tests for the inventory reservation helper — focused on the two
// behaviours that protect the checkout money-path:
//
//   1. FAIL-OPEN: any thrown error (Stripe down, RPC error) must NOT block a
//      sale — reserveCartInventory returns { ok: true, reservationIds: [] }.
//   2. OVERSOLD-RELEASE: when the RPC cleanly reports an oversell on a later
//      SKU, the holds taken for earlier SKUs are released (no leak) and the
//      result is { ok: false, oversoldProductId }.
//
// The supabase org-scoped client and the Stripe client are both mocked so the
// test never touches a network or DB.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Supabase org-scoped client mock ───────────────────────────────────────────
// We build a hand-rolled stub exposing exactly the chain the helper uses:
//   raw().schema("resupply").rpc("reserve_inventory", args)        → reserve
//   from(...).update(...).in("id", ids).eq("status","active")      → release
// `updateInMock` records the (column, ids) the helper passed to `.in(...)`;
// the trailing `.eq(...)` resolves to the staged result.
const rpcMock = vi.fn();
const updateInMock = vi.fn();

function makeSupabaseStub() {
  return {
    raw: () => ({
      schema: () => ({
        rpc: (...args: unknown[]) => rpcMock(...args),
      }),
    }),
    from: () => ({
      update: () => ({
        in: (...args: unknown[]) => {
          // releaseReservationIds: .in("id", ids).eq("status","active")
          // attachSessionToReservations: .in("id", ids) (awaited directly)
          const result = updateInMock(...args) ?? { error: null };
          return {
            eq: () => Promise.resolve(result),
            then: (
              resolve: (v: { error: unknown }) => unknown,
              reject?: (e: unknown) => unknown,
            ) => Promise.resolve(result).then(resolve, reject),
          };
        },
      }),
    }),
  };
}

const getOrgScopedClientMock = vi.fn((..._args: unknown[]) =>
  makeSupabaseStub(),
);
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (...args: unknown[]) => getOrgScopedClientMock(...args),
}));

import { reserveCartInventory } from "./reservations";

// ── Stripe price-retrieve stub ────────────────────────────────────────────────
// Returns a price whose expanded product carries a numeric stock_count, so the
// helper resolves the product as stock-tracked and calls the RPC.
function makeStripe(
  priceToProduct: Record<
    string,
    { productId: string; stockCount: number | null }
  >,
) {
  return {
    prices: {
      retrieve: vi.fn(async (priceId: string) => {
        const p = priceToProduct[priceId];
        if (!p) throw new Error(`unknown price ${priceId}`);
        return {
          id: priceId,
          product: {
            id: p.productId,
            deleted: false,
            metadata:
              p.stockCount === null
                ? {}
                : { stock_count: String(p.stockCount) },
          },
        };
      }),
    },
  } as never;
}

const ORG = "org_test_1";

beforeEach(() => {
  rpcMock.mockReset();
  updateInMock.mockReset();
  getOrgScopedClientMock.mockClear();
});

describe("reserveCartInventory — fail-open", () => {
  it("returns ok:true with no ids when the RPC throws (never blocks a sale)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "db down" } });
    const warn = vi.fn();
    const res = await reserveCartInventory({
      orgId: ORG,
      stripe: makeStripe({ price_a: { productId: "prod_a", stockCount: 5 } }),
      items: [{ priceId: "price_a", quantity: 1, mode: "one_time" }],
      log: { warn },
    });
    expect(res).toEqual({ ok: true, reservationIds: [] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns ok:true with no ids when Stripe price retrieval throws", async () => {
    const stripe = {
      prices: { retrieve: vi.fn(async () => Promise.reject(new Error("502"))) },
    } as never;
    const res = await reserveCartInventory({
      orgId: ORG,
      stripe,
      items: [{ priceId: "price_a", quantity: 1, mode: "one_time" }],
    });
    expect(res).toEqual({ ok: true, reservationIds: [] });
    // No reservation was recorded.
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("skips untracked products (null stock_count) without reserving", async () => {
    const res = await reserveCartInventory({
      orgId: ORG,
      stripe: makeStripe({
        price_a: { productId: "prod_a", stockCount: null },
      }),
      items: [{ priceId: "price_a", quantity: 3, mode: "one_time" }],
    });
    expect(res).toEqual({ ok: true, reservationIds: [] });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("ignores subscription lines (recurring stock is not modelled)", async () => {
    const res = await reserveCartInventory({
      orgId: ORG,
      stripe: makeStripe({
        price_sub: { productId: "prod_sub", stockCount: 2 },
      }),
      items: [{ priceId: "price_sub", quantity: 1, mode: "subscription" }],
    });
    expect(res).toEqual({ ok: true, reservationIds: [] });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("reserveCartInventory — success and oversold-release", () => {
  it("reserves each tracked product and returns the collected ids", async () => {
    rpcMock
      .mockResolvedValueOnce({ data: "res_a", error: null })
      .mockResolvedValueOnce({ data: "res_b", error: null });
    const res = await reserveCartInventory({
      orgId: ORG,
      stripe: makeStripe({
        price_a: { productId: "prod_a", stockCount: 5 },
        price_b: { productId: "prod_b", stockCount: 5 },
      }),
      items: [
        { priceId: "price_a", quantity: 1, mode: "one_time" },
        { priceId: "price_b", quantity: 2, mode: "one_time" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ reservationIds: ["res_a", "res_b"] });
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("aggregates duplicate lines of the same product into one reservation", async () => {
    rpcMock.mockResolvedValue({ data: "res_a", error: null });
    await reserveCartInventory({
      orgId: ORG,
      stripe: makeStripe({ price_a: { productId: "prod_a", stockCount: 9 } }),
      items: [
        { priceId: "price_a", quantity: 3, mode: "one_time" },
        { priceId: "price_a", quantity: 2, mode: "one_time" },
      ],
    });
    // One RPC call, with the summed quantity (3 + 2 = 5) against stock 9.
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [, args] = rpcMock.mock.calls[0]!;
    expect(args).toMatchObject({
      p_sku: "prod_a",
      p_qty: 5,
      p_available: 9,
    });
  });

  it("releases earlier holds and returns ok:false when a later SKU is oversold", async () => {
    // First product reserves fine (res_a); second product is oversold (null).
    rpcMock
      .mockResolvedValueOnce({ data: "res_a", error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    updateInMock.mockResolvedValue({ error: null });

    const res = await reserveCartInventory({
      orgId: ORG,
      stripe: makeStripe({
        price_a: { productId: "prod_a", stockCount: 5 },
        price_b: { productId: "prod_b", stockCount: 0 },
      }),
      items: [
        { priceId: "price_a", quantity: 1, mode: "one_time" },
        { priceId: "price_b", quantity: 1, mode: "one_time" },
      ],
    });
    expect(res).toEqual({ ok: false, oversoldProductId: "prod_b" });
    // The earlier hold (res_a) was released by id.
    expect(updateInMock).toHaveBeenCalledTimes(1);
    const [column, ids] = updateInMock.mock.calls[0]!;
    expect(column).toBe("id");
    expect(ids).toEqual(["res_a"]);
  });
});
