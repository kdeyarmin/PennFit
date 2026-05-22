// pg-boss job: multi-touch supply-campaign nurture for completed
// fitter leads.
//
// Why this exists
// ---------------
// The three fitter-adjacent dispatchers in the worker today
// (first-day-nudge, reengage, lapsed-customer-winback) are all
// SINGLE-SHOT lifecycle nudges. None of them runs a structured
// drip aimed at turning "fit but didn't buy" prospects into
// first-time mask buyers, and none of them know whether the patient
// actually finished the fitter (vs. abandoned at /consent).
//
// This dispatcher is the new conversion path: when /results fires
// POST /shop/fitter-complete (artifacts/resupply-api/src/routes/shop/
// fitter-complete.ts), the lead's journey_stage flips to
// 'campaign_active' and the first touchpoint is scheduled 24h out.
// This worker drains "due" rows from there, sends the next touch,
// and reschedules.
//
// Touchpoint sequence (defined in fitter-complete.ts)
// --------------------------------------------------
// 6 touches over 60 days, with copy that escalates from soft recap
// (T1, day 1) → social proof (T2, day 3) → benefit reminders (T3
// FSA/HSA, day 7) → one-time discount (T4, day 14) → educational
// (T5, day 30) → final-call (T6, day 60). After T6 the lead is
// stamped journey_stage='expired'.
//
// Channels
// --------
// Email always (when SENDGRID_* configured). SMS for T1/T4 only
// (highest-intent touches) when the lead has phone_e164 +
// sms_opt_in. Other touches stay email-only to avoid burning the
// SMS channel — SMS marketing tolerance is lower than email
// tolerance for the same patient cohort.
//
// Idempotency
// -----------
// Atomic claim by bumping campaign_touch_count BEFORE the send,
// using a WHERE clause that pins the current value (optimistic
// concurrency). The per-row audit log
// (resupply.fitter_campaign_touches) has a UNIQUE constraint on
// (lead_id, touch_index, channel) as the second line of defense
// — a race that double-claimed would still only insert one
// audit row.
//
// Conversion stop
// ---------------
// The fitter-conversion-attribution worker stamps
// journey_stage='converted' on rows whose email matches a recent
// order. This dispatcher's WHERE clause excludes 'converted',
// 'unsubscribed', 'expired' — so a converting patient drops out
// the moment attribution fires.
//
// Feature flag
// ------------
// Two gates:
//   1. RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED=1 — boot-time flag
//      that controls registration (mirrors first-day-nudge). Off
//      by default so a staging deploy with real SendGrid keys
//      doesn't start emailing the moment this lands.
//   2. resupply.feature_flags.fitter_supply_campaign.dispatcher —
//      runtime flag flipped from the admin Control Center. The
//      worker re-checks every tick; flipping it off pauses sends
//      without a deploy.

import type PgBoss from "pg-boss";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type FitterLeadsUpdate = Database["resupply"]["Tables"]["fitter_leads"]["Update"];
import { createSendgridClient, EmailConfigError } from "@workspace/resupply-email";
import { createTwilioSmsClient, TwilioConfigError } from "@workspace/resupply-telecom";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import {
  TOUCHPOINT_OFFSETS_MS,
  TOTAL_TOUCHPOINTS,
  signUnsubscribeToken,
} from "../../routes/shop/fitter-complete";

const JOB_NAME = "fitter-lead.supply-campaign";
/** Hourly at :43 — clear of every other resupply cron. */
const JOB_CRON = "43 * * * *";
const BATCH_SIZE = 200;

/** Channel set per touchpoint. SMS only on T1 (day 1) and T4 (day
 *  14 discount) — the two highest-intent touches. Other touches
 *  stay email-only to avoid SMS-fatigue on the same lead. */
const SMS_TOUCH_INDEXES = new Set<number>([1, 4]);

export interface SupplyCampaignStats {
  scanned: number;
  emailed: number;
  smsSent: number;
  skippedNoEmailConfig: number;
  skippedNoSmsConfig: number;
  skippedFlagDisabled: number;
  skippedClaimLost: number;
  expired: number;
  errors: number;
}

interface LeadRow {
  id: string;
  email: string;
  phone_e164: string | null;
  sms_opt_in: boolean;
  recommended_mask_id: string | null;
  recommended_mask_name: string | null;
  recommended_mask_type: string | null;
  campaign_touch_count: number;
  completed_at: string | null;
}

