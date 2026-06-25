// pg-boss job: auto-workflow engine.
//
// Runs every 5 minutes. Closes the loop on AI-driven billing
// automation — see lib/billing/auto-workflow-engine.ts for the
// per-pass detail.

import type PgBoss from "pg-boss";

import { runAutoWorkflowPass } from "../../lib/billing/auto-workflow-engine";
import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const JOB = "billing.auto-workflow";
const CRON = "*/5 * * * *";

export async function registerAutoWorkflowJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(JOB, async () => {
    // Fan out per active tenant. Each pass scopes its work (and per-pass
    // feature-flag checks) to the tenant's own org. On a single-tenant
    // deployment this runs exactly once for the seed org — behavior
    // unchanged. forEachActiveOrg isolates a failing tenant so it can't
    // abort the others; a tenant throwing is logged + tallied there, so we
    // no longer re-throw out of the whole tick.
    await forEachActiveOrg(
      async (orgId) => {
        const stats = await runAutoWorkflowPass(orgId);
        if (
          stats.scrubsTriggered > 0 ||
          stats.denialAnalysesTriggered > 0 ||
          stats.statementsQueued > 0 ||
          stats.secondaryClaimsDrafted > 0 ||
          stats.errors > 0
        ) {
          logger.info(
            { event: "billing.auto-workflow.completed", orgId, ...stats },
            "billing.auto-workflow: tick",
          );
        }
      },
      { jobName: JOB },
    );
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "billing.auto-workflow scheduled");
}
