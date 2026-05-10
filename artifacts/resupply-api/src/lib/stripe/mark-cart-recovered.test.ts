// Tests for `markCartRecovered` — the helper invoked from the
// checkout.session.completed branch of the Stripe webhook handler.
//
// Coverage:
//   * Session WITH metadata.customer_id → UPDATE shop_abandoned_carts
//     (recovered_at = now, items = [], subtotal = 0).
//   * Session WITHOUT a customer-id metadata key (guest checkout) →
//     no-op (no DB update, no logging surface beyond debug).
//
// We intentionally do NOT exercise the full webhook-handler entry
// point here (that requires Stripe signature construction). The
// helper is exported precisely so it can be unit-tested in isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { markCartRecovered } from "./webhook-handler";

function makeSession(
  metadata: Record<string, string> | null,
): Stripe.Checkout.Session {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    metadata,
  } as unknown as Stripe.Checkout.Session;
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("markCartRecovered", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("issues an UPDATE when session.metadata.customer_id is present", async () => {
    const log = makeLog();
    // PostgREST returns the matched-row(s) array via the trailing
    // `.select("id")` after the UPDATE.
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      data: [{ id: "row_aaa" }],
    });
    await markCartRecovered(
      makeSession({ customer_id: "user_signed_in_42" }),
      log,
    );
    expect(log.info).toHaveBeenCalledTimes(1);
    const [meta, msg] = log.info.mock.calls[0];
    expect(meta).toEqual({ customerId: "user_signed_in_42", rowId: "row_aaa" });
    expect(msg).toBe("abandoned cart marked recovered");
  });

  it("is a silent no-op when session has no customer_id (guest checkout)", async () => {
    const log = makeLog();
    await markCartRecovered(makeSession(null), log);
    await markCartRecovered(makeSession({}), log);
    await markCartRecovered(makeSession({ other: "value" }), log);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not log when no row matched (already recovered or never created)", async () => {
    const log = makeLog();
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: [] });
    await markCartRecovered(makeSession({ customer_id: "user_no_cart" }), log);
    expect(log.info).not.toHaveBeenCalled();
  });
});
