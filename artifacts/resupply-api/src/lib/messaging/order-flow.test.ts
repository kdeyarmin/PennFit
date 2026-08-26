// Tests for reactivatePatient (new in this PR).
//
// reactivatePatient is the exact inverse of pausePatient: it flips a
// `paused` patient back to `active` and re-enables the shop_customers
// SMS flags (smsMarketing: true, smsTransactional: true).
//
// Key invariants tested here:
//   1. A paused patient is set to active and shop_customers SMS flags
//      are re-enabled.
//   2. The update is guarded to `status = 'paused'` rows only — a
//      non-paused (e.g. archived) patient is a no-op.
//   3. If the patient has no email the function returns without
//      touching shop_customers.
//   4. If there is no matching shop_customers row the function returns
//      without error.
//   5. DB errors propagate as thrown exceptions.
//   6. Existing communication_preferences keys are preserved; only
//      smsMarketing and smsTransactional are overwritten.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  placeResupplyOrderForConversation,
  reactivatePatient,
  requestAddressChangeHold,
  releaseAddressChangeHold,
} from "./order-flow";
import { decideCoverageBlock } from "../billing/coverage-eligibility";
import { invalidateFeatureFlagCache } from "../feature-flags";

beforeEach(() => {
  supabaseMock.reset();
  invalidateFeatureFlagCache();
});

const PATIENT_ID = "00000000-0000-4000-8000-000000000011";
const ORG_ID = "00000000-0000-4000-8000-000000000000";
const CUSTOMER_ID = "00000000-0000-4000-8000-000000000022";

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("reactivatePatient — happy path", () => {
  it("sets patient status to active and re-enables sms flags", async () => {
    // patients update (guarded by .eq("status","paused")) returns the updated row
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    // shop_customers select by email_lower
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: {
          smsMarketing: false,
          smsTransactional: false,
        },
      },
      error: null,
    });
    // shop_customers update
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await expect(
      reactivatePatient(PATIENT_ID, ORG_ID),
    ).resolves.toBeUndefined();

    // Verify the patient update was called once
    expect(supabaseMock.callCount("patients", "update")).toBe(1);
    const [patientPayload] = supabaseMock.writePayloads(
      "patients",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(patientPayload!.status).toBe("active");

    // Verify shop_customers was updated with smsMarketing and smsTransactional = true
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(1);
    const [custPayload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = custPayload!.communication_preferences as Record<
      string,
      unknown
    >;
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
  });

  it("preserves existing communication_preferences keys while enabling SMS", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: {
          smsMarketing: false,
          smsTransactional: false,
          emailMarketing: true,
          someOtherKey: "preserved",
        },
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await reactivatePatient(PATIENT_ID, ORG_ID);

    const [custPayload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = custPayload!.communication_preferences as Record<
      string,
      unknown
    >;
    // New values
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
    // Preserved values
    expect(prefs.emailMarketing).toBe(true);
    expect(prefs.someOtherKey).toBe("preserved");
  });

  it("works when shop_customers has null communication_preferences", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: null,
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await expect(
      reactivatePatient(PATIENT_ID, ORG_ID),
    ).resolves.toBeUndefined();

    const [custPayload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = custPayload!.communication_preferences as Record<
      string,
      unknown
    >;
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-op paths
// ---------------------------------------------------------------------------

describe("reactivatePatient — no-op paths", () => {
  it("returns without touching shop_customers when the patient is not paused (null returned from conditional update)", async () => {
    // PostgREST returns null from the conditional update when no row
    // matched the .eq("status", "paused") guard — simulates an already-
    // active or archived patient.
    stageSupabaseResponse("patients", "update", {
      data: null,
      error: null,
    });

    await expect(
      reactivatePatient(PATIENT_ID, ORG_ID),
    ).resolves.toBeUndefined();

    // shop_customers should never be touched
    expect(supabaseMock.callCount("shop_customers", "select")).toBe(0);
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });

  it("returns without touching shop_customers when the patient has no email", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: null },
      error: null,
    });

    await expect(
      reactivatePatient(PATIENT_ID, ORG_ID),
    ).resolves.toBeUndefined();

    expect(supabaseMock.callCount("shop_customers", "select")).toBe(0);
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });

  it("returns without error when no matching shop_customers row exists", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "noaccount@example.com" },
      error: null,
    });
    // Unstaged select returns null (no matching row)
    stageSupabaseResponse("shop_customers", "select", {
      data: null,
      error: null,
    });

    await expect(
      reactivatePatient(PATIENT_ID, ORG_ID),
    ).resolves.toBeUndefined();

    // Should not attempt to update a row that doesn't exist
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("reactivatePatient — error propagation", () => {
  it("throws when the patients update returns an error", async () => {
    stageSupabaseResponse("patients", "update", {
      data: null,
      error: { message: "patients write failed", code: "PGRST500" },
    });

    await expect(reactivatePatient(PATIENT_ID, ORG_ID)).rejects.toMatchObject({
      message: "patients write failed",
    });
  });

  it("throws when the shop_customers update returns an error", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: null,
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: { message: "shop_customers write failed", code: "PGRST500" },
    });

    await expect(reactivatePatient(PATIENT_ID, ORG_ID)).rejects.toMatchObject({
      message: "shop_customers write failed",
    });
  });
});

