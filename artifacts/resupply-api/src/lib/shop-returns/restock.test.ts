import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { restockReturnedOrder } from "./restock";

const supabaseMock = installSupabaseMock();
const ORG = "00000000-0000-4000-8000-000000000000";
const noAccount: Stripe.RequestOptions = {};

function fakeStripe(
  current: Record<string, number | null>,
  update = vi.fn().mockResolvedValue({}),
) {
  const retrieve = vi.fn(async (id: string) => ({
    id,
    metadata:
      current[id] === null || current[id] === undefined
        ? {}
        : { stock_count: String(current[id]) },
  }));
  return {
    stripe: {
      products: { retrieve, update },
    } as unknown as Parameters<typeof restockReturnedOrder>[0]["stripe"],
    update,
    retrieve,
  };
}

beforeEach(() => supabaseMock.reset());

describe("restockReturnedOrder", () => {
  it("adds returned quantities back to each tracked product", async () => {
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        { product_id: "prod_a", quantity: 2 },
        { product_id: "prod_b", quantity: 1 },
      ],
    });
    const { stripe, update } = fakeStripe({ prod_a: 5, prod_b: 0 });

    const result = await restockReturnedOrder({
      stripe,
      accountOptions: noAccount,
      supabase: getOrgScopedClient(ORG),
      orderId: "o1",
      sessionId: null,
    });

    expect(result.productsRestocked).toBe(2);
    expect(update).toHaveBeenCalledWith(
      "prod_a",
      { metadata: { stock_count: "7" } },
      noAccount,
    );
    expect(update).toHaveBeenCalledWith(
      "prod_b",
      { metadata: { stock_count: "1" } },
      noAccount,
    );
  });

  it("skips untracked products (null stock_count)", async () => {
    stageSupabaseResponse("shop_order_items", "select", {
      data: [{ product_id: "prod_untracked", quantity: 3 }],
    });
    const { stripe, update } = fakeStripe({ prod_untracked: null });

    const result = await restockReturnedOrder({
      stripe,
      accountOptions: noAccount,
      supabase: getOrgScopedClient(ORG),
      orderId: "o1",
      sessionId: null,
    });

    expect(result.productsRestocked).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("no-ops when the order has no items", async () => {
    stageSupabaseResponse("shop_order_items", "select", { data: [] });
    const { stripe, update } = fakeStripe({});
    const result = await restockReturnedOrder({
      stripe,
      accountOptions: noAccount,
      supabase: getOrgScopedClient(ORG),
      orderId: "o1",
      sessionId: null,
    });
    expect(result.productsRestocked).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("is fail-soft: a Stripe error on one product doesn't throw", async () => {
    stageSupabaseResponse("shop_order_items", "select", {
      data: [{ product_id: "prod_a", quantity: 1 }],
    });
    const update = vi.fn().mockRejectedValue(new Error("stripe down"));
    const { stripe } = fakeStripe({ prod_a: 5 }, update);
    const warn = vi.fn();
    await expect(
      restockReturnedOrder({
        stripe,
        accountOptions: noAccount,
        supabase: getOrgScopedClient(ORG),
        orderId: "o1",
        sessionId: null,
        log: { warn },
      }),
    ).resolves.toEqual({ productsRestocked: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
