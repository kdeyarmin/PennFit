// Tests for the patient-autopay charge tick's per-authorization claim
// (app-review 2026-06-10, P1-9).
//
// pg-boss can run two overlapping ticks (15-minute expiry retry, deploy
// rollover), and each tick reserves a FRESH patient_payments row — a
// different Stripe idempotency key, so overlapping runs used to mint
// two real PaymentIntents for the same balance. The fix is a CAS claim:
// stamp last_charge_attempt_at conditionally on the exact value the
// scan read; the losing tick's UPDATE matches zero rows and skips
// before any payment row or Stripe call exists.

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import type { OffSessionCharger } from "../../lib/billing/payment-plan-autocharge.js";
import { runPatientAutopayCharge } from "./patient-autopay-charge";

beforeEach(() => {
  supabaseMock.reset();
});

function stageAuthorizationScan(over: Record<string, unknown> = {}) {
  stageSupabaseResponse("patient_autopay_authorizations", "select", {
    data: [
      {
        id: "auth-1",
        patient_id: "pat-1",
        stripe_customer_id: "cus_1",
        stripe_payment_method_id: "pm_1",
        autopay_enabled: true,
        charge_attempts: 0,
        last_charge_attempt_at: null,
        ...over,
      },
    ],
    error: null,
  });
}

function stageOpenBalance() {
  stageSupabaseResponse("insurance_claims", "select", {
    data: [{ id: "claim-1", patient_responsibility_cents: 5000 }],
    error: null,
  });
  // Unsettled-payment guard: nothing in flight.
  stageSupabaseResponse("patient_payments", "select", {
    data: [],
    error: null,
  });
}

describe("runPatientAutopayCharge — per-authorization claim", () => {
  it("claims via CAS on the scanned last_charge_attempt_at before any charge", async () => {
    stageAuthorizationScan();
    stageOpenBalance();
    // Claim won.
    stageSupabaseResponse("patient_autopay_authorizations", "update", {
      data: [{ id: "auth-1" }],
      error: null,
    });
    // patient_payments reservation row.
    stageSupabaseResponse("patient_payments", "insert", {
      data: { id: "pay-1" },
      error: null,
    });

    const charger = vi.fn<OffSessionCharger>().mockResolvedValue({
      outcome: "failed",
      paymentIntentId: "pi_1",
      reason: "card_declined",
    });

    const stats = await runPatientAutopayCharge({ charger });

    expect(charger).toHaveBeenCalledTimes(1);
    expect(stats.failed).toBe(1);

    // The claim stamped the once-per-day marker conditionally on the
    // snapshot (null → IS NULL) plus the enabled/revoked re-check.
    const claimPayload = supabaseMock.writePayloads(
      "patient_autopay_authorizations",
      "update",
    )[0] as Record<string, unknown>;
    expect(claimPayload).toHaveProperty("last_charge_attempt_at");
    const filters = supabaseMock.filterCalls(
      "patient_autopay_authorizations",
      "update",
    );
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["autopay_enabled", true],
    });
    expect(filters).toContainEqual({ verb: "is", args: ["revoked_at", null] });
    expect(filters).toContainEqual({
      verb: "is",
      args: ["last_charge_attempt_at", null],
    });
  });

  it("CASes against the exact scanned timestamp when one exists", async () => {
    const yesterday = "2026-06-09T04:00:00.000Z";
    stageAuthorizationScan({ last_charge_attempt_at: yesterday });
    stageOpenBalance();
    stageSupabaseResponse("patient_autopay_authorizations", "update", {
      data: [{ id: "auth-1" }],
      error: null,
    });
    stageSupabaseResponse("patient_payments", "insert", {
      data: { id: "pay-1" },
      error: null,
    });

    const charger = vi.fn<OffSessionCharger>().mockResolvedValue({
      outcome: "failed",
      paymentIntentId: "pi_1",
      reason: "card_declined",
    });
    await runPatientAutopayCharge({ charger });

    expect(charger).toHaveBeenCalledTimes(1);
    const filters = supabaseMock.filterCalls(
      "patient_autopay_authorizations",
      "update",
    );
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["last_charge_attempt_at", yesterday],
    });
  });

  it("skips the charge entirely when a concurrent tick already claimed", async () => {
    stageAuthorizationScan();
    stageOpenBalance();
    // Claim lost — zero rows back.
    stageSupabaseResponse("patient_autopay_authorizations", "update", {
      data: [],
      error: null,
    });

    const charger = vi.fn<OffSessionCharger>();
    const stats = await runPatientAutopayCharge({ charger });

    expect(charger).not.toHaveBeenCalled();
    // No payment row was ever reserved — the loser backs out before
    // creating the second idempotency key.
    expect(supabaseMock.callCount("patient_payments", "insert")).toBe(0);
    expect(stats.charged).toBe(0);
    expect(stats.failed).toBe(0);
  });
});
