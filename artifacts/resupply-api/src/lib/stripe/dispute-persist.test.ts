import { describe, it, expect, beforeEach } from "vitest";
import type Stripe from "stripe";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { persistStripeDispute } from "./dispute-persist";

const ORG = "00000000-0000-4000-8000-000000000000";

function dispute(overrides: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
  return {
    id: "dp_123",
    charge: "ch_123",
    amount: 4500,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    created: 1_700_000_000,
    is_charge_refundable: true,
    evidence_details: { due_by: 1_701_000_000 },
    ...overrides,
  } as unknown as Stripe.Dispute;
}

beforeEach(() => supabaseMock.reset());

describe("persistStripeDispute", () => {
  it("no-ops when org is null", async () => {
    await persistStripeDispute(null, dispute());
    expect(supabaseMock.callCount("stripe_disputes", "upsert")).toBe(0);
  });

  it("upserts an open dispute linked to its order", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: { id: "order-1" } });
    stageSupabaseResponse("stripe_disputes", "upsert", { data: null });

    await persistStripeDispute(ORG, dispute());

    const row = supabaseMock.writePayloads("stripe_disputes", "upsert")[0] as
      | Record<string, unknown>
      | undefined;
    expect(row?.stripe_dispute_id).toBe("dp_123");
    expect(row?.order_id).toBe("order-1");
    expect(row?.amount_cents).toBe(4500);
    expect(row?.status).toBe("needs_response");
    expect(row?.evidence_due_by).toBe(
      new Date(1_701_000_000 * 1000).toISOString(),
    );
    expect(row?.closed_at).toBeNull();
    expect(row?.outcome).toBeNull();
  });

  it("stamps closed_at + outcome for a closed dispute", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: null });
    stageSupabaseResponse("stripe_disputes", "upsert", { data: null });

    await persistStripeDispute(ORG, dispute({ status: "lost" }));

    const row = supabaseMock.writePayloads("stripe_disputes", "upsert")[0] as
      | Record<string, unknown>
      | undefined;
    expect(row?.order_id).toBeNull();
    expect(row?.closed_at).toBeTruthy();
    expect(row?.outcome).toBe("lost");
  });

  it("never throws on a DB error (fail-soft)", async () => {
    stageSupabaseResponse("shop_orders", "select", { data: null });
    stageSupabaseResponse("stripe_disputes", "upsert", {
      error: { message: "boom" },
    });
    await expect(persistStripeDispute(ORG, dispute())).resolves.toBeUndefined();
  });
});
