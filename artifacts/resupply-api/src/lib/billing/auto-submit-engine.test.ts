// Tests for the auto-submit engine: the pure eligibility/grouping
// helpers, the DB-bound ready selection (against the staged supabase
// mock + an injected preflight), and the run orchestrator (with injected
// select + submit so no clearinghouse traffic is generated).

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  classifyEligibility,
  chunkClaimsByPayer,
  groupReadyClaims,
  selectSubmissionReadyClaims,
  runAutoSubmitBatch,
  type ReadyClaim,
  type SubmissionReadiness,
} from "./auto-submit-engine";
import type { BatchSubmitResult } from "./office-ally-batch";

beforeEach(() => {
  supabaseMock.reset();
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 5); // 2026-06-05

function readyClaim(over: Partial<ReadyClaim> = {}): ReadyClaim {
  return {
    claimId: "claim-1",
    patientId: "pat-1",
    patientName: "John Doe",
    payerProfileId: "payer-1",
    payerName: "Aetna PA",
    totalBilledCents: 12_000,
    dateOfService: "2026-05-01",
    eligibilityVerifiedAt: new Date(NOW - 5 * DAY).toISOString(),
    ...over,
  };
}

describe("classifyEligibility (pure)", () => {
  it("returns missing when there's no parsed result", () => {
    expect(classifyEligibility(undefined, { nowMs: NOW })).toBe("missing");
  });

  it("returns inactive when the latest 271 is not active", () => {
    expect(
      classifyEligibility(
        { isActive: false, respondedAt: new Date(NOW).toISOString() },
        { nowMs: NOW },
      ),
    ).toBe("inactive");
    expect(
      classifyEligibility(
        { isActive: null, respondedAt: new Date(NOW).toISOString() },
        { nowMs: NOW },
      ),
    ).toBe("inactive");
  });

  it("returns stale when active but older than the freshness window", () => {
    expect(
      classifyEligibility(
        {
          isActive: true,
          respondedAt: new Date(NOW - 200 * DAY).toISOString(),
        },
        { nowMs: NOW },
      ),
    ).toBe("stale");
  });

  it("returns ok when active and within the freshness window", () => {
    expect(
      classifyEligibility(
        { isActive: true, respondedAt: new Date(NOW - 5 * DAY).toISOString() },
        { nowMs: NOW },
      ),
    ).toBe("ok");
  });

  it("honors a custom freshDays window", () => {
    const ten = {
      isActive: true,
      respondedAt: new Date(NOW - 10 * DAY).toISOString(),
    };
    expect(classifyEligibility(ten, { nowMs: NOW, freshDays: 7 })).toBe(
      "stale",
    );
    expect(classifyEligibility(ten, { nowMs: NOW, freshDays: 30 })).toBe("ok");
  });
});

describe("chunkClaimsByPayer (pure)", () => {
  it("splits per payer and caps each batch at maxPerBatch", () => {
    const claims: ReadyClaim[] = [
      ...Array.from({ length: 3 }, (_, i) =>
        readyClaim({
          claimId: `a${i}`,
          payerProfileId: "P1",
          payerName: "P-One",
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        readyClaim({
          claimId: `b${i}`,
          payerProfileId: "P2",
          payerName: "P-Two",
        }),
      ),
    ];
    const batches = chunkClaimsByPayer(claims, 2);
    // P1 -> [2,1], P2 -> [2]
    expect(batches).toHaveLength(3);
    const p1 = batches.filter((b) => b.payerProfileId === "P1");
    expect(p1.map((b) => b.claimIds.length).sort()).toEqual([1, 2]);
    const p2 = batches.filter((b) => b.payerProfileId === "P2");
    expect(p2).toHaveLength(1);
    expect(p2[0]!.claimIds).toHaveLength(2);
  });
});

describe("groupReadyClaims (pure)", () => {
  it("groups by payer and sorts by claim count desc", () => {
    const claims: ReadyClaim[] = [
      readyClaim({ claimId: "a", payerProfileId: "P1", totalBilledCents: 100 }),
      readyClaim({ claimId: "b", payerProfileId: "P2", totalBilledCents: 200 }),
      readyClaim({ claimId: "c", payerProfileId: "P2", totalBilledCents: 300 }),
    ];
    const groups = groupReadyClaims(claims);
    expect(groups[0]!.payerProfileId).toBe("P2");
    expect(groups[0]!.claimCount).toBe(2);
    expect(groups[0]!.totalBilledCents).toBe(500);
    expect(groups[1]!.payerProfileId).toBe("P1");
  });
});

describe("selectSubmissionReadyClaims (gate end-to-end)", () => {
  it("admits only preflight-clean claims with active, fresh eligibility", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: "A",
          patient_id: "pa",
          payer_profile_id: "P1",
          insurance_coverage_id: "C1",
          total_billed_cents: 100,
          date_of_service: "2026-05-01",
        },
        {
          id: "B",
          patient_id: "pb",
          payer_profile_id: "P1",
          insurance_coverage_id: "C2",
          total_billed_cents: 200,
          date_of_service: "2026-05-01",
        },
        {
          id: "C",
          patient_id: "pc",
          payer_profile_id: null,
          insurance_coverage_id: "C3",
          total_billed_cents: 300,
          date_of_service: "2026-05-01",
        },
        {
          id: "D",
          patient_id: "pd",
          payer_profile_id: "P1",
          insurance_coverage_id: null,
          total_billed_cents: 400,
          date_of_service: "2026-05-01",
        },
        {
          id: "E",
          patient_id: "pe",
          payer_profile_id: "P1",
          insurance_coverage_id: "C5",
          total_billed_cents: 500,
          date_of_service: "2026-05-01",
        },
        {
          id: "F",
          patient_id: "pf",
          payer_profile_id: "P1",
          insurance_coverage_id: "C6",
          total_billed_cents: 600,
          date_of_service: "2026-05-01",
        },
        {
          id: "G",
          patient_id: "pg",
          payer_profile_id: "P1",
          insurance_coverage_id: "C7",
          total_billed_cents: 700,
          date_of_service: "2026-05-01",
        },
      ],
    });
    stageSupabaseResponse("eligibility_checks", "select", {
      data: [
        {
          insurance_coverage_id: "C1",
          is_active: true,
          responded_at: new Date(NOW - 5 * DAY).toISOString(),
        },
        {
          insurance_coverage_id: "C2",
          is_active: true,
          responded_at: new Date(NOW - 5 * DAY).toISOString(),
        },
        {
          insurance_coverage_id: "C5",
          is_active: false,
          responded_at: new Date(NOW - 5 * DAY).toISOString(),
        },
        {
          insurance_coverage_id: "C7",
          is_active: true,
          responded_at: new Date(NOW - 200 * DAY).toISOString(),
        },
      ],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: "P1", display_name: "Aetna PA" }],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "pa", legal_first_name: "John", legal_last_name: "Doe" }],
    });

    const preflight = async (claimId: string) =>
      claimId === "A"
        ? { readyToSubmit: true, errorCount: 0 }
        : { readyToSubmit: false, errorCount: 2 };

    const result = await selectSubmissionReadyClaims({ preflight, nowMs: NOW });

    expect(result.readyClaimCount).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.payerProfileId).toBe("P1");
    expect(result.groups[0]!.claims[0]!.claimId).toBe("A");
    expect(result.groups[0]!.claims[0]!.patientName).toBe("John Doe");
    expect(result.groups[0]!.claims[0]!.payerName).toBe("Aetna PA");

    const byReason = Object.fromEntries(
      result.excluded.map((e) => [e.claimId, e.reason]),
    );
    expect(byReason).toEqual({
      B: "preflight_blocked",
      C: "no_payer_profile",
      D: "no_coverage",
      E: "eligibility_inactive",
      F: "eligibility_missing",
      G: "eligibility_stale",
    });
    expect(result.scannedCount).toBe(7);
  });
});

