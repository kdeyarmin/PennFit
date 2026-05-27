// pg-boss job: daily smart-trigger send-due dispatch (Phase G.14).
//
// Companion to smart-trigger-evaluator.ts. The evaluator scans
// patient_therapy_nights for newly-fired triggers and inserts rows;
// this dispatcher walks the unsent rows and ships the email + SMS
// nudges (plus the Phase G.8 push fan-out runs inside the
// dispatcher helper itself).
//
// Schedule
// --------
// 04:13 UTC daily — 50 minutes after the evaluator (03:23 UTC) so
// the evaluator's batch is durable before this job tries to send
// it. Off-hours globally; far enough from the reminders cron
// (hourly :07) and attachment-sweep (Sunday 03:13) to avoid
// resource contention spikes.
//
// Channel ordering: email first (cheaper, higher delivery rate),
// then SMS (mops up patients without an email on file). Both
// channels share the sent_at stamp on patient_smart_trigger_events
// so a patient is never nudged twice for the same trigger.
//
// Failure handling
// ----------------
// "Not configured" on either channel is logged and skipped — a
// half-configured deploy shouldn't fail the entire cron. Vendor
// 5xx during a send is counted in `failed` but doesn't bubble
// up: the next cron tick will pick the row up again because
// sent_at remains NULL on a failed dispatch.
//
// Audit
// -----
// Every successful send writes `patient.smart_trigger.sent` with
// `adminEmail = "system:cron:smart-trigger-send"` so the audit log
// can distinguish cron-driven dispatches from admin Run-now ones.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import {
  buildQueueConfig,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";
import { runSmartTriggerSendDue } from "../../lib/smart-triggers/dispatcher";
import {
  htmlBody,
  pushBody,
  smsBody,
  subjectForKind,
  textBody,
} from "../../lib/smart-triggers/renderers";

const SEND_JOB = "smart-triggers.send-due";
/** Daily 04:13 UTC. Sequenced 50 min after the evaluator cron
 *  (03:23) so its insert batch has settled before we dispatch. */
const SEND_CRON = "13 4 * * *";

const SYSTEM_ACTOR_EMAIL = "system:cron:smart-trigger-send";

export async function registerSmartTriggerSendJob(boss: PgBoss): Promise<void> {
  // Smart-trigger sends fan out to Twilio / SendGrid / Web Push; the
  // vendor-send retry posture applies. Exhausted retries land in the
  // DLQ so a deterministically-broken trigger (e.g. template render
  // permanently failing) surfaces to ops.
  await boss.createQueue(SEND_JOB, buildQueueConfig(SEND_JOB, VENDOR_SEND_QUEUE_OPTS));

  await boss.work(SEND_JOB, async () => {
    const renderers = { subjectForKind, textBody, htmlBody, smsBody, pushBody };
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
      const emailOutcome = await runSmartTriggerSendDue(
        "email",
        actor,
        renderers,
      );
      if (emailOutcome.status === "not_configured") {
        logger.warn(
          { source: "cron" },
          "smart-triggers.send-due: SendGrid not configured — skipping email channel",
        );
      } else {
        logger.info(
          { source: "cron", ...emailOutcome },
          "smart-triggers.send-due: email channel complete",
        );
      }
    } catch (err) {
      logger.error(
        {
          channel: "email",
          err: err instanceof Error ? err.message : String(err),
        },
        "smart-triggers.send-due: email channel threw",
      );
      channelErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Then SMS — mops up patients with no email on file.
    try {
      const smsOutcome = await runSmartTriggerSendDue("sms", actor, renderers);
      if (smsOutcome.status === "not_configured") {
        logger.warn(
          { source: "cron" },
          "smart-triggers.send-due: Twilio not configured — skipping SMS channel",
        );
      } else {
        logger.info(
          { source: "cron", ...smsOutcome },
          "smart-triggers.send-due: SMS channel complete",
        );
      }
    } catch (err) {
      logger.error(
        {
          channel: "sms",
          err: err instanceof Error ? err.message : String(err),
        },
        "smart-triggers.send-due: SMS channel threw",
      );
      channelErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    if (channelErrors.length > 0) {
      throw new AggregateError(
        channelErrors,
        `smart-triggers.send-due: ${channelErrors.length} channel(s) failed`,
      );
    }
  });

  await boss.schedule(SEND_JOB, SEND_CRON);
  logger.info({ cron: SEND_CRON }, "smart-triggers.send-due scheduled");
}
