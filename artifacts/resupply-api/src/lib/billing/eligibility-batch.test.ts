// Tests for Biller #31 write-half — the pure batch selector + the
// run-core (with an injected verify stub + staged supabase).

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  selectReverificationBatch,
  runEligibilityReverificationBatch,
} from "./eligibility-batch";
import { buildVerificationWorklist } from "./eligibility-worklist";

beforeEach(() => {
  supabaseMock.reset();
});

const DAY = 86_400_000;
function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
}

describe("selectReverificationBatch (pure)", () => {
  const items = buildVerificationWorklist([
    {
      id: "stale-1",
      patientId: "p1",
      rank: "primary",
      payerName: "Aetna",
      memberIdTail: null,
      verifiedAt: daysAgoIso(60),
      terminationDate: null,
    },
    {
      id: "never-1",
      patientId: "p2",
      rank: "primary",
      payerName: "BCBS",
      memberIdTail: null,
      verifiedAt: null,
      terminationDate: null,
    },
    {
      id: "ok-1",
      patientId: "p3",
      rank: "primary",
      payerName: "UHC",
      memberIdTail: null,
      verifiedAt: daysAgoIso(1),
      terminationDate: null,
    },
  ]).items;

  it("drops ok coverages and returns the due ones", () => {
    const got = selectReverificationBatch(items, new Map(), {
      cap: 10,
      minHoursBetweenAttempts: 168,
    });
    expect(got.sort()).toEqual(["never-1", "stale-1"]);
  });

  it("honors the cap", () => {
    const got = selectReverificationBatch(items, new Map(), {
      cap: 1,
      minHoursBetweenAttempts: 168,
    });
    expect(got).toHaveLength(1);
  });

  it("skips coverages attempted inside the throttle window", () => {
    const recent = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2h ago
    const got = selectReverificationBatch(
      items,
      new Map([["stale-1", recent]]),
      { cap: 10, minHoursBetweenAttempts: 168 },
    );
    expect(got).toEqual(["never-1"]); // stale-1 throttled out
  });

  it("re-includes a coverage once its last attempt ages past the window", () => {
    const old = new Date(Date.now() - 200 * 3_600_000).toISOString(); // >168h
    const got = selectReverificationBatch(items, new Map([["stale-1", old]]), {
      cap: 10,
      minHoursBetweenAttempts: 168,
    });
    expect(got.sort()).toEqual(["never-1", "stale-1"]);
  });
});

describe("runEligibilityReverificationBatch", () => {
  function stageCoverages(rows: Array<Record<string, unknown>>) {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: rows,
      error: null,
    });
  }
  function stageAttempts(
    rows: Array<{ insurance_coverage_id: string; requested_at: string }>,
  ) {
    stageSupabaseResponse("eligibility_checks", "select", {
      data: rows,
      error: null,
    });
  }

  it("fires a 270 for each due coverage and summarizes the run", async () => {
    stageCoverages([
      {
        id: "stale-1",
        patient_id: "p1",
        rank: "primary",
        payer_name: "Aetna",
        member_id: "M1",
        verified_at: daysAgoIso(60),
        termination_date: null,
      },
      {
        id: "never-1",
        patient_id: "p2",
        rank: "primary",
        payer_name: "BCBS",
        member_id: "M2",
        verified_at: null,
        termination_date: null,
      },
      {
        id: "ok-1",
        patient_id: "p3",
        rank: "primary",
        payer_name: "UHC",
        member_id: "M3",
        verified_at: daysAgoIso(1),
        termination_date: null,
      },
    ]);
    stageAttempts([]);

    const verify = vi.fn().mockResolvedValue({
      eligibilityCheckId: "e1",
      isaControlNumber: "000000001",
      traceReference: "T1",
      uploadOk: true,
      errorMessage: null,
    });

    const result = await runEligibilityReverificationBatch(
      { cap: 10 },
      { verify, throttleMs: 0 },
    );

    expect(result.scanned).toBe(3);
    expect(result.due).toBe(2);
    expect(result.selected).toBe(2);
    expect(result.fired).toBe(2);
    expect(result.uploadOk).toBe(2);
    expect(result.errored).toBe(0);
    expect(verify).toHaveBeenCalledTimes(2);
    const firedIds = verify.mock.calls.map((c) => c[0].insuranceCoverageId);
    expect(firedIds.sort()).toEqual(["never-1", "stale-1"]);
  });

  it("throttles out a coverage with a recent attempt", async () => {
    stageCoverages([
      {
        id: "stale-1",
        patient_id: "p1",
        rank: "primary",
        payer_name: "Aetna",
        member_id: "M1",
        verified_at: daysAgoIso(60),
        termination_date: null,
      },
    ]);
    stageAttempts([
      {
        insurance_coverage_id: "stale-1",
        requested_at: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
      },
    ]);

    const verify = vi.fn();
    const result = await runEligibilityReverificationBatch(
      { cap: 10, minHoursBetweenAttempts: 168 },
      { verify, throttleMs: 0 },
    );

    expect(result.due).toBe(1);
    expect(result.selected).toBe(0);
    expect(result.fired).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it("counts a verify that throws as errored without aborting the batch", async () => {
    stageCoverages([
      {
        id: "stale-1",
        patient_id: "p1",
        rank: "primary",
        payer_name: "PaperOnly",
        member_id: "M1",
        verified_at: daysAgoIso(60),
        termination_date: null,
      },
      {
        id: "never-1",
        patient_id: "p2",
        rank: "primary",
        payer_name: "BCBS",
        member_id: "M2",
        verified_at: null,
        termination_date: null,
      },
    ]);
    stageAttempts([]);

    const verify = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("payer does not accept electronic 270/271"),
      )
      .mockResolvedValueOnce({
        eligibilityCheckId: "e2",
        isaControlNumber: "000000002",
        traceReference: "T2",
        uploadOk: true,
        errorMessage: null,
      });

    const result = await runEligibilityReverificationBatch(
      { cap: 10 },
      { verify, throttleMs: 0 },
    );

    expect(result.fired + result.errored).toBe(2);
    expect(result.errored).toBe(1);
    expect(result.uploadOk).toBe(1);
  });
});
