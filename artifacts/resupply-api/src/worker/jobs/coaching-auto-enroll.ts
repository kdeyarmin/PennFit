// pg-boss job: daily auto-enroll of early-risk patients into adherence
// coaching (RT #R3).
//
// What this job does
// ------------------
// Daily cron. Calls `runCoachingAutoEnrollSweep()` — scores active
// patients still inside the early-therapy window and opens a
// `patient_coaching_plans` row for the genuinely at-risk ones who don't
// already have a recent/open plan — then logs the stats. All decision +
// suppression logic lives in the lib sweep; this file only wires it.
//
// Feature flag
// ------------
// OFF by default. Set `RESUPPLY_COACHING_AUTO_ENROLL_ENABLED=1` to turn
// it on. Mirrors the posture of `cart-abandonment.scan`: a deploy that
// lands this code does NOT start auto-creating clinical-workflow records
// until an operator opts in after reviewing the heuristic on their data.
//
// Scheduled at 05:23 UTC — after the nightly therapy sync (04:30) and the
// coaching progress sweep (04:41) so the freshest nights are scored.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { runCoachingAutoEnrollSweep } from "../../lib/clinical/coaching-auto-enroll";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const COACHING_AUTO_ENROLL_JOB = "coaching-plan.auto-enroll-sweep";

/** Daily 05:23 UTC — staggered after nightly-sync + progress-sweep. */
export const COACHING_AUTO_ENROLL_CRON = "23 5 * * *";

export async function registerCoachingAutoEnrollJob(
  boss: PgBoss,
): Promise<void> {
  if (process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED !== "1") {
    logger.info(
      { event: "coaching-plan.auto-enroll-sweep.disabled" },
      "coaching-plan.auto-enroll-sweep: not registered (RESUPPLY_COACHING_AUTO_ENROLL_ENABLED!=1)",
    );
    return;
  }
  await createQueueWithDlq(
    boss,
    COACHING_AUTO_ENROLL_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(COACHING_AUTO_ENROLL_JOB, async () => {
    try {
      const stats = await runCoachingAutoEnrollSweep();
      logger.info(
        { event: "coaching-plan.auto-enroll-sweep.completed", ...stats },
        "coaching-plan.auto-enroll-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "coaching-plan.auto-enroll-sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(COACHING_AUTO_ENROLL_JOB, COACHING_AUTO_ENROLL_CRON);
  logger.info(
    { cron: COACHING_AUTO_ENROLL_CRON },
    "coaching-plan.auto-enroll-sweep scheduled",
  );
}