describe("runAutoSubmitBatch (orchestration)", () => {
  function readiness(claims: ReadyClaim[]): SubmissionReadiness {
    return {
      groups: groupReadyClaims(claims),
      readyClaimCount: claims.length,
      readyPayerCount: groupReadyClaims(claims).length,
      readyTotalBilledCents: claims.reduce((s, c) => s + c.totalBilledCents, 0),
      excluded: [],
      scannedCount: claims.length,
      generatedAt: new Date(NOW).toISOString(),
    };
  }
  const okResult = (
    id: string,
    n: number,
    uploadOk = true,
  ): BatchSubmitResult => ({
    ok: true,
    submissionId: id,
    claimCount: n,
    isaControlNumber: "000000123",
    gsControlNumber: "123",
    fileSizeBytes: 100,
    transport: "sftp",
    uploadOk,
    uploadError: uploadOk ? null : "boom",
  });

  it("submits one batch per payer and tallies uploaded claims", async () => {
    const claims = [
      readyClaim({ claimId: "a", payerProfileId: "P1" }),
      readyClaim({ claimId: "b", payerProfileId: "P1" }),
      readyClaim({ claimId: "c", payerProfileId: "P2" }),
    ];
    const submitCalls: string[][] = [];
    const result = await runAutoSubmitBatch(
      { submittedByEmail: "ops@example.com", triggeredBy: "cron" },
      {
        select: async () => readiness(claims),
        submit: async (input) => {
          submitCalls.push(input.claimIds);
          return okResult(`sub-${input.claimIds[0]}`, input.claimIds.length);
        },
      },
    );
    expect(submitCalls).toHaveLength(2); // one per payer
    expect(result.batchesAttempted).toBe(2);
    expect(result.claimsSubmitted).toBe(3);
    expect(result.failures).toHaveLength(0);
    expect(result.skippedNotReady).toHaveLength(0);
  });

  it("only submits approved ids that are still ready and reports the rest", async () => {
    const claims = [
      readyClaim({ claimId: "a", payerProfileId: "P1" }),
      readyClaim({ claimId: "b", payerProfileId: "P1" }),
    ];
    const submitCalls: string[][] = [];
    const result = await runAutoSubmitBatch(
      {
        submittedByEmail: "ops@example.com",
        triggeredBy: "operator",
        approvedClaimIds: ["a", "ghost"],
      },
      {
        select: async () => readiness(claims),
        submit: async (input) => {
          submitCalls.push(input.claimIds);
          return okResult("sub-a", input.claimIds.length);
        },
      },
    );
    expect(submitCalls).toEqual([["a"]]);
    expect(result.claimsSubmitted).toBe(1);
    expect(result.skippedNotReady).toEqual(["ghost"]);
  });

  it("does not count claims when the upload failed, and records hard failures", async () => {
    const claims = [
      readyClaim({ claimId: "a", payerProfileId: "P1" }),
      readyClaim({ claimId: "c", payerProfileId: "P2" }),
    ];
    const result = await runAutoSubmitBatch(
      { submittedByEmail: "ops@example.com", triggeredBy: "cron" },
      {
        select: async () => readiness(claims),
        submit: async (input) =>
          input.claimIds[0] === "a"
            ? okResult("sub-a", 1, false) // transport failed
            : { ok: false, kind: "payer_not_electronic", detail: {} },
      },
    );
    expect(result.claimsSubmitted).toBe(0);
    expect(result.submissions).toHaveLength(1); // the transport-failed one persisted a row
    expect(result.submissions[0]!.uploadOk).toBe(false);
    expect(result.failures).toEqual([
      { payerProfileId: "P2", kind: "payer_not_electronic" },
    ]);
  });
});
