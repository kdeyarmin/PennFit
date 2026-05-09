// pg-boss job: daily multi-channel onboarding check-in dispatch +
// daily CSR compliance scan.
//
// Two related crons live in one module because they share the same
// data domain (active onboarding journeys + therapy-nights data) and
// scheduling them together makes the dependency obvious — the
// dispatcher fires first, then the compliance scan reads any
// vendor-failure attempts the dispatcher just logged.
//
// Cadence:
//   onboarding-checkins.dispatch  — daily 14:17 UTC (10:17 ET)
//   onboarding-checkins.scan      — daily 14:47 UTC (30 min later)
//
// Both are off-peak for our Eastern-US patient base but still
// in-business-hours so a vendor-error alert lands while a CSR is
// online. Idempotency: each handler is safe to re-run — the
// dispatcher's `dayN_sent_at IS NULL` guard prevents double-sends,
// and the scanner's partial unique index keeps one open alert per
// patient.

import type PgBoss from "pg-boss";

import { dispatchDueCheckins } from "../../lib/checkin-dispatcher";
import { scanCompliance } from "../../lib/compliance-scanner";
import { logger } from "../../lib/logger";

const DISPATCH_JOB = "onboarding-checkins.dispatch";
const DISPATCH_CRON = "17 14 * * *";

const SCAN_JOB = "onboarding-checkins.scan";
const SCAN_CRON = "47 14 * * *";

export async function registerOnboardingCheckinJobs(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(DISPATCH_JOB);
  await boss.createQueue(SCAN_JOB);

  await boss.work(DISPATCH_JOB, async () => {
    try {
      const summary = await dispatchDueCheckins({
        actor: { kind: "system" },
      });
      logger.info({ summary }, "onboarding-checkins.dispatch: completed");
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "onboarding-checkins.dispatch: failed",
      );
      throw err;
    }
  });

  await boss.work(SCAN_JOB, async () => {
    try {
      const summary = await scanCompliance();
      logger.info({ summary }, "onboarding-checkins.scan: completed");
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "onboarding-checkins.scan: failed",
      );
      throw err;
    }
  });

  await boss.schedule(DISPATCH_JOB, DISPATCH_CRON);
  await boss.schedule(SCAN_JOB, SCAN_CRON);
  logger.info(
    { dispatchCron: DISPATCH_CRON, scanCron: SCAN_CRON },
    "onboarding-checkins jobs scheduled",
  );
}
