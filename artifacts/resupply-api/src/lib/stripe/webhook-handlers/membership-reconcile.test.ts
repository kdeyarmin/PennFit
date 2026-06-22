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

import {
  joinMembershipFromSubscription,
  reconcileMembershipFromSubscription,
} from "./membership-reconcile";

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

describe("joinMembershipFromSubscription", () => {
  it("sets the tier + links the sub on a self-serve join (active)", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: "cust-1", membership_started_at: null },
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: { customer_id: "cust-1" },
    });

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    await joinMembershipFromSubscription(
      sub(
        {
          status: "active",
          metadata: {
            customer_id: "cust-1",
            membership_tier: "monthly_unlimited",
          } as Stripe.Metadata,
        },
        periodEnd,
      ),
      undefined,
    );

    const patch = getSupabaseWritePayloads(
      "shop_customers",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch.membership_tier).toBe("monthly_unlimited");
    expect(patch.membership_stripe_subscription_id).toBe("sub_1");
    expect(patch.membership_renews_at).toBe(
      new Date(periodEnd * 1000).toISOString(),
    );
    expect(patch.membership_started_at).toBeTruthy();
  });

  it("preserves an existing membership_started_at on replay", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: "cust-1",
        membership_started_at: "2026-01-01T00:00:00Z",
      },
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: { customer_id: "cust-1" },
    });

    await joinMembershipFromSubscription(
      sub({
        status: "active",
        metadata: {
          customer_id: "cust-1",
          membership_tier: "quarterly_unlimited",
        } as Stripe.Metadata,
      }),
      undefined,
    );

    const patch = getSupabaseWritePayloads(
      "shop_customers",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch.membership_started_at).toBe("2026-01-01T00:00:00Z");
  });

  it("no-ops for a subscription without membership_tier metadata", async () => {
    await joinMembershipFromSubscription(
      sub({ status: "active", metadata: {} as Stripe.Metadata }),
      undefined,
    );
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });

  it("no-ops when the subscription is not active/trialing", async () => {
    await joinMembershipFromSubscription(
      sub({
        status: "incomplete",
        metadata: {
          customer_id: "cust-1",
          membership_tier: "monthly_unlimited",
        } as Stripe.Metadata,
      }),
      undefined,
    );
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });
});
