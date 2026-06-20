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
import { forEachActiveOrg } from "../lib/for-each-active-org";
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
    // A previously persisted pg-boss schedule keeps enqueueing
    // ticks into this now-worker-less queue (and replays them in
    // a burst on re-enable). Clear it so disabling the flag
    // actually stops the cron (table-guard pattern).
    // typeof-guarded like worker/lib/table-guard.ts — test
    // doubles (and old pg-boss) may not implement unschedule.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(COACHING_AUTO_ENROLL_JOB).catch(() => undefined);
    }
    return;
  }
  await createQueueWithDlq(
    boss,
    COACHING_AUTO_ENROLL_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(COACHING_AUTO_ENROLL_JOB, async () => {
    // Fan out across every active tenant. patient_coaching_plans +
    // patient_therapy_nights are tenant-scoped, so each tenant is scored on
    // its own org — the sweep gets an explicit orgId here (never the seed-org
    // default). forEachActiveOrg isolates per-tenant failures so one tenant's
    // DB error can't abort the rest of the sweep (or the scheduler tick).
    await forEachActiveOrg(
      async (orgId) => {
        const stats = await runCoachingAutoEnrollSweep(orgId);
        logger.info(
          {
            event: "coaching-plan.auto-enroll-sweep.completed",
            org_id: orgId,
            ...stats,
          },
          "coaching-plan.auto-enroll-sweep: completed",
        );
      },
      { jobName: COACHING_AUTO_ENROLL_JOB },
    );
  });
  await boss.schedule(COACHING_AUTO_ENROLL_JOB, COACHING_AUTO_ENROLL_CRON);
  logger.info(
    { cron: COACHING_AUTO_ENROLL_CRON },
    "coaching-plan.auto-enroll-sweep scheduled",
  );
}
