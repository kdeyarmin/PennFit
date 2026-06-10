// pg-boss job: first-day fitter-lead re-engagement.
//
// Why this exists
// ---------------
// The existing fitter-lead.reengage worker scans for leads aged
// 3-30 days who never converted. That's the right window for
// patients who set the fitting aside and forgot about it — but it
// misses the bigger cohort: patients who started, got partway
// through the camera / measurement / questionnaire flow, and
// dropped off in the same day. Their intent is still warm, the
// browser session may still be open, and a same-day nudge with
// "you were close — want a hand?" copy converts at a meaningfully
// higher rate than the 3-30 day version.
//
// What this job does
// ------------------
// Hourly cron. Scans resupply.fitter_leads for rows that:
//   * Were created 18-30 hours ago (so the patient has had a chance
//     to wrap up naturally without us interrupting in the same
//     session, but the intent hasn't gone fully cold).
//   * Opted in to marketing.
//   * Don't have first_day_nudged_at stamped.
//   * Don't have a matching public.orders row (already converted).
//
// For each match, send:
//   * An email with first-day-specific copy.
//   * An SMS (when phone_e164 + sms_opt_in are present) — net-new
//     channel for this dispatcher, made possible by the SMS opt-in
//     field added in 0121.
//
// Idempotency
// -----------
// Atomic-claim the first_day_nudged_at stamp BEFORE the send. The
// 3-30 day re-engagement worker uses a separate `nudged_at` column,
// so a lead can receive BOTH nudges — first-day at 24h, then the
// 3-30d follow-up if they're still cold. Two emails per lead per
// month is the policy for opted-in leads; that's well inside any
// reasonable marketing cadence.
//
// Feature flag
// ------------
// Behind RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED=1, mirroring the
// existing reengage worker. Staging deploys with real SendGrid +
// Twilio keys should NOT start nudging real fitter leads the moment
// this lands; production opts in by setting the flag.

import type PgBoss from "pg-boss";

import {
  escapePostgRESTFilterValue,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { isOutsideSmsSendWindow } from "../../lib/comm-prefs";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const NUDGE_JOB = "fitter-lead.first-day-nudge";
/** Hourly at :19 — keeps the schedule clear of every other resupply cron. */
const NUDGE_CRON = "19 * * * *";
const MIN_AGE_MS = 18 * 3_600_000;
const MAX_AGE_MS = 30 * 3_600_000;
const BATCH_SIZE = 200;

export interface FirstDayNudgeStats {
  scanned: number;
  emailed: number;
  smsSent: number;
  skippedConverted: number;
  skippedAlreadyClaimed: number;
  skippedNoEmailConfig: number;
  skippedNoSmsConfig: number;
  /** SMS-opted-in leads deferred by the 9am–8pm TCPA send window —
   *  retried by a later hourly tick inside the window. */
  skippedQuietHours: number;
  errors: number;
}

interface LeadRow {
  id: string;
  email: string;
  phone_e164: string | null;
  sms_opt_in: boolean;
  source: "consent" | "sleep_apnea_quiz" | "insurance_quote";
  created_at: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://pennpaps.com")
  ).replace(/\/$/, "");
}

/** Compose the first-day email. Exported so tests can pin the copy
 *  without running the whole sweep. */
