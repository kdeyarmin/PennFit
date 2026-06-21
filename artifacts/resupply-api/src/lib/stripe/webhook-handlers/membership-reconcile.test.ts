// reconcileMembershipFromSubscription — downgrade-on-cancel + renewal refresh.
//
// shop_customers.membership_tier must end when its backing Stripe
// subscription is canceled/lapsed, and the renewal stamp must track the live
// subscription period. Non-membership subscriptions (no linked row) are a
// no-op.

import { describe, it, expect, beforeEach } from "vitest";
import type Stripe from "stripe";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { reconcileMembershipFromSubscription } from "./membership-reconcile";

beforeEach(() => supabaseMock.reset());

function sub(
  overrides: Partial<Stripe.Subscription> & {
    status: Stripe.Subscription.Status;
  },
  periodEndUnix: number | null = null,
): Stripe.Subscription {
  return {
    id: "sub_1",
    items: {
      data: periodEndUnix
        ? [{ current_period_end: periodEndUnix } as never]
        : [],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("reconcileMembershipFromSubscription", () => {
  it("downgrades to payg + clears renewal & link on the deleted event", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: "cust-1", membership_tier: "monthly_unlimited" },
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: { customer_id: "cust-1" },
    });

    await reconcileMembershipFromSubscription(
      sub({ status: "canceled" }),
      true,
      undefined,
    );

    const updates = getSupabaseWritePayloads("shop_customers", "update");
    expect(updates).toHaveLength(1);
    const patch = updates[0] as Record<string, unknown>;
    expect(patch.membership_tier).toBe("payg");
    expect(patch.membership_renews_at).toBeNull();
    expect(patch.membership_stripe_subscription_id).toBeNull();
  });

  it("downgrades on a terminal status without the deleted event", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: "cust-1", membership_tier: "monthly_unlimited" },
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: { customer_id: "cust-1" },
    });

    await reconcileMembershipFromSubscription(
      sub({ status: "unpaid" }),
      false,
      undefined,
    );

    const patch = getSupabaseWritePayloads(
      "shop_customers",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch.membership_tier).toBe("payg");
  });

  it("refreshes the renewal date on an active subscription (no downgrade)", async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: "cust-1", membership_tier: "monthly_unlimited" },
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: { customer_id: "cust-1" },
    });

    await reconcileMembershipFromSubscription(
      sub({ status: "active" }, periodEnd),
      false,
      undefined,
    );

    const patch = getSupabaseWritePayloads(
      "shop_customers",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch.membership_renews_at).toBe(
      new Date(periodEnd * 1000).toISOString(),
    );
    // Renewal refresh must NOT touch the tier or the link.
    expect(patch.membership_tier).toBeUndefined();
    expect(patch.membership_stripe_subscription_id).toBeUndefined();
  });

  it("is a no-op when no customer is linked to the subscription", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });

    await reconcileMembershipFromSubscription(
      sub({ status: "canceled" }),
      true,
      undefined,
    );

    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });
});
