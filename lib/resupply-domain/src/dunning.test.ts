import { describe, expect, it } from "vitest";

import {
  DEFAULT_DUNNING_POLICY,
  DUNNING_MIN_BALANCE_CENTS,
  decideDunningAction,
  nextDunningStep,
  shouldOpenDunningRun,
} from "./dunning";

const base = {
  currentStep: "reminder" as const,
  nextActionAt: "2026-06-20",
  balanceCents: 5000,
  hasActivePaymentPlan: false,
  hasAutopay: false,
  today: "2026-06-20",
};

describe("decideDunningAction", () => {
  it("resolves the moment the balance is cleared, mid-ladder", () => {
    const d = decideDunningAction({ ...base, balanceCents: 0 });
    expect(d).toEqual({ type: "resolve", reason: "paid" });
  });

  it("resolves on a credit balance too", () => {
    expect(decideDunningAction({ ...base, balanceCents: -100 }).type).toBe(
      "resolve",
    );
  });

  it("pauses when a payment plan is active (takes priority over due send)", () => {
    const d = decideDunningAction({ ...base, hasActivePaymentPlan: true });
    expect(d).toEqual({ type: "pause", reason: "payment_plan_active" });
  });

  it("pauses when autopay is enrolled", () => {
    const d = decideDunningAction({ ...base, hasAutopay: true });
    expect(d).toEqual({ type: "pause", reason: "autopay_enrolled" });
  });

  it("waits when the step is not yet due", () => {
    const d = decideDunningAction({
      ...base,
      nextActionAt: "2026-06-25",
      today: "2026-06-20",
    });
    expect(d).toEqual({ type: "wait" });
  });

  it("sends the current step on its policy channels when due", () => {
    const d = decideDunningAction({ ...base, currentStep: "final_notice" });
    expect(d).toEqual({
      type: "send",
      step: "final_notice",
      channels: ["email", "sms", "letter"],
    });
  });

  it("hands off (no auto-send) at the agency step", () => {
    expect(decideDunningAction({ ...base, currentStep: "agency" }).type).toBe(
      "handoff",
    );
  });

  it("acts now when nextActionAt is null", () => {
    const d = decideDunningAction({ ...base, nextActionAt: null });
    expect(d.type).toBe("send");
  });
});

describe("nextDunningStep", () => {
  it("advances along the ladder with cumulative due dates", () => {
    expect(nextDunningStep("statement", "2026-06-01")).toEqual({
      step: "reminder",
      nextActionAt: "2026-06-08",
    });
    expect(nextDunningStep("reminder", "2026-06-01")).toEqual({
      step: "second_notice",
      nextActionAt: "2026-06-22",
    });
    expect(nextDunningStep("final_notice", "2026-06-01")).toEqual({
      step: "agency",
      nextActionAt: "2026-07-31",
    });
  });

  it("returns null past the last step", () => {
    expect(nextDunningStep("agency", "2026-06-01")).toBeNull();
  });
});

describe("shouldOpenDunningRun", () => {
  it("opens for a balance at/above the floor with no plan/autopay", () => {
    expect(shouldOpenDunningRun(DUNNING_MIN_BALANCE_CENTS, false, false)).toBe(
      true,
    );
  });

  it("does not open below the floor", () => {
    expect(
      shouldOpenDunningRun(DUNNING_MIN_BALANCE_CENTS - 1, false, false),
    ).toBe(false);
  });

  it("does not open when a plan or autopay is active", () => {
    expect(shouldOpenDunningRun(10000, true, false)).toBe(false);
    expect(shouldOpenDunningRun(10000, false, true)).toBe(false);
  });
});

describe("DEFAULT_DUNNING_POLICY", () => {
  it("ends at the agency step with no automated channels", () => {
    const last = DEFAULT_DUNNING_POLICY[DEFAULT_DUNNING_POLICY.length - 1]!;
    expect(last.step).toBe("agency");
    expect(last.channels).toEqual([]);
  });
});
