import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  planSlaEscalations,
  runSlaEscalationSweep,
  type SlaConversationRow,
} from "./sla-escalation-sweep";

const NOW = Date.parse("2026-06-03T12:00:00.000Z");

function row(over: Partial<SlaConversationRow>): SlaConversationRow {
  return {
    id: "c1",
    patient_id: "p1",
    customer_id: null,
    status: "open",
    priority: "normal",
    sla_due_at: new Date(NOW - 10 * 60_000).toISOString(),
    escalated_at: null,
    ...over,
  };
}

beforeEach(() => supabaseMock.reset());

describe("planSlaEscalations (pure)", () => {
  it("warns on a recent breach, escalates to critical past 60 min", () => {
    const plans = planSlaEscalations(
      [
        row({
          id: "recent",
          sla_due_at: new Date(NOW - 10 * 60_000).toISOString(),
        }),
        row({
          id: "old",
          sla_due_at: new Date(NOW - 120 * 60_000).toISOString(),
        }),
      ],
      NOW,
    );
    const byId = Object.fromEntries(plans.map((p) => [p.conversationId, p]));
    expect(byId.recent.severity).toBe("warning");
    expect(byId.old.severity).toBe("critical");
    expect(byId.old.minutesOverdue).toBe(120);
  });

  it("treats an urgent-priority breach as critical immediately", () => {
    const plans = planSlaEscalations(
      [
        row({
          id: "u",
          priority: "urgent",
          sla_due_at: new Date(NOW - 1 * 60_000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(plans[0].severity).toBe("critical");
  });

  it("skips future, null-SLA, and already-escalated rows", () => {
    const plans = planSlaEscalations(
      [
        row({
          id: "future",
          sla_due_at: new Date(NOW + 60 * 60_000).toISOString(),
        }),
        row({ id: "nosla", sla_due_at: null }),
        row({
          id: "done",
          escalated_at: new Date(NOW - 5 * 60_000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(plans).toHaveLength(0);
  });
});

describe("runSlaEscalationSweep", () => {
  it("escalates each breached conversation and returns counts", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: [
        row({ id: "a", sla_due_at: "2020-01-01T00:00:00.000Z" }),
        row({
          id: "b",
          priority: "urgent",
          sla_due_at: "2020-01-01T00:00:00.000Z",
        }),
      ],
    });
    // Two race-guarded updates, each returns the updated row.
    stageSupabaseResponse("conversations", "update", { data: [{ id: "a" }] });
    stageSupabaseResponse("conversations", "update", { data: [{ id: "b" }] });

    const stats = await runSlaEscalationSweep();
    expect(stats.scanned).toBe(2);
    expect(stats.escalated).toBe(2);
    expect(stats.critical).toBe(2); // both are way past 60 min overdue
  });

  it("does not count a row that lost the escalation race", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: [row({ id: "raced", sla_due_at: "2020-01-01T00:00:00.000Z" })],
    });
    stageSupabaseResponse("conversations", "update", { data: [] }); // raced away
    const stats = await runSlaEscalationSweep();
    expect(stats.scanned).toBe(1);
    expect(stats.escalated).toBe(0);
  });
});
