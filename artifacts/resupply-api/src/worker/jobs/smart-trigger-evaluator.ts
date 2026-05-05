// pg-boss job: daily smart-trigger evaluator scan (Phase G.13).
//
// Why a cron rather than only the admin "Run now" button:
// detection is most useful when it runs every night. Without a
// cron, a patient whose leak rate trends up on Monday wouldn't
// see a "we noticed" insight or email until an admin manually hit
// Run-now sometime later in the week. A daily scan keeps the
// data-driven nudges within a 24-hour-of-detection cadence,
// matching what Aeroflow / Easy Resupply industry standard hits.
//
// Schedule
// --------
// 03:23 UTC daily. Off-hours globally; the scan is a sequence of
// per-patient SELECT + per-rule INSERT ON CONFLICT DO NOTHING
// passes, capped at PER_RUN_PATIENT_CAP=200 patients per run.
// Production roster of active patients fits well within that cap;
// if it grows, the evaluator's per-run cap can grow without
// schema changes.
//
// Idempotency
// -----------
// The partial-unique index on (patient_id, kind) WHERE
// dismissed_at IS NULL guarantees the same trigger never lands
// twice while pending. Re-running the cron mid-day (or stacking
// it with an admin Run-now) is safe.
//
// Audit
// -----
// Every newly-inserted event records `patient.smart_trigger.detected`
// with `adminEmail = "system:cron:smart-trigger-evaluator"` so the
// audit log can distinguish cron-driven detections from admin-driven
// ones. The dispatch (email/SMS/push) is a separate cron concern —
// this job only fires the detection pass; the existing send-due
// dispatcher handles delivery.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { runSmartTriggerEvaluator } from "../../lib/smart-triggers/evaluator";

const EVALUATE_JOB = "smart-triggers.evaluate";
/** Daily 03:23 UTC. Picked off the hour to avoid colliding with the
 *  existing reminders cron (hourly :00) and the attachment-sweep
 *  cron (Sunday 03:13). Quiet-hours window in every Penn region. */
const EVALUATE_CRON = "23 3 * * *";

const SYSTEM_ACTOR_EMAIL = "system:cron:smart-trigger-evaluator";

export async function registerSmartTriggerEvaluatorJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(EVALUATE_JOB);

  await boss.work(EVALUATE_JOB, async () => {
    try {
      const counters = await runSmartTriggerEvaluator({
        adminEmail: SYSTEM_ACTOR_EMAIL,
        adminUserId: null,
        ip: null,
        userAgent: null,
      });
      logger.info(
        { ...counters, source: "cron" },
        "smart-triggers.evaluate: run complete",
      );
    } catch (err) {
      // Let the failure propagate so pg-boss marks it failed and
      // SOC sees the gap. Silently swallowing here would hide a
      // broken evaluator from the only surface that proves the
      // schedule fired.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "smart-triggers.evaluate: run failed",
      );
      throw err;
    }
  });

  await boss.schedule(EVALUATE_JOB, EVALUATE_CRON);
  logger.info({ cron: EVALUATE_CRON }, "smart-triggers.evaluate scheduled");
}
