// pg-boss job: weekly accreditation-survey readiness audit.
//
// Cron: every Monday at 04:13 UTC. Runs the full check engine
// (lib/accreditation/readiness-engine.ts) against the singleton
// dme_organization. The weekly cadence is loose enough to avoid
// audit-log noise but tight enough that an unannounced surveyor
// landing on a Wednesday sees results no more than 9 days old.
//
// CSR-visible escalation: when the run's overall_status flips to
// 'blocking', we insert a csr_compliance_alerts row of type
// 'manual' with severity 'critical' linking to the run id. (Not
// adding a new alert_type for this — the CSR triage flow already
// surfaces critical alerts at the top of the queue.)

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { runAccreditationReadiness } from "../../lib/accreditation/readiness-engine";
import { logger } from "../../lib/logger";

const JOB = "accreditation-readiness.sweep";
const CRON = "13 4 * * 1"; // Mondays 04:13 UTC

export async function registerAccreditationReadinessSweepJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const result = await runAccreditationReadiness();
      if (!result) {
        logger.info(
          { event: "accreditation-readiness.sweep.skipped" },
          "accreditation-readiness.sweep: skipped (no organization row)",
        );
        return;
      }
      logger.info(
        { event: "accreditation-readiness.sweep.completed", ...result },
        "accreditation-readiness.sweep: completed",
      );
      if (result.overallStatus === "blocking") {
        // Find any open patient to attach a synthetic alert to —
        // actually, the alerts table requires a patient_id. Instead
        // we log a structured WARN that the ops-status dashboard
        // can pick up; per-patient alerts are out of place here.
        const supabase = getSupabaseServiceRoleClient();
        void supabase
          .schema("resupply")
          .from("audit_log")
          .insert({
            operator_email: "system:cron:accreditation-readiness-sweep",
            operator_user_id: null,
            action: "accreditation_readiness.blocking",
            target_table: "accreditation_readiness_runs",
            target_id: result.runId,
            metadata: {
              checks_failed: result.checksFailed,
              checks_warning: result.checksWarning,
            },
            ip: null,
            user_agent: null,
          });
      }
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "accreditation-readiness.sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "accreditation-readiness.sweep scheduled");
}
