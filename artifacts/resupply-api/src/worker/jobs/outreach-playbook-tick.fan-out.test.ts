// Outreach-playbook tick: multi-tenant fan-out smoke coverage.
//
// The per-step send pipeline runs against a real PostgREST surface
// elsewhere. Here we verify the sweep fans out across active tenants (each
// scans its own due runs) and that the dispatcher flag gates each tenant
// independently.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const flagEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags.js", () => ({
  isFeatureEnabled: vi.fn(async () => flagEnabled.value),
}));

// Per-tenant brand resolver — stubbed so the test controls which name each
// org resolves to and can assert the rendered body carries the SENDING
// tenant's brand rather than the process-global RESUPPLY_PRACTICE_NAME.
const companyNameByOrg = vi.hoisted(
  () => ({ value: {} }) as { value: Record<string, string> },
);
vi.mock("../../lib/company-info.js", () => ({
  getCompanyInfo: vi.fn(async (orgId?: string) => ({
    name: companyNameByOrg.value[orgId ?? ""] ?? "CareMetric Breathe",
  })),
}));

import { runOutreachPlaybookSweep } from "./outreach-playbook-tick";

const NOW = new Date("2026-06-16T17:00:00Z");

beforeEach(() => {
  supabaseMock.reset();
  flagEnabled.value = true;
  companyNameByOrg.value = {};
});

describe("runOutreachPlaybookSweep — multi-tenant fan-out", () => {
  it("scans each active tenant's due runs when the dispatcher flag is on", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's due-run scan comes back empty → nothing sent.
    stageSupabaseResponse("outreach_playbook_runs", "select", { data: [] });
    stageSupabaseResponse("outreach_playbook_runs", "select", { data: [] });

    const stats = await runOutreachPlaybookSweep(NOW);
    expect(stats.scanned).toBe(0);
    expect(stats.flagDisabled).toBe(false);
    // Each active tenant ran its own due-run scan.
    expect(getSupabaseCallCount("outreach_playbook_runs", "select")).toBe(2);
  });

  it("gates each tenant on the dispatcher flag (per-tenant)", async () => {
    flagEnabled.value = false;
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const stats = await runOutreachPlaybookSweep(NOW);
    expect(stats.flagDisabled).toBe(true);
    // Both tenants short-circuit on the flag → no due-run scan.
    expect(getSupabaseCallCount("outreach_playbook_runs", "select")).toBe(0);
  });

  it("renders the body with the SENDING tenant's brand, not the global practice name", async () => {
    // One tenant with a due 'call' step whose body references the practice
    // name. The rendered staff script (persisted to the step log) must carry
    // THIS tenant's brand — resolved via getCompanyInfo(orgId) — never the
    // process-global RESUPPLY_PRACTICE_NAME (the seed brand).
    companyNameByOrg.value = { "org-a": "Acme DME" };
    process.env.RESUPPLY_PRACTICE_NAME = "Penn Home Medical Supply";

    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }],
    });
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
          body: "Call from {{practice_name}} about your resupply.",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        id: "pat-1",
        status: "active",
        legal_first_name: "Sam",
        communication_preferences: null,
        timezone: null,
        address: null,
      },
    });
    // Atomic claim succeeds (returns the run id).
    stageSupabaseResponse("outreach_playbook_runs", "update", {
      data: [{ id: "run-1" }],
    });

    const stats = await runOutreachPlaybookSweep(NOW);
    expect(stats.callTasksCreated).toBe(1);

    const logInserts = getSupabaseWritePayloads(
      "outreach_playbook_step_log",
      "insert",
    ) as Array<Record<string, unknown>>;
    const callTask = logInserts.find((r) => r.channel === "call");
    expect(callTask).toBeDefined();
    expect(String(callTask!.call_script)).toBe(
      "Call from Acme DME about your resupply.",
    );
    expect(String(callTask!.call_script)).not.toContain(
      "Penn Home Medical Supply",
    );

    delete process.env.RESUPPLY_PRACTICE_NAME;
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runOutreachPlaybookSweep(NOW);
    expect(stats.scanned).toBe(0);
    expect(stats.flagDisabled).toBe(false);
    expect(getSupabaseCallCount("outreach_playbook_runs", "select")).toBe(0);
  });
});
