// Outreach-playbook tick: where the dispatcher reads consent from.
//
// This job used to select `patients.communication_preferences`. That
// column is on `shop_customers`, so PostgREST answered 42703, the error
// landed in the patient-gate's `patientErr` branch, and the loop
// `continue`d — for EVERY run, on EVERY tick. The dispatcher therefore
// advanced no step and sent no message at all, while reporting the
// outcome only as an `errors` counter. It failed safe, but it was
// completely inert.
//
// A column-blind mock cannot reproduce that, so these tests pin the
// columns the patient gate asks for and the table the consent read
// targets.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseSelectColumns,
  getSupabaseFilterCalls,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const flagEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags.js", () => ({
  isFeatureEnabled: vi.fn(async () => flagEnabled.value),
}));

vi.mock("../../lib/company-info.js", () => ({
  getCompanyInfo: vi.fn(async () => ({ name: "Acme DME" })),
}));

import { runOutreachPlaybookSweep } from "./outreach-playbook-tick";

const ORG = "org-a";
// 17:00Z is 13:00 America/New_York — inside the 9am–8pm SMS window, so a
// quiet-hours defer cannot be mistaken for a consent skip.
const NOW = new Date("2026-06-16T17:00:00Z");

beforeEach(() => {
  supabaseMock.reset();
  flagEnabled.value = true;
});

/**
 * One tenant, one due `call` step, one active patient. `call` is used
 * because it needs no messaging vendor config to reach the step log,
 * which keeps these tests about consent rather than delivery.
 */
function stageDueCallStep(
  opts: { prefsResponse?: Record<string, unknown> } = {},
) {
  stageSupabaseResponse("organizations", "select", { data: [{ id: ORG }] });
  stageSupabaseResponse("outreach_playbook_runs", "select", {
    data: [
      {
        id: "run-1",
        playbook_id: "pb-1",
        patient_id: "pat-1",
        next_step_index: 0,
        started_at: NOW.toISOString(),
      },
    ],
  });
  stageSupabaseResponse("outreach_playbook_steps", "select", {
    data: [
      {
        playbook_id: "pb-1",
        step_index: 0,
        day_offset: 0,
        channel: "call",
        subject: null,
        body: "Call about your resupply.",
      },
    ],
  });
  stageSupabaseResponse("patients", "select", {
    data: {
      id: "pat-1",
      status: "active",
      legal_first_name: "Sam",
      email: "sam@example.com",
      portal_auth_user_id: null,
      timezone: "America/New_York",
      address: null,
    },
  });
  stageSupabaseResponse(
    "shop_customers",
    "select",
    opts.prefsResponse ?? {
      data: { communication_preferences: { smsTransactional: true } },
    },
  );
  stageSupabaseResponse("outreach_playbook_runs", "update", {
    data: [{ id: "run-1" }],
  });
}

describe("runOutreachPlaybookSweep — where consent comes from", () => {
  it("does not ask patients for communication_preferences", async () => {
    // The regression itself. `patients` has no such column, and asking
    // for it aborted the patient gate before any step could run.
    stageDueCallStep();

    await runOutreachPlaybookSweep(NOW);

    const selects = getSupabaseSelectColumns("patients");
    expect(selects.length).toBeGreaterThan(0);
    for (const cols of selects) {
      expect(cols).not.toContain("communication_preferences");
    }
    // It must ask for what the consent bridge actually needs instead.
    expect(selects.some((c) => c.includes("email"))).toBe(true);
    expect(selects.some((c) => c.includes("portal_auth_user_id"))).toBe(true);
  });

  it("reads consent from shop_customers and advances the step", async () => {
    stageDueCallStep();

    const stats = await runOutreachPlaybookSweep(NOW);

    // The proof the dispatcher is no longer inert.
    expect(stats.callTasksCreated).toBe(1);
    expect(stats.errors).toBe(0);

    const joins = getSupabaseFilterCalls("shop_customers", "select")
      .filter((f) => f.verb === "eq" && f.args[0] !== "org_id")
      .map((f) => f.args[0]);
    expect(joins).toContain("email_lower");

    const log = getSupabaseWritePayloads(
      "outreach_playbook_step_log",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(log.some((r) => r.channel === "call")).toBe(true);
  });

  it("holds the touch when consent cannot be read", async () => {
    // Preferences we could not read might be a refusal. Leaving the run
    // untouched costs one tick and consumes no step.
    stageDueCallStep({ prefsResponse: { error: { message: "boom" } } });

    const stats = await runOutreachPlaybookSweep(NOW);

    expect(stats.callTasksCreated).toBe(0);
    expect(stats.errors).toBe(1);
    // Nothing was claimed, so the next tick re-evaluates the same step.
    expect(
      getSupabaseWritePayloads("outreach_playbook_step_log", "insert"),
    ).toEqual([]);
  });

  it("still runs a step for a patient with no storefront account", async () => {
    // Most patients arrive through the insurance pipeline and never
    // create a shop_customers row. "No row" is not a refusal.
    stageDueCallStep({ prefsResponse: { data: null } });

    const stats = await runOutreachPlaybookSweep(NOW);

    expect(stats.callTasksCreated).toBe(1);
    expect(stats.errors).toBe(0);
  });
});
