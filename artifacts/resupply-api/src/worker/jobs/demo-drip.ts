// pg-boss job: demo-lead nurture drip.
//
// Why this exists
// ---------------
// The Breathe marketing site captures a visitor's email when they open
// the self-serve demo (POST /demo-lead → public.newsletter_subscribers,
// source='breathe-demo'). Until this job, that list was capture-only —
// no email ever went back out. This walks each demo lead through a short,
// branded welcome + follow-up sequence so a warm signup actually hears
// from us.
//
// What it does
// ------------
// Hourly cron. Scans newsletter_subscribers for source='breathe-demo'
// rows that are not unsubscribed and haven't finished the sequence
// (demo_drip_stage < 3), and sends the next email that's DUE:
//
//   stage 0 → welcome           (due immediately)
//   stage 1 → "what to explore" (due ≥2 days after the welcome)
//   stage 2 → "ready to talk?"  (due ≥3 days after follow-up 1)
//
// These are PLATFORM emails: brand = CareMetric Breathe, sent under the
// platform's own SendGrid sender (createSendgridClient), every one
// carrying a one-click unsubscribe link.
//
// Idempotency
// -----------
// Atomic-claim the stage bump (guarded UPDATE on the current stage) BEFORE
// the send, so a crash mid-tick can't double-deliver on the next hourly
// run. A vendor-side send failure is logged but does not roll the stage
// back — the policy is "one attempt per stage", consistent with the
// fitter-lead nudges.
//
// Feature flag
// ------------
// Off by default. A staging deploy with a real SendGrid key should NOT
// start emailing real demo leads the moment this lands; production opts in
// with RESUPPLY_DEMO_DRIP_ENABLED=1 (mirrors the fitter first-day nudge).

import type PgBoss from "pg-boss";

import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import {
  DEMO_DRIP_EMAILS,
  type DemoEmailLinks,
} from "../../lib/demo-marketing/emails.js";
import { signNewsletterUnsubscribeToken } from "../../lib/demo-marketing/unsubscribe-token.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

const DEMO_DRIP_JOB = "demo-lead.drip";
/** Hourly at :37 — clear of the other resupply crons. */
const DEMO_DRIP_CRON = "37 * * * *";
const BATCH_SIZE = 200;
const DEMO_LEAD_SOURCE = "breathe-demo";

/** Minimum spacing before the email for each stage is DUE, measured from
 *  `demo_drip_last_sent_at`. Index === the stage value being sent. Stage 0
 *  (welcome) is due immediately. */
const STAGE_MIN_GAP_MS = [
  0, // stage 0 → welcome: send on the first tick after signup
  2 * 86_400_000, // stage 1 → follow-up 1: ≥2 days after welcome
  3 * 86_400_000, // stage 2 → follow-up 2: ≥3 days after follow-up 1
] as const;

export interface DemoDripStats {
  scanned: number;
  sent: number;
  notDueYet: number;
  skippedAlreadyClaimed: number;
  skippedNoEmailConfig: number;
  errors: number;
}

interface SubscriberRow {
  email: string;
  demo_drip_stage: number;
  demo_drip_last_sent_at: string | null;
}

/** Platform public origin the demo links point at.
 *
 * This is a PLATFORM-only drip (CareMetric Breathe marketing), so it must
 * resolve the platform's OWN host — NOT `SHOP_PUBLIC_BASE_URL`, which the
 * README documents as a tenant storefront deep-link host (e.g.
 * `https://pennpaps.com`). Pointing demo links or the unsubscribe URL at a
 * tenant domain would leak platform marketing traffic into that tenant's
 * brand. Order: explicit `PLATFORM_PUBLIC_BASE_URL` override → the
 * platform's Railway host → the canonical `cmbreathe.com` apex. */
export function demoDripBaseUrl(): string {
  return (
    process.env.PLATFORM_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://cmbreathe.com")
  ).replace(/\/$/, "");
}

/** Build the per-lead link set (the demo gate, features page, contact,
 *  and the one-click unsubscribe bound to this email). */
export function buildDemoLinks(email: string, baseUrl: string): DemoEmailLinks {
  const token = signNewsletterUnsubscribeToken(email);
  return {
    demoUrl: `${baseUrl}/admin?demo=1`,
    featuresUrl: `${baseUrl}/breathe-features`,
    contactUrl:
      "mailto:info@cmbreathe.com?subject=CareMetric%20Breathe%20walkthrough",
    unsubscribeUrl: `${baseUrl}/api/newsletter-unsubscribe?t=${encodeURIComponent(token)}`,
  };
}

/** Whether the email for `stage` is due, given the last send time.
 *  Exported for testing. */