interface TouchpointCopy {
  email: { subject: string; html: string; text: string };
  sms: string;
}

function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "https://pennpaps.com")
  ).replace(/\/$/, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Map a 1-based touch index to the copy that should ship. Exported
 *  for testability — pure function, no DB or vendor calls. */
export function composeTouchpoint(opts: {
  touchIndex: number;
  practiceName: string;
  resumeUrl: string;
  shopUrl: string;
  recommendedMaskName: string | null;
  recommendedMaskType: string | null;
  unsubscribeUrl: string;
}): TouchpointCopy {
  const {
    touchIndex,
    practiceName,
    resumeUrl,
    shopUrl,
    recommendedMaskName,
    unsubscribeUrl,
  } = opts;
  // Friendly "your AirFit P30i" snippet, fallback when the recommended
  // mask name isn't persisted yet (legacy rows or attribution races).
  const maskRef = recommendedMaskName
    ? `your ${recommendedMaskName}`
    : "your recommended mask";
  const maskRefHtml = escapeHtml(maskRef);

  const footer = (textMode: boolean): string =>
    textMode
      ? `\n\n— ${practiceName}\nDon't want these? Unsubscribe: ${unsubscribeUrl}`
      : `<p style="color:#888;font-size:12px;margin-top:32px;">${escapeHtml(practiceName)} · <a href="${unsubscribeUrl}" style="color:#888;">Unsubscribe from these emails</a></p>`;

  const ctaButton = (label: string, href: string): string =>
    `<p><a href="${href}" style="display:inline-block;padding:12px 22px;background:#0f1d3a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a></p>`;

  switch (touchIndex) {
    case 1: {
      // T1 — day 1: warm recap.
      const subject = `${maskRef} is ready when you are`;
      const text = [
        `Hi from ${practiceName},`,
        "",
        `Yesterday you ran our at-home fitting and we matched you to ${maskRef}.`,
        "It's still saved — no need to redo the measurements.",
        "",
        `Pick up where you left off: ${resumeUrl}`,
        "",
        "Most patients we work with sleep noticeably better in the first week.",
        "Reply to this email if you have a question — a real human reads it.",
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          <p>Hi from <strong>${escapeHtml(practiceName)}</strong>,</p>
          <p>Yesterday you ran our at-home fitting and we matched you to <strong>${maskRefHtml}</strong>. It&apos;s still saved — no need to redo the measurements.</p>
          ${ctaButton("Pick up where you left off", resumeUrl)}
          <p>Most patients we work with sleep noticeably better in the first week. Reply to this email if you have a question — a real human reads it.</p>
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${practiceName}: ${maskRef} from your fitting is ready. Continue: ${resumeUrl} . Reply STOP to opt out.`,
      };
    }
    case 2: {
      // T2 — day 3: social proof.
      const subject = `What ${practiceName} patients say about ${maskRef}`;
      const text = [
        `Hi again,`,
        "",
        `${maskRef} is one of the most-chosen masks for patients with similar measurements to yours.`,
        "What patients tell us most often:",
        "  • Quieter than they expected",
        "  • Comfortable for side sleepers",
        "  • Easy to clean in under a minute",
        "",
        `Take another look: ${resumeUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          <p>Hi again,</p>
          <p><strong>${maskRefHtml}</strong> is one of the most-chosen masks for patients with similar measurements to yours.</p>
          <p>What patients tell us most often:</p>
          <ul>
            <li>Quieter than they expected</li>
            <li>Comfortable for side sleepers</li>
            <li>Easy to clean in under a minute</li>
          </ul>
          ${ctaButton("Take another look", resumeUrl)}
          ${footer(false)}
        </div>`;
      return { email: { subject, html, text }, sms: "" };
    }
    case 3: {
      // T3 — day 7: FSA/HSA reminder.
      const subject = "Your FSA / HSA covers CPAP supplies";
      const text = [
        "Quick reminder:",
        "",
        "CPAP masks and supplies are FSA- and HSA-eligible. If you have one of",
        "these accounts, ordering through us is one less expense out of pocket.",
        "We accept FSA/HSA cards directly at checkout — no receipts to submit.",
        "",
        `Browse compatible supplies: ${shopUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          <p>Quick reminder:</p>
          <p>CPAP masks and supplies are <strong>FSA- and HSA-eligible</strong>. If you have one of these accounts, ordering through us is one less expense out of pocket. We accept FSA/HSA cards directly at checkout — no receipts to submit.</p>
          ${ctaButton("Browse compatible supplies", shopUrl)}
          ${footer(false)}
        </div>`;
      return { email: { subject, html, text }, sms: "" };
    }
    case 4: {
      // T4 — day 14: one-time discount. The promo code is the same
      // for every recipient — Stripe coupon, expires 30 days from
      // send. (Promo creation isn't part of this PR; the placeholder
      // code is wired so ops can swap it via env later.)
      const promo = process.env.FITTER_SUPPLY_CAMPAIGN_PROMO ?? "WELCOME15";
      const subject = `15% off your first ${maskRef}`;
      const text = [
        `One-time offer — code ${promo} takes 15% off your first order, mask or supplies.`,
        "Valid for 30 days from this email.",
        "",
        `Use it here: ${shopUrl}`,
        "",
        "We made it once per patient — works on the mask we recommended or anything else you'd like to try.",
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          <p style="font-size:18px;"><strong>15% off your first order</strong></p>
          <p>One-time offer — code <code style="background:#f2f2f2;padding:2px 6px;border-radius:4px;">${escapeHtml(promo)}</code> takes 15% off your first order, mask or supplies. Valid for 30 days.</p>
          ${ctaButton(`Shop ${maskRef}`, shopUrl)}
          <p style="color:#666;">We made it once per patient — works on the mask we recommended or anything else you&apos;d like to try.</p>
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${practiceName}: 15% off your first order with ${promo} (30d). ${shopUrl} . Reply STOP to opt out.`,
      };
    }
    case 5: {
      // T5 — day 30: educational.
      const subject = "What 30 days of CPAP looks like";
      const text = [
        "After 30 nights on the right CPAP setup, most patients notice:",
        "  • Morning headaches gone or much milder",
        "  • Daytime energy noticeably better",
        "  • Bed partner sleeping through the night",
        "",
        "We've held your fitting recommendation — when you're ready, it's still here:",
        `  ${resumeUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          <p>After 30 nights on the right CPAP setup, most patients notice:</p>
          <ul>
            <li>Morning headaches gone or much milder</li>
            <li>Daytime energy noticeably better</li>
            <li>Bed partner sleeping through the night</li>
          </ul>
          <p>We&apos;ve held your fitting recommendation — when you&apos;re ready, it&apos;s still here:</p>
          ${ctaButton("See my recommendation", resumeUrl)}
          ${footer(false)}
        </div>`;
      return { email: { subject, html, text }, sms: "" };
    }
    case 6:
    default: {
      // T6 — day 60: final touch.
      const subject = `Final note from ${practiceName}`;
      const text = [
        `This is the last email we'll send about ${maskRef}.`,
        "",
        "Your fitting will stay on file for 12 months in case you'd like to come back to it.",
        "If you have questions or want to talk to someone, just reply — we read every reply.",
        "",
        `Resume any time: ${resumeUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          <p>This is the last email we&apos;ll send about <strong>${maskRefHtml}</strong>.</p>
          <p>Your fitting will stay on file for 12 months in case you&apos;d like to come back to it. If you have questions or want to talk to someone, just reply — we read every reply.</p>
          ${ctaButton("Resume any time", resumeUrl)}
          ${footer(false)}
        </div>`;
      return { email: { subject, html, text }, sms: "" };
    }
  }
}

function tryCreateSendgrid(): ReturnType<typeof createSendgridClient> | null {
  try {
    return createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) return null;
    throw err;
  }
}

function tryCreateTwilioSms(): ReturnType<typeof createTwilioSmsClient> | null {
  try {
    return createTwilioSmsClient();
  } catch (err) {
    if (err instanceof TwilioConfigError) return null;
    throw err;
  }
}

/**
 * Run one sweep of the supply-campaign dispatcher. Exported for
 * test seams + manual ops invocation.
 */
export async function runFitterSupplyCampaignSweep(): Promise<SupplyCampaignStats> {
  const stats: SupplyCampaignStats = {
    scanned: 0,
    emailed: 0,
    smsSent: 0,
    skippedNoEmailConfig: 0,
    skippedNoSmsConfig: 0,
    skippedFlagDisabled: 0,
    skippedClaimLost: 0,
    expired: 0,
    errors: 0,
  };

  // Runtime feature-flag check. The boot-time RESUPPLY_FITTER_*_ENABLED
  // env var controls whether the cron is REGISTERED at all; this DB
  // flag controls whether a REGISTERED cron actually does work. Lets
  // ops pause the campaign from the Control Center without a deploy.
  const flagEnabled = await isFeatureEnabled(
    "fitter_supply_campaign.dispatcher",
  );
  if (!flagEnabled) {
    stats.skippedFlagDisabled = 1;
    return stats;
  }

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Eligibility: opted-in row in campaign_active with a due-now
  // next_campaign_touch_at. The partial index
  // `fitter_leads_campaign_due_idx` covers this exact predicate.
  const { data: leads, error } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .select(
      "id, email, phone_e164, sms_opt_in, recommended_mask_id, recommended_mask_name, recommended_mask_type, campaign_touch_count, completed_at",
    )
    .eq("journey_stage", "campaign_active")
    .eq("marketing_opt_in", true)
    .is("unsubscribed_at", null)
    .lte("next_campaign_touch_at", nowIso)
    .order("next_campaign_touch_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  const candidates = (leads ?? []).filter(
    (l): l is LeadRow =>
      typeof l.email === "string" && l.email.length > 0,
  );
  if (candidates.length === 0) return stats;

  const sendgrid = tryCreateSendgrid();
  const twilioSms = tryCreateTwilioSms();
  const practiceName = process.env.RESUPPLY_PRACTICE_NAME ?? "PennPaps";
  const baseUrl = publicBaseUrl();
  const resumeUrl = `${baseUrl}/results`;
  const shopUrl = `${baseUrl}/shop`;

  for (const lead of candidates) {
    stats.scanned += 1;
    const nextTouchIndex = lead.campaign_touch_count + 1;

    // Schedule based on absolute offset from completed_at — so a
    // worker delay doesn't telescope the cadence (T2 still lands at
    // day 3, not day 1+2). When the touch we're about to send IS
    // the final one, set next_campaign_touch_at = null AND flip the
    // journey_stage to 'expired' in the same atomic write — keeps
    // the row out of the dispatcher's WHERE on the next tick instead
    // of leaving it dangling with a null due-time.
    const isFinalTouch = nextTouchIndex >= TOTAL_TOUCHPOINTS;
    const completedAtMs = lead.completed_at
      ? new Date(lead.completed_at).getTime()
      : Date.now();
    const nextTouchAt = isFinalTouch
      ? null
      : new Date(
          completedAtMs + TOUCHPOINT_OFFSETS_MS[nextTouchIndex],
        ).toISOString();

    // Atomic claim — bump campaign_touch_count BEFORE the send, with
    // an optimistic WHERE pinning the prior value. A concurrent
    // worker that claimed first will see no rows updated and we
    // skip this lead.
    const claimIso = new Date().toISOString();
    const claimUpdate: FitterLeadsUpdate = {
      campaign_touch_count: nextTouchIndex,
      last_campaign_touch_at: claimIso,
      next_campaign_touch_at: nextTouchAt,
    };
    if (isFinalTouch) claimUpdate.journey_stage = "expired";

    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update(claimUpdate)
      .eq("id", lead.id)
      .eq("campaign_touch_count", lead.campaign_touch_count)
      .eq("journey_stage", "campaign_active")
      .select("id");
    if (claimErr) {
      stats.errors += 1;
      logger.warn(
        { err: claimErr.message, leadId: lead.id, touchIndex: nextTouchIndex },
        "fitter-lead.supply-campaign: claim failed",
      );
      continue;
    }
    if (!claimed || claimed.length === 0) {
      // Lost race / state changed under us — skip.
      stats.skippedClaimLost += 1;
      continue;
    }
    if (isFinalTouch) stats.expired += 1;

    // Build the unsubscribe URL once per lead (signed token includes
    // the lead_id so a leaked link can't unsubscribe a different
    // patient).
    let unsubscribeUrl: string;
    try {
      const token = signUnsubscribeToken(lead.id);
      unsubscribeUrl = `${baseUrl}/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(token)}`;
    } catch (err) {
      // RESUPPLY_LINK_HMAC_KEY missing → service misconfig. Skip
      // sending; we never want to ship an email without a working
      // unsubscribe path (CAN-SPAM, common decency).
      logger.error(
        { err, leadId: lead.id },
        "fitter-lead.supply-campaign: unsubscribe token mint failed",
      );
      stats.errors += 1;
      continue;
    }

    const copy = composeTouchpoint({
      touchIndex: nextTouchIndex,
      practiceName,
      resumeUrl,
      shopUrl,
      recommendedMaskName: lead.recommended_mask_name,
      recommendedMaskType: lead.recommended_mask_type,
      unsubscribeUrl,
    });

    // Email leg.
    if (sendgrid) {
      try {
        await sendgrid.sendEmail({
          to: lead.email,
          subject: copy.email.subject,
          html: copy.email.html,
          text: copy.email.text,
          customArgs: {
            kind: "fitter_supply_campaign",
            touch_index: String(nextTouchIndex),
            lead_id: lead.id,
          },
        });
        stats.emailed += 1;
        await recordTouch(lead.id, nextTouchIndex, "email", "sent", null);
      } catch (err) {
        stats.errors += 1;
        logger.warn(
          { err, leadId: lead.id, touchIndex: nextTouchIndex },
          "fitter-lead.supply-campaign: email send failed",
        );
        await recordTouch(
          lead.id,
          nextTouchIndex,
          "email",
          "failed",
          err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        );
      }
    } else {
      stats.skippedNoEmailConfig += 1;
      await recordTouch(lead.id, nextTouchIndex, "email", "skipped", "no_sendgrid_config");
    }

    // SMS leg — gated by both per-touch policy (SMS_TOUCH_INDEXES)
    // and per-lead consent (sms_opt_in + phone_e164 present).
    const smsEligible =
      SMS_TOUCH_INDEXES.has(nextTouchIndex) &&
      lead.phone_e164 &&
      lead.sms_opt_in &&
      copy.sms.length > 0;
    if (smsEligible) {
      if (twilioSms) {
        try {
          await twilioSms.sendSms({
            to: lead.phone_e164 as string,
            body: copy.sms,
          });
          stats.smsSent += 1;
          await recordTouch(lead.id, nextTouchIndex, "sms", "sent", null);
        } catch (err) {
          stats.errors += 1;
          logger.warn(
            { err, leadId: lead.id, touchIndex: nextTouchIndex },
            "fitter-lead.supply-campaign: sms send failed",
          );
          await recordTouch(
            lead.id,
            nextTouchIndex,
            "sms",
            "failed",
            err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          );
        }
      } else {
        stats.skippedNoSmsConfig += 1;
        await recordTouch(lead.id, nextTouchIndex, "sms", "skipped", "no_twilio_config");
      }
    }
  }

  return stats;
}

/** Best-effort write to fitter_campaign_touches. Audit log only;
 *  a failure to insert never blocks the send pipeline. */
async function recordTouch(
  leadId: string,
  touchIndex: number,
  channel: "email" | "sms",
  status: "sent" | "failed" | "skipped",
  errorMessage: string | null,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("fitter_campaign_touches")
      .insert({
        lead_id: leadId,
        touch_index: touchIndex,
        channel,
        template_key: `fitter_supply_campaign.t${touchIndex}`,
        status,
        error_message: errorMessage,
      });
    if (error) {
      // Unique-constraint hit is expected on a retry of a lost-race
      // claim; everything else is logged.
      const code = (error as { code?: string }).code;
      if (code !== "23505") {
        logger.warn(
          { err: error.message, leadId, touchIndex, channel },
          "fitter-lead.supply-campaign: touch audit insert failed",
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err, leadId, touchIndex, channel },
      "fitter-lead.supply-campaign: touch audit insert threw",
    );
  }
}

export async function registerFitterSupplyCampaignJob(
  boss: PgBoss,
): Promise<void> {
  // Boot-time gate. See file header for the two-layer flag rationale.
  if (process.env.RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED !== "1") {
    logger.info(
      { event: "fitter-lead.supply-campaign.disabled" },
      "fitter-lead.supply-campaign: not registered (RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED!=1)",
    );
    return;
  }
  await boss.createQueue(JOB_NAME);
  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runFitterSupplyCampaignSweep();
      logger.info(
        { event: "fitter-lead.supply-campaign.completed", ...stats },
        "fitter-lead.supply-campaign: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "fitter-lead.supply-campaign: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "fitter-lead.supply-campaign scheduled");
}
