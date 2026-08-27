import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runPaMcoSlaSweepForOrg } from "./pa-sla-tracker";

const TEST_ORG_ID = "00000000-0000-4000-8000-000000000000";

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "pa-sla-tracker.ts"),
  "utf8",
);

describe("runPaMcoSlaSweepForOrg", () => {
  beforeEach(() => supabaseMock.reset());

  it("returns zero counts on an empty PA set", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    const stats = await runPaMcoSlaSweepForOrg(TEST_ORG_ID);
    expect(stats.scanned).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.alertsCreated).toBe(0);
  });

  it("stamps decided when decision_at is set", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        {
          id: "pa-1",
          patient_id: "pat-1",
          payer_name: "Keystone First",
          hcpcs_code: "E0601",
          status: "approved",
          submitted_at: "2026-05-12T10:00:00Z",
          decision_at: "2026-05-14T10:00:00Z",
          mco_sla_target_date: null,
          mco_sla_status: null,
          insurance_coverage_id: "cov-1",
        },
      ],
    });
    // resolvePayerLobMap → coverage lookup + payer_profiles lookup.
    stageSupabaseResponse("insurance_coverages", "select", {
      data: [{ id: "cov-1", payer_name: "Keystone First" }],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [
        { display_name: "Keystone First", line_of_business: "medicaid_mco" },
      ],
    });
    const stats = await runPaMcoSlaSweepForOrg(TEST_ORG_ID);
    expect(stats.scanned).toBe(1);
    expect(stats.byStatus.decided).toBe(1);
  });

  it("does NOT stamp non-MCO Medicaid commercial payers", async () => {
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [
        {
          id: "pa-1",
          patient_id: "pat-1",
          payer_name: "Highmark BCBS",
          hcpcs_code: "E0601",
          status: "submitted",
          submitted_at: "2026-05-12T10:00:00Z",
          decision_at: null,
          mco_sla_target_date: null,
          mco_sla_status: null,
          insurance_coverage_id: "cov-1",
        },
      ],
    });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: [{ id: "cov-1", payer_name: "Highmark BCBS" }],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ display_name: "Highmark BCBS", line_of_business: "commercial" }],
    });
    const stats = await runPaMcoSlaSweepForOrg(TEST_ORG_ID);
    expect(stats.scanned).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.alertsCreated).toBe(0);
  });
});

// Regression guard: PA SLA sweep must page past PostgREST max_rows.
// A bare `.limit(5000)` silently truncated, so PAs past the first
// unordered page never received SLA stamps.
describe("runPaMcoSlaSweepForOrg — paginated PA scan", () => {
  it("does not use a raw high .limit() that PostgREST would silently cap", () => {
    expect(SRC).not.toContain(".limit(5000)");
  });

  it("pages prior_authorizations with .range() ordered by id", () => {
    expect(SRC).toContain('.order("id", { ascending: true })');
    expect(SRC).toContain(".range(from, from + PAGE - 1)");
  });
});
