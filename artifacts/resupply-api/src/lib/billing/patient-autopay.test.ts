// Pure-logic tests for patient-autopay: the worker's eligibility selector
// and the client-facing status view. The Stripe/Supabase-touching helpers
// are covered at the route layer (me-payment-methods.test.ts).

import { describe, it, expect } from "vitest";

import {
  MAX_AUTOPAY_CHARGE_ATTEMPTS,
  selectChargeableAuthorizations,
  toAutopayStatusView,
  type ChargeableAuthorization,
} from "./patient-autopay";

function auth(
  over: Partial<ChargeableAuthorization> = {},
): ChargeableAuthorization {
  return {
    id: "a1",
    patientId: "p1",
    stripeCustomerId: "cus_x",
    stripePaymentMethodId: "pm_x",
    autopayEnabled: true,
    chargeAttempts: 0,
    lastChargeAttemptAt: null,
    ...over,
  };
}

const TODAY = "2026-06-09";

describe("selectChargeableAuthorizations", () => {
  it("includes an enabled, untried authorization with a card", () => {
    expect(selectChargeableAuthorizations([auth()], TODAY)).toHaveLength(1);
  });

  it("excludes when autopay is disabled", () => {
    expect(
      selectChargeableAuthorizations([auth({ autopayEnabled: false })], TODAY),
    ).toHaveLength(0);
  });

  it("excludes when the stripe customer or payment method is missing", () => {
    expect(
      selectChargeableAuthorizations([auth({ stripeCustomerId: "" })], TODAY),
    ).toHaveLength(0);
    expect(
      selectChargeableAuthorizations(
        [auth({ stripePaymentMethodId: "" })],
        TODAY,
      ),
    ).toHaveLength(0);
  });

  it("excludes when the attempt budget is exhausted", () => {
    expect(
      selectChargeableAuthorizations(
        [auth({ chargeAttempts: MAX_AUTOPAY_CHARGE_ATTEMPTS })],
        TODAY,
      ),
    ).toHaveLength(0);
  });

  it("excludes when already attempted today (at most once/day)", () => {
    expect(
      selectChargeableAuthorizations(
        [auth({ lastChargeAttemptAt: `${TODAY}T08:00:00.000Z` })],
        TODAY,
      ),
    ).toHaveLength(0);
  });

  it("includes when the last attempt was a prior day and budget remains", () => {
    expect(
      selectChargeableAuthorizations(
        [
          auth({
            lastChargeAttemptAt: "2026-06-08T23:00:00.000Z",
            chargeAttempts: 2,
          }),
        ],
        TODAY,
      ),
    ).toHaveLength(1);
  });

  it("respects a custom maxAttempts", () => {
    expect(
      selectChargeableAuthorizations([auth({ chargeAttempts: 2 })], TODAY, 2),
    ).toHaveLength(0);
  });
});

describe("toAutopayStatusView", () => {
  it("maps null to an empty state", () => {
    expect(toAutopayStatusView(null)).toEqual({
      hasCard: false,
      autopayEnabled: false,
      card: null,
      authorizedAt: null,
    });
  });

  it("maps a row to a card view without leaking the stripe ids", () => {
    const view = toAutopayStatusView({
      id: "a1",
      patient_id: "p1",
      shop_customer_id: "cust-1",
      stripe_customer_id: "cus_secret",
      stripe_payment_method_id: "pm_secret",
      card_brand: "visa",
      card_last4: "4242",
      card_exp_month: 12,
      card_exp_year: 2030,
      autopay_enabled: true,
      authorized_at: "2026-06-01T00:00:00.000Z",
      autopay_enabled_at: "2026-06-01T00:00:00.000Z",
      autopay_disabled_at: null,
      revoked_at: null,
      charge_attempts: 0,
      last_charge_error: null,
      last_charge_attempt_at: null,
      created_by: "customer:bob@example.com",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    });
    expect(view.hasCard).toBe(true);
    expect(view.autopayEnabled).toBe(true);
    expect(view.card).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
    });
    // PHI/security: the serialized view must never carry Stripe ids.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("cus_secret");
    expect(serialized).not.toContain("pm_secret");
  });
});
