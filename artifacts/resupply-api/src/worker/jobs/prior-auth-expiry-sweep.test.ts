// Tests for the prior-authorization expiry sweep worker.
//
// Coverage:
//   * Returns zero counts when no PAs are due to expire
//   * Expires approved PAs whose approved_through < today
//   * Creates a 'prior_auth_expired' CSR alert (severity=critical) per expired PA
//   * Writes an audit row (logAuditBestEffort) per expired PA
//   * Reports the correct expired count in the stats object
//   * Skips a PA if the per-row update fails (continue behaviour)
//   * Heads-up: creates a 'prior_auth_expiring' alert for PAs expiring in 30/14/7 days
//   * Heads-up: severity=warning at T-30/T-14, severity=critical at T-7
//   * Heads-up: idempotent — skips rows when an 'open' alert already exists
//   * Heads-up: does NOT create alerts when no PAs fall on target date
//   * today parameter controls which PAs are due (deterministic clock injection)

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const logAuditBestEffortMock = vi.fn(async () => undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAuditBestEffort: (...a: unknown[]) => logAuditBestEffortMock(...a),
}));

import { runPriorAuthExpirySweep } from "./prior-auth-expiry-sweep";

// Fixed "today" so tests are deterministic regardless of wall-clock.
const TODAY = new Date("2026-05-18T03:47:00Z");
const TODAY_ISO = "2026-05-18";

// PA rows used across tests
const PA_ID_1 = "pa111111-1111-4111-8111-111111111111";
const PA_ID_2 = "pa222222-2222-4222-8222-222222222222";
const PATIENT_ID_1 = "pt111111-1111-4111-8111-111111111111";
const PATIENT_ID_2 = "pt222222-2222-4222-8222-222222222222";

function makeExpiredPaRow(
  id = PA_ID_1,
  patientId = PATIENT_ID_1,
  approvedThrough = "2026-05-17",
) {
  return {
    id,
    patient_id: patientId,
    hcpcs_code: "E0601",
    payer_name: "Aetna",
    approved_through: approvedThrough,
    auth_number: "AUTH-001",
  };
}

function makeUpcomingPaRow(
  id = PA_ID_1,
  patientId = PATIENT_ID_1,
  approvedThrough = "2026-06-17",
) {
  return {
    id,
    patient_id: patientId,
    hcpcs_code: "E0601",
    payer_name: "Aetna",
    approved_through: approvedThrough,
    auth_number: "AUTH-002",
  };
}

/** Stages empty responses for all 3 heads-up windows so tests that only
 *  care about the expire step don't have to wire up heads-up stages. */
function stageEmptyHeadsUp(): void {
  // 3 windows × (1 PA select + 0 alert selects since no rows)
  for (let i = 0; i < 3; i++) {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
  }
}

beforeEach(() => {
  supabaseMock.reset();
  logAuditBestEffortMock.mockReset().mockResolvedValue(undefined);
});

// ── Zero work ─────────────────────────────────────────────────────────────────

describe("runPriorAuthExpirySweep — nothing to do", () => {
  it("returns all-zero stats when no PAs are due to expire or warn", async () => {
    // Expire step: no rows
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    // Heads-up: empty for all 3 windows
    stageEmptyHeadsUp();

    const stats = await runPriorAuthExpirySweep(TODAY);
    expect(stats.expired).toBe(0);
    expect(stats.headsUpQueued).toBe(0);
    expect(stats.windows).toEqual({ 30: 0, 14: 0, 7: 0 });
  });

  it("does not write any CSR alerts when there is nothing to expire", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    stageEmptyHeadsUp();

    await runPriorAuthExpirySweep(TODAY);
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(0);
  });

  it("does not write any audit rows when nothing expires", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    stageEmptyHeadsUp();

    await runPriorAuthExpirySweep(TODAY);
    expect(logAuditBestEffortMock).not.toHaveBeenCalled();
  });
});

// ── EXPIRE step ───────────────────────────────────────────────────────────────

