// Tests for the capped-rental-advancer, focused on the date-filtered
// fee-schedule lookup introduced in this PR.
//
// Before this PR, `defaultBilledForHcpcs` queried `payer_fee_schedules`
// without any date guards. A future-dated or already-expired fee row
// could be selected and used as the billed amount on the generated
// rental claim.
//
// The fix adds:
//   .lte("effective_from", onDate)
//   .or(`effective_through.is.null,effective_through.gte.${onDate}`)
//
// where `onDate` is the date of service for the new claim.  The tests
// verify:
//   1. The date filters are applied to the fee-schedule query.
//   2. The onDate passed to the filters equals the DOS that will be
//      stamped on the generated draft claim.
//   3. When no payer_profile_id is set, the fee schedule is not queried
//      and the product_hcpcs_map fallback is used instead.
//   4. When the fee schedule returns no row, the product_hcpcs_map
//      fallback is used.

import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runCappedRentalAdvance } from "./capped-rental-advancer";

beforeEach(() => {
  supabaseMock.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a cycle row whose anniversary has long since passed so advanceCycle
// always enters the "advance" branch (not noop or transfer).
//
// start_date="2025-01-01", current_month=1 →
//   nextDueMs = 2025-01-01 + 30 days = 2025-01-31 (well in the past)
//   dos        = "2025-01-31"
const BASE_CYCLE = {
  id: "cycle-001",
  patient_id: "patient-001",
  hcpcs_code: "E0601",
  payer_profile_id: "pp-001",
  insurance_coverage_id: "cov-001",
  start_date: "2025-01-01",
  current_month: 1,
  max_months: 13,
  status: "active",
};

// The expected DOS for the BASE_CYCLE advance:
//   new Date("2025-01-01T00:00:00Z").getTime() + 1 * 30 * 24 * 3600 * 1000
const EXPECTED_DOS = new Date(
  new Date("2025-01-01T00:00:00Z").getTime() + 30 * 24 * 3600 * 1000,
)
  .toISOString()
  .slice(0, 10);

// Stage the full sequence of Supabase calls for one advance cycle,
// optionally injecting a custom fee schedule response.
function stageFullAdvance({
  feeScheduleData = { allowed_cents: 25000 },
}: {
  feeScheduleData?: { allowed_cents: number } | null;
} = {}) {
  // 1. capped_rental_cycles roster
  stageSupabaseResponse("capped_rental_cycles", "select", {
    data: [BASE_CYCLE],
    error: null,
  });
  // 2. patient_therapy_nights compliance check (≥21 nights = compliant)
  const nights = Array.from({ length: 25 }, () => ({ usage_minutes: 300 }));
  stageSupabaseResponse("patient_therapy_nights", "select", {
    data: nights,
    error: null,
  });
  // 3. payer_profiles (optional lookup in advanceCycle)
  stageSupabaseResponse("payer_profiles", "select", {
    data: {
      display_name: "Highmark BCBS",
      payer_legal_name: "Highmark Blue Cross",
    },
    error: null,
  });
  // 4. payer_fee_schedules
  stageSupabaseResponse("payer_fee_schedules", "select", {
    data: feeScheduleData,
    error: null,
  });
  // 4b. capped_rental_cycles optimistic month-claim update — returns the
  //     claimed row so the advancer proceeds to generate the claim.
  stageSupabaseResponse("capped_rental_cycles", "update", {
    data: [{ id: "cycle-001" }],
    error: null,
  });
  // 5. insurance_claims insert
  stageSupabaseResponse("insurance_claims", "insert", {
    data: { id: "claim-001" },
    error: null,
  });
  // 6. insurance_claim_line_items insert
  stageSupabaseResponse("insurance_claim_line_items", "insert", {
    data: null,
    error: null,
  });
  // 7. insurance_claim_events insert
  stageSupabaseResponse("insurance_claim_events", "insert", {
    data: null,
    error: null,
  });
  // 8. capped_rental_cycles update (link latest_claim_id; current_month
  //    was already advanced by the optimistic month-claim above)
  stageSupabaseResponse("capped_rental_cycles", "update", {
    data: null,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Date filtering on payer_fee_schedules
// ---------------------------------------------------------------------------

describe("runCappedRentalAdvance — defaultBilledForHcpcs date filtering", () => {
  it("applies lte(effective_from, dos) to the fee-schedule query", async () => {
    stageFullAdvance();
    await runCappedRentalAdvance();

    const filters = supabaseMock.filterCalls("payer_fee_schedules", "select");
    const lteCall = filters.find((f) => f.verb === "lte");
    expect(lteCall).toBeDefined();
    expect(lteCall!.args[0]).toBe("effective_from");
    expect(lteCall!.args[1]).toBe(EXPECTED_DOS);
  });

  it("applies or(effective_through) with the DOS", async () => {
    stageFullAdvance();
    await runCappedRentalAdvance();

    const filters = supabaseMock.filterCalls("payer_fee_schedules", "select");
    const orCall = filters.find((f) => f.verb === "or");
    expect(orCall).toBeDefined();
    expect(orCall!.args[0] as string).toContain("effective_through.is.null");
    expect(orCall!.args[0] as string).toContain(EXPECTED_DOS);
  });

  it("the DOS used in the fee-schedule filter matches the claim's date_of_service", async () => {
    stageFullAdvance();
    await runCappedRentalAdvance();

    // The claim insert payload must carry the same DOS the filter used.
    const [claimPayload] = supabaseMock.writePayloads(
      "insurance_claims",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(claimPayload).toBeDefined();
    expect(claimPayload!.date_of_service).toBe(EXPECTED_DOS);

    // Confirm the lte filter also used that same DOS.
    const filters = supabaseMock.filterCalls("payer_fee_schedules", "select");
    const lteCall = filters.find((f) => f.verb === "lte");
    expect(lteCall!.args[1]).toBe(claimPayload!.date_of_service);
  });

  it("uses the fee-schedule allowed_cents as the claim's total_billed_cents", async () => {
    stageFullAdvance({ feeScheduleData: { allowed_cents: 25000 } });
    await runCappedRentalAdvance();

    const [claimPayload] = supabaseMock.writePayloads(
      "insurance_claims",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(claimPayload!.total_billed_cents).toBe(25000);
  });
});

// ---------------------------------------------------------------------------
// Fallback paths
// ---------------------------------------------------------------------------

describe("runCappedRentalAdvance — defaultBilledForHcpcs fallback paths", () => {
  it("falls back to product_hcpcs_map when the fee schedule returns no row", async () => {
    // Stage fee schedule returning null, then product_hcpcs_map returning a default.
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [BASE_CYCLE],
      error: null,
    });
    const nights = Array.from({ length: 25 }, () => ({ usage_minutes: 300 }));
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: nights,
      error: null,
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { display_name: "BCBS", payer_legal_name: null },
      error: null,
    });
    // No matching fee schedule row
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: null,
      error: null,
    });
    // product_hcpcs_map fallback
    stageSupabaseResponse("product_hcpcs_map", "select", {
      data: { default_billed_cents: 19999 },
      error: null,
    });
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: [{ id: "cycle-001" }],
      error: null,
    });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: "claim-002" },
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: null,
      error: null,
    });

    const stats = await runCappedRentalAdvance();
    expect(stats.advanced).toBe(1);

    const [claimPayload] = supabaseMock.writePayloads(
      "insurance_claims",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(claimPayload!.total_billed_cents).toBe(19999);
  });

  it("skips the fee-schedule lookup and goes directly to product_hcpcs_map when payer_profile_id is null", async () => {
    const cycleNoPayer = { ...BASE_CYCLE, payer_profile_id: null };
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [cycleNoPayer],
      error: null,
    });
    const nights = Array.from({ length: 25 }, () => ({ usage_minutes: 300 }));
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: nights,
      error: null,
    });
    // No payer_profile_id → payer_profiles and payer_fee_schedules are not queried.
    stageSupabaseResponse("product_hcpcs_map", "select", {
      data: { default_billed_cents: 18000 },
      error: null,
    });
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: [{ id: "cycle-001" }],
      error: null,
    });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: "claim-003" },
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: null,
      error: null,
    });

    const stats = await runCappedRentalAdvance();
    expect(stats.advanced).toBe(1);

    // payer_fee_schedules must not be queried when there's no payer profile.
    expect(supabaseMock.callCount("payer_fee_schedules", "select")).toBe(0);

    const [claimPayload] = supabaseMock.writePayloads(
      "insurance_claims",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(claimPayload!.total_billed_cents).toBe(18000);
  });

  it("returns 0 for billed_cents when both fee-schedule and product_hcpcs_map return no row", async () => {
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [BASE_CYCLE],
      error: null,
    });
    const nights = Array.from({ length: 25 }, () => ({ usage_minutes: 300 }));
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: nights,
      error: null,
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { display_name: "Unknown Payer", payer_legal_name: null },
      error: null,
    });
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: null,
      error: null,
    });
    // product_hcpcs_map also returns null
    stageSupabaseResponse("product_hcpcs_map", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: [{ id: "cycle-001" }],
      error: null,
    });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: "claim-004" },
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: null,
      error: null,
    });

    const stats = await runCappedRentalAdvance();
    expect(stats.advanced).toBe(1);

    const [claimPayload] = supabaseMock.writePayloads(
      "insurance_claims",
      "insert",
    ) as Array<Record<string, unknown>>;
    // defaultBilledForHcpcs returns 0 when no fee schedule or map entry found.
    expect(claimPayload!.total_billed_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stats and advance logic
// ---------------------------------------------------------------------------

describe("runCappedRentalAdvance — advance stats", () => {
  it("reports advanced=1 and byHcpcs entry when a cycle advances", async () => {
    stageFullAdvance();
    const stats = await runCappedRentalAdvance();
    expect(stats.advanced).toBe(1);
    expect(stats.byHcpcs["E0601"]).toBe(1);
    expect(stats.scanned).toBe(1);
    expect(stats.errored).toBe(0);
  });

  it("reports transferred=1 when the cycle has reached max_months", async () => {
    const transferCycle = {
      ...BASE_CYCLE,
      current_month: 13, // = max_months → transfer
      max_months: 13,
    };
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [transferCycle],
      error: null,
    });
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: null,
      error: null,
    });

    const stats = await runCappedRentalAdvance();
    expect(stats.transferred).toBe(1);
    expect(stats.advanced).toBe(0);
  });

  it("reports errored=1 when the claim insert fails", async () => {
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [BASE_CYCLE],
      error: null,
    });
    const nights = Array.from({ length: 25 }, () => ({ usage_minutes: 300 }));
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: nights,
      error: null,
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { display_name: "BCBS", payer_legal_name: null },
      error: null,
    });
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: { allowed_cents: 25000 },
      error: null,
    });
    // Optimistic month-claim succeeds so we reach the claim insert…
    stageSupabaseResponse("capped_rental_cycles", "update", {
      data: [{ id: "cycle-001" }],
      error: null,
    });
    // …which then fails. The advancer rolls the month back (a second,
    // unstaged capped_rental_cycles update → mock returns an empty
    // envelope) and rethrows, so the cycle is counted as errored.
    stageSupabaseResponse("insurance_claims", "insert", {
      data: null,
      error: { message: "insert failed", code: "PGRST500" },
    });

    const stats = await runCappedRentalAdvance();
    expect(stats.errored).toBe(1);
    expect(stats.advanced).toBe(0);
  });

  it("reports scanned=0 when no active cycles exist", async () => {
    stageSupabaseResponse("capped_rental_cycles", "select", {
      data: [],
      error: null,
    });

    const stats = await runCappedRentalAdvance();
    expect(stats.scanned).toBe(0);
    expect(stats.advanced).toBe(0);
  });
});
