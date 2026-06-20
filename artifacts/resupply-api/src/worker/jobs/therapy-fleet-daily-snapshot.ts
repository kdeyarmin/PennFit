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

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
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

/**
 * Capture one tenant's therapy-fleet daily snapshot. Extracted so the cron
 * can fan out across every active tenant — therapy_fleet_daily_metrics is
 * now keyed (org_id, metric_date) (migration 0381), so each tenant gets its
 * own daily row, and the four summary RPCs take a leading p_org_id. Returns
 * THIS tenant's snapshot result.
 */
export async function runTherapyFleetSnapshotForOrg(
  orgId: string,
): Promise<FleetSnapshotResult> {
  const supabase = getOrgScopedClient(orgId);

  const [overview, resupply, setup, clinical] = await Promise.all([
    supabase.raw().schema("resupply").rpc("therapy_fleet_overview", {
      p_org_id: orgId,
      p_window_days: 30,
    }),
    supabase.raw().schema("resupply").rpc("therapy_resupply_summary", {
      p_org_id: orgId,
      p_due_within_days: 0,
    }),
    supabase.raw().schema("resupply").rpc("therapy_setup_adherence_summary", {
      p_org_id: orgId,
    }),
    supabase.raw().schema("resupply").rpc("therapy_clinical_signal_counts", {
      p_org_id: orgId,
    }),
  ]);
  if (overview.error) throw overview.error;
  if (resupply.error) throw resupply.error;
  if (setup.error) throw setup.error;
  if (clinical.error) throw clinical.error;

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
  const cl = (
    Array.isArray(clinical.data) ? clinical.data[0] : clinical.data
  ) as Record<string, unknown> | null;

  const metricDate = new Date().toISOString().slice(0, 10);
  const row = {
    org_id: orgId,
    metric_date: metricDate,
    patients_with_data: int(ov?.patients_with_data),
    compliant: int(ov?.compliant),
    at_risk: int(ov?.at_risk),
    non_compliant: int(ov?.non_compliant),
    high_leak: int(ov?.high_leak),
    resupply_items_due: int(rs?.items_due),
    setups_in_window: int(su?.patients_in_window),
    setups_at_risk: int(su?.at_risk),
    clinical_signals_open: int(cl?.total),
    clinical_signals_high: int(cl?.high),
    clinical_signals_medium: int(cl?.medium),
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .raw()
    .schema("resupply")
    .from("therapy_fleet_daily_metrics")
    .upsert(row, { onConflict: "org_id,metric_date" });
  if (upsertErr) throw upsertErr;

  logger.info(
    {
      queue: THERAPY_FLEET_SNAPSHOT_JOB,
      org_id: orgId,
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

export async function runTherapyFleetSnapshot(): Promise<FleetSnapshotResult> {
  const metricDate = new Date().toISOString().slice(0, 10);

  // Fan out across every active tenant — each writes its own per-tenant
  // daily row (migration 0381), with per-tenant failure isolation. The
  // returned aggregate sums patient/at-risk counts across tenants.
  let patientsWithData = 0;
  let atRisk = 0;
  await forEachActiveOrg(
    async (orgId) => {
      const result = await runTherapyFleetSnapshotForOrg(orgId);
      patientsWithData += result.patientsWithData;
      atRisk += result.atRisk;
    },
    { jobName: THERAPY_FLEET_SNAPSHOT_JOB },
  );

  return { metricDate, patientsWithData, atRisk };
}