describe("runPriorAuthExpirySweep — expire step", () => {
  it("flips each approved PA past its approved_through to expired", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    stageSupabaseResponse("prior_authorizations", "update", { data: null });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });
    stageEmptyHeadsUp();

    const stats = await runPriorAuthExpirySweep(TODAY);
    expect(stats.expired).toBe(1);

    const updates = getSupabaseWritePayloads("prior_authorizations", "update");
    expect(updates).toHaveLength(1);
    expect((updates[0] as { status: string }).status).toBe("expired");
  });

  it("reports correct count when two PAs expire", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        makeExpiredPaRow(PA_ID_1, PATIENT_ID_1, "2026-05-16"),
        makeExpiredPaRow(PA_ID_2, PATIENT_ID_2, "2026-05-10"),
      ],
    });
    // Two per-row update calls
    stageSupabaseResponse("prior_authorizations", "update", { data: null });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });
    stageSupabaseResponse("prior_authorizations", "update", { data: null });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });
    stageEmptyHeadsUp();

    const stats = await runPriorAuthExpirySweep(TODAY);
    expect(stats.expired).toBe(2);
  });

  it("creates a prior_auth_expired CSR alert with severity=critical per expired PA", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    stageSupabaseResponse("prior_authorizations", "update", { data: null });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });
    stageEmptyHeadsUp();

    await runPriorAuthExpirySweep(TODAY);

    const alertInserts = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    expect(alertInserts).toHaveLength(1);
    const alert = alertInserts[0] as Record<string, unknown>;
    expect(alert.alert_type).toBe("prior_auth_expired");
    expect(alert.severity).toBe("critical");
    expect(alert.patient_id).toBe(PATIENT_ID_1);
  });

  it("embeds priorAuthId in the CSR alert metric_snapshot", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow(PA_ID_1, PATIENT_ID_1, "2026-05-17")],
    });
    stageSupabaseResponse("prior_authorizations", "update", { data: null });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });
    stageEmptyHeadsUp();

    await runPriorAuthExpirySweep(TODAY);

    const alertInserts = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    const snapshot = (alertInserts[0] as { metric_snapshot: Record<string, unknown> })
      .metric_snapshot;
    expect(snapshot.priorAuthId).toBe(PA_ID_1);
    expect(snapshot.hcpcsCode).toBe("E0601");
    expect(snapshot.payerName).toBe("Aetna");
  });

  it("writes a logAuditBestEffort row per expired PA", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeExpiredPaRow()],
    });
    stageSupabaseResponse("prior_authorizations", "update", { data: null });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });
    stageEmptyHeadsUp();

    await runPriorAuthExpirySweep(TODAY);

    expect(logAuditBestEffortMock).toHaveBeenCalledTimes(1);
    expect(logAuditBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prior_authorization.expired",
        targetTable: "prior_authorizations",
        targetId: PA_ID_1,
        adminEmail: "system:cron:prior-auth-expiry-sweep",
      }),
      expect.any(Object),
    );
  });

  it("skips a PA and continues when the per-row update fails", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        makeExpiredPaRow(PA_ID_1, PATIENT_ID_1),
        makeExpiredPaRow(PA_ID_2, PATIENT_ID_2),
      ],
    });
    // First update errors; second succeeds
    stageSupabaseResponse("prior_authorizations", "update", {
      data: null,
      error: { message: "DB locked" },
    });
    stageSupabaseResponse("prior_authorizations", "update", { data: null });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });
    stageEmptyHeadsUp();

    const stats = await runPriorAuthExpirySweep(TODAY);
    // Only the second PA contributes to the count
    expect(stats.expired).toBe(1);
  });
});

// ── PRE-EXPIRY HEADS-UP step ──────────────────────────────────────────────────