// ---------------------------------------------------------------------------
// Contrast with pausePatient (regression guard)
// ---------------------------------------------------------------------------
// Ensure reactivatePatient does the OPPOSITE of pausePatient with respect
// to the smsMarketing / smsTransactional flags.

describe("reactivatePatient — contrast with pausePatient (regression guard)", () => {
  it("sets smsMarketing=true and smsTransactional=true (not false)", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: {
          smsMarketing: false,
          smsTransactional: false,
        },
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await reactivatePatient(PATIENT_ID, ORG_ID);

    const [payload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = payload!.communication_preferences as Record<string, unknown>;
    // If this were pausePatient the values would be false; they must be true here.
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideCoverageBlock — pure coverage decision matrix (#2)
// ---------------------------------------------------------------------------
// The order-time coverage guard only blocks on an EXPLICIT negative
// signal. Everything else (null row, unknown/positive fields) is "no
// opinion" → the order proceeds (fail open).

describe("decideCoverageBlock", () => {
  const ELIG_ID = "00000000-0000-4000-8000-0000000000e1";

  it("returns null when there is no parsed eligibility row", () => {
    expect(decideCoverageBlock(null, "Aetna")).toBeNull();
  });

  it("blocks (inactive) when is_active is explicitly false", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: false, requires_prior_auth: null },
        "Aetna",
      ),
    ).toEqual({
      reason: "inactive",
      payerName: "Aetna",
      eligibilityCheckId: ELIG_ID,
    });
  });

  it("blocks (prior_auth_required) when requires_prior_auth is true and plan is active", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: true, requires_prior_auth: true },
        "Cigna",
      ),
    ).toEqual({
      reason: "prior_auth_required",
      payerName: "Cigna",
      eligibilityCheckId: ELIG_ID,
    });
  });

  it("does NOT block an active plan with no PA requirement", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: true, requires_prior_auth: false },
        "Aetna",
      ),
    ).toBeNull();
  });

  it("does NOT block when activeness is unknown (null) — fail open", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: null, requires_prior_auth: false },
        "Aetna",
      ),
    ).toBeNull();
  });

  it("prefers the inactive reason over PA when both are negative", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: false, requires_prior_auth: true },
        "Aetna",
      ),
    ).toMatchObject({ reason: "inactive" });
  });
});

// ---------------------------------------------------------------------------
// placeResupplyOrderForConversation — order-time coverage guard (#2)
// ---------------------------------------------------------------------------

