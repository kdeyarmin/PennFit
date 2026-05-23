// Tests for runPriorAuthExpirySweep() — the exported function that
// contains all the business logic of the daily PA expiry job.
//
// Coverage:
//   * no expired PAs and no upcoming PAs → stats all zero, no DB writes
//   * N expired PAs → stats.expired === N, each gets a CSR alert + audit
//   * PA update failure is logged but doesn't stop the rest of the sweep
//   * pre-expiry heads-up windows (30, 14, 7 days):
//       - inserts alerts for PAs expiring on those exact dates
//       - severity: "warning" for 14 and 30 days, "critical" for 7 days
//   * idempotency: existing "open" alert for (priorAuthId, window) is not
//     duplicated
//   * error on the expired-PA query propagates as a throw (caller sees it)

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const logAuditBestEffortMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditBestEffortMock(...a),
  logAuditBestEffort: (...a: unknown[]) => logAuditBestEffortMock(...a),
}));

import { runPriorAuthExpirySweep } from "./prior-auth-expiry-sweep";

// ── Helpers ───────────────────────────────────────────────────────────

const PA_ID_1 = "11111111-1111-4111-8111-111111111111";
const PA_ID_2 = "22222222-2222-4222-8222-222222222222";
const PATIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * Returns a Date whose UTC representation is "today" at noon UTC.
 * Used to make the "today" argument deterministic.
 */
