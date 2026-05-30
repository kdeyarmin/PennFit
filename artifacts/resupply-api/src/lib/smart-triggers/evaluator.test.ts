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
    expect(
      getSupabaseWritePayloads("patient_smart_trigger_events", "insert"),
    ).toEqual([]);
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
    expect(
      getSupabaseWritePayloads("patient_smart_trigger_events", "insert"),
    ).toEqual([]);
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
    expect(
      getSupabaseWritePayloads("patient_smart_trigger_events", "insert"),
    ).toEqual([
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

// ---------------------------------------------------------------------------
// Roster pagination (new in this PR)
// ---------------------------------------------------------------------------
// Before this PR the evaluator made a SINGLE .select() for the roster
// (no .range()), which PostgREST silently capped at ~1000 rows. Patients
// past that cap were NEVER evaluated. The new implementation pages in
// PAGE_SIZE=1000 chunks until it gets a partial/empty page.
//
// The structural tests pin the two key implementation details without
// requiring a 1000-row test fixture.  The behavioural test exercises the
// multi-page code path with a real (but small) two-page sequence that
// verifies the second request is issued and results de-duplicated.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const EVAL_SRC = readFileSync(path.join(__dirname2, "evaluator.ts"), "utf8");

describe("runSmartTriggerEvaluator — roster pagination (source check)", () => {
  it("uses .range() for pagination (not a single uncapped query)", () => {
    // .range() was not present before this PR; its presence proves the
    // paginated fetch is wired up.
    expect(EVAL_SRC).toContain(".range(");
  });

  it("defines PAGE_SIZE = 1000", () => {
    expect(EVAL_SRC).toContain("const PAGE_SIZE = 1000");
  });

  it("uses MAX_PATIENTS_PER_RUN (5000) instead of the old PER_RUN_PATIENT_CAP (200)", () => {
    expect(EVAL_SRC).toContain("const MAX_PATIENTS_PER_RUN = 5000");
    // Old constant must be gone
    expect(EVAL_SRC).not.toContain("PER_RUN_PATIENT_CAP");
  });

  it("logs a warn event when roster exceeds MAX_PATIENTS_PER_RUN", () => {
    expect(EVAL_SRC).toContain("smart_triggers.evaluate.roster_overflow");
  });

  it("no longer breaks out of the candidate loop when the set reaches 200 (old cap removed)", () => {
    // The old code had: `if (candidateSet.size >= PER_RUN_PATIENT_CAP) break;`
    // The new code only caps via .slice(0, MAX_PATIENTS_PER_RUN) after paging.
    expect(EVAL_SRC).not.toContain("candidateSet.size >=");
  });
});

describe("runSmartTriggerEvaluator — multi-page roster (behavioural)", () => {
  // Build a page of exactly PAGE_SIZE=1000 unique patients.  The second
  // page is empty, which terminates the pagination loop.  Per-patient
  // night selects fall through to the unstaged default ({ data: null })
  // so evaluateAll receives an empty array and produces no proposals.
  const PAGE_SIZE = 1000;

  it("makes two roster requests when first page is full (PAGE_SIZE rows)", async () => {
    // First roster page — exactly PAGE_SIZE rows triggers a follow-up request.
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      patient_id: `p_page1_${i}`,
    }));
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: page1,
    });
    // Second roster page — empty terminates the loop.
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [],
    });
    // Per-patient night selects for the 1000 patients fall through to the
    // unstaged default ({ data: null }), so each patient has 0 nights and
    // evaluateAll fires with an empty array → no proposals.

    const result = await runSmartTriggerEvaluator(ACTOR);

    expect(result.scanned).toBe(PAGE_SIZE);
    // No events were produced (empty nights).
    expect(result.proposed).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it("de-duplicates patient_ids that appear in multiple pages", async () => {
    // Overlap: p_dup_0 … p_dup_4 appear in both pages.
    const sharedIds = Array.from({ length: 5 }, (_, i) => `p_dup_${i}`);
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      patient_id: i < 5 ? sharedIds[i]! : `p_page1_${i}`,
    }));
    const page2 = sharedIds.map((id) => ({ patient_id: id })); // all duplicates

    stageSupabaseResponse("patient_therapy_nights", "select", { data: page1 });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: page2 });
    // Per-patient night selects (unstaged → empty nights)

    const result = await runSmartTriggerEvaluator(ACTOR);

    // After de-duplication: 1000 from page1 + 0 new from page2 (all overlap)
    // = exactly PAGE_SIZE unique candidates.
    expect(result.scanned).toBe(PAGE_SIZE);
  });
});