describe("placeResupplyOrderForConversation — coverage guard", () => {
  const CONV_ID = "00000000-0000-4000-8000-0000000000c1";
  const EPISODE_ID = "00000000-0000-4000-8000-0000000000e2";
  const RX_ID = "00000000-0000-4000-8000-0000000000r1";
  const COVERAGE_ID = "00000000-0000-4000-8000-0000000000cv";
  const ELIG_ID = "00000000-0000-4000-8000-0000000000e9";

  function stageLookupChain(): void {
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_ID, patient_id: PATIENT_ID, episode_id: EPISODE_ID },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: RX_ID,
        status: "outreach_pending",
      },
      error: null,
    });
    // Address-change guard (order-flow step 2b) probes
    // csr_compliance_alerts before the prescription read. The mock is a
    // per-table FIFO and does not filter on alert_type, so stage its
    // "no open address change" answer here to keep later alert lookups
    // aligned with the real call order.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    // isFeatureEnabled lookups, in call order: entitlement first
    // (staged OFF so the entitlement guard is skipped), eligibility
    // second (staged ON so the coverage guard runs).
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
      error: null,
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
      error: null,
    });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { id: COVERAGE_ID, payer_name: "Aetna" },
      error: null,
    });
  }

  it("holds the order and raises a CSR alert when the cached 271 is inactive", async () => {
    stageLookupChain();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: ELIG_ID,
        is_active: false,
        requires_prior_auth: null,
        status: "parsed",
        responded_at: new Date().toISOString(),
      },
      error: null,
    });
    // raiseCoverageAlert: no existing open alert, then insert.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: null,
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("coverage_blocked");
    if (result.status === "coverage_blocked") {
      expect(result.coverage.reason).toBe("inactive");
      expect(result.coverage.payerName).toBe("Aetna");
      expect(result.coverage.eligibilityCheckId).toBe(ELIG_ID);
    }

    // The episode must NOT be claimed/confirmed — the order is held.
    expect(supabaseMock.callCount("episodes", "update")).toBe(0);
    // Exactly one CSR alert row was written, with the right type.
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(1);
    const [alert] = supabaseMock.writePayloads(
      "csr_compliance_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert!.alert_type).toBe("resupply_coverage_blocked");
    expect(alert!.patient_id).toBe(PATIENT_ID);
  });

  it("does not de-dupe-insert when an open coverage alert already exists", async () => {
    stageLookupChain();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: ELIG_ID,
        is_active: false,
        requires_prior_auth: null,
        status: "parsed",
        responded_at: new Date().toISOString(),
      },
      error: null,
    });
    // An open alert already exists → raiseCoverageAlert returns early.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: { id: "existing-alert" },
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("coverage_blocked");
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// placeResupplyOrderForConversation — continued-use guard (#3)
// ---------------------------------------------------------------------------
// The guard only holds an order when the patient's own therapy data
// AFFIRMATIVELY shows non-use: ≥21 reported nights in the 30-day
// window AND fewer than half of them at 4+ hours. No data, sparse
// data, healthy data proceed (fail open by omission); lookup errors
// hold when the flag is ON (fail closed).

