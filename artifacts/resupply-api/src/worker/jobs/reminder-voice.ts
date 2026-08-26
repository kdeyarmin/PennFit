// reminders.place-call — the automated VOICE tier of the resupply-reminder
// escalation ladder.
//
// The hourly `reminders.scan` does the first touch on one text channel (SMS
// or email). The daily `reminders.escalation-scan` walks an unanswered
// episode up the ladder SMS → email → voice → CSR alert. When a tenant has
// the `reminder_escalation.voice` flag on AND the voice path is configured,
// the escalation enqueues THIS job for the voice step: it places an
// automated AI resupply check-in call — the same agent an admin reaches via
// the patient "Call" button — through the shared `placeOutboundReorderCall`
// helper.
//
// Why a separate send job (mirrors reminders.send-sms / .send-email):
//   - It reuses the SAME per-(patient, episode, day) dedup guard so a
//     pg-boss retry after a post-dial DB hiccup can't double-dial, and the
//     same local-business-hours gate so an automated call never lands in a
//     patient's quiet hours (TCPA).
//   - It degrades gracefully: if the voice path isn't configured it logs and
//     exits 0 rather than filling the retry queue with permanent failures —
//     exactly like the text send jobs do when Twilio/SendGrid is unset.
//
// Placing the call opens a `conversations` row (channel='voice'), so the
// next daily escalation tick sees "voice tried" and the ladder advances to
// the CSR hand-off. A quiet-hours deferral creates NO conversation, so the
// next tick simply re-enqueues the voice step until it lands in-hours.

import type PgBoss from "pg-boss";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { markEpisodeAwaitingResponse } from "../../lib/episodes/mark-awaiting-response.js";
import { recordTenantUsage } from "../../lib/metering/usage.js";
import { placeOutboundReorderCall } from "../../lib/voice/place-outbound-call.js";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";
import {
  isWithinQuietHours,
  releaseReminderDedupKey,
  tryClaimReminderDedupKey,
} from "./reminders.js";

export const SEND_VOICE_JOB = "reminders.place-call";

export interface VoiceSendJobData {
  patientId: string;
  episodeId: string;
  /**
   * Tenant this reminder belongs to. Stamped by the per-tenant escalation
   * scan so this job dials under the RIGHT tenant's caller-id and reads on
   * the right org-scoped client. Optional for back-compat (falls back to the
   * seed org — single-tenant-correct).
   */
  orgId?: string;
}

/**
 * Register the voice send job + its queue. Idempotent (createQueue is an
 * upsert; pg-boss `work()` is safe to call on every boot). No schedule —
 * the job is only ever enqueued by `reminders.escalation-scan`, never
 * cron-driven on its own.
 */
export async function registerReminderVoiceJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, SEND_VOICE_JOB, VENDOR_SEND_QUEUE_OPTS);

  await boss.work<VoiceSendJobData>(SEND_VOICE_JOB, async (jobs) => {
    const j = jobs[0];
    if (!j) return;

    // Voice path must be fully configured to dial. Mirrors the text send
    // jobs' "not configured → log + exit 0" posture so a half-configured
    // deploy doesn't fill the retry queue.
    const config = readVoiceConfigOrNull();
    if (!config || !config.twilioPhoneNumber) {
      logger.warn(
        { job_id: j.id },
        "reminders.place-call: voice not configured (missing OPENAI_API_KEY / TWILIO_* / RESUPPLY_VOICE_PUBLIC_BASE_URL) — skipping",
      );
      return;
    }

    // Prefer the tenant stamped by the escalation scan; fall back to the
    // seed org for jobs enqueued before the fan-out deploy. Treat an
    // empty/whitespace payload orgId as absent.
    const orgId = j.data.orgId?.trim() || (await resolveSeedOrgId());
    if (!orgId) {
      logger.warn(
        { job_id: j.id },
        "reminders.place-call: no org resolved — skipping",
      );
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Local-business-hours gate (TCPA). The escalation cron fires at 18:00
    // UTC — inside 9am–8pm for every CONTINENTAL-US timezone — but a HI/AK
    // patient can fall outside it, so we re-check per recipient here and
    // defer if it's their quiet hours. Deferring creates no conversation,
    // so the next daily escalation tick re-enqueues the voice step (a fresh
    // dedup-key day) until it lands in-hours. Fail open to ET on a bad tz.
    let timezone = "America/New_York";
    try {
      const { data: tzRow } = await supabase
        .from("patients")
        .select("timezone")
        .eq("id", j.data.patientId)
        .limit(1)
        .maybeSingle();
      if (tzRow?.timezone) timezone = tzRow.timezone;
    } catch {
      // Network blip — fall back to default tz; isWithinQuietHours also
      // guards an unrecognized value.
    }
    if (isWithinQuietHours(new Date(), timezone)) {
      logger.debug(
        {
          event: "reminder_voice_deferred_quiet_hours",
          job_id: j.id,
          timezone,
        },
        "reminders.place-call: outside patient local business hours — deferring to next escalation tick",
      );
      return;
    }

    // Idempotency: short-circuit if another attempt already dialed (or is
    // dialing) for this (patient, episode, day). Same posture as the text
    // send jobs (a degraded dedup table never blocks the call).
    const { proceed, key: dedupKey } = await tryClaimReminderDedupKey(
      supabase,
      "voice",
      j.data.patientId,
      j.data.episodeId,
      j.id,
    );
    if (!proceed) return;

    let outcome: Awaited<ReturnType<typeof placeOutboundReorderCall>>;
    try {
      outcome = await placeOutboundReorderCall({
        orgId,
        patientId: j.data.patientId,
        episodeId: j.data.episodeId,
        config: { ...config, twilioPhoneNumber: config.twilioPhoneNumber },
        actor: { kind: "system", jobId: j.id },
      });
    } catch (err) {
      // placeOutboundReorderCall threw (e.g. a Supabase read rejected).
      // Release the dedup claim before the throw propagates so pg-boss's
      // retry can re-claim; otherwise the key stays held for its full TTL
      // and this call is silently dropped for the whole window.
      try {
        await releaseReminderDedupKey(supabase, dedupKey, j.id);
      } catch {
        // best-effort release; surface the original failure regardless
      }
      throw err;
    }

    if (outcome.status !== "ok") {
      logger.warn(
        {
          job_id: j.id,
          patient_id: j.data.patientId,
          episode_id: j.data.episodeId,
          outcome: outcome.status,
        },
        "reminders.place-call: non-ok outcome",
      );
      // Transient failures should be retried by pg-boss. A Twilio API error
      // or a failed conversation insert may succeed on retry; the other
      // outcomes (patient inactive / missing phone / episode mismatch) are
      // terminal — warn only, don't burn the retry budget.
      if (
        outcome.status === "twilio_api_error" ||
        outcome.status === "conversation_create_failed"
      ) {
        await releaseReminderDedupKey(supabase, dedupKey, j.id);
        throw new Error(
          `reminders.place-call: retryable failure: ${outcome.status}`,
        );
      }
    } else {
      // One automated voice call went out (dedup-claimed once-per
      // (patient, episode, day) — no double-count on retry).
      void recordTenantUsage({
        orgId,
        metricKey: "aiVoiceEvents",
        source: "reminders.voice",
      });
      await markEpisodeAwaitingResponse(supabase, j.data.episodeId);
    }
  });

  logger.info("reminders.place-call worker registered");
}
