// Behavioral tests for the signed-order → fulfillment bridge.
//
// The regression this closes: after the Stripe checkout route was deleted,
// a patient could complete the signature flow and nothing downstream
// happened — the order never reached fulfillments/claims. These pin both
// the happy path and every case where we deliberately do NOTHING rather
// than guess.

import { describe, expect, it, vi, beforeEach } from "vitest";

const { ensureFulfillmentsMock } = vi.hoisted(() => ({
  ensureFulfillmentsMock: vi.fn(),
}));
vi.mock("../messaging/order-flow", () => ({
  ensureFulfillments: (...a: unknown[]) => ensureFulfillmentsMock(...a),
}));

import { dispenseSignedCsrOrder } from "./dispense-on-sign";

/** Minimal org-scoped-client stand-in: one `.from(...).select(...)` chain. */
function clientReturning(row: unknown, error: unknown = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: row, error }),
  };
  return { from: () => chain } as never;
}

const DRAFT = {
  id: "draft-1",
  patient_id: "patient-1",
  category: "cushion",
  suggested_product_id: "CUSH-P10",
};

beforeEach(() => {
  ensureFulfillmentsMock.mockReset().mockResolvedValue(["ful-1"]);
});

describe("dispenseSignedCsrOrder — creates the insurance work", () => {
  it("queues a fulfillment for the draft's patient and SKU", async () => {
    const res = await dispenseSignedCsrOrder(clientReturning(DRAFT), "req-1");

    expect(res.skipped).toBeNull();
    expect(res.fulfillmentIds).toEqual(["ful-1"]);
    expect(ensureFulfillmentsMock).toHaveBeenCalledWith(expect.anything(), {
      patientId: "patient-1",
      // Keyed on the DRAFT id: that is the unit of resupply work, and it is
      // what makes a double-submitted signature idempotent rather than
      // dispensing twice.
      episodeId: "draft-1",
      itemSku: "CUSH-P10",
    });
  });

  it("falls back to the draft category when no specific SKU was proposed", async () => {
    await dispenseSignedCsrOrder(
      clientReturning({ ...DRAFT, suggested_product_id: null }),
      "req-1",
    );
    expect(ensureFulfillmentsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ itemSku: "cushion" }),
    );
  });

  it("ignores a whitespace-only suggested SKU", async () => {
    await dispenseSignedCsrOrder(
      clientReturning({ ...DRAFT, suggested_product_id: "   " }),
      "req-1",
    );
    expect(ensureFulfillmentsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ itemSku: "cushion" }),
    );
  });
});

describe("dispenseSignedCsrOrder — does nothing rather than guess", () => {
  it("skips an ad-hoc order with no draft behind it", async () => {
    // A CSR-built order carries a customer NAME, not a patient id.
    // Attributing a claim by name-matching would be worse than leaving it
    // in the admin queue for a human.
    const res = await dispenseSignedCsrOrder(clientReturning(null), "req-1");
    expect(res).toEqual({ fulfillmentIds: [], skipped: "no_draft" });
    expect(ensureFulfillmentsMock).not.toHaveBeenCalled();
  });

  it("skips a draft with no patient", async () => {
    const res = await dispenseSignedCsrOrder(
      clientReturning({ ...DRAFT, patient_id: null }),
      "req-1",
    );
    expect(res.skipped).toBe("no_patient");
    expect(ensureFulfillmentsMock).not.toHaveBeenCalled();
  });

  it("skips when neither a SKU nor a category is known", async () => {
    const res = await dispenseSignedCsrOrder(
      clientReturning({ ...DRAFT, suggested_product_id: null, category: null }),
      "req-1",
    );
    expect(res.skipped).toBe("no_sku");
    expect(ensureFulfillmentsMock).not.toHaveBeenCalled();
  });
});

describe("dispenseSignedCsrOrder — never throws", () => {
  it("swallows a lookup error", async () => {
    // The signature is already committed and acknowledged; this must not
    // turn a completed signing into an error page.
    const res = await dispenseSignedCsrOrder(
      clientReturning(null, new Error("db down")),
      "req-1",
    );
    expect(res).toEqual({ fulfillmentIds: [], skipped: "error" });
  });

  it("swallows a downstream fulfillment failure", async () => {
    ensureFulfillmentsMock.mockRejectedValue(new Error("insert failed"));
    const res = await dispenseSignedCsrOrder(clientReturning(DRAFT), "req-1");
    expect(res.skipped).toBe("error");
  });
});
