// pg-boss job: daily snapshot of the therapy-fleet metrics.
//
// Captures one row per calendar day in resupply.therapy_fleet_daily_metrics
// by calling the existing summary RPCs:
//   * therapy_fleet_overview(30)        — compliance cohorts + clinical flags
//   * therapy_resupply_summary(0)       — supply items due now/overdue
//   * therapy_setup_adherence_summary() — 90-day window cohorts
//
// This is what turns the point-in-time fleet views into a trend: the
// /admin/therapy-fleet/trend route + the fleet-page sparklines read this
// history to answer "is compliance improving, is the at-risk count
// falling?". Scheduled AFTER the nightly therapy sync (which refreshes
// patient_therapy_nights) so each snapshot reflects fresh data.
//
// Idempotent: upsert on metric_date, so a manual re-run or a retry just
// overwrites today's row. Aggregate counts only — no PHI.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const THERAPY_FLEET_SNAPSHOT_JOB = "therapy-fleet.daily-snapshot";

function int(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

export interface FleetSnapshotResult {
  metricDate: string;
  patientsWithData: number;
  atRisk: number;
}

export async function registerTherapyFleetSnapshotJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    THERAPY_FLEET_SNAPSHOT_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(THERAPY_FLEET_SNAPSHOT_JOB, async () => {
    await runTherapyFleetSnapshot();
  });
  // 05:00 UTC — 30 minutes after the 04:30 nightly therapy sync so the
  // snapshot reflects the freshly-synced nights.
  await boss.schedule(THERAPY_FLEET_SNAPSHOT_JOB, "0 5 * * *");
  logger.info(
    { queue: THERAPY_FLEET_SNAPSHOT_JOB },
    "therapy fleet daily-snapshot worker registered",
  );
}

export async function runTherapyFleetSnapshot(): Promise<FleetSnapshotResult> {
  const supabase = getSupabaseServiceRoleClient();

  const [overview, resupply, setup] = await Promise.all([
    supabase.schema("resupply").rpc("therapy_fleet_overview", {
      p_window_days: 30,
    }),
    supabase.schema("resupply").rpc("therapy_resupply_summary", {
      p_due_within_days: 0,
    }),
    supabase.schema("resupply").rpc("therapy_setup_adherence_summary"),
  ]);
  if (overview.error) throw overview.error;
  if (resupply.error) throw resupply.error;
  if (setup.error) throw setup.error;

  const ov = (
    Array.isArray(overview.data) ? overview.data[0] : overview.data
  ) as Record<string, unknown> | null;
  const rs = (
    Array.isArray(resupply.data) ? resupply.data[0] : resupply.data
  ) as Record<string, unknown> | null;
  const su = (Array.isArray(setup.data) ? setup.data[0] : setup.data) as Record<
    string,
    unknown
  > | null;

  const metricDate = new Date().toISOString().slice(0, 10);
  const row = {
    metric_date: metricDate,
    patients_with_data: int(ov?.patients_with_data),
    compliant: int(ov?.compliant),
    at_risk: int(ov?.at_risk),
    non_compliant: int(ov?.non_compliant),
    high_leak: int(ov?.high_leak),
    resupply_items_due: int(rs?.items_due),
    setups_in_window: int(su?.patients_in_window),
    setups_at_risk: int(su?.at_risk),
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .schema("resupply")
    .from("therapy_fleet_daily_metrics")
    .upsert(row, { onConflict: "metric_date" });
  if (upsertErr) throw upsertErr;

  logger.info(
    {
      queue: THERAPY_FLEET_SNAPSHOT_JOB,
      metric_date: metricDate,
      patients_with_data: row.patients_with_data,
    },
    "therapy fleet daily snapshot captured",
  );

  return {
    metricDate,
    patientsWithData: row.patients_with_data,
    atRisk: row.at_risk,
  };
}
