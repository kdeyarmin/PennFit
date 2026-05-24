// pg-boss job: daily capped-rental month advance.

import type PgBoss from "pg-boss";

import { runCappedRentalAdvance } from "../../lib/billing/capped-rental-advancer";
import { logger } from "../../lib/logger";
import { buildQueueConfig, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const JOB = "capped-rental.advance";
const CRON = "29 5 * * *"; // 05:29 UTC daily

export async function registerCappedRentalAdvanceJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB, buildQueueConfig(JOB, CRON_SCAN_QUEUE_OPTS));
  await boss.work(JOB, async () => {
    try {
      const stats = await runCappedRentalAdvance();
      logger.info(
        { event: "capped-rental.advance.completed", ...stats },
        "capped-rental.advance: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "capped-rental.advance: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "capped-rental.advance scheduled");
}