describe("placeResupplyOrderForConversation — continued-use guard", () => {
  const CONV_ID = "00000000-0000-4000-8000-0000000000c1";
  const EPISODE_ID = "00000000-0000-4000-8000-0000000000e2";
  const RX_ID = "00000000-0000-4000-8000-0000000000r1";

  /** Stage conversation → episode → prescription, then the three
      feature-flag reads in call order: entitlement OFF, eligibility
      OFF, usage-compliance ON. */
  function stageLookupChain(): void {
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_ID, patient_id: PATIENT_ID, episode_id: EPISODE_ID },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: RX_ID,
        status: "outreach_pending",
      },
      error: null,
    });
    // Address-change guard (order-flow step 2b) probes
    // csr_compliance_alerts before the prescription read. The mock is a
    // per-table FIFO and does not filter on alert_type, so stage its
    // "no open address change" answer here to keep later alert lookups
    // aligned with the real call order.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
      error: null,
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
      error: null,
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
      error: null,
    });
  }

  /** ISO date for "i days ago" — gives every row a unique night. */
  function nightDate(i: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Build N therapy-night rows on N distinct calendar nights, the
   * first `compliant` of which are 4h+.
   */
  function nightsRows(
    total: number,
    compliant: number,
  ): Array<{ night_date: string; usage_minutes: number | null }> {
    return Array.from({ length: total }, (_, i) => ({
      night_date: nightDate(i),
      usage_minutes: i < compliant ? 300 : 30,
    }));
  }

  /** Stage the post-guard happy path: claim succeeds, no existing
      fulfillments, insert returns one row. */
  function stageClaimAndFulfillment(): void {
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: EPISODE_ID }],
      error: null,
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: [],
      error: null,
    });
    stageSupabaseResponse("fulfillments", "insert", {
      data: [{ id: "00000000-0000-4000-8000-0000000000f1" }],
      error: null,
    });
  }

  it("holds the order and raises a usage-review CSR alert on affirmative non-use", async () => {
    stageLookupChain();
    // 30 reported nights, only 5 at 4h+ → well under the 50% bar.
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: nightsRows(30, 5),
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: null,
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("usage_review");
    if (result.status === "usage_review") {
      expect(result.usage.dataNights).toBe(30);
      expect(result.usage.compliantNights).toBe(5);
      expect(result.usage.windowDays).toBe(30);
    }
    // The episode must NOT be claimed/confirmed — the order is held.
    expect(supabaseMock.callCount("episodes", "update")).toBe(0);
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(1);
    const [alert] = supabaseMock.writePayloads(
      "csr_compliance_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert!.alert_type).toBe("resupply_usage_review");
    expect(alert!.patient_id).toBe(PATIENT_ID);
    // Counts only in the snapshot — never per-night detail.
    expect(alert!.metric_snapshot).toMatchObject({
      dataNights: 30,
      compliantNights: 5,
    });
  });

  it("proceeds when the patient has NO therapy data (fail open)", async () => {
    stageLookupChain();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
      error: null,
    });
    stageClaimAndFulfillment();

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(0);
  });

  it("proceeds on a sparse window (under 21 reported nights) even when all nights are low", async () => {
    stageLookupChain();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: nightsRows(10, 0),
      error: null,
    });
    stageClaimAndFulfillment();

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
  });

  it("dedupes multi-source rows to calendar nights (duplicates can't inflate a sparse window)", async () => {
    stageLookupChain();
    // 15 distinct nights, each reported by TWO cloud sources = 30 rows.
    // Counting rows would clear the 21-night minimum sample and hold
    // the order; counting calendar nights (15) must keep it sparse →
    // no opinion → the order proceeds.
    const fifteenNightsTwice = [...nightsRows(15, 0), ...nightsRows(15, 0)];
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: fifteenNightsTwice,
      error: null,
    });
    stageClaimAndFulfillment();

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
  });

  it("counts a night compliant when ANY source reports 4+ hours for it", async () => {
    stageLookupChain();
    // 30 distinct nights, every night low from source A; source B
    // re-reports the first 15 nights at 4+ hours. Per-night max ⇒
    // 15/30 compliant = at the 50% bar → no hold.
    const sourceA = nightsRows(30, 0);
    const sourceB = nightsRows(15, 15);
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [...sourceA, ...sourceB],
      error: null,
    });
    stageClaimAndFulfillment();

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
  });

  it("proceeds when usage is healthy (half or more nights at 4h+)", async () => {
    stageLookupChain();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: nightsRows(30, 15),
      error: null,
    });
    stageClaimAndFulfillment();

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
  });

  it("holds when the therapy-nights lookup errors (fail closed)", async () => {
    stageLookupChain();
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: null,
      error: { message: "boom" },
    });
    // raiseGuardLookupAlert: existing-open probe then insert.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: { id: "alert-lookup" },
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("guard_lookup_error");
    if (result.status === "guard_lookup_error") {
      expect(result.guard).toBe("usage");
    }
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(1);
    expect(supabaseMock.callCount("episodes", "update")).toBe(0);
  });

  it("skips the lookup entirely when the flag is OFF", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_ID, patient_id: PATIENT_ID, episode_id: EPISODE_ID },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: RX_ID,
        status: "outreach_pending",
      },
      error: null,
    });
    // Address-change guard (order-flow step 2b) probes
    // csr_compliance_alerts before the prescription read. The mock is a
    // per-table FIFO and does not filter on alert_type, so stage its
    // "no open address change" answer here to keep later alert lookups
    // aligned with the real call order.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    // All three guard flags OFF.
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("feature_flags", "select", {
        data: { enabled: false },
        error: null,
      });
    }
    stageClaimAndFulfillment();

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
    expect(supabaseMock.callCount("patient_therapy_nights", "select")).toBe(0);
  });
});

