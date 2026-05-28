// pg-boss job: daily "finish your fitting" nudge for abandoned
// fitter sessions.
//
// The /consent page captures (email, marketing_opt_in=true) into
// resupply.fitter_leads at the start of the fitter flow. Patients
// who advance into /capture but never finish at /order leave a row
// behind with no order ever attached to it. This dispatcher closes
// that gap:
//
//   * eligibility: opt-in row aged 3–30 days, never nudged, no
//     matching public.orders.patient_email (i.e. patient hasn't
//     submitted an order yet);
//   * one shot per row: a stamped nudged_at column flags the lead
//     so it never gets emailed twice;
//   * fail-soft: SendGrid misconfig logs and exits 0 (so a half-
//     configured deploy doesn't fill the pg-boss retry queue),
//     and per-row send errors increment `errors` but don't halt
//     the sweep.
//
// Why 3 days minimum:
//   Patients commonly bounce out and back into the fitter inside a
//   single workday. The 3-day floor avoids nudging someone who's
//   genuinely just paused — they're far more likely to come back
//   on their own inside that window than to need an email.
//
// Why 30 days maximum:
//   Older opt-ins are stale; the patient has almost certainly
//   forgotten the session they started, and a "you didn't finish"
//   email a month later reads more as spam than as helpful.

import type PgBoss from "pg-boss";

import { createSendgridClient } from "@workspace/resupply-email";
import {
  escapePostgRESTFilterValue,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { createQueueWithDlq, VENDOR_SEND_QUEUE_OPTS } from "../lib/queue-options";

const NUDGE_JOB = "fitter-lead.reengage";
const NUDGE_CRON = "37 9 * * *"; // 09:37 UTC daily
const MIN_AGE_MS = 3 * 86_400_000;
const MAX_AGE_MS = 30 * 86_400_000;
// Same per-run cap as the maintenance nudge — keeps SendGrid burst
// traffic predictable. The cron picks up the rest tomorrow.
const BATCH_SIZE = 200;

interface ReengageStats {
  scanned: number;
  emailed: number;
  skippedConverted: number;
  skippedNoConfig: number;
  skippedAlreadyClaimed: number;
  errors: number;
}

interface MessagingConfig {
  sendgridApiKey: string | null;
  sendgridFromEmail: string | null;
  sendgridFromName: string | null;
  practiceName: string;
  publicBaseUrl: string;
}

export function readReengageMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): MessagingConfig {
  return {
    sendgridApiKey: env.SENDGRID_API_KEY ?? null,
    sendgridFromEmail: env.SENDGRID_FROM_EMAIL ?? null,
    sendgridFromName: env.SENDGRID_FROM_NAME ?? null,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "PennPaps",
    publicBaseUrl:
      (env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
        (env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
          : "")) ||
      "",
  };
}

/** Compose the re-engagement email. Exported so the test can pin
 *  the subject + body without running the whole sweep. */
