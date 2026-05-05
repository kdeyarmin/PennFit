// Unit tests for runSmartTriggerEvaluator (Phase G.13 helper).
//
// We mock the drizzle adapter + audit + the rule library so the test
// covers the orchestration layer specifically: candidate iteration,
// per-patient night fetch, proposal insert lifecycle (ON CONFLICT
// DO NOTHING returning empty → skippedExisting; non-empty → inserted),
// and the audit envelope shape.
//
// The pure rule logic (evaluateAll, evaluateLeakRising, etc.) is
// covered separately in ./index.test.ts; we only need a controlled
// stub of evaluateAll here.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

interface SelectStubFrame {
  rows: unknown[];
}
const selectQueue: SelectStubFrame[] = [];
const insertReturnQueue: Array<Array<{ id: string }>> = [];
const insertedValues: Array<Record<string, unknown>> = [];

const dbStub = {
  selectDistinct: vi.fn(() => {
    const result = selectQueue.shift()?.rows ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  select: vi.fn(() => {
    const result = selectQueue.shift()?.rows ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const obj: Record<string, unknown> = {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return obj;
      },
      onConflictDoNothing: () => obj,
      returning: () => Promise.resolve(insertReturnQueue.shift() ?? []),
    };
    return obj;
  }),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

import { runSmartTriggerEvaluator } from "./evaluator";

const ACTOR = {
  adminEmail: "ops@penn.example.com",
  adminUserId: "u_admin",
  ip: "10.0.0.1",
  userAgent: "vitest",
};

beforeEach(() => {
  selectQueue.length = 0;
  insertReturnQueue.length = 0;
  insertedValues.length = 0;
  logAuditMock.mockClear();
  evaluateAllMock.mockReset();
  evaluateAllMock.mockReturnValue([]);
});

describe("runSmartTriggerEvaluator", () => {
  it("returns zero counts when no candidate patients exist", async () => {
    selectQueue.push({ rows: [] }); // selectDistinct candidates
    const result = await runSmartTriggerEvaluator(ACTOR);
    expect(result).toEqual({
      scanned: 0,
      proposed: 0,
      inserted: 0,
      skippedExisting: 0,
    });
    expect(insertedValues).toEqual([]);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("scans candidates that produce no proposals without inserting", async () => {
    selectQueue.push({ rows: [{ patientId: "p_1" }, { patientId: "p_2" }] });
    selectQueue.push({ rows: [{ date: "2026-04-01" }] }); // p_1 nights
    selectQueue.push({ rows: [{ date: "2026-04-01" }] }); // p_2 nights
    evaluateAllMock.mockReturnValue([]);

    const result = await runSmartTriggerEvaluator(ACTOR);

    expect(result).toEqual({
      scanned: 2,
      proposed: 0,
      inserted: 0,
      skippedExisting: 0,
    });
    expect(insertedValues).toEqual([]);
  });

  it("inserts a new event + audits when a rule fires", async () => {
    selectQueue.push({ rows: [{ patientId: "p_1" }] });
    selectQueue.push({
      rows: [
        {
          date: "2026-04-15",
          usageMinutes: 240,
          ahi: 3.5,
          leakRateLMin: 12,
          pressureP95Cmh2o: 11,
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
    insertReturnQueue.push([{ id: "evt_new_1" }]);

    const result = await runSmartTriggerEvaluator(ACTOR);

    expect(result).toEqual({
      scanned: 1,
      proposed: 1,
      inserted: 1,
      skippedExisting: 0,
    });
    expect(insertedValues).toEqual([
      {
        patientId: "p_1",
        kind: "leak_rising",
        windowStartDate: "2026-04-01",
        windowEndDate: "2026-04-14",
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

  it("counts ON CONFLICT DO NOTHING (empty returning) as skippedExisting", async () => {
    selectQueue.push({ rows: [{ patientId: "p_1" }] });
    selectQueue.push({ rows: [{ date: "2026-04-15" }] });
    evaluateAllMock.mockReturnValue([
      {
        kind: "cushion_wear",
        windowStartDate: "2026-04-01",
        windowEndDate: "2026-04-14",
      },
    ]);
    insertReturnQueue.push([]); // ON CONFLICT skipped insert

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
    selectQueue.push({ rows: [{ patientId: "p_phi" }] });
    selectQueue.push({
      rows: [
        {
          date: "2026-04-15",
          usageMinutes: 240,
          ahi: 3.5,
          leakRateLMin: 99.9,
          pressureP95Cmh2o: 11,
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
    insertReturnQueue.push([{ id: "evt_phi_1" }]);

    await runSmartTriggerEvaluator(ACTOR);

    const audit = logAuditMock.mock.calls[0]?.[0];
    const auditJson = JSON.stringify(audit);
    // The detection inputs (leak rate, AHI, usage) must never appear
    // in the audit envelope — only kind + window dates + patient_id.
    expect(auditJson).not.toContain("99.9");
    expect(auditJson).not.toContain("usageMinutes");
    expect(auditJson).not.toContain("leakRate");
    expect(auditJson).not.toContain("ahi");
  });
});
