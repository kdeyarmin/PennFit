// pg-boss job: auto-workflow engine.
//
// Runs every 5 minutes. Closes the loop on AI-driven billing
// automation — see lib/billing/auto-workflow-engine.ts for the
// per-pass detail.

import type PgBoss from "pg-boss";

import { runAutoWorkflowPass } from "../../lib/billing/auto-workflow-engine";
import { logger } from "../../lib/logger";

const JOB = "billing.auto-workflow";
const CRON = "*/5 * * * *";

export async function registerAutoWorkflowJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runAutoWorkflowPass();
      if (
        stats.scrubsTriggered > 0 ||
        stats.denialAnalysesTriggered > 0 ||
        stats.statementsQueued > 0 ||
        stats.errors > 0
      ) {
        logger.info(
          { event: "billing.auto-workflow.completed", ...stats },
          "billing.auto-workflow: tick",
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
        "billing.auto-workflow: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "billing.auto-workflow scheduled");
}
