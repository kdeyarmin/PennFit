// Closing the loop from a fitting to the order it produced.
//
// The three things worth pinning down here are the three ways this could
// quietly go wrong rather than fail loudly: attributing an order twice on
// a Stripe re-delivery, silently dropping the ORDER link when only the
// mask slug is unresolvable, and counting a dispense at payment time
// instead of at delivery.

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const VARIANT_ID = "22222222-2222-4222-8222-222222222222";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "cs_test_order_1";
const ORG_ID = "44444444-4444-4444-8444-444444444444";

const db = vi.hoisted(() => ({
  /** slug → mask_models row, or undefined for "no such mask". */
  masks: new Map<string, { id: string }>(),
  /** Updates seen by `fit_sessions`, in order. */
  updates: [] as Array<{ patch: Record<string, unknown>; filters: string[] }>,
  /** What the guarded update returns: a row = it matched, null = no-op. */
  updateMatches: true,
  updateError: null as { message: string } | null,
}));

vi.mock("@workspace/resupply-db", () => {
  const maskBuilder = () => {
    let slug = "";
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "or", "limit"]) chain[m] = () => self();
    chain.eq = (_col: string, v: string) => {
      slug = v;
      return self();
    };
    chain.maybeSingle = async () => ({
      data: db.masks.get(slug) ?? null,
      error: null,
    });
    return chain;
  };

  const sessionBuilder = () => {
    const filters: string[] = [];
    let patch: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.update = (p: Record<string, unknown>) => {
      patch = p;
      return self();
    };
    chain.eq = (col: string, v: string) => {
      filters.push(`${col}=${v}`);
      return self();
    };
    chain.is = (col: string, v: null) => {
      filters.push(`${col} IS ${String(v)}`);
      return self();
    };
    for (const m of ["select", "limit"]) chain[m] = () => self();
    chain.maybeSingle = async () => {
      db.updates.push({ patch, filters });
      if (db.updateError) return { data: null, error: db.updateError };
      return {
        data: db.updateMatches ? { id: SESSION_ID } : null,
        error: null,
      };
    };
    return chain;
  };

  return {
    getOrgScopedClient: vi.fn(() => ({
      from: () => sessionBuilder(),
      raw: () => ({ schema: () => ({ from: () => maskBuilder() }) }),
    })),
  };
});

import {
  FIT_ORDERED_MASK_METADATA_KEY,
  FIT_ORDERED_VARIANT_METADATA_KEY,
  FIT_SESSION_METADATA_KEY,
  linkFitSessionToOrder,
  markFitSessionDispensed,
  readFitOrderLink,
} from "./order-link";

beforeEach(() => {
  db.masks = new Map([["resmed-airfit-f20", { id: MODEL_ID }]]);
  db.updates = [];
  db.updateMatches = true;
  db.updateError = null;
});

describe("readFitOrderLink", () => {
  it("returns null for an ordinary shop checkout", () => {
    expect(readFitOrderLink({ org_id: ORG_ID })).toBeNull();
    expect(readFitOrderLink(null)).toBeNull();
    expect(readFitOrderLink(undefined)).toBeNull();
  });

  it("treats a blank session id as absent rather than linking nothing", () => {
    expect(readFitOrderLink({ [FIT_SESSION_METADATA_KEY]: "   " })).toBeNull();
  });

  it("reads the mask and variant when the fitting supplied them", () => {
    expect(
      readFitOrderLink({
        [FIT_SESSION_METADATA_KEY]: SESSION_ID,
        [FIT_ORDERED_MASK_METADATA_KEY]: "resmed-airfit-f20",
        [FIT_ORDERED_VARIANT_METADATA_KEY]: VARIANT_ID,
      }),
    ).toEqual({
      fitSessionId: SESSION_ID,
      orderedMaskSlug: "resmed-airfit-f20",
      orderedVariantId: VARIANT_ID,
    });
  });

  it("still links the session when only the session id survived", () => {
    expect(
      readFitOrderLink({ [FIT_SESSION_METADATA_KEY]: SESSION_ID }),
    ).toEqual({
      fitSessionId: SESSION_ID,
      orderedMaskSlug: null,
      orderedVariantId: null,
    });
  });
});

describe("linkFitSessionToOrder", () => {
  const link = {
    fitSessionId: SESSION_ID,
    orderedMaskSlug: "resmed-airfit-f20",
    orderedVariantId: VARIANT_ID,
  };

  it("resolves the slug to a catalog id and records the order", async () => {
    const result = await linkFitSessionToOrder(ORG_ID, {
      link,
      shopOrderId: ORDER_ID,
    });
    expect(result).toEqual({ linked: true });
    const [update] = db.updates;
    expect(update?.patch).toMatchObject({
      shop_order_id: ORDER_ID,
      ordered_mask_model_id: MODEL_ID,
      ordered_variant_id: VARIANT_ID,
    });
  });

  it("guards on shop_order_id IS NULL so a re-delivery cannot re-attribute", async () => {
    await linkFitSessionToOrder(ORG_ID, { link, shopOrderId: ORDER_ID });
    expect(db.updates[0]?.filters).toContain("shop_order_id IS null");

    // Second delivery of the same event: the guard matches nothing.
    db.updateMatches = false;
    const second = await linkFitSessionToOrder(ORG_ID, {
      link,
      shopOrderId: "cs_test_order_2",
    });
    expect(second).toEqual({ linked: false });
  });

  it("links the order even when the mask slug resolves to nothing", async () => {
    // Losing the order link too would also lose `dispensed_at`, which
    // hangs off it — a worse outcome than a null mask.
    const result = await linkFitSessionToOrder(ORG_ID, {
      link: { ...link, orderedMaskSlug: "not-in-this-catalog" },
      shopOrderId: ORDER_ID,
    });
    expect(result).toEqual({ linked: true });
    expect(db.updates[0]?.patch).toMatchObject({ shop_order_id: ORDER_ID });
    expect(db.updates[0]?.patch).not.toHaveProperty("ordered_mask_model_id");
  });

  it("reports failure instead of throwing when the write errors", async () => {
    db.updateError = { message: "connection reset" };
    await expect(
      linkFitSessionToOrder(ORG_ID, { link, shopOrderId: ORDER_ID }),
    ).resolves.toEqual({ linked: false });
  });
});

describe("markFitSessionDispensed", () => {
  it("stamps the delivery against the linked order only once", async () => {
    const first = await markFitSessionDispensed(ORG_ID, ORDER_ID);
    expect(first).toEqual({ stamped: true });
    expect(db.updates[0]?.filters).toEqual([
      `shop_order_id=${ORDER_ID}`,
      "dispensed_at IS null",
    ]);
    expect(db.updates[0]?.patch).toHaveProperty("dispensed_at");

    // The carrier webhook and the admin "mark delivered" action can both
    // fire for one order; only the first one counts.
    db.updateMatches = false;
    await expect(markFitSessionDispensed(ORG_ID, ORDER_ID)).resolves.toEqual({
      stamped: false,
    });
  });

  it("reports failure instead of throwing when the write errors", async () => {
    db.updateError = { message: "timeout" };
    await expect(markFitSessionDispensed(ORG_ID, ORDER_ID)).resolves.toEqual({
      stamped: false,
    });
  });
});
