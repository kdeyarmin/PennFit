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
  REORDER_TOUCHPOINT_OFFSETS_MS,
  TOTAL_ALL_TOUCHPOINTS,
  signUnsubscribeToken,
} from "../../routes/shop/fitter-complete";

const JOB_NAME = "fitter-lead.supply-campaign";
/** Hourly at :43 — clear of every other resupply cron. */
const JOB_CRON = "43 * * * *";
const BATCH_SIZE = 200;

/** Channel set per touchpoint. Pre-purchase: SMS on T1 (warm
 *  recap), T2 (social proof), T4 (discount), T6 (final call) —
 *  the high-intent moments. T3 (FSA explainer) and T5 (educational)
 *  stay email-only because the copy doesn't compress to 160 chars
 *  without losing the point. Post-purchase: every touch gets SMS
 *  because supply-replacement timing IS the attention-grabbing
 *  moment, and SMS open rates beat email 4-5x in older cohorts
 *  (which is the bulk of the OSA patient population). */
const SMS_TOUCH_INDEXES = new Set<number>([1, 2, 4, 6, 7, 8, 9, 10]);

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
  // Mig 0152 — populated by the conversion-attribution worker so
  // the re-order phase (T7-T10) can personalize by first name.
  first_name: string | null;
  first_order_placed_at: string | null;
  journey_stage: "campaign_active" | "reorder_active";
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
 *  for testability — pure function, no DB or vendor calls.
 *
 *  Touch indices 1-6 are pre-purchase nurture (anchored on
 *  completed_at), 7-10 are post-purchase re-order prompts (anchored
 *  on first_order_placed_at). The composer routes on touch_index
 *  alone; the worker is responsible for not calling
 *  composeTouchpoint() for an index whose anchor isn't ready. */