export function composeFirstDayEmail(opts: {
  practiceName: string;
  resumeUrl: string;
  source: string;
}): { subject: string; html: string; text: string } {
  const sourceCopy =
    opts.source === "sleep_apnea_quiz"
      ? "the sleep-apnea quiz"
      : opts.source === "insurance_quote"
        ? "the insurance estimator"
        : "the at-home mask fitting";
  const subject = `Want a hand finishing your ${opts.practiceName} fitting?`;
  const text = [
    `Hi from ${opts.practiceName},`,
    "",
    `You started ${sourceCopy} earlier today but didn't quite finish.`,
    "Most patients wrap it up in two or three minutes — the camera does the",
    "work and we send the recommendation straight to your inbox.",
    "",
    `Pick up where you left off: ${opts.resumeUrl}`,
    "",
    "Stuck on a question? Reply to this email and a real human picks it up.",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
    <p>Hi from <strong>${escapeHtml(opts.practiceName)}</strong>,</p>
    <p>You started ${escapeHtml(sourceCopy)} earlier today but didn&apos;t quite finish.
       Most patients wrap it up in two or three minutes — the camera does the
       work and we send the recommendation straight to your inbox.</p>
    <p><a href="${opts.resumeUrl}" style="display:inline-block;padding:10px 18px;background:#0f1d3a;color:#fff;text-decoration:none;border-radius:6px;">Pick up where you left off</a></p>
    <p style="color:#666;font-size:13px;">Stuck on a question? Reply to this email and a real human picks it up.</p>
  </div>`;
  return { subject, html, text };
}

/** Compose the first-day SMS. Exported for testability.
 *  Stays under 160 GSM-7 chars so it ships as a single segment. */
export function composeFirstDaySms(opts: {
  practiceName: string;
  resumeUrl: string;
}): string {
  return `${opts.practiceName}: you started a mask fitting earlier — finish in 2 min: ${opts.resumeUrl} . Reply STOP to opt out.`;
}

/** Construct the SendGrid client; return null on missing config so the
 *  worker can degrade gracefully rather than killing the cron tick. */
function tryCreateSendgrid(): ReturnType<typeof createSendgridClient> | null {
  try {
    return createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) return null;
    throw err;
  }
}

/** Construct the Twilio SMS client; return null on missing config. */
function tryCreateTwilioSms(): ReturnType<typeof createTwilioSmsClient> | null {
  try {
    return createTwilioSmsClient();
  } catch (err) {
    if (err instanceof TwilioConfigError) return null;
    throw err;
  }
}

/** Run a single first-day-nudge sweep. Exported for testability. */
export async function runFirstDayNudgeSweep(): Promise<FirstDayNudgeStats> {
  const stats: FirstDayNudgeStats = {
    scanned: 0,
    emailed: 0,
    smsSent: 0,
    skippedConverted: 0,
    skippedAlreadyClaimed: 0,
    skippedNoEmailConfig: 0,
    skippedNoSmsConfig: 0,
    skippedQuietHours: 0,
    errors: 0,
  };

  const supabase = getSupabaseServiceRoleClient();
  const now = Date.now();
  const youngerThan = new Date(now - MIN_AGE_MS).toISOString();
  const olderThan = new Date(now - MAX_AGE_MS).toISOString();

  // Eligibility: opted-in, not yet first-day-nudged, NOT yet
  // completed, aged 18–30h. The completed_at IS NULL guard keeps this
  // ABANDONMENT nudge ("you didn't quite finish") off patients who
  // actually finished the fitter — those are enrolled in the supply
  // campaign (fitter-supply-campaign.ts), whose day-1 touch ("your
  // mask is on hold") would otherwise collide with this email and
  // contradict it. Finishers get the supply campaign; non-finishers
  // get this nudge.
  const { data: leads, error } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .select("id, email, phone_e164, sms_opt_in, source, created_at")
    .eq("marketing_opt_in", true)
    .is("first_day_nudged_at", null)
    .is("completed_at", null)
    .lt("created_at", youngerThan)
    .gt("created_at", olderThan)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  const candidates = (leads ?? []).filter(
    (l): l is LeadRow => typeof l.email === "string" && l.email.length > 0,
  );
  if (candidates.length === 0) return stats;

  // Bulk check converted leads — same shape as the 3-30d worker. ILIKE
  // chunked so the URI stays under the 8KB PostgREST default limit
  // even with up to BATCH_SIZE distinct emails.
  const emails = Array.from(
    new Set(
      candidates
        .map((c) => c.email)
        .filter((e): e is string => typeof e === "string" && e.length > 0)
        .map((e) => e.toLowerCase()),
    ),
  );
  const CHUNK = 50;
  const convertedSet = new Set<string>();
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const orClauses = chunk
      .map((e) => `patient_email.ilike.${escapePostgRESTFilterValue(e)}`)
      .join(",");
    const { data: converted, error: convErr } = await supabase
      .schema("public")
      .from("orders")
      .select("patient_email")
      .or(orClauses);
    if (convErr) throw convErr;
    for (const r of converted ?? []) {
      if (typeof r.patient_email === "string") {
        convertedSet.add(r.patient_email.toLowerCase());
      }
    }
  }

  // Lazily construct the clients so a missing-channel-config deploy
  // can still send via the channels it DOES have configured. e.g.
  // SendGrid configured but Twilio missing → emails still ship, SMS
  // is silently skipped.
  const sendgrid = tryCreateSendgrid();
  const twilioSms = tryCreateTwilioSms();

  const practiceName = process.env.RESUPPLY_PRACTICE_NAME ?? "PennPaps";
  const resumeUrl = `${publicBaseUrl()}/consent`;

  for (const lead of candidates) {
    stats.scanned += 1;
    const leadEmailLower =
      typeof lead.email === "string" ? lead.email.toLowerCase() : null;
    if (leadEmailLower && convertedSet.has(leadEmailLower)) {
      stats.skippedConverted += 1;
      continue;
    }

    // Check deliverability before claiming — no point stamping
    // first_day_nudged_at if we can't reach the lead via any channel.
    const canEmail = sendgrid && lead.email;
    const canSms = twilioSms && lead.phone_e164 && lead.sms_opt_in;

    // TCPA window: an SMS-opted-in lead must not be texted outside
    // 9am–8pm local (leads carry no timezone/ZIP, so this evaluates
    // against the ET default). If the lead is also reachable via email,
    // send the email leg now so the lead doesn't age past the 18–30h
    // query window without any contact. If email is unavailable too,
    // defer until the next tick inside the window so both legs fire
    // together.
    if (canSms && isOutsideSmsSendWindow(new Date()) && !canEmail) {
      stats.skippedQuietHours += 1;
      continue;
    }

    if (!canEmail && !canSms) {
      if (!sendgrid) stats.skippedNoEmailConfig += 1;
      if (!twilioSms && lead.phone_e164 && lead.sms_opt_in) {
        stats.skippedNoSmsConfig += 1;
      }
      continue;
    }

    // Atomic claim — stamp first_day_nudged_at before the send so a
    // crash mid-send doesn't double-deliver on the next hourly tick.
    const claimIso = new Date().toISOString();
    const { data: claimResult, error: claimErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({ first_day_nudged_at: claimIso })
      .eq("id", lead.id)
      .is("first_day_nudged_at", null)
      .select("id");
    if (claimErr) {
      logger.warn(
        { err: claimErr.message, leadId: lead.id },
        "fitter-lead.first-day-nudge: claim failed",
      );
      stats.errors += 1;
      continue;
    }
    if (!claimResult || claimResult.length === 0) {
      stats.skippedAlreadyClaimed += 1;
      continue;
    }

    // Email leg. Failures are logged but don't release the claim —
    // the policy is "one nudge attempt per lead per day-window", so
    // a vendor-side hiccup means the lead just doesn't get nudged
    // this cycle (the 3-30d worker still might pick them up later).
    if (sendgrid) {
      const { subject, html, text } = composeFirstDayEmail({
        practiceName,
        resumeUrl,
        source: lead.source,
      });
      try {
        await sendgrid.sendEmail({
          to: lead.email,
          subject,
          html,
          text,
          customArgs: {
            kind: "fitter_first_day_nudge",
            source: lead.source,
          },
        });
        stats.emailed += 1;
      } catch (err) {
        logger.warn(
          { err, leadId: lead.id },
          "fitter-lead.first-day-nudge: email send failed",
        );
        stats.errors += 1;
      }
    } else {
      stats.skippedNoEmailConfig += 1;
    }

    // SMS leg — only for leads who explicitly opted in AND have a
    // normalized phone number AND are inside the TCPA send window.
    // The fitter_leads sms_opt_in column is itself gated server-side
    // by phone presence in the recordFitterLead helper (Wave 2a).
    if (
      lead.phone_e164 &&
      lead.sms_opt_in &&
      !isOutsideSmsSendWindow(new Date())
    ) {
      if (twilioSms) {
        try {
          await twilioSms.sendSms({
            to: lead.phone_e164,
            body: composeFirstDaySms({ practiceName, resumeUrl }),
          });
          stats.smsSent += 1;
        } catch (err) {
          logger.warn(
            { err, leadId: lead.id },
            "fitter-lead.first-day-nudge: sms send failed",
          );
          stats.errors += 1;
        }
      } else {
        stats.skippedNoSmsConfig += 1;
      }
    }
  }

  return stats;
}

export async function registerFitterLeadFirstDayNudgeJob(
  boss: PgBoss,
): Promise<void> {
  // Off by default. Staging deploys with credentialed SendGrid +
  // Twilio should not start nudging real leads the moment this lands;
  // production sets RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED=1 to
  // turn the cron on. Mirrors the existing reengage worker's
  // feature-flag posture exactly.
  if (process.env.RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED !== "1") {
    logger.info(
      { event: "fitter-lead.first-day-nudge.disabled" },
      "fitter-lead.first-day-nudge: not registered (RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED!=1)",
    );
    // A previously persisted pg-boss schedule keeps enqueueing
    // ticks into this now-worker-less queue (and replays them in
    // a burst on re-enable). Clear it so disabling the flag
    // actually stops the cron (table-guard pattern).
    await boss.unschedule(NUDGE_JOB).catch(() => undefined);
    return;
  }
  await createQueueWithDlq(boss, NUDGE_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(NUDGE_JOB, async () => {
    try {
      // Runtime kill switch (admin Control Center). The env var gates
      // registration; this flag pauses the sweep without changing env.
      if (!(await isFeatureEnabled("fitter_first_day_nudge.dispatcher"))) {
        logger.info(
          { event: "fitter-lead.first-day-nudge.flag_off" },
          "fitter-lead.first-day-nudge: feature flag off — skipping",
        );
        return;
      }
      const stats = await runFirstDayNudgeSweep();
      logger.info(
        { event: "fitter-lead.first-day-nudge.completed", ...stats },
        "fitter-lead.first-day-nudge: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "fitter-lead.first-day-nudge: failed",
      );
      throw err;
    }
  });
  await boss.schedule(NUDGE_JOB, NUDGE_CRON);
  logger.info({ cron: NUDGE_CRON }, "fitter-lead.first-day-nudge scheduled");
}
