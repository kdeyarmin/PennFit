// Tests for the auto-workflow engine's secondary / COB pass (pass 4).
//
// Focused on the pass's own logic — flag gate, candidate selection,
// dedupe against existing secondaries, per-item draft + event publish, and
// stats accounting. The COB derivation + claim creation (the shared
// `generateSecondaryClaimDraft` helper) is exercised end-to-end by the
// route tests in secondary-claims.test.ts, so here it is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { flagEnabled } = vi.hoisted(() => ({ flagEnabled: { current: true } }));
vi.mock("../feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => flagEnabled.current),
}));

const { publishEventMock } = vi.hoisted(() => ({ publishEventMock: vi.fn() }));
vi.mock("../webhooks/publisher", () => ({
  publishEvent: publishEventMock,
}));

// Keep the real pure helpers (deriveSecondaryCob / filterSecondaryEligible /
// SECONDARY_CLAIM_SELECT) and only stub the I/O draft fn.
const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock("./secondary-claim-generator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./secondary-claim-generator")>();
  return { ...actual, generateSecondaryClaimDraft: generateMock };
});

import { runSecondaryClaimPass } from "./auto-workflow-engine";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

function freshStats() {
  return {
    scrubsTriggered: 0,
    denialAnalysesTriggered: 0,
    statementsQueued: 0,
    secondaryClaimsDrafted: 0,
    errors: 0,
  };
}

// A paid primary with a secondary coverage + a $40 balance — eligible.
function eligiblePrimary(id: string, balanceCents = 4000) {
  return {
    id,
    patient_id: `pat_${id}`,
    payer_name: "Aetna",
    status: "paid",
    payer_sequence: "primary",
    secondary_coverage_id: `cov_${id}`,
    total_billed_cents: 10000,
    total_allowed_cents: 8000,
    total_paid_cents: 4000,
    patient_responsibility_cents: balanceCents,
  };
}

describe("runSecondaryClaimPass", () => {
  beforeEach(() => {
    supabaseMock.reset();
    publishEventMock.mockReset();
    generateMock.mockReset();
    flagEnabled.current = true;
  });

  it("no-ops when the feature flag is disabled", async () => {
    flagEnabled.current = false;
    const stats = freshStats();
    await runSecondaryClaimPass(getSupabaseServiceRoleClient(), stats);
    expect(stats.secondaryClaimsDrafted).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("drafts a secondary for an eligible primary and publishes the event", async () => {
    // candidates query
    stageSupabaseResponse("insurance_claims", "select", {
      data: [eligiblePrimary("c1")],
    });
    // existing-secondaries query — none yet
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    generateMock.mockResolvedValueOnce({
      status: "created",
      secondaryClaimId: "sec_c1",
      cob: {
        primaryPaidCents: 4000,
        contractualCents: 2000,
        patientRespCents: 4000,
        billableToSecondaryCents: 4000,
      },
      lineCount: 2,
    });

    const stats = freshStats();
    await runSecondaryClaimPass(getSupabaseServiceRoleClient(), stats);

    expect(generateMock).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(stats.secondaryClaimsDrafted).toBe(1);
    expect(stats.errors).toBe(0);
    expect(publishEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "claim.secondary_drafted",
        payload: expect.objectContaining({
          claim_id: "sec_c1",
          primary_claim_id: "c1",
          line_count: 2,
        }),
      }),
    );
  });

  it("skips primaries that already have a secondary", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [eligiblePrimary("c1"), eligiblePrimary("c2")],
    });
    // c1 already spawned a secondary; c2 has not.
    stageSupabaseResponse("insurance_claims", "select", {
      data: [{ primary_claim_id: "c1" }],
    });
    generateMock.mockResolvedValueOnce({
      status: "created",
      secondaryClaimId: "sec_c2",
      cob: {
        primaryPaidCents: 4000,
        contractualCents: 2000,
        patientRespCents: 4000,
        billableToSecondaryCents: 4000,
      },
      lineCount: 1,
    });

    const stats = freshStats();
    await runSecondaryClaimPass(getSupabaseServiceRoleClient(), stats);

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledWith(expect.anything(), "c2");
    expect(stats.secondaryClaimsDrafted).toBe(1);
  });

  it("counts a real draft failure as an error but not a benign exists/no-op", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [eligiblePrimary("c1"), eligiblePrimary("c2")],
    });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    generateMock
      .mockResolvedValueOnce({ status: "exists", secondaryClaimId: "sec_x" })
      .mockResolvedValueOnce({ status: "create_failed" });

    const stats = freshStats();
    await runSecondaryClaimPass(getSupabaseServiceRoleClient(), stats);

    expect(stats.secondaryClaimsDrafted).toBe(0);
    expect(stats.errors).toBe(1);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("returns early when there are no candidates", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    const stats = freshStats();
    await runSecondaryClaimPass(getSupabaseServiceRoleClient(), stats);
    expect(generateMock).not.toHaveBeenCalled();
    expect(stats.secondaryClaimsDrafted).toBe(0);
  });

  it("records an error and bails when the candidate query fails", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      error: { message: "boom" },
    });
    const stats = freshStats();
    await runSecondaryClaimPass(getSupabaseServiceRoleClient(), stats);
    expect(stats.errors).toBe(1);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("records an error and bails when the existing-secondary lookup fails (no duplicate-create attempt)", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [eligiblePrimary("c1")],
    });
    stageSupabaseResponse("insurance_claims", "select", {
      error: { message: "boom" },
    });
    const stats = freshStats();
    await runSecondaryClaimPass(getSupabaseServiceRoleClient(), stats);
    expect(stats.errors).toBe(1);
    // Must NOT proceed to draft (which would risk duplicate creates).
    expect(generateMock).not.toHaveBeenCalled();
  });
});