describe("placeResupplyOrderForConversation — refill-window guard", () => {
  const CONV_ID = "00000000-0000-4000-8000-0000000000d1";
  const EPISODE_ID = "00000000-0000-4000-8000-0000000000d2";
  const RX_ID = "00000000-0000-4000-8000-0000000000d3";

  /** Stage conversation → episode → prescription, then the four
      feature-flag reads in call order: entitlement OFF, eligibility OFF,
      usage OFF, refill-window ON. */
  function stageLookupChain(): void {
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_ID, patient_id: PATIENT_ID, episode_id: EPISODE_ID },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: RX_ID,
        status: "outreach_pending",
      },
      error: null,
    });
    // Address-change guard (order-flow step 2b) probes
    // csr_compliance_alerts before the prescription read. The mock is a
    // per-table FIFO and does not filter on alert_type, so stage its
    // "no open address change" answer here to keep later alert lookups
    // aligned with the real call order.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    // entitlement OFF, eligibility OFF, usage OFF, refill-window ON.
    for (const enabled of [false, false, false, true]) {
      stageSupabaseResponse("feature_flags", "select", {
        data: { enabled },
        error: null,
      });
    }
  }

  /** Stage the resolveSkuEntitlement reads: SKU→HCPCS map, the HCPCS
      rule (30-day supply), and the patient's last dispense `daysAgo`. */
  function stageEntitlementReads(daysAgo: number): void {
    stageSupabaseResponse("sku_hcpcs_map", "select", {
      data: [{ sku_prefix: "CUSHION-NASAL", hcpcs_code: "A7032" }],
      error: null,
    });
    stageSupabaseResponse("hcpcs_codes", "select", {
      data: {
        code: "A7032",
        min_interval_days: 30,
        max_quantity_per_period: 2,
        period_days: 30,
        active: true,
      },
      error: null,
    });
    const lastDispense = new Date();
    lastDispense.setUTCDate(lastDispense.getUTCDate() - daysAgo);
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          quantity: 1,
          created_at: lastDispense.toISOString(),
          status: "shipped",
        },
      ],
      error: null,
    });
  }

  it("holds the order and raises a refill-window CSR alert when it would ship too early", async () => {
    stageLookupChain();
    // Dispensed 5 days ago, 30-day supply → depletion 25 days out, ship
    // window opens at 25 − 10 = 15 days out → not allowed now.
    stageEntitlementReads(5);
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: null,
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("too_early");
    if (result.status === "too_early") {
      expect(result.refillWindow.hcpcsCode).toBe("A7032");
      expect(result.refillWindow.daysUntilShip).toBeGreaterThan(0);
    }
    // The episode must NOT be claimed — the order is held.
    expect(supabaseMock.callCount("episodes", "update")).toBe(0);
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(1);
    const [alert] = supabaseMock.writePayloads(
      "csr_compliance_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert!.alert_type).toBe("resupply_refill_too_early");
    expect(alert!.patient_id).toBe(PATIENT_ID);
  });

  it("proceeds when inside the 10-day ship window", async () => {
    stageLookupChain();
    // Dispensed 22 days ago, 30-day supply → depletion 8 days out, which
    // is inside the 10-day ship window → allowed.
    stageEntitlementReads(22);
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: EPISODE_ID }],
      error: null,
    });
    stageSupabaseResponse("fulfillments", "select", { data: [], error: null });
    stageSupabaseResponse("fulfillments", "insert", {
      data: [{ id: "00000000-0000-4000-8000-0000000000f9" }],
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(0);
  });
});

