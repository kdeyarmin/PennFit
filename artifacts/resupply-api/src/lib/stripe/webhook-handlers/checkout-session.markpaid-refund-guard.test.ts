// Regression guard for the markPaid refunded->paid flip.
//
// markPaid runs for BOTH checkout.session.completed and
// checkout.session.async_payment_succeeded (distinct Stripe event ids, so the
// stripe_webhook_events id-dedup does not collapse them), and a dashboard
// "Resend" / very delayed retry of `completed` can also land AFTER a
// charge.refunded flipped the order to "refunded". The old bare
// upsert(status:"paid") silently reverted refunded -> paid. These tests lock
// the guarded write: refunded is terminal, a normal pending row still goes
// paid, and a genuinely missing row is still inserted (crash recovery).

import type Stripe from "stripe";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseFilterCalls,
} from "../../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const resolveWebhookOrgId = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => "org-x"),
);
vi.mock("../webhook-org-context", () => ({ resolveWebhookOrgId }));

import { markPaid } from "./checkout-session";

function fakeSession(): Stripe.Checkout.Session {
  return {
    id: "cs_test_123",
    payment_intent: "pi_123",
    amount_total: 4999,
    currency: "usd",
    metadata: { customer_id: "cust_1" },
    customer_details: { email: "Buyer@Example.com" },
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  supabaseMock.reset();
  resolveWebhookOrgId.mockClear();
});

describe("markPaid — refunded is terminal", () => {
  it("does NOT resurrect a refunded order, and never inserts", async () => {
    // Guarded UPDATE excludes status='refunded' → matches zero rows.
    stageSupabaseResponse("shop_orders", "update", { data: [] });
    // Existence probe finds the row, still refunded.
    stageSupabaseResponse("shop_orders", "select", {
      data: { id: "ord_1", status: "refunded" },
    });

    const result = await markPaid(fakeSession(), undefined);

    expect(result).toBeNull();
    // The UPDATE carried the refunded-excluding guard.
    const updateFilters = getSupabaseFilterCalls("shop_orders", "update");
    expect(
      updateFilters.some(
        (f) => f.verb === "neq" && (f.args as unknown[])[1] === "refunded",
      ),
    ).toBe(true);
    // Crucially, no INSERT — the terminal row is left exactly as it was.
    expect(getSupabaseCallCount("shop_orders", "insert")).toBe(0);
  });

  it("marks a normal (non-refunded) order paid via the guarded UPDATE", async () => {
    stageSupabaseResponse("shop_orders", "update", {
      data: [
        { id: "ord_1", customer_id: "cust_1", paid_at: "2026-06-24T00:00:00Z" },
      ],
    });

    const result = await markPaid(fakeSession(), undefined);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ord_1");
    // No existence probe, no insert — the UPDATE matched.
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
    expect(getSupabaseCallCount("shop_orders", "insert")).toBe(0);
  });

  it("inserts when no row exists yet (checkout-crash recovery)", async () => {
    stageSupabaseResponse("shop_orders", "update", { data: [] });
    // Existence probe: genuinely missing.
    stageSupabaseResponse("shop_orders", "select", { data: null });
    stageSupabaseResponse("shop_orders", "insert", {
      data: [
        {
          id: "ord_new",
          customer_id: "cust_1",
          paid_at: "2026-06-24T00:00:00Z",
        },
      ],
    });

    const result = await markPaid(fakeSession(), undefined);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ord_new");
    expect(getSupabaseCallCount("shop_orders", "insert")).toBe(1);
  });
});
