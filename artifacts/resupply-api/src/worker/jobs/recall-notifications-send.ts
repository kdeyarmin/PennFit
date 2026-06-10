// pg-boss job: drain queued recall_notifications and dispatch
// patient-facing notifications.
//
// What this job does
// ------------------
// Picks up to BATCH_SIZE rows where status='queued', looks up each
// patient's email + phone, fans out a recall notification on every
// available channel, then flips the row to 'sent' (or 'failed' /
// 'bounced' with reason). Idempotent at the row level: the
// (recall_id, asset_id) UNIQUE on recall_notifications guarantees
// the matcher can re-run without us double-sending.
//
// Why a separate job (not folded into the matcher)
// ------------------------------------------------
//   * The matcher is sync from the admin's HTTP call; sending
//     against SendGrid + Twilio adds tens-of-seconds of latency
//     and partial-failure modes. Keeping them split means the
//     admin's "Match" click finishes quickly, and the send retries
//     are isolated from the match audit.
//   * pg-boss schedules the send hourly, naturally throttling the
//     outbound burst.
//
// Posture
// -------
//   * No retries beyond what pg-boss gives the job overall — a row
//     marked 'failed' stays failed until a human marks it 'queued'
//     again or the matcher re-runs. We DO NOT silently re-enqueue
//     bouncing addresses; the audit trail says "we tried, here's
//     the bounce reason" and humans drive the next step.
//   * Channel fallback: if BOTH email and SMS are missing for the
//     patient, the row goes to 'skipped' with reason
//     'no_contact_channels' — surveyors want to see which patients
//     we couldn't reach.

import type PgBoss from "pg-boss";

import {
  createSendgridClient,
  DEFAULT_SENDGRID_FROM_EMAIL,
} from "@workspace/resupply-email";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const SEND_JOB = "recall-notifications.send";
// 19:23 UTC — 9:23am–3:23pm local across every US timezone. Recalls
// are safety communications (arguably TCPA-exempt), but a midnight
// text gets silenced/missed; an afternoon one gets read. The old
// 04:23 UTC slot was ~midnight ET (app-review 2026-06-10, P1-3).
const SEND_CRON = "23 19 * * *";
const BATCH_SIZE = 50;
// How long a row may sit in the transient 'sending' state before a
// later sweep assumes the claiming worker died and re-queues it. Must
// comfortably exceed one row's vendor round-trip (seconds) so a slow-
// but-live send is never yanked; well under the daily cron cadence.
const SENDING_LEASE_MS = 10 * 60 * 1000;

interface SweepStats {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

interface MessagingConfig {
  sendgridApiKey: string | null;
  sendgridFromEmail: string;
  sendgridFromName: string | null;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioPhoneNumber: string | null;
  twilioMessagingServiceSid: string | null;
  practiceName: string;
}

/** Read messaging config from env. Returned object has null fields
 *  when channel-specific creds are absent — callers branch on
 *  presence so the worker still runs (and surfaces 'skipped' rows)
 *  in dev environments without Twilio / SendGrid. */
export function readRecallMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): MessagingConfig {
  return {
    sendgridApiKey: env.SENDGRID_API_KEY ?? null,
    sendgridFromEmail:
      env.SENDGRID_FROM_EMAIL?.trim() || DEFAULT_SENDGRID_FROM_EMAIL,
    sendgridFromName: env.SENDGRID_FROM_NAME ?? null,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? null,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER ?? null,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID ?? null,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "PennPaps",
  };
}

/**
 * Send a single recall notification. Pure (in the sense of taking
 * its dependencies as injected clients) so the test can stage the
 * SendGrid/Twilio responses without env or pg-boss.
 *
 * Returns a discriminated status so the worker writes the right
 * audit row.
 */
export interface RecallNotificationContext {
  recall: {
    id: string;
    title: string;
    description: string | null;
    severity: string;
    recallReference: string | null;
    referenceUrl: string | null;
  };
  patient: { id: string; email: string | null; phoneE164: string | null };
}

export type SendOutcome =
  | { kind: "sent"; channel: "email" | "sms" }
  | { kind: "failed"; channel: "email" | "sms"; reason: string }
  | { kind: "skipped"; reason: string };