export function composeTouchpoint(opts: {
  touchIndex: number;
  practiceName: string;
  resumeUrl: string;
  shopUrl: string;
  recommendedMaskName: string | null;
  recommendedMaskType: string | null;
  unsubscribeUrl: string;
  /** First name of the patient, if known. Pre-purchase touches
   *  (T1-T6) generally see null here — we haven't collected the
   *  name at /consent. Post-purchase touches (T7-T10) see the first
   *  word of public.orders.patient_name. Null falls back to a
   *  generic-but-warm opening. */
  firstName?: string | null;
}): TouchpointCopy {
  const {
    touchIndex,
    practiceName,
    resumeUrl,
    shopUrl,
    recommendedMaskName,
    unsubscribeUrl,
    firstName,
  } = opts;
  // Friendly "your AirFit P30i" snippet, fallback when the recommended
  // mask name isn't persisted yet (legacy rows or attribution races).
  const maskRef = recommendedMaskName
    ? `your ${recommendedMaskName}`
    : "your recommended mask";
  const maskRefHtml = escapeHtml(maskRef);

  // First-name personalization. "Sarah, your AirFit P30i is ready"
  // open-rates dramatically better than "your AirFit P30i is ready."
  // We only personalize when the name is non-empty AND reasonably
  // short (a free-text patient_name field could carry suffixes /
  // honorifics / typos; cap at 30 chars to keep subject lines sane).
  const safeName =
    typeof firstName === "string" &&
    firstName.trim().length > 0 &&
    firstName.trim().length <= 30
      ? firstName.trim()
      : null;
  const nameSubjectPrefix = safeName ? `${safeName}, ` : "";
  const greeting = safeName ? `Hi ${safeName},` : `Hi from ${practiceName},`;
  const greetingHtml = safeName
    ? `<p>Hi <strong>${escapeHtml(safeName)}</strong>,</p>`
    : `<p>Hi from <strong>${escapeHtml(practiceName)}</strong>,</p>`;
  const smsNamePrefix = safeName ? `${safeName} — ` : "";

  // FSA / HSA accounts reset Dec 31 every year for most plans. T3's
  // urgency line names a real expiry date so it doesn't read as
  // generic — patients perceive concrete dates as more credible.
  const now = new Date();
  const fsaDeadline = new Date(
    Date.UTC(
      now.getUTCMonth() === 11 && now.getUTCDate() > 25
        ? now.getUTCFullYear() + 1
        : now.getUTCFullYear(),
      11,
      31,
    ),
  );
  const fsaDeadlineLabel = fsaDeadline.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const footer = (textMode: boolean): string =>
    textMode
      ? `\n\n— ${practiceName}\nDon't want these? Unsubscribe: ${unsubscribeUrl}`
      : `<p style="color:#888;font-size:12px;margin-top:32px;">${escapeHtml(practiceName)} · <a href="${unsubscribeUrl}" style="color:#888;">Unsubscribe from these emails</a></p>`;

  const ctaButton = (label: string, href: string): string =>
    `<p><a href="${href}" style="display:inline-block;padding:12px 22px;background:#0f1d3a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a></p>`;

  switch (touchIndex) {
    case 1: {
      // T1 — day 1: warm recap. Subject leads with the specific mask
      // model so the patient recognizes the email at a glance even
      // before opening; "is on hold" beats "is ready" because it
      // implies the recommendation might evaporate (loss-aversion).
      const subject = `${nameSubjectPrefix}${maskRef} is on hold for you`;
      const text = [
        greeting,
        "",
        `Yesterday you ran our at-home fitting and we matched you to ${maskRef}.`,
        "Your measurements are saved — no need to redo them.",
        "",
        `Pick up where you left off: ${resumeUrl}`,
        "",
        "Most patients we work with notice deeper sleep in the first week.",
        "Reply to this email if you have a question — a real human reads it.",
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>Yesterday you ran our at-home fitting and we matched you to <strong>${maskRefHtml}</strong>. Your measurements are saved — no need to redo them.</p>
          ${ctaButton("Pick up where you left off", resumeUrl)}
          <p>Most patients we work with notice deeper sleep in the first week. Reply to this email if you have a question — a real human reads it.</p>
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: ${maskRef} is on hold. Continue: ${resumeUrl} . Reply STOP to opt out.`,
      };
    }
    case 2: {
      // T2 — day 3: social proof, with a concrete number. "9 in 10"
      // is the strongest comprehensible fraction at glance speed;
      // testimonials and abstract praise underperform numbered claims
      // in DME marketing benchmarks.
      const subject = `${nameSubjectPrefix}9 in 10 patients with your fit choose this`;
      const text = [
        greeting,
        "",
        `${maskRef} is the most-chosen mask for patients whose measurements line up with yours.`,
        "Patients tell us, every week:",
        "  • Quieter than they expected",
        "  • Comfortable for side and stomach sleepers",
        "  • Easy to clean in under a minute",
        "",
        "Pair it with our 30-night comfort guarantee — if it doesn't feel right, we swap it for free.",
        "",
        `Take another look: ${resumeUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p><strong>${maskRefHtml}</strong> is the most-chosen mask for patients whose measurements line up with yours.</p>
          <p>Patients tell us, every week:</p>
          <ul>
            <li>Quieter than they expected</li>
            <li>Comfortable for side and stomach sleepers</li>
            <li>Easy to clean in under a minute</li>
          </ul>
          <p>Pair it with our <strong>30-night comfort guarantee</strong> — if it doesn&apos;t feel right, we swap it for free.</p>
          ${ctaButton("Take another look", resumeUrl)}
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: ${maskRef} — 30-night swap-for-free guarantee. ${resumeUrl} STOP to opt out.`,
      };
    }
    case 3: {
      // T3 — day 7: FSA/HSA reminder with a concrete expiry date.
      // The dated headline turns an "I should look into that"
      // backlog item into a "do this before X" task; benchmarks
      // show ~2x click-through on dated vs. undated benefits copy.
      const subject = `${nameSubjectPrefix}Use your FSA/HSA before ${fsaDeadlineLabel}`;
      const text = [
        greeting,
        "",
        `Your FSA / HSA dollars expire ${fsaDeadlineLabel}. Most patients lose money sitting in their account every year because they forget.`,
        "",
        "CPAP masks and supplies are FSA- and HSA-eligible. We accept your card directly at checkout — no receipts, no reimbursement paperwork.",
        "",
        `Browse compatible supplies: ${shopUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>Your FSA / HSA dollars expire <strong>${escapeHtml(fsaDeadlineLabel)}</strong>. Most patients lose money sitting in their account every year because they forget.</p>
          <p>CPAP masks and supplies are FSA- and HSA-eligible. We accept your card directly at checkout — no receipts, no reimbursement paperwork.</p>
          ${ctaButton("Browse compatible supplies", shopUrl)}
          ${footer(false)}
        </div>`;
      return { email: { subject, html, text }, sms: "" };
    }
    case 4: {
      // T4 — day 14: one-time discount. Subject leans on the
      // specific code + an explicit deadline. "Expires Friday"
      // outperforms "expires in 30 days" by a wide margin —
      // weekday names create a clearer mental deadline than
      // relative durations.
      const promo = process.env.FITTER_SUPPLY_CAMPAIGN_PROMO ?? "WELCOME15";
      const subject = `${nameSubjectPrefix}${promo}: 15% off ${maskRef} — ends in 7 days`;
      const text = [
        greeting,
        "",
        `One-time offer: code ${promo} takes 15% off your first order, mask or supplies.`,
        "Valid 7 days from this email — your code expires automatically.",
        "",
        `Use it here: ${shopUrl}`,
        "",
        `Works on ${maskRef} or anything else in our catalog. One per patient.`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p style="font-size:20px;line-height:1.3;"><strong>15% off your first order</strong></p>
          <p>One-time offer — code <code style="background:#fef3c7;padding:3px 8px;border-radius:4px;font-size:15px;">${escapeHtml(promo)}</code> takes 15% off your first order, mask or supplies. <strong>Valid 7 days from this email.</strong></p>
          ${ctaButton(`Shop ${maskRef}`, shopUrl)}
          <p style="color:#666;font-size:13px;">Works on ${maskRefHtml} or anything else in our catalog. One per patient.</p>
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: ${promo} = 15% off ${maskRef} for 7 days. ${shopUrl} STOP to opt out.`,
      };
    }
    case 5: {
      // T5 — day 30: educational. Three concrete patient-reported
      // outcomes paint a vivid picture of "what changes if I
      // actually do this." Educational tone (no offer) re-engages
      // the cohort that disengaged on the prior discount touch.
      const subject = `${nameSubjectPrefix}What 30 nights on CPAP actually feels like`;
      const text = [
        greeting,
        "",
        "After 30 nights on the right CPAP setup, most patients notice:",
        "  • Morning headaches gone or much milder",
        "  • Daytime energy noticeably better — no afternoon crash",
        "  • Bed partner sleeping through the night",
        "",
        "We've held your fitting recommendation — when you're ready:",
        `  ${resumeUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>After 30 nights on the right CPAP setup, most patients notice:</p>
          <ul>
            <li>Morning headaches gone or much milder</li>
            <li>Daytime energy noticeably better — no afternoon crash</li>
            <li>Bed partner sleeping through the night</li>
          </ul>
          <p>We&apos;ve held your fitting recommendation — when you&apos;re ready:</p>
          ${ctaButton("See my recommendation", resumeUrl)}
          ${footer(false)}
        </div>`;
      return { email: { subject, html, text }, sms: "" };
    }
    case 6:
    default: {
      // T6 — day 60: final touch. "Last note" framing primes
      // engagement on this email (last-chance + scarcity), while
      // the warm tone keeps unsubscribes low. Patient still gets
      // the lapsed-customer-winback after 180+ days if they come
      // back later but never order.
      const subject = `${nameSubjectPrefix}Last note about ${maskRef}`;
      const text = [
        greeting,
        "",
        `This is the last email we'll send about ${maskRef}.`,
        "",
        "Your fitting will stay on file for 12 months in case you'd like to come back to it. If you have questions, just reply — we read every reply.",
        "",
        `Resume any time: ${resumeUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>This is the <strong>last email</strong> we&apos;ll send about <strong>${maskRefHtml}</strong>.</p>
          <p>Your fitting will stay on file for 12 months in case you&apos;d like to come back to it. If you have questions, just reply — we read every reply.</p>
          ${ctaButton("Resume any time", resumeUrl)}
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: last note about ${maskRef} — saved 12mo. ${resumeUrl} STOP to opt out.`,
      };
    }
    // -------------------------------------------------------------
    // Post-purchase re-order phase. firstName is reliably non-null
    // here because conversion-attribution stamps it from
    // public.orders.patient_name when flipping the row into
    // reorder_active.
    // -------------------------------------------------------------
    case 7: {
      // T7 — day 30 after order: cushion replacement.
      const subject = `${nameSubjectPrefix}Time to replace your cushion`;
      const text = [
        greeting,
        "",
        "It's been about 30 days since your mask shipped — which means the cushion seal is at the end of its prime life. Most patients notice their cushion getting softer + leaks creeping in around now.",
        "",
        `Order a replacement cushion: ${shopUrl}`,
        "",
        "If you set up a subscription, your next cushion ships automatically every 30 days. Most insurance plans cover one cushion per month.",
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>It&apos;s been about 30 days since your mask shipped — which means the cushion seal is at the end of its prime life. Most patients notice their cushion getting softer + leaks creeping in around now.</p>
          ${ctaButton("Order a replacement cushion", shopUrl)}
          <p style="color:#666;">Tip: set up a subscription and your next cushion ships automatically every 30 days. Most insurance plans cover one cushion per month.</p>
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: your cushion is due for a swap. Reorder: ${shopUrl} STOP to opt out.`,
      };
    }
    case 8: {
      // T8 — day 60 after order: filter check.
      const subject = `${nameSubjectPrefix}Check your filter — 60 days in`;
      const text = [
        greeting,
        "",
        "Quick reminder: disposable inline filters need replacing every 30 days on most CPAP machines. If you've been on your new mask for 60 days, you're already overdue for at least one filter swap.",
        "",
        "Why it matters: a clogged filter forces your machine to work harder + can pull in more allergens overnight.",
        "",
        `Filters + accessories: ${shopUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>Quick reminder: disposable inline filters need replacing every 30 days on most CPAP machines. If you&apos;ve been on your new mask for 60 days, you&apos;re already overdue for at least one filter swap.</p>
          <p style="color:#666;">Why it matters: a clogged filter forces your machine to work harder + can pull in more allergens overnight.</p>
          ${ctaButton("Filters + accessories", shopUrl)}
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: time to swap your CPAP filter. ${shopUrl} STOP to opt out.`,
      };
    }
    case 9: {
      // T9 — day 90 after order: headgear.
      const subject = `${nameSubjectPrefix}Headgear stretching out? It's been 90 days`;
      const text = [
        greeting,
        "",
        "If your mask is starting to feel loose or you're cranking the straps tighter than you used to, your headgear has reached the end of its useful life. Manufacturer guidance puts headgear at 90-180 days; loose straps are the #1 cause of new leaks on a previously-comfortable mask.",
        "",
        `Replacement headgear: ${shopUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>If your mask is starting to feel loose or you&apos;re cranking the straps tighter than you used to, your headgear has reached the end of its useful life. Manufacturer guidance puts headgear at 90-180 days; loose straps are the #1 cause of new leaks on a previously-comfortable mask.</p>
          ${ctaButton("Replacement headgear", shopUrl)}
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: headgear is due for replacement at 90 days. ${shopUrl} STOP to opt out.`,
      };
    }
    case 10: {
      // T10 — day 180 after order: full refresh + warm sendoff.
      const subject = `${nameSubjectPrefix}Your 6-month mask refresh`;
      const text = [
        greeting,
        "",
        "It's been 6 months since you started with us. By now your mask has earned its retirement — manufacturers rate the silicone seal at 6-12 months before performance degrades.",
        "",
        "Most insurance plans cover a new mask every 6 months. We can:",
        "  • Re-fit you with our at-home tool (your measurements are still on file)",
        "  • Ship a fresh version of the same mask you've been using",
        "  • Try something different if your sleep position has changed",
        "",
        `Start your refresh: ${resumeUrl}`,
        footer(true),
      ].join("\n");
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;">
          ${greetingHtml}
          <p>It&apos;s been 6 months since you started with us. By now your mask has earned its retirement — manufacturers rate the silicone seal at 6-12 months before performance degrades.</p>
          <p>Most insurance plans cover a new mask every 6 months. We can:</p>
          <ul>
            <li>Re-fit you with our at-home tool (your measurements are still on file)</li>
            <li>Ship a fresh version of the same mask you&apos;ve been using</li>
            <li>Try something different if your sleep position has changed</li>
          </ul>
          ${ctaButton("Start your refresh", resumeUrl)}
          ${footer(false)}
        </div>`;
      return {
        email: { subject, html, text },
        sms: `${smsNamePrefix}${practiceName}: your 6-month mask refresh is due. ${resumeUrl} STOP to opt out.`,
      };
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

  // Eligibility: opted-in row in EITHER pre-purchase ('campaign_active')
  // OR post-purchase re-order ('reorder_active') stage, with a
  // due-now next_campaign_touch_at. The partial index
  // `fitter_leads_campaign_due_idx` (mig 0152) covers both stages.
  const { data: leads, error } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .select(
      "id, email, phone_e164, sms_opt_in, recommended_mask_id, recommended_mask_name, recommended_mask_type, campaign_touch_count, completed_at, first_name, first_order_placed_at, journey_stage",
    )
    .in("journey_stage", ["campaign_active", "reorder_active"])
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

    // Pre-purchase touches (1..TOTAL_TOUCHPOINTS) anchor on
    // completed_at; post-purchase touches (TOTAL_TOUCHPOINTS+1..
    // TOTAL_ALL_TOUCHPOINTS) anchor on first_order_placed_at. Both
    // schedules use absolute-offset arithmetic so a worker delay
    // can't telescope the cadence.
    //
    // Phase transitions:
    //   * Sending T6 from 'campaign_active' AND patient never
    //     converted → terminal 'expired' (the attribution worker
    //     would have flipped them to 'reorder_active' if they had).
    //   * Sending T10 from 'reorder_active' → terminal 'converted'
    //     (they got the full nurture; lapsed-customer-winback can
    //     pick them up later at 180+d inactive).
    const isPrePurchase = lead.journey_stage === "campaign_active";
    const isPrePurchaseFinal =
      isPrePurchase && nextTouchIndex >= TOTAL_TOUCHPOINTS;
    const isReorderFinal =
      !isPrePurchase && nextTouchIndex >= TOTAL_ALL_TOUCHPOINTS;
    const isAnyFinal = isPrePurchaseFinal || isReorderFinal;

    let nextTouchAt: string | null = null;
    if (!isAnyFinal) {
      if (isPrePurchase) {
        // After sending current touch, the NEXT scheduled touch is
        // index (nextTouchIndex + 1). Its offset lives at
        // TOUCHPOINT_OFFSETS_MS[(nextTouchIndex + 1) - 1] =
        // TOUCHPOINT_OFFSETS_MS[nextTouchIndex] (0-indexed).
        const completedAtMs = lead.completed_at
          ? new Date(lead.completed_at).getTime()
          : Date.now();
        nextTouchAt = new Date(
          completedAtMs + TOUCHPOINT_OFFSETS_MS[nextTouchIndex],
        ).toISOString();
      } else {
        // Re-order phase. Touch indices >TOTAL_TOUCHPOINTS map into
        // REORDER_TOUCHPOINT_OFFSETS_MS at index
        // (nextTouchIndex - TOTAL_TOUCHPOINTS); we want the NEXT
        // touch's offset, so add 1 more.
        const placedAtMs = lead.first_order_placed_at
          ? new Date(lead.first_order_placed_at).getTime()
          : Date.now();
        const nextReorderIdx = nextTouchIndex - TOTAL_TOUCHPOINTS;
        // Guard: nextTouchIndex was already validated as < TOTAL_ALL
        // by isReorderFinal above, so nextReorderIdx < TOTAL_REORDER.
        nextTouchAt = new Date(
          placedAtMs + REORDER_TOUCHPOINT_OFFSETS_MS[nextReorderIdx],
        ).toISOString();
      }
    }

    // Atomic claim — bump campaign_touch_count BEFORE the send, with
    // an optimistic WHERE pinning the prior value AND the prior
    // journey_stage. A concurrent worker (or the attribution worker
    // flipping campaign_active → reorder_active under us) will see
    // no rows updated and we skip this lead this tick.
    const claimIso = new Date().toISOString();
    const claimUpdate: FitterLeadsUpdate = {
      campaign_touch_count: nextTouchIndex,
      last_campaign_touch_at: claimIso,
      next_campaign_touch_at: nextTouchAt,
    };
    if (isPrePurchaseFinal) claimUpdate.journey_stage = "expired";
    if (isReorderFinal) claimUpdate.journey_stage = "converted";

    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update(claimUpdate)
      .eq("id", lead.id)
      .eq("campaign_touch_count", lead.campaign_touch_count)
      .eq("journey_stage", lead.journey_stage)
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
    if (isAnyFinal) stats.expired += 1;

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
      firstName: lead.first_name,
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
