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

import { logAuditBestEffort } from "@workspace/resupply-audit";

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
        // Surface the blocking state via the audit log. The previous
        // implementation `void`-prefixed a raw `audit_log` insert,
        // which (a) bypassed the HMAC chain that migration 0116 put
        // around every audit row — every direct insert breaks the
        // chain — and (b) left the promise unhandled, so an insert
        // failure was silently lost AND would crash Node under
        // --unhandled-rejections=strict. logAuditBestEffort handles
        // chain signing, schema selection, and error logging.
        await logAuditBestEffort(
          {
            action: "accreditation_readiness.blocking",
            adminEmail: "system:cron:accreditation-readiness-sweep",
            adminUserId: null,
            targetTable: "accreditation_readiness_runs",
            targetId: result.runId,
            metadata: {
              checks_failed: result.checksFailed,
              checks_warning: result.checksWarning,
            },
            ip: null,
            userAgent: null,
          },
          {
            contextLabel: "accreditation_readiness_blocking_audit",
            onWriteFailure: (failure) => {
              logger.error(failure, "accreditation_readiness.audit_failed");
            },
          },
        );
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