export function composeReengageEmail(opts: {
  practiceName: string;
  publicBaseUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = `Finish your mask fitting with ${opts.practiceName}`;
  // Land back on /consent so they re-affirm; the gate is cheap and
  // their email + opt-in are already on file in sessionStorage if
  // they're on the same device. New device → they re-enter both.
  const resumeUrl = `${opts.publicBaseUrl}/consent`;
  const text = [
    `Hi from ${opts.practiceName},`,
    "",
    "You started a CPAP mask fitting with us recently but didn't finish.",
    "It only takes a couple of minutes — the camera does the work and we",
    "send the mask recommendation straight to your inbox.",
    "",
    `Pick up where you left off: ${resumeUrl}`,
    "",
    "If you've already ordered or this email reached you by mistake,",
    "no action is needed — we won't send another reminder for this session.",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;">
    <p>Hi from <strong>${escapeHtml(opts.practiceName)}</strong>,</p>
    <p>You started a CPAP mask fitting with us recently but didn't finish.
       It only takes a couple of minutes — the camera does the work and we
       send the mask recommendation straight to your inbox.</p>
    <p><a href="${resumeUrl}" style="display:inline-block;padding:10px 18px;background:#1e3a8a;color:#fff;text-decoration:none;border-radius:6px;">Pick up where you left off</a></p>
    <p style="color:#666;font-size:13px;">If you've already ordered or this email
       reached you by mistake, no action is needed — we won't send another
       reminder for this session.</p>
  </div>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Run a single re-engagement sweep. Exported for tests. */
export async function runFitterLeadReengageSweep(
  cfg: MessagingConfig = readReengageMessagingConfig(),
): Promise<ReengageStats> {
  const stats: ReengageStats = {
    scanned: 0,
    emailed: 0,
    skippedConverted: 0,
    skippedNoConfig: 0,
    skippedAlreadyClaimed: 0,
    errors: 0,
  };
  if (
    !cfg.sendgridApiKey ||
    !cfg.sendgridFromEmail ||
    !cfg.sendgridFromName ||
    !cfg.publicBaseUrl
  ) {
    stats.skippedNoConfig = 1;
    logger.warn(
      { event: "fitter-lead.reengage.skipped_no_config" },
      "fitter-lead-reengage: skipping run, messaging config incomplete",
    );
    return stats;
  }

  const supabase = getSupabaseServiceRoleClient();
  const now = Date.now();
  const youngerThan = new Date(now - MIN_AGE_MS).toISOString();
  const olderThan = new Date(now - MAX_AGE_MS).toISOString();

  // Eligibility: opted-in, not yet nudged, in the 3–30 day window.
  // The partial index `fitter_leads_unnudged_created_idx` covers
  // this exact predicate.
  const { data: leads, error } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .select("id, email, created_at")
    .eq("marketing_opt_in", true)
    .is("nudged_at", null)
    .lt("created_at", youngerThan)
    .gt("created_at", olderThan)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  const candidates = (leads ?? []).filter(
    (l): l is { id: string; email: string; created_at: string } =>
      typeof l.email === "string" && l.email.length > 0,
  );
  if (candidates.length === 0) return stats;

  // Bulk-check conversion: pull every public.orders row whose
  // patient_email case-insensitively matches one of our candidates.
  //
  // Case normalization: fitter_leads rows are lowercased at write
  // (the /shop/fitter-leads zod schema .toLowerCase()s before insert),
  // but public.orders.patient_email is stored as-entered (see
  // routes/storefront/orders.ts), so a mixed-case order email would
  // miss a plain `.in("patient_email", emails)` filter and the
  // dispatcher would re-email a patient who already converted.
  //
  // PostgREST .in() is case-sensitive, so we compose an OR of
  // case-insensitive ILIKE clauses — one per candidate email — and
  // lowercase the returned values before set-membership tests.
  //
  // Chunked at CHUNK to keep each PostgREST URI well below the 8KB
  // default limit even when the candidate list approaches BATCH_SIZE.
  // Special characters in the email (`,`, `(`, `)`, quotes) are
  // escaped via escapePostgRESTFilterValue so they can't break out
  // of the filter expression.
  const emails = Array.from(new Set(candidates.map((c) => c.email)));
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

  const sendgrid = createSendgridClient({
    apiKey: cfg.sendgridApiKey,
    fromEmail: cfg.sendgridFromEmail,
    fromName: cfg.sendgridFromName,
  });
  const { subject, html, text } = composeReengageEmail({
    practiceName: cfg.practiceName,
    publicBaseUrl: cfg.publicBaseUrl,
  });

  for (const lead of candidates) {
    stats.scanned += 1;
    if (convertedSet.has(lead.email)) {
      stats.skippedConverted += 1;
      continue;
    }

    // Atomic claim: update nudged_at only if it's still null. If
    // another worker already claimed this lead, we skip it to avoid
    // duplicate sends.
    const { data: claimResult, error: claimErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({ nudged_at: new Date().toISOString() })
      .eq("id", lead.id)
      .is("nudged_at", null)
      .select();

    if (claimErr) {
      logger.warn(
        { err: claimErr, leadId: lead.id },
        "fitter-lead-reengage: claim failed",
      );
      stats.errors += 1;
      continue;
    }

    if (!claimResult || claimResult.length === 0) {
      // Another worker claimed this lead already.
      stats.skippedAlreadyClaimed += 1;
      continue;
    }

    // Claim succeeded, proceed to send.
    try {
      await sendgrid.sendEmail({
        to: lead.email,
        subject,
        html,
        text,
      });
      stats.emailed += 1;
    } catch (err) {
      // Pass the Error object so pino's err.message / err.stack /
      // err.cause.* redact rules engage; logging err.message as a
      // bare string would bypass them.
      logger.warn(
        { err, leadId: lead.id },
        "fitter-lead-reengage: send failed",
      );
      stats.errors += 1;
      // The claim stamp remains in place; we won't retry this lead
      // even though the send failed. One nudge attempt per session
      // is the policy; spam-side failure is preferable to spam-side
      // success.
    }
  }

  return stats;
}

export async function registerFitterLeadReengageJob(
  boss: PgBoss,
): Promise<void> {
  // Opt-in via env. Without RESUPPLY_FITTER_REENGAGE_ENABLED=1 we
  // skip registration entirely — no queue, no schedule, no handler.
  // This keeps the cron OFF by default so a staging deploy with real
  // SendGrid keys can't accidentally email production patient
  // addresses; production sets the flag explicitly to turn it on.
  // The runtime sweep (runFitterLeadReengageSweep) already self-skips
  // on missing SendGrid creds, but credentialed staging environments
  // exist and would otherwise start firing the moment this lands.
  if (process.env.RESUPPLY_FITTER_REENGAGE_ENABLED !== "1") {
    logger.info(
      { event: "fitter-lead.reengage.disabled" },
      "fitter-lead-reengage: not registered (RESUPPLY_FITTER_REENGAGE_ENABLED!=1)",
    );
    return;
  }
  await createQueueWithDlq(boss, NUDGE_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(NUDGE_JOB, async () => {
    try {
      const stats = await runFitterLeadReengageSweep();
      logger.info(
        { event: "fitter-lead.reengage.completed", ...stats },
        "fitter-lead-reengage: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "fitter-lead-reengage: failed",
      );
      throw err;
    }
  });
  await boss.schedule(NUDGE_JOB, NUDGE_CRON);
  logger.info({ cron: NUDGE_CRON }, "fitter-lead.reengage scheduled");
}