function todayUtc(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`);
}

function makeExpiredPaRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PA_ID_1,
    patient_id: PATIENT_ID,
    hcpcs_code: "E0601",
    payer_name: "Medicare Part B",
    approved_through: "2026-04-30",
    auth_number: "AUTH-001",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("runPriorAuthExpirySweep — expire step", () => {
  beforeEach(() => {
    supabaseMock.reset();
    logAuditBestEffortMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns zero stats when there are no expired PAs and no upcoming PAs", async () => {
    // Step 1: expired PAs query → empty
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // Steps 2-4: heads-up window queries (30, 14, 7 days) → empty
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    const stats = await runPriorAuthExpirySweep(todayUtc("2026-05-18"));
    expect(stats.expired).toBe(0);
    expect(stats.headsUpQueued).toBe(0);
    expect(stats.windows).toEqual({ 7: 0, 14: 0, 30: 0 });
  });

  it("expires one PA and writes a CSR alert + audit entry", async () => {
    // Expired PAs query
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    // UPDATE prior_authorizations
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    // Insert CSR alert
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // Heads-up windows 30/14/7 → nothing
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    const stats = await runPriorAuthExpirySweep(todayUtc("2026-05-18"));
    expect(stats.expired).toBe(1);
    expect(getSupabaseCallCount("prior_authorizations", "update")).toBe(1);
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(1);
    expect(logAuditBestEffortMock).toHaveBeenCalledTimes(1);
  });

  it("sets status: expired in the update payload", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    await runPriorAuthExpirySweep(todayUtc("2026-05-18"));

    const payloads = getSupabaseWritePayloads("prior_authorizations", "update");
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as Record<string, unknown>).status).toBe("expired");
  });

  it("inserts a CSR alert with type prior_auth_expired and severity critical", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    await runPriorAuthExpirySweep(todayUtc("2026-05-18"));

    const alertPayloads = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    const alert = alertPayloads[0] as Record<string, unknown>;
    expect(alert.alert_type).toBe("prior_auth_expired");
    expect(alert.severity).toBe("critical");
    expect(alert.patient_id).toBe(PATIENT_ID);
  });

  it("writes the audit entry with the system actor email", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    await runPriorAuthExpirySweep(todayUtc("2026-05-18"));

    expect(logAuditBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prior_authorization.expired",
        adminEmail: "system:cron:prior-auth-expiry-sweep",
        targetTable: "prior_authorizations",
        targetId: PA_ID_1,
      }),
      expect.anything(),
    );
  });

  it("expires two PAs and counts each", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        makeExpiredPaRow({ id: PA_ID_1 }),
        makeExpiredPaRow({ id: PA_ID_2 }),
      ],
    });
    // Two updates
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    const stats = await runPriorAuthExpirySweep(todayUtc("2026-05-18"));
    expect(stats.expired).toBe(2);
    expect(logAuditBestEffortMock).toHaveBeenCalledTimes(2);
  });

  it("continues sweeping other PAs when one update fails", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        makeExpiredPaRow({ id: PA_ID_1 }),
        makeExpiredPaRow({ id: PA_ID_2 }),
      ],
    });
    // First update fails
    stageSupabaseResponse("prior_authorizations", "update", {
      error: { message: "DB constraint violation" },
    });
    // Second update succeeds
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    const stats = await runPriorAuthExpirySweep(todayUtc("2026-05-18"));
    // Only the second PA counted (first was skipped after update failure).
    expect(stats.expired).toBe(1);
  });

  it("throws when the initial expired-PAs select fails", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      error: { message: "connection refused" },
    });

    await expect(
      runPriorAuthExpirySweep(todayUtc("2026-05-18")),
    ).rejects.toBeTruthy();
  });
});

describe("runPriorAuthExpirySweep — heads-up windows", () => {
  beforeEach(() => {
    supabaseMock.reset();
    logAuditBestEffortMock.mockReset().mockResolvedValue(undefined);
  });

  it("queues an alert for a PA expiring in 30 days", async () => {
    const today = todayUtc("2026-05-18");
    const expectedTarget = "2026-06-17"; // 30 days from 2026-05-18
    // No expired PAs
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // 30-day window: one upcoming PA
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ approved_through: expectedTarget })],
    });
    // Idempotency check → no existing alert
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    // Insert heads-up alert
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 14-day window → nothing
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // 7-day window → nothing
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });

    const stats = await runPriorAuthExpirySweep(today);
    expect(stats.headsUpQueued).toBe(1);
    expect(stats.windows[30]).toBe(1);
    expect(stats.windows[14]).toBe(0);
    expect(stats.windows[7]).toBe(0);
  });

  it("queues an alert for a PA expiring in 14 days", async () => {
    const today = todayUtc("2026-05-18");
    const expectedTarget = "2026-06-01"; // 14 days from 2026-05-18
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expired
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 30-day
    // 14-day window
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ approved_through: expectedTarget })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 7-day

    const stats = await runPriorAuthExpirySweep(today);
    expect(stats.windows[14]).toBe(1);
    expect(stats.headsUpQueued).toBe(1);
  });

  it("queues an alert for a PA expiring in 7 days", async () => {
    const today = todayUtc("2026-05-18");
    const expectedTarget = "2026-05-25"; // 7 days from 2026-05-18
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expired
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 30-day
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 14-day
    // 7-day window
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ approved_through: expectedTarget })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });

    const stats = await runPriorAuthExpirySweep(today);
    expect(stats.windows[7]).toBe(1);
    expect(stats.headsUpQueued).toBe(1);
  });

  it("uses severity=warning for 30-day and 14-day windows", async () => {
    const today = todayUtc("2026-05-18");
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // 30-day
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ id: PA_ID_1 })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 14-day
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ id: PA_ID_2 })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 7-day → nothing
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });

    await runPriorAuthExpirySweep(today);

    const alertPayloads = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    expect(alertPayloads).toHaveLength(2);
    for (const p of alertPayloads) {
      expect((p as Record<string, unknown>).severity).toBe("warning");
    }
  });

  it("uses severity=critical for the 7-day window", async () => {
    const today = todayUtc("2026-05-18");
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expired
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 30-day
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 14-day
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });

    await runPriorAuthExpirySweep(today);

    const alertPayloads = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    expect(alertPayloads).toHaveLength(1);
    expect((alertPayloads[0] as Record<string, unknown>).severity).toBe(
      "critical",
    );
  });

  it("stores alert_type: prior_auth_expiring and the window in metric_snapshot", async () => {
    const today = todayUtc("2026-05-18");
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // 7-day
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });

    await runPriorAuthExpirySweep(today);

    const alertPayloads = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    const alert = alertPayloads[0] as Record<string, unknown>;
    expect(alert.alert_type).toBe("prior_auth_expiring");
    const snapshot = alert.metric_snapshot as Record<string, unknown>;
    expect(snapshot.window).toBe(7);
    expect(snapshot.priorAuthId).toBe(PA_ID_1);
  });

  it("skips inserting an alert if one already exists (idempotency)", async () => {
    const today = todayUtc("2026-05-18");
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // 7-day: one upcoming PA
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    // Idempotency check → alert already exists
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: [{ id: "existing-alert-id" }],
    });

    const stats = await runPriorAuthExpirySweep(today);
    // No new alert was inserted.
    expect(stats.headsUpQueued).toBe(0);
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(0);
  });

  it("continues with remaining windows when heads-up read fails for one window", async () => {
    const today = todayUtc("2026-05-18");
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expired
    // 30-day: query error
    stageSupabaseResponse("prior_authorizations", "select", {
      error: { message: "timeout" },
    });
    // 14-day: OK, one PA
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 7-day → nothing
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });

    const stats = await runPriorAuthExpirySweep(today);
    // The 30-day window was skipped, but 14-day still ran.
    expect(stats.windows[14]).toBe(1);
    expect(stats.headsUpQueued).toBe(1);
  });

  it("processes all three windows when all have upcoming PAs", async () => {
    const today = todayUtc("2026-05-18");
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expired
    // 30-day
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ id: "pa-30" })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 14-day
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ id: "pa-14" })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 7-day
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ id: "pa-7" })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });

    const stats = await runPriorAuthExpirySweep(today);
    expect(stats.headsUpQueued).toBe(3);
    expect(stats.windows[30]).toBe(1);
    expect(stats.windows[14]).toBe(1);
    expect(stats.windows[7]).toBe(1);
  });
});

describe("runPriorAuthExpirySweep — combined expired + heads-up", () => {
  beforeEach(() => {
    supabaseMock.reset();
    logAuditBestEffortMock.mockReset().mockResolvedValue(undefined);
  });

  it("counts both expired and heads-up in the same run", async () => {
    const today = todayUtc("2026-05-18");
    // 1 expired PA
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ id: PA_ID_1 })],
    });
    // The expire UPDATE now `.select("id")`s the affected row so the
    // sweep can tell winner from loser of a concurrent-tick race.
    // Stage a one-element data payload so the row counts as claimed.
    stageSupabaseResponse("prior_authorizations", "update", {
      data: [{ id: "claimed" }],
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 30-day: 1 PA
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow({ id: PA_ID_2 })],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { error: null });
    // 14-day → nothing
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // 7-day → nothing
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });

    const stats = await runPriorAuthExpirySweep(today);
    expect(stats.expired).toBe(1);
    expect(stats.headsUpQueued).toBe(1);
    // Audit was called once for the expired PA.
    expect(logAuditBestEffortMock).toHaveBeenCalledTimes(1);
    // Two CSR alert inserts: one expired, one heads-up.
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(2);
  });
});
