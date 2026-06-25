// Tests for the auto-workflow engine's statement pass (pass 3).
//
// Focused on the pass's own selection logic after the row-cap fix:
//   * patients statemented inside the cooldown window are skipped
//   * statement GENERATION is capped at MAX_PER_PASS per tick (so one
//     tick can't fan out an unbounded number of PDF renders / events)
//   * the candidate scan is no longer bounded to a fixed top-N — distinct
//     off-cooldown patients are collected up to the per-tick cap
//
// The statement builder itself (`generatePatientBillingStatement`) and the
// webhook publisher are mocked — this test is about which patients the pass
// picks, not the PDF/COB math.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { publishEventMock } = vi.hoisted(() => ({ publishEventMock: vi.fn() }));
vi.mock("../webhooks/publisher", () => ({
  publishEvent: publishEventMock,
}));

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock("./statement-generation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./statement-generation")>();
  return { ...actual, generatePatientBillingStatement: generateMock };
});

import { runStatementPass } from "./auto-workflow-engine";
import {
  getOrgScopedClient,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001";

function orgScoped() {
  return getOrgScopedClient(
    TEST_ORG_ID,
    getSupabaseServiceRoleClient() as never,
  );
}

function freshStats() {
  return {
    scrubsTriggered: 0,
    denialAnalysesTriggered: 0,
    statementsQueued: 0,
    secondaryClaimsDrafted: 0,
    errors: 0,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  publishEventMock.mockReset();
  generateMock.mockReset();
  generateMock.mockImplementation(
    async ({ patientId }: { patientId: string }) => ({
      statementId: `stmt_${patientId}`,
      totalPatientResponsibilityCents: 4000,
      claimCount: 1,
    }),
  );
});

describe("runStatementPass — candidate selection", () => {
  it("skips patients statemented inside the cooldown window", async () => {
    // Cooldown set: one patient already statemented (single short page).
    stageSupabaseResponse("patient_billing_statements", "select", {
      data: [{ patient_id: "pat_cooldown" }],
    });
    // Candidate open-balance claims: two off-cooldown patients + the
    // on-cooldown one (single short page → scan stops after one read).
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        { patient_id: "pat_a" },
        { patient_id: "pat_b" },
        { patient_id: "pat_cooldown" },
        { patient_id: "pat_a" }, // a second claim for pat_a — deduped
      ],
    });

    const stats = freshStats();
    await runStatementPass(orgScoped(), stats);

    expect(stats.statementsQueued).toBe(2);
    const billedFor = generateMock.mock.calls.map((c) => c[0].patientId).sort();
    expect(billedFor).toEqual(["pat_a", "pat_b"]);
    expect(billedFor).not.toContain("pat_cooldown");
  });

  it("caps statement generation at MAX_PER_PASS (50) per tick", async () => {
    stageSupabaseResponse("patient_billing_statements", "select", { data: [] });
    // 60 distinct off-cooldown patients available this tick.
    stageSupabaseResponse("insurance_claims", "select", {
      data: Array.from({ length: 60 }, (_, i) => ({ patient_id: `pat_${i}` })),
    });

    const stats = freshStats();
    await runStatementPass(orgScoped(), stats);

    expect(stats.statementsQueued).toBe(50);
    expect(generateMock).toHaveBeenCalledTimes(50);
  });

  it("does nothing when every open-balance patient is on cooldown", async () => {
    stageSupabaseResponse("patient_billing_statements", "select", {
      data: [{ patient_id: "pat_a" }, { patient_id: "pat_b" }],
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: [{ patient_id: "pat_a" }, { patient_id: "pat_b" }],
    });

    const stats = freshStats();
    await runStatementPass(orgScoped(), stats);

    expect(stats.statementsQueued).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
  });
});
