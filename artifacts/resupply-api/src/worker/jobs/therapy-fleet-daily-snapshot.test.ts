// Tests for the therapy-fleet daily-snapshot worker job.
//
// Coverage:
//   * Calls the three summary RPCs and upserts a single daily row with
//     the coerced counts (PostgREST returns bigint as strings).
//   * Upserts on metric_date (idempotent re-run).
//   * Propagates an RPC error instead of writing a partial row.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseRpcResponse,
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
}

describe("runTherapyFleetSnapshot", () => {
  it("upserts a daily row with coerced counts", async () => {
    stageAllSummaries();
    const result = await runTherapyFleetSnapshot();

    expect(result.patientsWithData).toBe(120);
    expect(result.atRisk).toBe(25);
    expect(result.metricDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const upserts = getSupabaseWritePayloads(
      "therapy_fleet_daily_metrics",
      "upsert",
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      patients_with_data: 120,
      compliant: 70,
      at_risk: 25,
      non_compliant: 15,
      high_leak: 12,
      resupply_items_due: 40,
      setups_in_window: 30,
      setups_at_risk: 5,
    });
    expect((upserts[0] as { metric_date: string }).metric_date).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("defaults missing summary fields to zero", async () => {
    stageSupabaseRpcResponse("therapy_fleet_overview", { data: [] });
    stageSupabaseRpcResponse("therapy_resupply_summary", { data: [] });
    stageSupabaseRpcResponse("therapy_setup_adherence_summary", { data: [] });
    const result = await runTherapyFleetSnapshot();
    expect(result.patientsWithData).toBe(0);
    const upserts = getSupabaseWritePayloads(
      "therapy_fleet_daily_metrics",
      "upsert",
    );
    expect(upserts[0]).toMatchObject({
      patients_with_data: 0,
      resupply_items_due: 0,
      setups_in_window: 0,
    });
  });

  it("propagates an RPC error without writing a row", async () => {
    stageSupabaseRpcResponse("therapy_fleet_overview", {
      error: { message: "boom" },
    });
    stageSupabaseRpcResponse("therapy_resupply_summary", { data: [] });
    stageSupabaseRpcResponse("therapy_setup_adherence_summary", { data: [] });
    await expect(runTherapyFleetSnapshot()).rejects.toBeDefined();
    expect(
      getSupabaseWritePayloads("therapy_fleet_daily_metrics", "upsert"),
    ).toEqual([]);
  });
});
