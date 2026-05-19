// pg-boss job: compliance auto-workflow engine.
//
// Runs every 15 minutes. Mirror of billing.auto-workflow for the
// Phase 10 compliance machinery — see
// lib/compliance/auto-workflow.ts for per-pass detail.
//
// Each pass is idempotent and de-duped via the audit_log cooldown
// row, so re-runs inside the 24-hour window are no-ops.

import type PgBoss from "pg-boss";

import { runComplianceWorkflowPass } from "../../lib/compliance/auto-workflow";
import { logger } from "../../lib/logger";

const JOB = "compliance.auto-workflow";
// 15-minute cadence is plenty — these checks compare to dates, not
// seconds. Running every 5m would just thrash the cooldown gate.
const CRON = "*/15 * * * *";

export async function registerComplianceAutoWorkflowJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runComplianceWorkflowPass();
      if (
        stats.baaExpiringPublished > 0 ||
        stats.baaExpiredPublished > 0 ||
        stats.oigOverduePublished > 0 ||
        stats.rightsOverduePublished > 0 ||
        stats.errors > 0
      ) {
        logger.info(
          { event: "compliance.auto-workflow.completed", ...stats },
          "compliance.auto-workflow: tick",
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
        "compliance.auto-workflow: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "compliance.auto-workflow scheduled");
}
