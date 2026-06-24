// Tests for the platform double-subscription race guard:
// findExistingPlatformSubscriptionId. Before minting a NEW Stripe subscription
// for a tenant, syncTenantStripeSubscription adopts any platform subscription
// already on the customer (the DB row may not have caught up with a concurrent
// create). This locks the selection logic: match our platform scope + org, and
// never adopt a terminal (canceled / incomplete_expired) subscription.

import { describe, it, expect, vi } from "vitest";

// Pure-function imports only; no platform-billing deps are touched because we
// pass a fake Stripe client straight into the exported helper.
import { findExistingPlatformSubscriptionId } from "./stripe";

const SCOPE = "platform_tenant";
const ORG = "org_abc";
const CUSTOMER = "cus_123";

interface FakeSub {
  id: string;
  status: string;
  metadata?: Record<string, string>;
}

function fakeStripe(subs: FakeSub[]) {
  const list = vi.fn(async () => ({ data: subs }));
  return {
    client: { subscriptions: { list } } as never,
    list,
  };
}

describe("findExistingPlatformSubscriptionId", () => {
  it("adopts a live platform subscription matching scope + org", async () => {
    const { client, list } = fakeStripe([
      {
        id: "sub_match",
        status: "active",
        metadata: { billing_scope: SCOPE, org_id: ORG },
      },
    ]);
    const id = await findExistingPlatformSubscriptionId(client, CUSTOMER, ORG);
    expect(id).toBe("sub_match");
    // Scoped to the customer when querying Stripe.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: CUSTOMER, status: "all" }),
    );
  });

  it("returns null when there is nothing to adopt", async () => {
    const { client } = fakeStripe([]);
    expect(
      await findExistingPlatformSubscriptionId(client, CUSTOMER, ORG),
    ).toBeNull();
  });

  it("ignores subscriptions for a different org (cross-tenant safety)", async () => {
    const { client } = fakeStripe([
      {
        id: "sub_other",
        status: "active",
        metadata: { billing_scope: SCOPE, org_id: "org_other" },
      },
    ]);
    expect(
      await findExistingPlatformSubscriptionId(client, CUSTOMER, ORG),
    ).toBeNull();
  });

  it("ignores non-platform subscriptions (e.g. a patient autopay sub)", async () => {
    const { client } = fakeStripe([
      { id: "sub_patient", status: "active", metadata: { org_id: ORG } },
    ]);
    expect(
      await findExistingPlatformSubscriptionId(client, CUSTOMER, ORG),
    ).toBeNull();
  });

  it("never adopts a terminal subscription (canceled / incomplete_expired)", async () => {
    const { client } = fakeStripe([
      {
        id: "sub_canceled",
        status: "canceled",
        metadata: { billing_scope: SCOPE, org_id: ORG },
      },
      {
        id: "sub_dead",
        status: "incomplete_expired",
        metadata: { billing_scope: SCOPE, org_id: ORG },
      },
    ]);
    expect(
      await findExistingPlatformSubscriptionId(client, CUSTOMER, ORG),
    ).toBeNull();
  });

  it("adopts the live sub even when a canceled one is also present", async () => {
    const { client } = fakeStripe([
      {
        id: "sub_canceled",
        status: "canceled",
        metadata: { billing_scope: SCOPE, org_id: ORG },
      },
      {
        id: "sub_live",
        status: "past_due",
        metadata: { billing_scope: SCOPE, org_id: ORG },
      },
    ]);
    expect(
      await findExistingPlatformSubscriptionId(client, CUSTOMER, ORG),
    ).toBe("sub_live");
  });
});