export function isStageDue(
  stage: number,
  lastSentAt: string | null,
  now: number,
): boolean {
  const gap = STAGE_MIN_GAP_MS[stage];
  if (gap === undefined) return false;
  if (gap === 0) return true;
  if (!lastSentAt) return true;
  return now - new Date(lastSentAt).getTime() >= gap;
}

/** Run a single demo-drip sweep. Exported for testability. */
export async function runDemoDripSweep(): Promise<DemoDripStats> {
  const stats: DemoDripStats = {
    scanned: 0,
    sent: 0,
    notDueYet: 0,
    skippedAlreadyClaimed: 0,
    skippedNoEmailConfig: 0,
    errors: 0,
  };

  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("public")
    .from("newsletter_subscribers")
    .select("email, demo_drip_stage, demo_drip_last_sent_at")
    .eq("source", DEMO_LEAD_SOURCE)
    .is("unsubscribed_at", null)
    .lt("demo_drip_stage", DEMO_DRIP_EMAILS.length)
    .order("demo_drip_last_sent_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  const candidates = ((rows ?? []) as SubscriberRow[]).filter(
    (r) => typeof r.email === "string" && r.email.length > 0,
  );
  if (candidates.length === 0) return stats;

  const now = Date.now();

  // Lazily build the platform SendGrid client; a missing key degrades the
  // whole tick gracefully (no sends) rather than throwing.
  let sendgrid: ReturnType<typeof createSendgridClient>;
  try {
    sendgrid = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.info(
        { event: "demo-lead.drip.no_email_config" },
        "demo-lead.drip: SendGrid not configured — skipping tick",
      );
      stats.skippedNoEmailConfig = candidates.length;
      return stats;
    }
    throw err;
  }

  const baseUrl = demoDripBaseUrl();

  for (const row of candidates) {
    stats.scanned += 1;
    const stage = row.demo_drip_stage;
    if (!isStageDue(stage, row.demo_drip_last_sent_at, now)) {
      stats.notDueYet += 1;
      continue;
    }
    const render = DEMO_DRIP_EMAILS[stage];
    if (!render) continue;

    // Atomic claim: bump the stage (guarded on the value we read) BEFORE
    // sending, so a concurrent tick or a crash can't double-deliver.
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("public")
      .from("newsletter_subscribers")
      .update({
        demo_drip_stage: stage + 1,
        demo_drip_last_sent_at: nowIso,
        updated_at: nowIso,
      })
      .eq("email", row.email)
      .eq("demo_drip_stage", stage)
      .is("unsubscribed_at", null)
      .select("email");
    if (claimErr) {
      logger.warn(
        { event: "demo-lead.drip.claim_failed", pgCode: claimErr.code ?? null },
        "demo-lead.drip: stage claim failed",
      );
      stats.errors += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) {
      // Someone else advanced it, or the lead unsubscribed between read
      // and claim. Either way, not ours to send.
      stats.skippedAlreadyClaimed += 1;
      continue;
    }

    const { subject, html, text } = render(buildDemoLinks(row.email, baseUrl));
    try {
      await sendgrid.sendEmail({
        to: row.email,
        subject,
        html,
        text,
        customArgs: { kind: "demo_drip", stage: String(stage) },
      });
      stats.sent += 1;
    } catch {
      // Logged but the stage stays advanced — one attempt per stage. The
      // address is never logged (PHI/marketing posture).
      logger.warn(
        { event: "demo-lead.drip.send_failed", stage },
        "demo-lead.drip: email send failed",
      );
      stats.errors += 1;
    }
  }

  return stats;
}

export async function registerDemoDripJob(boss: PgBoss): Promise<void> {
  if (process.env.RESUPPLY_DEMO_DRIP_ENABLED !== "1") {
    logger.info(
      { event: "demo-lead.drip.disabled" },
      "demo-lead.drip: not registered (RESUPPLY_DEMO_DRIP_ENABLED!=1)",
    );
    // Clear any previously persisted schedule so disabling the flag
    // actually stops the cron (table-guard pattern; typeof-guarded for
    // test doubles / older pg-boss).
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(DEMO_DRIP_JOB).catch(() => undefined);
    }
    return;
  }
  await createQueueWithDlq(boss, DEMO_DRIP_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(DEMO_DRIP_JOB, async () => {
    try {
      const stats = await runDemoDripSweep();
      logger.info(
        { event: "demo-lead.drip.completed", ...stats },
        "demo-lead.drip: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "demo-lead.drip: failed",
      );
      throw err;
    }
  });
  await boss.schedule(DEMO_DRIP_JOB, DEMO_DRIP_CRON);
  logger.info({ cron: DEMO_DRIP_CRON }, "demo-lead.drip scheduled");
}