export async function sendRecallNotification(
  ctx: RecallNotificationContext,
  cfg: MessagingConfig,
): Promise<SendOutcome> {
  const subject = `Important: ${ctx.recall.title}`;
  const bodyText = [
    `This is a manufacturer recall notice from ${cfg.practiceName}.`,
    "",
    ctx.recall.description ?? ctx.recall.title,
    ctx.recall.recallReference
      ? `\nManufacturer reference: ${ctx.recall.recallReference}`
      : "",
    ctx.recall.referenceUrl ? `\nMore info: ${ctx.recall.referenceUrl}` : "",
    "",
    "We will contact you to coordinate next steps. Reply STOP to opt out of SMS reminders.",
  ]
    .filter((s) => s !== "")
    .join("\n");

  // Prefer email when available — its body carries the full
  // description; SMS is the short-form fallback.
  if (ctx.patient.email && cfg.sendgridApiKey && cfg.sendgridFromName) {
    try {
      const client = createSendgridClient({
        apiKey: cfg.sendgridApiKey,
        fromEmail: cfg.sendgridFromEmail,
        fromName: cfg.sendgridFromName,
      });
      await client.sendEmail({
        to: ctx.patient.email,
        subject,
        html: bodyText
          .split("\n")
          .map((line) => `<p>${escapeHtml(line)}</p>`)
          .join(""),
        text: bodyText,
      });
      return { kind: "sent", channel: "email" };
    } catch (err) {
      // Fall through to SMS — email errored but we'd rather reach
      // the patient than abort.
      logger.warn(
        {
          err: err instanceof Error ? err.message : "unknown",
          recallId: ctx.recall.id,
        },
        "recall-notifications.send: email failed; trying SMS",
      );
    }
  }

  if (
    ctx.patient.phoneE164 &&
    cfg.twilioAccountSid &&
    cfg.twilioAuthToken &&
    (cfg.twilioPhoneNumber || cfg.twilioMessagingServiceSid)
  ) {
    try {
      const client = createTwilioSmsClient({
        accountSid: cfg.twilioAccountSid,
        authToken: cfg.twilioAuthToken,
        from: cfg.twilioPhoneNumber ?? undefined,
        messagingServiceSid: cfg.twilioMessagingServiceSid ?? undefined,
      });
      const smsBody = ctx.recall.recallReference
        ? `${cfg.practiceName} recall notice: ${ctx.recall.title}. Manufacturer ref ${ctx.recall.recallReference}. We will contact you with next steps.`
        : `${cfg.practiceName} recall notice: ${ctx.recall.title}. We will contact you with next steps.`;
      await client.sendSms({
        to: ctx.patient.phoneE164,
        body: smsBody.slice(0, 320),
      });
      return { kind: "sent", channel: "sms" };
    } catch (err) {
      return {
        kind: "failed",
        channel: "sms",
        reason: err instanceof Error ? err.message : "twilio_unknown",
      };
    }
  }

  // No usable channel.
  return { kind: "skipped", reason: "no_contact_channels" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// In-process single-flight guard, mirroring the onboarding check-in
// dispatcher. The sweep does SELECT-queued → send → flip-status, so two
// concurrent in-process runs could both pull the same `queued` rows and
// double-send to a patient. Today the only trigger is the teamSize=1
// pg-boss cron (there is no manual "send now" route), so this is
// PREVENTIVE — it closes the in-process race the moment any concurrent
// caller is added (e.g. an admin trigger route, the way onboarding has
// one). It does NOT address the cross-process race the per-row
// `.eq("status","queued")` guard below describes (two horizontally-
// scaled worker instances both pulling the SELECT) — that needs a
// claim-before-send with an intermediate 'sending' status, i.e. a
// migration.
let inFlightRecallSweep: Promise<SweepStats> | null = null;

/** Run one sweep cycle. Exported for test injection. */
export function runRecallSendSweep(
  cfg: MessagingConfig = readRecallMessagingConfig(),
): Promise<SweepStats> {
  if (inFlightRecallSweep) return inFlightRecallSweep;
  const run = runRecallSendSweepInner(cfg).finally(() => {
    inFlightRecallSweep = null;
  });
  inFlightRecallSweep = run;
  return run;
}

async function runRecallSendSweepInner(
  cfg: MessagingConfig,
): Promise<SweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: SweepStats = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  // Phase 0 — reclaim orphaned claims. A worker that flipped a row to
  // 'sending' (below) and then crashed before the terminal flip would
  // otherwise leave it stuck forever — the SELECT only picks 'queued',
  // so the patient would never get the recall notice. Re-queue any
  // 'sending' row older than the lease so the next pass retries it. The
  // generous lease means a slow-but-live send is never reclaimed out
  // from under itself.
  const leaseCutoff = new Date(Date.now() - SENDING_LEASE_MS).toISOString();
  const { error: reclaimErr } = await supabase
    .schema("resupply")
    .from("recall_notifications")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("status", "sending")
    .lt("updated_at", leaseCutoff);
  if (reclaimErr) {
    // Non-fatal: a reclaim hiccup shouldn't abort the whole sweep. Worst
    // case the stuck row waits for the next pass.
    logger.warn(
      { err: reclaimErr.message },
      "recall-notifications.send: stale-claim reclaim failed",
    );
  }

  const { data: queued, error } = await supabase
    .schema("resupply")
    .from("recall_notifications")
    .select("id, recall_id, asset_id, patient_id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;
  const rows = queued ?? [];
  if (rows.length === 0) return stats;

  const recallIds = Array.from(new Set(rows.map((r) => r.recall_id)));
  const patientIds = Array.from(new Set(rows.map((r) => r.patient_id)));

  const [recalls, patients] = await Promise.all([
    supabase
      .schema("resupply")
      .from("equipment_recalls")
      .select(
        "id, title, description, severity, recall_reference, reference_url",
      )
      .in("id", recallIds),
    supabase
      .schema("resupply")
      .from("patients")
      .select("id, email, phone_e164")
      .in("id", patientIds),
  ]);
  if (recalls.error) throw recalls.error;
  if (patients.error) throw patients.error;

  const recallById = new Map(
    (recalls.data ?? []).map((r) => [r.id, r] as const),
  );
  const patientById = new Map(
    (patients.data ?? []).map((p) => [p.id, p] as const),
  );

  for (const row of rows) {
    stats.attempted += 1;
    const recall = recallById.get(row.recall_id);
    const patient = patientById.get(row.patient_id);
    if (!recall || !patient) {
      // Source row vanished mid-sweep — skip and let a human
      // figure out what happened. Gate on status='queued' so a
      // sibling worker that already finished this row doesn't get
      // its terminal status overwritten by 'skipped'.
      const { error: skipErr } = await supabase
        .schema("resupply")
        .from("recall_notifications")
        .update({
          status: "skipped",
          failed_reason: !recall ? "recall_missing" : "patient_missing",
          failed_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "queued");
      if (skipErr) {
        logger.warn(
          { err: skipErr.message, id: row.id },
          "recall-notifications.send: skip stamp failed",
        );
      }
      stats.skipped += 1;
      continue;
    }

    // Claim the row exclusively BEFORE the vendor call: queued ->
    // sending. Only the worker whose UPDATE matches status='queued'
    // proceeds; a concurrent worker (in-process OR a horizontally-scaled
    // instance) that already claimed it gets 0 rows back and skips — so
    // the recall notice is sent at most once per row. This is the
    // cross-process guarantee the in-process single-flight guard alone
    // cannot give. Phase 0 above re-queues a claim whose worker died.
    const claimIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("recall_notifications")
      .update({ status: "sending", updated_at: claimIso })
      .eq("id", row.id)
      .eq("status", "queued")
      .select("id");
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, id: row.id },
        "recall-notifications.send: claim failed",
      );
      continue;
    }
    if (!claimed || claimed.length === 0) {
      // Lost the claim to a concurrent worker — it owns the send.
      continue;
    }

    const outcome = await sendRecallNotification(
      {
        recall: {
          id: recall.id,
          title: recall.title,
          description: recall.description,
          severity: recall.severity,
          recallReference: recall.recall_reference,
          referenceUrl: recall.reference_url,
        },
        patient: {
          id: patient.id,
          email: patient.email,
          phoneE164: patient.phone_e164,
        },
      },
      cfg,
    );

    // Terminal flip: sending -> sent/failed/skipped, gated on
    // status='sending' (the state THIS worker claimed above). If a
    // Phase-0 reclaim from another pass had flipped our claim back to
    // 'queued' past the lease, this UPDATE is a no-op and the reclaiming
    // pass owns the (re)send — the lease is sized so that only happens
    // on a genuinely stuck claim.
    const nowIso = new Date().toISOString();
    if (outcome.kind === "sent") {
      const { error: sentErr } = await supabase
        .schema("resupply")
        .from("recall_notifications")
        .update({
          status: "sent",
          channel: outcome.channel,
          notified_at: nowIso,
        })
        .eq("id", row.id)
        .eq("status", "sending");
      if (sentErr) {
        logger.error(
          { err: sentErr.message, id: row.id },
          "recall-notifications.send: sent stamp failed — row may stay in sending state",
        );
      }
      stats.sent += 1;
    } else if (outcome.kind === "failed") {
      const { error: failedErr } = await supabase
        .schema("resupply")
        .from("recall_notifications")
        .update({
          status: "failed",
          channel: outcome.channel,
          failed_at: nowIso,
          failed_reason: outcome.reason.slice(0, 500),
        })
        .eq("id", row.id)
        .eq("status", "sending");
      if (failedErr) {
        logger.error(
          { err: failedErr.message, id: row.id },
          "recall-notifications.send: failed stamp failed — row may stay in sending state",
        );
      }
      stats.failed += 1;
    } else {
      const { error: skippedErr } = await supabase
        .schema("resupply")
        .from("recall_notifications")
        .update({
          status: "skipped",
          failed_at: nowIso,
          failed_reason: outcome.reason,
        })
        .eq("id", row.id)
        .eq("status", "sending");
      if (skippedErr) {
        logger.error(
          { err: skippedErr.message, id: row.id },
          "recall-notifications.send: skipped stamp failed — row may stay in sending state",
        );
      }
      stats.skipped += 1;
    }
  }

  return stats;
}

export async function registerRecallNotificationSendJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, SEND_JOB, VENDOR_SEND_QUEUE_OPTS);

  await boss.work(SEND_JOB, async () => {
    try {
      const stats = await runRecallSendSweep();
      logger.info(
        { event: "recall-notifications.send.completed", ...stats },
        "recall-notifications.send: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "recall-notifications.send: failed",
      );
      throw err;
    }
  });

  await boss.schedule(SEND_JOB, SEND_CRON);
  logger.info({ cron: SEND_CRON }, "recall-notifications.send scheduled");
}
