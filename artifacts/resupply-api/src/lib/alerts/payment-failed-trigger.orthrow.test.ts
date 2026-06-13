// dispatchPaymentFailedAlertOrThrow — outcome-to-error mapping.
//
// dispatchAlert maps recoverable SendGrid API errors to a
// `vendor_error` OUTCOME instead of throwing; the retry-backed pg-boss
// job depends on the OrThrow wrapper converting exactly that outcome
// (and only that outcome) into a throw. Mocked at the dispatchAlert
// boundary so we don't have to stage the whole alerts-config chain.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const dispatchAlertMock = vi.fn();
vi.mock("./dispatch", () => ({
  dispatchAlert: (...args: unknown[]) => dispatchAlertMock(...args),
}));

import { invalidateFeatureFlagCache } from "../feature-flags";
import {
  dispatchPaymentFailedAlertOrThrow,
  maybeDispatchPaymentFailedAlert,
} from "./payment-failed-trigger";

function stageResolvableChain() {
  stageSupabaseResponse("feature_flags", "select", {
    data: { enabled: true },
  });
  stageSupabaseResponse("shop_customers", "select", {
    data: { email_lower: "pat@example.com" },
  });
  // The trigger uses .limit(2) (exactly-one ambiguity guard), so the
  // staged response must be an array, not a maybeSingle object.
  stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
}

beforeEach(() => {
  supabaseMock.reset();
  dispatchAlertMock.mockReset();
  invalidateFeatureFlagCache();
});

describe("dispatchPaymentFailedAlertOrThrow", () => {
  it("throws on a vendor_error outcome so pg-boss retries", async () => {
    stageResolvableChain();
    dispatchAlertMock.mockResolvedValue({
      status: "vendor_error",
      channel: "email",
      vendorStatus: 503,
      vendorCode: null,
    });
    await expect(
      dispatchPaymentFailedAlertOrThrow({
        stripeCustomerId: "cus_123",
        amountDueCents: 1000,
        currency: "usd",
      }),
    ).rejects.toThrow(/vendor error/);
  });

  it("completes (no throw) on unresolvable outcomes like alert_not_found", async () => {
    stageResolvableChain();
    dispatchAlertMock.mockResolvedValue({ status: "alert_not_found" });
    await expect(
      dispatchPaymentFailedAlertOrThrow({
        stripeCustomerId: "cus_123",
        amountDueCents: 1000,
        currency: "usd",
      }),
    ).resolves.toBeUndefined();
  });

  it("maybeDispatch still swallows the vendor_error throw (webhook fallback path)", async () => {
    stageResolvableChain();
    dispatchAlertMock.mockResolvedValue({
      status: "vendor_error",
      channel: "email",
      vendorStatus: 429,
      vendorCode: "rate_limited",
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
