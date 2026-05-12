// pg-boss job: nightly sweep that flags audit_log rows past the
// HIPAA 6-year retention floor as archived. Destruction itself is
// human-triggered.
//
// Posture mirrors patient-documents-retention-sweep: flag only,
// never auto-delete. Surveyors and counsel both want a human step
// in the destruction path.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const SWEEP_JOB = "audit-log.archive-sweep";
const SWEEP_CRON = "27 3 * * *";
/** 6 years — HIPAA Privacy Rule §164.530(j)(2) minimum. */
const RETENTION_YEARS = 6;

export interface ArchiveSweepStats {
  flagged: number;
}

export async function runAuditLogArchiveSweep(): Promise<ArchiveSweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RETENTION_YEARS);
  const cutoffIso = cutoff.toISOString();
  const nowIso = new Date().toISOString();

  const { data: flaggedRows, error } = await supabase
    .schema("resupply")
    .from("audit_log")
    .update({ archived_at: nowIso })
    .lt("occurred_at", cutoffIso)
    .is("archived_at", null)
    .select("id");
  if (error) throw error;
  return { flagged: (flaggedRows ?? []).length };
}

export async function registerAuditLogArchiveSweepJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(SWEEP_JOB);
  await boss.work(SWEEP_JOB, async () => {
    try {
      const stats = await runAuditLogArchiveSweep();
      logger.info(
        { event: "audit-log.archive-sweep.completed", ...stats },
        "audit-log.archive-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "audit-log.archive-sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(SWEEP_JOB, SWEEP_CRON);
  logger.info(
    { cron: SWEEP_CRON },
    "audit-log.archive-sweep scheduled",
  );
}
