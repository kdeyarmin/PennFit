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
//   onboarding-checkins.dispatch  — daily 19:17 UTC (3:17pm ET)
//   onboarding-checkins.scan      — daily 19:47 UTC (30 min later)
//
// 19:17 UTC is inside the 9am–8pm TCPA send window for EVERY US
// timezone (the old 14:17 UTC slot was 6:17am Pacific in winter —
// under the TCPA 8am floor for West-Coast patients; app-review
// 2026-06-10, P1-3), and still in-business-hours so a vendor-error
// alert lands while a CSR is online. Idempotency: each handler is
// safe to re-run — the dispatcher's `dayN_sent_at IS NULL` guard
// prevents double-sends, and the scanner's partial unique index
// keeps one open alert per patient.

import type PgBoss from "pg-boss";

import { dispatchDueCheckins } from "../../lib/checkin-dispatcher";
import { scanCompliance } from "../../lib/compliance-scanner";
import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const DISPATCH_JOB = "onboarding-checkins.dispatch";
const DISPATCH_CRON = "17 19 * * *";

const SCAN_JOB = "onboarding-checkins.scan";
const SCAN_CRON = "47 19 * * *";

export async function registerOnboardingCheckinJobs(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, DISPATCH_JOB, VENDOR_SEND_QUEUE_OPTS);
  await createQueueWithDlq(boss, SCAN_JOB, CRON_SCAN_QUEUE_OPTS);

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