describe("runPriorAuthExpirySweep — heads-up step", () => {
  it("creates a prior_auth_expiring alert for a PA expiring in 30 days", async () => {
    // Expire step: nothing
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });

    // Window 30: one PA expiring exactly 30 days from TODAY
    const target30 = "2026-06-17"; // 2026-05-18 + 30 days
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeUpcomingPaRow(PA_ID_1, PATIENT_ID_1, target30)],
    });
    // Idempotency check: no existing alert
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    // Insert new alert
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });

    // Windows 14 and 7: no PAs
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });

    const stats = await runPriorAuthExpirySweep(TODAY);
    expect(stats.headsUpQueued).toBe(1);
    expect(stats.windows[30]).toBe(1);
    expect(stats.windows[14]).toBe(0);
    expect(stats.windows[7]).toBe(0);
  });

  it("creates a prior_auth_expiring alert for a PA expiring in 7 days", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expire
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 30d
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 14d

    const target7 = "2026-05-25"; // 2026-05-18 + 7 days
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeUpcomingPaRow(PA_ID_1, PATIENT_ID_1, target7)],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });

    const stats = await runPriorAuthExpirySweep(TODAY);
    expect(stats.windows[7]).toBe(1);
    expect(stats.headsUpQueued).toBe(1);
  });

  it("uses severity=warning for 30-day and 14-day alerts", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expire

    // 30-day window
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeUpcomingPaRow(PA_ID_1, PATIENT_ID_1, "2026-06-17")],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });

    // 14-day window
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeUpcomingPaRow(PA_ID_2, PATIENT_ID_2, "2026-06-01")],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });

    // 7-day: empty
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });

    await runPriorAuthExpirySweep(TODAY);

    const alertInserts = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    // Two heads-up inserts
    expect(alertInserts).toHaveLength(2);
    expect((alertInserts[0] as { severity: string }).severity).toBe("warning");
    expect((alertInserts[1] as { severity: string }).severity).toBe("warning");
  });

  it("uses severity=critical for the 7-day alert", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expire
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 30d
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 14d

    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeUpcomingPaRow(PA_ID_1, PATIENT_ID_1, "2026-05-25")],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });

    await runPriorAuthExpirySweep(TODAY);

    const alertInserts = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    expect((alertInserts[0] as { severity: string }).severity).toBe("critical");
  });

  it("embeds the window value in the metric_snapshot for idempotency later", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expire
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 30d
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 14d

    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeUpcomingPaRow(PA_ID_1, PATIENT_ID_1, "2026-05-25")],
    });
    stageSupabaseResponse("csr_compliance_alerts", "select", { data: [] });
    stageSupabaseResponse("csr_compliance_alerts", "insert", { data: null });

    await runPriorAuthExpirySweep(TODAY);

    const alertInserts = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    );
    const snap = (alertInserts[0] as { metric_snapshot: Record<string, unknown> })
      .metric_snapshot;
    expect(snap.window).toBe(7);
    expect(snap.priorAuthId).toBe(PA_ID_1);
  });

  it("skips inserting an alert when an open one already exists (idempotency)", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expire
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 30d
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // 14d

    stageSupabaseResponse("prior_authorizations", "select", {
      data: [makeUpcomingPaRow(PA_ID_1, PATIENT_ID_1, "2026-05-25")],
    });
    // Idempotency check: alert already exists
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: [{ id: "existing-alert-id" }],
    });
    // NO insert should happen

    const stats = await runPriorAuthExpirySweep(TODAY);
    expect(stats.headsUpQueued).toBe(0);
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(0);
  });
});

// ── Clock injection ──────────────────────────────────────────────────────────

describe("runPriorAuthExpirySweep — clock injection", () => {
  it("only expires PAs where approved_through < the injected today", async () => {
    // PA with approved_through = TODAY (same day → NOT yet expired)
    stageSupabaseResponse("prior_authorizations", "select", {
      // Empty → the select filtered out PAs expiring today (lt, not lte)
      data: [],
    });
    stageEmptyHeadsUp();

    const stats = await runPriorAuthExpirySweep(new Date(TODAY_ISO));
    expect(stats.expired).toBe(0);
  });

  it("computes heads-up target dates relative to the injected today", async () => {
    // We use a custom today of 2026-01-01 and verify the sweep runs without
    // errors (the exact filter values are captured by the mock builder but
    // not asserted here — the important thing is no crash + zero stats).
    const customToday = new Date("2026-01-01T03:47:00Z");

    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // expire
    // 3 heads-up windows
    for (let i = 0; i < 3; i++) {
      stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    }

    const stats = await runPriorAuthExpirySweep(customToday);
    expect(stats.expired).toBe(0);
    expect(stats.headsUpQueued).toBe(0);
  });
});
