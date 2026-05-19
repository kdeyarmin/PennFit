// pg-boss job: PA Medicaid MCO 7-day PA SLA sweep.
//
// Fires every 6 hours (4 ticks/day) to keep mco_sla_status fresh
// against the 7-day window. Idempotent — the sweep walks every
// non-terminal PA and stamps the target_date + status; re-runs on
// the same dataset produce zero new alerts when nothing crossed a
// threshold.

import type PgBoss from "pg-boss";

import { runPaMcoSlaSweep } from "../../lib/billing/pa-sla-tracker";
import { logger } from "../../lib/logger";

const JOB = "pa-mco-sla.sweep";
const CRON = "17 */6 * * *";

export async function registerPaMcoSlaSweepJob(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runPaMcoSlaSweep();
      logger.info(
        { event: "pa-mco-sla.sweep.completed", ...stats },
        "pa-mco-sla.sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "pa-mco-sla.sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "pa-mco-sla.sweep scheduled");
}