describe("placeResupplyOrderForConversation — refill attestation capture", () => {
  const CONV_ID = "00000000-0000-4000-8000-0000000000a1";
  const EPISODE_ID = "00000000-0000-4000-8000-0000000000a2";
  const RX_ID = "00000000-0000-4000-8000-0000000000a3";

  function stageOkConfirm(): void {
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_ID, patient_id: PATIENT_ID, episode_id: EPISODE_ID },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: RX_ID,
        status: "outreach_pending",
      },
      error: null,
    });
    // Address-change guard (order-flow step 2b) probes
    // csr_compliance_alerts before the prescription read. The mock is a
    // per-table FIFO and does not filter on alert_type, so stage its
    // "no open address change" answer here to keep later alert lookups
    // aligned with the real call order.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    // All four guard flags OFF (entitlement, eligibility, usage,
    // refill-window) so the confirm proceeds straight to the claim.
    for (let i = 0; i < 4; i++) {
      stageSupabaseResponse("feature_flags", "select", {
        data: { enabled: false },
        error: null,
      });
    }
    // Atomic claim + fulfillment insert.
    stageSupabaseResponse("episodes", "update", {
      data: [{ id: EPISODE_ID }],
      error: null,
    });
    stageSupabaseResponse("fulfillments", "select", { data: [], error: null });
    stageSupabaseResponse("fulfillments", "insert", {
      data: [{ id: "00000000-0000-4000-8000-0000000000fa" }],
      error: null,
    });
  }

  it("records a refill_confirmations row carrying the attestation when capture is ON", async () => {
    stageOkConfirm();
    // recordRefillConfirmation: capture flag ON (5th feature_flags read).
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
      error: null,
    });
    // Best-effort metadata resolve (HCPCS + depletion) — left unmapped so
    // the row records with null HCPCS but the attestation still persists.
    stageSupabaseResponse("sku_hcpcs_map", "select", { data: [], error: null });
    stageSupabaseResponse("refill_confirmations", "upsert", {
      data: null,
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
      affirmation: {
        channel: "sms",
        continuedUse: true,
        supplyLow: true,
        requestedBy: "self",
        ip: null,
        userAgent: null,
      },
    });

    expect(result.status).toBe("ok");
    expect(supabaseMock.callCount("refill_confirmations", "upsert")).toBe(1);
    const [row] = supabaseMock.writePayloads(
      "refill_confirmations",
      "upsert",
    ) as Array<Record<string, unknown>>;
    expect(row!.patient_id).toBe(PATIENT_ID);
    expect(row!.episode_id).toBe(EPISODE_ID);
    expect(row!.channel).toBe("sms");
    expect(row!.affirm_continued_use).toBe(true);
    expect(row!.affirm_supply_low).toBe(true);
    expect(typeof row!.attestation_text).toBe("string");
    expect((row!.attestation_text as string).length).toBeGreaterThan(0);
  });

  it("does not record a row when no affirmation is supplied", async () => {
    stageOkConfirm();

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("ok");
    expect(supabaseMock.callCount("refill_confirmations", "upsert")).toBe(0);
  });
});

