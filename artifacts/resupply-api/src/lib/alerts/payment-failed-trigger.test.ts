// Tests for the automated payment_failed alert trigger.
//
// Coverage:
//   * Flag OFF → no identity resolution, no send (fail-closed).
//   * No stripeCustomerId → no-op.
//   * Flag ON but no shop_customer for the stripe id → skip.
//   * Flag ON, shop_customer found, but no matching patient → skip.
//   * Never throws (callers fire-and-forget) even on a DB error.
//
// We assert the OUTCOME indirectly via call counts on the supabase
// mock: when the flag is off we must NOT touch shop_customers /
// patients at all.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getSupabaseCallCount,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { invalidateFeatureFlagCache } from "../feature-flags";
import { maybeDispatchPaymentFailedAlert } from "./payment-failed-trigger";

beforeEach(() => {
  supabaseMock.reset();
  invalidateFeatureFlagCache();
});

describe("maybeDispatchPaymentFailedAlert", () => {
  it("is a no-op when stripeCustomerId is null (no flag read either)", async () => {
    await maybeDispatchPaymentFailedAlert({
      stripeCustomerId: null,
      amountDueCents: 1000,
      currency: "usd",
    });
    expect(getSupabaseCallCount("feature_flags", "select")).toBe(0);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("fails closed when the alerts.auto_dispatch flag is OFF", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    await maybeDispatchPaymentFailedAlert({
      stripeCustomerId: "cus_123",
      amountDueCents: 1000,
      currency: "usd",
    });
    // Flag was consulted, but the identity chain must NOT run.
    expect(getSupabaseCallCount("feature_flags", "select")).toBe(1);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
    expect(getSupabaseCallCount("patients", "select")).toBe(0);
  });

  it("skips when no shop_customer matches the stripe customer id", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("shop_customers", "select", { data: null });
    await maybeDispatchPaymentFailedAlert({
      stripeCustomerId: "cus_unknown",
      amountDueCents: 1000,
      currency: "usd",
    });
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(1);
    // No email → never reaches the patient lookup.
    expect(getSupabaseCallCount("patients", "select")).toBe(0);
  });

  it("skips when no patient matches the shop_customer email", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "nobody@example.com" },
    });
    stageSupabaseResponse("patients", "select", { data: null });
    await maybeDispatchPaymentFailedAlert({
      stripeCustomerId: "cus_123",
      amountDueCents: 1000,
      currency: "usd",
    });
    expect(getSupabaseCallCount("patients", "select")).toBe(1);
  });

  it("never throws when a DB read errors (fire-and-forget safety)", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("shop_customers", "select", {
      error: { code: "08006", message: "connection failure" },
    });
    await expect(
      maybeDispatchPaymentFailedAlert({
        stripeCustomerId: "cus_123",
        amountDueCents: 1000,
        currency: "usd",
      }),
    ).resolves.toBeUndefined();
  });
});
