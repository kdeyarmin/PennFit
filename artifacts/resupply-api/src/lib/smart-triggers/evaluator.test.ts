// Unit tests for runSmartTriggerEvaluator (Phase G.13 helper).
//
// Mocks the Supabase service-role client + audit + the rule library
// so the test covers the orchestration layer specifically: candidate
// iteration, per-patient night fetch, proposal insert lifecycle
// (PostgREST returns `{ error: { code: '23505' } }` on the partial-
// unique-index violation → skippedExisting; `{ data: { id }, error:
// null }` → inserted), and the audit envelope shape.
//
// The pure rule logic (evaluateAll, evaluateLeakRising, etc.) is
// covered separately in ./index.test.ts; we only need a controlled
// stub of evaluateAll here.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const evaluateAllMock = vi.hoisted(() =>
  vi.fn<
    (nights: Array<{ date: string }>) => Array<{
      kind: string;
      windowStartDate: string;
      windowEndDate: string;
    }>
  >(() => []),
);
vi.mock("./index", () => ({ evaluateAll: evaluateAllMock }));

import { runSmartTriggerEvaluator } from "./evaluator";

const ACTOR = {
  adminEmail: "ops@penn.example.com",
  adminUserId: "u_admin",
  ip: "10.0.0.1",
  userAgent: "vitest",
};

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockClear();
  evaluateAllMock.mockReset();
  evaluateAllMock.mockReturnValue([]);
});

describe("runSmartTriggerEvaluator", () => {
  it("returns zero counts when no candidate patients exist", async () => {
    // Initial candidate roster is empty.
    stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });
    const result = await runSmartTriggerEvaluator(ACTOR);
    expect(result).toEqual({
      scanned: 0,
      proposed: 0,
      inserted: 0,
      skippedExisting: 0,
    });
    expect(getSupabaseWritePayloads("patient_smart_trigger_events", "insert"))
      .toEqual([]);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("scans candidates that produce no proposals without inserting", async () => {
    // Roster: two patients with at least one recent night.
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "p_1" }, { patient_id: "p_2" }],
    });
    // Per-patient night history.
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ night_date: "2026-04-01" }],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ night_date: "2026-04-01" }],
    });
    evaluateAllMock.mockReturnValue([]);

    const result = await runSmartTriggerEvaluator(ACTOR);

    expect(result).toEqual({
      scanned: 2,
      proposed: 0,
      inserted: 0,
      skippedExisting: 0,
    });
    expect(getSupabaseWritePayloads("patient_smart_trigger_events", "insert"))
      .toEqual([]);
  });

  it("inserts a new event + audits when a rule fires", async () => {
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "p_1" }],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          night_date: "2026-04-15",
          usage_minutes: 240,
          ahi: "3.5",
          leak_rate_l_min: "12",
          pressure_p95_cmh2o: "11",
        },
      ],
    });
    evaluateAllMock.mockReturnValue([
      {
        kind: "leak_rising",
        windowStartDate: "2026-04-01",
        windowEndDate: "2026-04-14",
      },
    ]);
    // PostgREST INSERT … RETURNING with .maybeSingle() returns the
    // single inserted row (or null if ON CONFLICT skipped). Here we
    // simulate a successful insert with a new id.
    stageSupabaseResponse("patient_smart_trigger_events", "insert", {
      data: { id: "evt_new_1" },
    });

    const result = await runSmartTriggerEvaluator(ACTOR);

    expect(result).toEqual({
      scanned: 1,
      proposed: 1,
      inserted: 1,
      skippedExisting: 0,
    });
    expect(getSupabaseWritePayloads("patient_smart_trigger_events", "insert"))
      .toEqual([
        {
          patient_id: "p_1",
          kind: "leak_rising",
          window_start_date: "2026-04-01",
          window_end_date: "2026-04-14",
        },
      ]);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      adminEmail: string | null;
      metadata: Record<string, unknown>;
      targetId: string;
    };
    expect(audit.action).toBe("patient.smart_trigger.detected");
    expect(audit.adminEmail).toBe("ops@penn.example.com");
    expect(audit.targetId).toBe("evt_new_1");
    expect(audit.metadata).toMatchObject({
      patient_id: "p_1",
      kind: "leak_rising",
      window_start: "2026-04-01",
      window_end: "2026-04-14",
    });
  });

  it("counts unique-violation (23505) as skippedExisting", async () => {
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "p_1" }],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ night_date: "2026-04-15" }],
    });
    evaluateAllMock.mockReturnValue([
      {
        kind: "cushion_wear",
        windowStartDate: "2026-04-01",
        windowEndDate: "2026-04-14",
      },
    ]);
    // Simulate the partial-unique-index hit: PostgREST surfaces it as
    // an error envelope with `code: "23505"`, the route swallows it
    // and bumps `skippedExisting`.
    stageSupabaseResponse("patient_smart_trigger_events", "insert", {
      error: { code: "23505", message: "duplicate key value" },
    });

    const result = await runSmartTriggerEvaluator(ACTOR);

    expect(result).toEqual({
      scanned: 1,
      proposed: 1,
      inserted: 0,
      skippedExisting: 1,
    });
    // No audit row when the insert was skipped.
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("PHI invariant — therapy values never reach the audit envelope", async () => {
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "p_phi" }],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          night_date: "2026-04-15",
          usage_minutes: 240,
          ahi: "3.5",
          leak_rate_l_min: "99.9",
          pressure_p95_cmh2o: "11",
        },
      ],
    });
    evaluateAllMock.mockReturnValue([
      {
        kind: "leak_rising",
        windowStartDate: "2026-04-01",
        windowEndDate: "2026-04-14",
      },
    ]);
    stageSupabaseResponse("patient_smart_trigger_events", "insert", {
      data: { id: "evt_phi_1" },
    });

    await runSmartTriggerEvaluator(ACTOR);

    const audit = logAuditMock.mock.calls[0]?.[0];
    const auditJson = JSON.stringify(audit);
    // The detection inputs (leak rate, AHI, usage) must never appear
    // in the audit envelope — only kind + window dates + patient_id.
    expect(auditJson).not.toContain("99.9");
    expect(auditJson).not.toContain("usage_minutes");
    expect(auditJson).not.toContain("leak_rate");
    expect(auditJson).not.toContain("ahi");
  });
});