// Address-change hold — closes the gap where a patient who confirmed and
// then asked to move (or asked to move and then clicked a still-valid
// confirm link) had supplies sent to the address already on file. The
// confirm path used to have no notion of a pending address change, and
// the edit path did nothing but flip the conversation to awaiting_admin.
describe("placeResupplyOrderForConversation — address-change guard", () => {
  const CONV_ID = "00000000-0000-4000-8000-0000000000f1";
  const EPISODE_ID = "00000000-0000-4000-8000-0000000000f2";
  const RX_ID = "00000000-0000-4000-8000-0000000000f3";
  const ALERT_ID = "00000000-0000-4000-8000-0000000000fa";

  function stageConversationAndEpisode(): void {
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_ID, patient_id: PATIENT_ID, episode_id: EPISODE_ID },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: RX_ID,
        status: "outreach_pending",
      },
      error: null,
    });
  }

  it("refuses to ship while an address change is open, and creates no fulfillment", async () => {
    stageConversationAndEpisode();
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: { id: ALERT_ID },
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).toBe("address_change_pending");
    // The whole point: nothing is queued toward the stale address.
    expect(supabaseMock.callCount("fulfillments", "insert")).toBe(0);
    // And we stop before the prescription read, so the guard is cheap.
    expect(supabaseMock.callCount("prescriptions", "select")).toBe(0);
  });

  it("proceeds normally when no address change is open", async () => {
    stageConversationAndEpisode();
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    for (let i = 0; i < 4; i++) {
      stageSupabaseResponse("feature_flags", "select", {
        data: { enabled: false },
        error: null,
      });
    }
    stageSupabaseResponse("episodes", "update", { data: null, error: null });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    stageSupabaseResponse("fulfillments", "insert", {
      data: [{ id: "00000000-0000-4000-8000-0000000000fb" }],
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).not.toBe("address_change_pending");
  });

  it("fails OPEN when the guard read errors, so a DB blip cannot block every refill", async () => {
    stageConversationAndEpisode();
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: { message: "connection reset", code: "57P01" },
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    for (let i = 0; i < 4; i++) {
      stageSupabaseResponse("feature_flags", "select", {
        data: { enabled: false },
        error: null,
      });
    }
    stageSupabaseResponse("episodes", "update", { data: null, error: null });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    stageSupabaseResponse("fulfillments", "insert", {
      data: [{ id: "00000000-0000-4000-8000-0000000000fc" }],
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
      orgId: ORG_ID,
    });

    expect(result.status).not.toBe("address_change_pending");
  });
});

describe("requestAddressChangeHold / releaseAddressChangeHold", () => {
  it("holds queued fulfillments and opens one alert", async () => {
    stageSupabaseResponse("fulfillments", "update", {
      data: [{ id: "f1" }, { id: "f2" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: null,
      error: null,
    });

    const out = await requestAddressChangeHold({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
      channel: "email",
    });

    expect(out).toEqual({ heldCount: 2, alertOpen: true });
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(1);
  });

  it("does not open a second alert when one is already open", async () => {
    stageSupabaseResponse("fulfillments", "update", {
      data: [],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: { id: "a1" },
      error: null,
    });

    const out = await requestAddressChangeHold({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
      channel: "sms",
    });

    expect(out).toEqual({ heldCount: 0, alertOpen: true });
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(0);
  });

  it("treats a lost insert race as already-open, not a failure", async () => {
    // The partial unique index collapses a concurrent double-click. The
    // loser must still report alertOpen: the alert exists, which is all
    // the confirm guard reads.
    stageSupabaseResponse("fulfillments", "update", {
      data: [{ id: "f1" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: null,
      error: { message: "duplicate key value", code: "23505" },
    });

    const out = await requestAddressChangeHold({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
      channel: "email",
    });

    expect(out).toEqual({ heldCount: 1, alertOpen: true });
  });

  it("still acknowledges the request when the hold write fails", async () => {
    // The patient must not see an error just because bookkeeping failed;
    // the alert is what actually blocks the confirm.
    stageSupabaseResponse("fulfillments", "update", {
      data: null,
      error: { message: "deadlock detected", code: "40P01" },
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: null,
      error: null,
    });

    const out = await requestAddressChangeHold({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
      channel: "email",
    });

    expect(out.heldCount).toBe(0);
    expect(out.alertOpen).toBe(true);
  });

  it("releases held fulfillments back to queued", async () => {
    stageSupabaseResponse("fulfillments", "update", {
      data: [{ id: "f1" }, { id: "f2" }, { id: "f3" }],
      error: null,
    });

    const released = await releaseAddressChangeHold({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
    });

    expect(released).toBe(3);
  });

  it("returns 0 rather than throwing when the release fails", async () => {
    stageSupabaseResponse("fulfillments", "update", {
      data: null,
      error: { message: "connection reset", code: "57P01" },
    });

    const released = await releaseAddressChangeHold({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
    });

    expect(released).toBe(0);
  });
});
