// pg-boss job: daily Rx-renewal dispatch (Phase G.15).
//
// Mirrors the smart-trigger send cron (Phase G.14): runs both
// channels (email then SMS) once a day, sharing the
// renewal_requested_at stamp so a patient is never nudged twice
// for the same renewal cycle.
//
// Schedule
// --------
// 19:43 UTC daily — 2:43/3:43pm ET, inside the 9am–8pm TCPA send
// window for every US timezone (Hawaii included), because this job
// texts patients. The old 04:43 UTC slot was ~midnight ET; with the
// dispatcher's per-patient quiet-hours gate a night-time daily cron
// would skip the same patients at the same local hour forever
// (app-review 2026-06-10, P1-3). Still sequenced 30 min after the
// smart-trigger cron (19:13 UTC) so the two pipelines don't compete
// for SendGrid / Twilio rate-limit budget at the same instant, and
// still clear of the reminders cron (hourly :00).
//
// Channel ordering: email first (cheaper, higher delivery rate),
// then SMS (mops up patients without an email on file).
//
// Failure handling
// ----------------
// "Not configured" on either channel is logged and skipped — a
// half-configured deploy shouldn't fail the entire cron. Vendor
// 5xx during a send is counted in `failed` but doesn't bubble:
// the next cron tick picks the row up again because
// renewal_requested_at remains NULL on a failed dispatch.
//
// Audit
// -----
// Every successful send writes `prescription.renewal_requested`
// with `adminEmail = "system:cron:rx-renewal-send"` so the audit
// log can distinguish cron-driven dispatches from admin Run-now
// ones.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { runRxRenewalSendDue } from "../../lib/rx-renewal/dispatcher";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const SEND_JOB = "rx-renewal.send-due";
/** Daily 19:43 UTC (afternoon across all US timezones — see the
 *  Schedule note above). Sequenced 30 min after the smart-trigger
 *  send cron (19:13) so we don't double-burst the email vendor. */
const SEND_CRON = "43 19 * * *";

const SYSTEM_ACTOR_EMAIL = "system:cron:rx-renewal-send";

export async function registerRxRenewalSendJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, SEND_JOB, VENDOR_SEND_QUEUE_OPTS);

  await boss.work(SEND_JOB, async () => {
    const actor = {
      adminEmail: SYSTEM_ACTOR_EMAIL,
      adminUserId: null,
      ip: null,
      userAgent: null,
    };

    // Run both channels regardless of individual failures so one
    // broken channel doesn't block the other. Collect errors and
    // re-throw at the end so pg-boss marks the job failed and the
    // SOC monitor can see the gap in the schedule.
    const channelErrors: Error[] = [];

    // Email first — higher delivery rate + cheaper than SMS.
    try {
      const emailOutcome = await runRxRenewalSendDue("email", actor);
      if (emailOutcome.status === "not_configured") {
        logger.warn(
          { source: "cron" },
          "rx-renewal.send-due: SendGrid not configured — skipping email channel",
        );
      } else {
        logger.info(
          { source: "cron", ...emailOutcome },
          "rx-renewal.send-due: email channel complete",
        );
      }
    } catch (err) {
      logger.error(
        { channel: "email", err },
        "rx-renewal.send-due: email channel threw",
      );
      channelErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Then SMS — mops up patients with no email on file.
    try {
      const smsOutcome = await runRxRenewalSendDue("sms", actor);
      if (smsOutcome.status === "not_configured") {
        logger.warn(
          { source: "cron" },
          "rx-renewal.send-due: Twilio not configured — skipping SMS channel",
        );
      } else {
        logger.info(
          { source: "cron", ...smsOutcome },
          "rx-renewal.send-due: SMS channel complete",
        );
      }
    } catch (err) {
      logger.error(
        { channel: "sms", err },
        "rx-renewal.send-due: SMS channel threw",
      );
      channelErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    if (channelErrors.length > 0) {
      throw new AggregateError(
        channelErrors,
        `rx-renewal.send-due: ${channelErrors.length} channel(s) failed`,
      );
    }
  });

  await boss.schedule(SEND_JOB, SEND_CRON);
  logger.info({ cron: SEND_CRON }, "rx-renewal.send-due scheduled");
}
