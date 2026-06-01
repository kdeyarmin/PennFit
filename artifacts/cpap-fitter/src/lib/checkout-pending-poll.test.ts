import { describe, expect, it } from "vitest";

import {
  MAX_PENDING_POLLS,
  shouldPollPendingPayment,
} from "./checkout-pending-poll";

describe("shouldPollPendingPayment", () => {
  const base = {
    loading: false,
    hasOrder: true,
    paymentStatus: "pending" as string | null | undefined,
    pollCount: 0,
  };

  it("does not poll while the initial fetch is still loading", () => {
    expect(shouldPollPendingPayment({ ...base, loading: true })).toBe(false);
  });

  it("does not poll in the error state (no order resolved)", () => {
    expect(shouldPollPendingPayment({ ...base, hasOrder: false })).toBe(false);
  });

  it("does not poll once the payment is paid", () => {
    expect(shouldPollPendingPayment({ ...base, paymentStatus: "paid" })).toBe(
      false,
    );
  });

  it("polls while payment is pending and under the attempt cap", () => {
    expect(shouldPollPendingPayment(base)).toBe(true);
    // A null status (unknown / still settling) is also pending.
    expect(shouldPollPendingPayment({ ...base, paymentStatus: null })).toBe(
      true,
    );
  });

  it("stops polling once the attempt cap is reached", () => {
    expect(
      shouldPollPendingPayment({ ...base, pollCount: MAX_PENDING_POLLS }),
    ).toBe(false);
    expect(
      shouldPollPendingPayment({ ...base, pollCount: MAX_PENDING_POLLS - 1 }),
    ).toBe(true);
  });
});
