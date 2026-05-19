import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runPaMcoSlaSweep } from "./pa-sla-tracker";

describe("runPaMcoSlaSweep", () => {
  beforeEach(() => supabaseMock.reset());

  it("returns zero counts on an empty PA set", async () => {
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    const stats = await runPaMcoSlaSweep();
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
    const stats = await runPaMcoSlaSweep();
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
      data: [
        { display_name: "Highmark BCBS", line_of_business: "commercial" },
      ],
    });
    const stats = await runPaMcoSlaSweep();
    expect(stats.scanned).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.alertsCreated).toBe(0);
  });
});
