// Tests for the therapy-fleet daily-snapshot worker job.
//
// Coverage:
//   * Fans out across active tenants and, per tenant, calls the four
//     summary RPCs with a leading p_org_id and upserts a single daily row
//     with the coerced counts (PostgREST returns bigint as strings).
//   * Upserts on (org_id, metric_date) (idempotent re-run, migration 0381).
//   * Propagates an RPC error instead of writing a partial row.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  stageSupabaseRpcResponse,
  getSupabaseRpcArgs,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runTherapyFleetSnapshot } from "./therapy-fleet-daily-snapshot";

beforeEach(() => {
  supabaseMock.reset();
});

function stageAllSummaries() {
  stageSupabaseRpcResponse("therapy_fleet_overview", {
    data: [
      {
        patients_with_data: "120",
        compliant: "70",
        at_risk: "25",
        non_compliant: "15",
        high_leak: "12",
      },
    ],
  });
  stageSupabaseRpcResponse("therapy_resupply_summary", {
    data: [{ items_due: "40" }],
  });
  stageSupabaseRpcResponse("therapy_setup_adherence_summary", {
    data: [{ patients_in_window: "30", at_risk: "5" }],
  });
  stageSupabaseRpcResponse("therapy_clinical_signal_counts", {
    data: [{ total: "18", high: "11", medium: "7" }],
  });
}

// Single-tenant fan-out: stage one active org so `listActiveOrgIds`
// resolves it and the sweep runs once. (org_id surfaces in the RPC args
// and the upsert payload — migration 0381.)
const ORG_ID = "org-a";
function stageActiveOrgs() {
  stageSupabaseResponse("organizations", "select", { data: [{ id: ORG_ID }] });
}

describe("runTherapyFleetSnapshot", () => {
  it("upserts a daily row with coerced counts, org-scoped per tenant", async () => {
    stageActiveOrgs();
    stageAllSummaries();
    const result = await runTherapyFleetSnapshot();

    expect(result.patientsWithData).toBe(120);
    expect(result.atRisk).toBe(25);
    expect(result.metricDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Every summary RPC received the tenant's p_org_id (migration 0381).
    expect(getSupabaseRpcArgs("therapy_fleet_overview")[0]).toEqual({
      p_org_id: ORG_ID,
      p_window_days: 30,
    });
    expect(getSupabaseRpcArgs("therapy_resupply_summary")[0]).toEqual({
      p_org_id: ORG_ID,
      p_due_within_days: 0,
    });
    expect(getSupabaseRpcArgs("therapy_setup_adherence_summary")[0]).toEqual({
      p_org_id: ORG_ID,
    });
    expect(getSupabaseRpcArgs("therapy_clinical_signal_counts")[0]).toEqual({
      p_org_id: ORG_ID,
    });

    const upserts = getSupabaseWritePayloads(
      "therapy_fleet_daily_metrics",
      "upsert",
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      org_id: ORG_ID,
      patients_with_data: 120,
      compliant: 70,
      at_risk: 25,
      non_compliant: 15,
      high_leak: 12,
      resupply_items_due: 40,
      setups_in_window: 30,
      setups_at_risk: 5,
      clinical_signals_open: 18,
      clinical_signals_high: 11,
      clinical_signals_medium: 7,
    });
    expect((upserts[0] as { metric_date: string }).metric_date).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("defaults missing summary fields to zero", async () => {
    stageActiveOrgs();
    stageSupabaseRpcResponse("therapy_fleet_overview", { data: [] });
    stageSupabaseRpcResponse("therapy_resupply_summary", { data: [] });
    stageSupabaseRpcResponse("therapy_setup_adherence_summary", { data: [] });
    stageSupabaseRpcResponse("therapy_clinical_signal_counts", { data: [] });
    const result = await runTherapyFleetSnapshot();
    expect(result.patientsWithData).toBe(0);
    const upserts = getSupabaseWritePayloads(
      "therapy_fleet_daily_metrics",
      "upsert",
    );
    expect(upserts[0]).toMatchObject({
      org_id: ORG_ID,
      patients_with_data: 0,
      resupply_items_due: 0,
      setups_in_window: 0,
      clinical_signals_open: 0,
      clinical_signals_high: 0,
      clinical_signals_medium: 0,
    });
  });

  it("isolates a per-tenant RPC error without writing that tenant's row", async () => {
    // forEachActiveOrg isolates per-tenant failures, so the sweep resolves
    // but the failing tenant writes no row.
    stageActiveOrgs();
    stageSupabaseRpcResponse("therapy_fleet_overview", {
      error: { message: "boom" },
    });
    stageSupabaseRpcResponse("therapy_resupply_summary", { data: [] });
    stageSupabaseRpcResponse("therapy_setup_adherence_summary", { data: [] });
    stageSupabaseRpcResponse("therapy_clinical_signal_counts", { data: [] });
    await runTherapyFleetSnapshot();
    expect(
      getSupabaseWritePayloads("therapy_fleet_daily_metrics", "upsert"),
    ).toEqual([]);
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const result = await runTherapyFleetSnapshot();
    expect(result.patientsWithData).toBe(0);
    expect(
      getSupabaseWritePayloads("therapy_fleet_daily_metrics", "upsert"),
    ).toEqual([]);
  });
});
