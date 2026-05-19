// pg-boss job: weekly DWO / CMN expiry sweep.
//
// Surfaces alerts at T-60 / T-30 / T-7 days before expires_on so
// the CSR queue chases the renewal before claims start denying for
// missing-DWO.
//
// Idempotency: csr_compliance_alerts.metric_snapshot carries
// { dwoDocumentId, daysOut } — re-runs don't double-alert.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const JOB = "dwo.expiry-sweep";
const CRON = "37 4 * * 1"; // Mondays 04:37 UTC

const HEADS_UP_DAYS = [60, 30, 7];

export async function registerDwoExpirySweepJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runDwoExpirySweep();
      logger.info(
        { event: "dwo.expiry-sweep.completed", ...stats },
        "dwo.expiry-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "dwo.expiry-sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "dwo.expiry-sweep scheduled");
}

interface SweepStats {
  scanned: number;
  alertsCreated: number;
  byWindow: Record<number, number>;
}

async function runDwoExpirySweep(): Promise<SweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: SweepStats = {
    scanned: 0,
    alertsCreated: 0,
    byWindow: { 60: 0, 30: 0, 7: 0 },
  };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const window of HEADS_UP_DAYS) {
    const target = new Date(today);
    target.setUTCDate(target.getUTCDate() + window);
    const targetIso = target.toISOString().slice(0, 10);
    const { data: dwos } = await supabase
      .schema("resupply")
      .from("dwo_documents")
      .select("id, patient_id, hcpcs_family, form_type, expires_on")
      .eq("expires_on", targetIso)
      .limit(500);
    for (const row of dwos ?? []) {
      stats.scanned += 1;
      const { data: existing } = await supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .select("id")
        .eq("patient_id", row.patient_id)
        .eq("alert_type", "manual")
        .eq("status", "open")
        .filter("metric_snapshot->>dwoDocumentId", "eq", row.id)
        .filter("metric_snapshot->>daysOut", "eq", String(window))
        .limit(1);
      if (existing && existing.length > 0) continue;
      const severity: "warning" | "critical" =
        window <= 7 ? "critical" : "warning";
      await supabase
        .schema("resupply")
        .from("csr_compliance_alerts")
        .insert({
          patient_id: row.patient_id,
          alert_type: "manual",
          severity,
          summary: `${row.form_type.toUpperCase()} for ${row.hcpcs_family} expires in ${window} days (${row.expires_on})`,
          metric_snapshot: {
            dwoDocumentId: row.id,
            hcpcsFamily: row.hcpcs_family,
            formType: row.form_type,
            expiresOn: row.expires_on,
            daysOut: window,
          },
        });
      stats.alertsCreated += 1;
      stats.byWindow[window] = (stats.byWindow[window] ?? 0) + 1;
    }
  }
  return stats;
}
