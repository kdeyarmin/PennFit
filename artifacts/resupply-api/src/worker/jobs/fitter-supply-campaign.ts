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
  FINAL_CALL_OFFSET_MS,
  signUnsubscribeToken,
  signOpenTrackingToken,
  signClickTrackingToken,
  pickSubjectVariant,
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
  /** Mig 0156 — leads where the dispatcher short-circuited T5+T6
   *  because the lead showed zero engagement through T4. */
  coldSkipped: number;
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
  journey_stage: "campaign_active" | "reorder_active" | "final_call_pending";
  // Mig 0153/0154 — engagement signals used by the cold-skip
  // transition. Pre-T5 we check if zero engagement has accrued
  // across T1-T4; if so, short-circuit T5 + T6 to T11.
  engagement_score: number;
  click_count: number;
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

// ---------------------------------------------------------------
// Email rendering helpers — preheader + branded template.
// ---------------------------------------------------------------
//
// Why a branded template
// ----------------------
// The original touch HTML was plain system-ui paragraphs. That's
// fine for transactional email but reads as "marketing afterthought"
// next to the polished templates patients see from competitors. A
// branded table-based layout (a header band in penn-navy, a single
// content cell, an accent border) lifts perceived legitimacy AND
// click-through; the bar is "looks like every other professional
// transactional email the patient receives."
//
// Table-based layout because:
//   * Gmail/iOS Mail/Outlook ignore most modern CSS — flexbox,
//     grid, custom properties. <table> + inline styles are the only
//     reliably-rendered structure across the top 5 email clients.
//   * Width clamps via `max-width` work in modern clients but Outlook
//     stubbornly ignores them; we use a fixed 560px wrapping table
//     and a 100%-width outer table so Outlook centers it cleanly.
//
// Preheader text
// --------------
// The preheader is the gray subtitle that appears next to the
// subject line in mobile inbox previews. When unset, clients use
// the first visible body content — usually our greeting, which
// wastes the most valuable real estate in the inbox. Setting an
// explicit preheader (a hidden <div> at the top of the body)
// reliably lifts open rates 5-15% across DME marketing benchmarks
// because it gives the patient a SECOND hook beyond the subject
// line.

const BRAND_NAVY = "#1F3A5C";
const BRAND_GOLD = "#F4B942";
const BG = "#f4f6f8";
const CARD_BG = "#ffffff";
const TEXT = "#1f2a37";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";

/** Render a single CTA button as a table (Outlook-safe). */
function renderCtaButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;">
    <tr><td style="border-radius:6px;background:${BRAND_NAVY};">
      <a href="${href}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;color:#fff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** Render the full responsive email shell around the per-touch
 *  body content. The body content carries paragraphs + CTAs +
 *  any lists; the shell adds the brand band, preheader, frame,
 *  footer, and (optionally) the 1x1 open-tracking pixel. */
function renderBrandedHtml(opts: {
  practiceName: string;
  preheader: string;
  bodyHtml: string;
  unsubscribeUrl: string;
  /** URL of the 1x1 open-tracking GIF (signed per-touch token).
   *  Embedded at the very end of the body so it doesn't render
   *  visibly. Omitted in tests / dev when the link HMAC key isn't
   *  configured. */
  trackingPixelUrl?: string | null;
}): string {
  const { practiceName, preheader, bodyHtml, unsubscribeUrl, trackingPixelUrl } =
    opts;
  // Inbox-preview hidden text. Trailing zero-width-non-joiners
  // pushed in to keep Gmail from grabbing email-source text after
  // the preheader and showing it as part of the preview snippet.
  // The exact tail length is tuned to keep total preview-content
  // under 100 chars for most clients.
  const previewPad = "&zwnj;&nbsp;".repeat(30);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(practiceName)}</title>
</head><body style="margin:0;padding:0;background:${BG};font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:${TEXT};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BG};opacity:0;">${escapeHtml(preheader)}${previewPad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:${CARD_BG};border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
      <tr><td style="background:${BRAND_NAVY};padding:16px 24px;">
        <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#fff;font-weight:600;">${escapeHtml(practiceName)}</div>
        <div style="height:3px;width:48px;background:${BRAND_GOLD};margin-top:8px;border-radius:2px;"></div>
      </td></tr>
      <tr><td style="padding:28px 28px 8px 28px;font-size:15px;line-height:1.55;color:${TEXT};">
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:0 28px 28px 28px;">
        <hr style="border:none;border-top:1px solid ${BORDER};margin:12px 0;"/>
        <p style="color:${MUTED};font-size:12px;line-height:1.5;margin:0;">
          ${escapeHtml(practiceName)} · <a href="${unsubscribeUrl}" style="color:${MUTED};text-decoration:underline;">Unsubscribe from these emails</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
${trackingPixelUrl ? `<img src="${trackingPixelUrl}" alt="" width="1" height="1" border="0" style="display:block;width:1px;height:1px;border:0;" />` : ""}
</body></html>`;
}

// ---------------------------------------------------------------
// Mask-type vocabulary.
// ---------------------------------------------------------------
//
// The re-order touchpoints (T7-T10) speak about specific mask parts.
// A patient on a nasal-pillow mask doesn't have "cushions" the way
// a full-face patient does — they have pillow inserts. Saying the
// wrong word costs credibility and lifts unsubscribe rates because
// patients perceive the email as bot-generated.
//
// `recommended_mask_type` is one of fullFace | nasal | nasalPillow |
// hybrid (the MaskType enum from data/maskCatalog.ts). Null falls
// back to neutral, slightly less-personalized language.

interface MaskPartVocab {
  /** Singular replacement noun used in T7 ("your X is due"). */
  cushionTerm: string;
  /** Mask-type-specific wear note used in T7 body. */
  cushionNote: string;
  /** Singular replacement noun for T9. Some masks call this
   *  "straps", others "headgear", others "headgear + chinstrap". */
  headgearTerm: string;
  /** Mask-type-specific cross-sell hint for T8 (filter touch). */
  filterCrossSell: string;
}

function maskPartVocabulary(maskType: string | null): MaskPartVocab {
  switch (maskType) {
    case "nasalPillow":
      return {
        cushionTerm: "pillow inserts",
        cushionNote:
          "Pillow inserts wear faster than larger cushions — most nasal-pillow users swap every 14-28 days. After 30, the silicone seal loses its springback and starts whistling.",
        headgearTerm: "headgear straps",
        filterCrossSell:
          "While you're here: pair your filter order with fresh pillow inserts so you're set for the next 30 days.",
      };
    case "fullFace":
      return {
        cushionTerm: "full-face cushion (and forehead pad)",
        cushionNote:
          "Full-face seals carry more pressure than smaller masks, so the cushion + forehead pad soften noticeably faster. By day 30 most patients are getting subtle leaks around the bridge of the nose.",
        headgearTerm: "headgear (and chinstrap loops if you use them)",
        filterCrossSell:
          "While you're here: full-face users often pair filter orders with a fresh cushion since both wear on the same 30-day cycle.",
      };
    case "hybrid":
      return {
        cushionTerm: "hybrid cushion",
        cushionNote:
          "The dual nasal-and-oral seal on a hybrid cushion carries more wear than a single-port mask — manufacturers rate hybrid cushions at 30 days even though the silicone looks fine to the eye.",
        headgearTerm: "headgear straps",
        filterCrossSell:
          "While you're here: hybrid users often add a backup cushion to the same order — replacement timing is the same 30-day window.",
      };
    case "nasal":
      return {
        cushionTerm: "nasal cushion",
        cushionNote:
          "Most nasal-cushion users notice the seal getting softer + faint leak whistles around day 25-30. Replacement timing tracks manufacturer guidance of 30 days.",
        headgearTerm: "headgear",
        filterCrossSell:
          "While you're here: pair your filter order with a fresh nasal cushion — both wear on the same monthly cycle.",
      };
    default:
      return {
        cushionTerm: "cushion",
        cushionNote:
          "Most patients notice their cushion getting softer + faint leak whistles around day 25-30. Manufacturer guidance is replacement every 30 days.",
        headgearTerm: "headgear",
        filterCrossSell:
          "While you're here: pair your filter order with a fresh cushion — both wear on the same monthly cycle.",
      };
  }
}

/** Subscription auto-ship upsell snippet rendered into T7-T9
 *  footers. Single CTA + one-sentence value prop; T10 (the warm
 *  sendoff) deliberately omits this to keep the tone non-salesy.
 *
 *  `shopUrl` is the bare subscription URL used in the plain-text
 *  body; `wrappedSubscribeUrl` (when provided) is the click-
 *  tracked redirect URL used in the HTML CTA. Plain text keeps
 *  the bare URL so spam filters don't down-weight obvious
 *  redirect domains. */
function renderSubscriptionUpsell(
  shopUrl: string,
  wrappedSubscribeUrl: string,
): { html: string; text: string } {
  const subscribeUrl = `${shopUrl}/subscribe`;
  return {
    html: `<div style="margin-top:18px;padding:14px 16px;background:#fef6e0;border-left:3px solid ${BRAND_GOLD};border-radius:4px;font-size:14px;line-height:1.5;">
      <strong>Never run out:</strong> set up auto-ship and save 10% on every order. Skip or cancel any month — no commitment.
      <div style="margin-top:8px;"><a href="${wrappedSubscribeUrl}" style="color:${BRAND_NAVY};font-weight:600;text-decoration:underline;">Set up auto-ship</a></div>
    </div>`,
    text: `\n\nNever run out: set up auto-ship and save 10% on every order. Skip or cancel any month — no commitment.\n${subscribeUrl}`,
  };
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
  /** Per-touch open-tracking pixel URL, signed by the dispatcher.
   *  Optional so the pure function stays testable without the link
   *  HMAC key configured. When null, no pixel is embedded. */
  trackingPixelUrl?: string | null;
  /** Per-CTA click-tracking wrapper. Given a link_key (one of
   *  CTA_DESTINATIONS in fitter-complete.ts), returns the signed
   *  redirect URL that records the click before 302-ing to the
   *  destination. When null, HTML CTAs use the bare URL (testing
   *  + dev mode where the link HMAC key isn't configured). Plain-
   *  text CTAs ALWAYS use the bare URL — tracking-redirect domains
   *  in plain text read as spammy and trip filters. */
  wrapCta?: ((linkKey: string) => string) | null;
  /** Mig 0157 — subject-line A/B variant for this lead+touch.
   *  Defaults to 'A' when unset; touches that don't have a
   *  variant configured for this key fall back to the default
   *  copy. Tests pin a specific variant for deterministic
   *  output. */
  subjectVariantKey?: string;
}): TouchpointCopy {
  const {
    touchIndex,
    practiceName,
    resumeUrl,
    shopUrl,
    recommendedMaskName,
    recommendedMaskType,
    unsubscribeUrl,
    firstName,
    trackingPixelUrl,
    wrapCta,
    subjectVariantKey = "A",
  } = opts;

  /** HTML CTA URL — wrapped through the click-tracking redirect
   *  when wrapCta is configured, bare otherwise. The `fallback`
   *  is the plain URL we'd 302 to and is what plain-text bodies
   *  reference directly. */
  const ctaHref = (linkKey: string, fallback: string): string =>
    wrapCta ? wrapCta(linkKey) : fallback;
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
  const greetingHtml = safeName
    ? `<p style="margin:0 0 14px 0;">Hi <strong>${escapeHtml(safeName)}</strong>,</p>`
    : `<p style="margin:0 0 14px 0;">Hi from <strong>${escapeHtml(practiceName)}</strong>,</p>`;
  const greetingText = safeName ? `Hi ${safeName},` : `Hi from ${practiceName},`;
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

  // Mask-type vocabulary for the re-order phase. Pre-purchase touches
  // ignore this (they speak about the mask as a whole, not its parts).
  const vocab = maskPartVocabulary(recommendedMaskType);

  // Internal builder so every case returns the same shape and the
  // branded shell is applied uniformly. Avoids per-case copy-paste
  // of the renderBrandedHtml call.
  const buildEmail = (
    subject: string,
    preheader: string,
    bodyHtml: string,
    bodyText: string,
  ): { subject: string; html: string; text: string } => ({
    subject,
    html: renderBrandedHtml({
      practiceName,
      preheader,
      bodyHtml: `${greetingHtml}${bodyHtml}`,
      unsubscribeUrl,
      trackingPixelUrl,
    }),
    text: `${greetingText}\n\n${bodyText}\n\n— ${practiceName}\nUnsubscribe: ${unsubscribeUrl}`,
  });

  switch (touchIndex) {
    case 1: {
      // T1 — day 1: warm recap. Mig 0157 ships two A/B subject
      // variants:
      //   * A (default) — loss-aversion: "is on hold for you"
      //     implies the recommendation might evaporate.
      //   * B — promise-based: "is ready when you are" leads with
      //     warmth + patient agency.
      // Both subjects keep the mask model up front so the patient
      // recognizes the email at a glance. Body copy + preheader
      // stay constant across variants — we're isolating the
      // subject as the test variable.
      const subject =
        subjectVariantKey === "B"
          ? `${nameSubjectPrefix}${maskRef} is ready when you are`
          : `${nameSubjectPrefix}${maskRef} is on hold for you`;
      const preheader = `Your measurements are saved — finish your fitting in 2 minutes.`;
      const bodyText = [
        `Yesterday you ran our at-home fitting and we matched you to ${maskRef}.`,
        "Your measurements are saved — no need to redo them.",
        "",
        `Pick up where you left off: ${resumeUrl}`,
        "",
        "Most patients we work with notice deeper sleep in the first week.",
        "Reply to this email if you have a question — a real human reads it.",
      ].join("\n");
      const bodyHtml = `
        <p>Yesterday you ran our at-home fitting and we matched you to <strong>${maskRefHtml}</strong>. Your measurements are saved — no need to redo them.</p>
        ${renderCtaButton("Pick up where you left off", ctaHref("results", resumeUrl))}
        <p style="color:${MUTED};font-size:14px;">Most patients we work with notice deeper sleep in the first week. Reply to this email if you have a question — a real human reads it.</p>`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: ${maskRef} is on hold. Continue: ${resumeUrl} . Reply STOP to opt out.`,
      };
    }
    case 2: {
      // T2 — day 3: social proof, with a concrete number. "9 in 10"
      // is the strongest comprehensible fraction at glance speed.
      const subject = `${nameSubjectPrefix}9 in 10 patients with your fit choose this`;
      const preheader = `Plus our 30-night comfort guarantee — if it doesn't fit, we swap it free.`;
      const bodyText = [
        `${maskRef} is the most-chosen mask for patients whose measurements line up with yours.`,
        "Patients tell us, every week:",
        "  • Quieter than they expected",
        "  • Comfortable for side and stomach sleepers",
        "  • Easy to clean in under a minute",
        "",
        "Pair it with our 30-night comfort guarantee — if it doesn't feel right, we swap it for free.",
        "",
        `Take another look: ${resumeUrl}`,
      ].join("\n");
      const bodyHtml = `
        <p><strong>${maskRefHtml}</strong> is the most-chosen mask for patients whose measurements line up with yours.</p>
        <p>Patients tell us, every week:</p>
        <ul style="margin:8px 0;padding-left:22px;">
          <li>Quieter than they expected</li>
          <li>Comfortable for side and stomach sleepers</li>
          <li>Easy to clean in under a minute</li>
        </ul>
        <p>Pair it with our <strong>30-night comfort guarantee</strong> — if it doesn&apos;t feel right, we swap it for free.</p>
        ${renderCtaButton("Take another look", ctaHref("results", resumeUrl))}`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: ${maskRef} — 30-night swap-for-free guarantee. ${resumeUrl} STOP to opt out.`,
      };
    }
    case 3: {
      // T3 — day 7: FSA/HSA reminder with a concrete expiry date.
      const subject = `${nameSubjectPrefix}Use your FSA/HSA before ${fsaDeadlineLabel}`;
      const preheader = `CPAP supplies are eligible — and we accept your FSA/HSA card at checkout.`;
      const bodyText = [
        `Your FSA / HSA dollars expire ${fsaDeadlineLabel}. Most patients lose money sitting in their account every year because they forget.`,
        "",
        "CPAP masks and supplies are FSA- and HSA-eligible. We accept your card directly at checkout — no receipts, no reimbursement paperwork.",
        "",
        `Browse compatible supplies: ${shopUrl}`,
      ].join("\n");
      const bodyHtml = `
        <p>Your FSA / HSA dollars expire <strong>${escapeHtml(fsaDeadlineLabel)}</strong>. Most patients lose money sitting in their account every year because they forget.</p>
        <p>CPAP masks and supplies are FSA- and HSA-eligible. We accept your card directly at checkout — no receipts, no reimbursement paperwork.</p>
        ${renderCtaButton("Browse compatible supplies", ctaHref("shop", shopUrl))}`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: "",
      };
    }
    case 4: {
      // T4 — day 14: one-time discount with explicit 7-day deadline.
      // Mig 0157 ships two A/B subject variants:
      //   * A (default) — promo-code-first: leads with WELCOME15
      //     as the curiosity hook ("what's WELCOME15?").
      //   * B — urgency-first: leads with "15% off ends in 7 days"
      //     to engage on scarcity/deadline framing.
      // Body copy stays constant; only the subject varies.
      const promo = process.env.FITTER_SUPPLY_CAMPAIGN_PROMO ?? "WELCOME15";
      const subject =
        subjectVariantKey === "B"
          ? `${nameSubjectPrefix}15% off ${maskRef} — ends in 7 days`
          : `${nameSubjectPrefix}${promo}: 15% off ${maskRef} — ends in 7 days`;
      const preheader = `One-time offer. Use code ${promo} at checkout — expires automatically.`;
      const bodyText = [
        `One-time offer: code ${promo} takes 15% off your first order, mask or supplies.`,
        "Valid 7 days from this email — your code expires automatically.",
        "",
        `Use it here: ${shopUrl}`,
        "",
        `Works on ${maskRef} or anything else in our catalog. One per patient.`,
      ].join("\n");
      const bodyHtml = `
        <p style="font-size:22px;line-height:1.3;margin:0 0 12px 0;"><strong style="color:${BRAND_NAVY};">15% off your first order</strong></p>
        <p>One-time offer — code <code style="background:#fef3c7;padding:4px 10px;border-radius:4px;font-size:16px;font-weight:600;letter-spacing:0.5px;">${escapeHtml(promo)}</code> takes 15% off your first order, mask or supplies. <strong>Valid 7 days from this email.</strong></p>
        ${renderCtaButton(`Shop ${maskRef}`, ctaHref("promo", shopUrl))}
        <p style="color:${MUTED};font-size:13px;">Works on ${maskRefHtml} or anything else in our catalog. One per patient.</p>`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: ${promo} = 15% off ${maskRef} for 7 days. ${shopUrl} STOP to opt out.`,
      };
    }
    case 5: {
      // T5 — day 30: educational. No offer — concrete patient-reported
      // outcomes re-engage the cohort that disengaged on T4.
      const subject = `${nameSubjectPrefix}What 30 nights on CPAP actually feels like`;
      const preheader = `Morning headaches, daytime energy, your bed partner — what changes first.`;
      const bodyText = [
        "After 30 nights on the right CPAP setup, most patients notice:",
        "  • Morning headaches gone or much milder",
        "  • Daytime energy noticeably better — no afternoon crash",
        "  • Bed partner sleeping through the night",
        "",
        "We've held your fitting recommendation — when you're ready:",
        `  ${resumeUrl}`,
      ].join("\n");
      const bodyHtml = `
        <p>After 30 nights on the right CPAP setup, most patients notice:</p>
        <ul style="margin:8px 0;padding-left:22px;">
          <li>Morning headaches gone or much milder</li>
          <li>Daytime energy noticeably better — no afternoon crash</li>
          <li>Bed partner sleeping through the night</li>
        </ul>
        <p>We&apos;ve held your fitting recommendation — when you&apos;re ready:</p>
        ${renderCtaButton("See my recommendation", ctaHref("results", resumeUrl))}`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: "",
      };
    }
    case 6:
    default: {
      // T6 — day 60: final touch. "Last note" framing.
      const subject = `${nameSubjectPrefix}Last note about ${maskRef}`;
      const preheader = `We're holding your fitting for 12 months — come back any time.`;
      const bodyText = [
        `This is the last email we'll send about ${maskRef}.`,
        "",
        "Your fitting will stay on file for 12 months in case you'd like to come back to it. If you have questions, just reply — we read every reply.",
        "",
        `Resume any time: ${resumeUrl}`,
      ].join("\n");
      const bodyHtml = `
        <p>This is the <strong>last email</strong> we&apos;ll send about <strong>${maskRefHtml}</strong>.</p>
        <p>Your fitting will stay on file for 12 months in case you&apos;d like to come back to it. If you have questions, just reply — we read every reply.</p>
        ${renderCtaButton("Resume any time", ctaHref("results", resumeUrl))}`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: last note about ${maskRef} — saved 12mo. ${resumeUrl} STOP to opt out.`,
      };
    }
    // -------------------------------------------------------------
    // Post-purchase re-order phase. Mask-type-specific vocabulary
    // pulled from maskPartVocabulary() above; subscription upsell
    // appears in T7-T9 footers but not in T10 (warm sendoff).
    // -------------------------------------------------------------
    case 7: {
      // T7 — day 30 after order: cushion / pillow-insert replacement.
      const subject = `${nameSubjectPrefix}Time to replace your ${vocab.cushionTerm}`;
      const preheader = `30 days in — your seal is at the end of its prime life.`;
      const sub = renderSubscriptionUpsell(shopUrl, ctaHref("subscribe", `${shopUrl}/subscribe`));
      const bodyText = [
        `It's been about 30 days since your mask shipped. ${vocab.cushionNote}`,
        "",
        `Order a replacement ${vocab.cushionTerm}: ${shopUrl}`,
        sub.text,
      ].join("\n");
      const bodyHtml = `
        <p>It&apos;s been about 30 days since your mask shipped. ${escapeHtml(vocab.cushionNote)}</p>
        ${renderCtaButton(`Order replacement ${vocab.cushionTerm}`, ctaHref("shop", shopUrl))}
        ${sub.html}`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: your ${vocab.cushionTerm} are due for a swap. Reorder: ${shopUrl} STOP to opt out.`,
      };
    }
    case 8: {
      // T8 — day 60 after order: filter check + mask-type cross-sell.
      const subject = `${nameSubjectPrefix}Check your filter — 60 days in`;
      const preheader = `Disposable filters expire every 30 days. You're overdue.`;
      const sub = renderSubscriptionUpsell(shopUrl, ctaHref("subscribe", `${shopUrl}/subscribe`));
      const bodyText = [
        "Quick reminder: disposable inline filters need replacing every 30 days on most CPAP machines. If you've been on your new mask for 60 days, you're already overdue for at least one filter swap.",
        "",
        "Why it matters: a clogged filter forces your machine to work harder + can pull in more allergens overnight.",
        "",
        vocab.filterCrossSell,
        "",
        `Filters + accessories: ${shopUrl}`,
        sub.text,
      ].join("\n");
      const bodyHtml = `
        <p>Quick reminder: disposable inline filters need replacing every 30 days on most CPAP machines. If you&apos;ve been on your new mask for 60 days, you&apos;re already overdue for at least one filter swap.</p>
        <p style="color:${MUTED};font-size:14px;">Why it matters: a clogged filter forces your machine to work harder + can pull in more allergens overnight.</p>
        <p><em>${escapeHtml(vocab.filterCrossSell)}</em></p>
        ${renderCtaButton("Filters + accessories", ctaHref("shop", shopUrl))}
        ${sub.html}`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: time to swap your CPAP filter. ${shopUrl} STOP to opt out.`,
      };
    }
    case 9: {
      // T9 — day 90 after order: mask-type-aware headgear language.
      const subject = `${nameSubjectPrefix}Your ${vocab.headgearTerm} at 90 days`;
      const preheader = `Loose straps are the #1 cause of new leaks on a comfortable mask.`;
      const sub = renderSubscriptionUpsell(shopUrl, ctaHref("subscribe", `${shopUrl}/subscribe`));
      const bodyText = [
        `If your mask is starting to feel loose or you're cranking the straps tighter than you used to, your ${vocab.headgearTerm} have reached the end of their useful life. Manufacturer guidance puts headgear at 90-180 days; loose straps are the #1 cause of new leaks on a previously-comfortable mask.`,
        "",
        `Replacement ${vocab.headgearTerm}: ${shopUrl}`,
        sub.text,
      ].join("\n");
      const bodyHtml = `
        <p>If your mask is starting to feel loose or you&apos;re cranking the straps tighter than you used to, your ${escapeHtml(vocab.headgearTerm)} have reached the end of their useful life. Manufacturer guidance puts headgear at 90-180 days; loose straps are the #1 cause of new leaks on a previously-comfortable mask.</p>
        ${renderCtaButton(`Replacement ${vocab.headgearTerm}`, ctaHref("shop", shopUrl))}
        ${sub.html}`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: ${vocab.headgearTerm} due at 90 days. ${shopUrl} STOP to opt out.`,
      };
    }
    case 10: {
      // T10 — day 180 after order: full refresh, warm sendoff +
      // refer-a-friend ask. The 6-month mark is the warmest moment
      // in the journey: the patient has been sleeping well for half
      // a year, the campaign hasn't bothered them excessively, and
      // they're now eligible for an insurance-covered refresh.
      // Asking for a referral here lands far better than anywhere
      // else in the funnel.
      const subject = `${nameSubjectPrefix}Your 6-month mask refresh`;
      const preheader = `Most insurance covers a new mask every 6 months. Plus a referral perk.`;
      const referUrl = `${shopUrl}/refer`;
      const wrappedReferUrl = ctaHref("refer", referUrl);
      const bodyText = [
        "It's been 6 months since you started with us. By now your mask has earned its retirement — manufacturers rate the silicone seal at 6-12 months before performance degrades.",
        "",
        "Most insurance plans cover a new mask every 6 months. We can:",
        "  • Re-fit you with our at-home tool (your measurements are still on file)",
        "  • Ship a fresh version of the same mask you've been using",
        "  • Try something different if your sleep position has changed",
        "",
        `Start your refresh: ${resumeUrl}`,
        "",
        "Know someone who snores? Share us — you both get $25 off:",
        `  ${referUrl}`,
      ].join("\n");
      const bodyHtml = `
        <p>It&apos;s been 6 months since you started with us. By now your mask has earned its retirement — manufacturers rate the silicone seal at 6-12 months before performance degrades.</p>
        <p>Most insurance plans cover a new mask every 6 months. We can:</p>
        <ul style="margin:8px 0;padding-left:22px;">
          <li>Re-fit you with our at-home tool (your measurements are still on file)</li>
          <li>Ship a fresh version of the same mask you&apos;ve been using</li>
          <li>Try something different if your sleep position has changed</li>
        </ul>
        ${renderCtaButton("Start your refresh", ctaHref("results", resumeUrl))}
        <div style="margin-top:22px;padding:14px 16px;background:#eef2f7;border-left:3px solid ${BRAND_NAVY};border-radius:4px;font-size:14px;line-height:1.5;">
          <strong>Know someone who snores?</strong> Share us — you both get $25 off your next order.
          <div style="margin-top:8px;"><a href="${wrappedReferUrl}" style="color:${BRAND_NAVY};font-weight:600;text-decoration:underline;">Share with a friend</a></div>
        </div>`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: `${smsNamePrefix}${practiceName}: your 6-month mask refresh is due. ${resumeUrl} STOP to opt out.`,
      };
    }
    case 11: {
      // T11 — final-call. 90 days after the pre-purchase campaign
      // expired without a conversion. ONE more email with a
      // stronger, time-limited offer + clear "we're closing your
      // fitting" framing. After this, the lead is truly terminal
      // and only the lapsed-customer-winback worker (180d+) can
      // reach them. SMS deliberately omitted — at 150 days post-
      // fitting most patients have forgotten they ever ran the
      // tool; an SMS reads as cold-spam where the email reads as
      // a courtesy.
      const promo = process.env.FITTER_FINAL_CALL_PROMO ?? "LAST20";
      const subject = `${nameSubjectPrefix}We're closing your ${recommendedMaskName ?? "fitting"} — last chance, 20% off`;
      const preheader = `Code ${promo} for 20% off. After this we won't email again about your fitting.`;
      const bodyText = [
        `It's been a few months since you ran our at-home fitting and matched to ${maskRef}. We're cleaning up our records this week.`,
        "",
        `Before we close your fitting, here's a final offer: code ${promo} takes 20% off your first order — masks, supplies, anything in the catalog. Valid 14 days.`,
        "",
        `Use it here: ${shopUrl}`,
        "",
        "After this email we won't reach out about this fitting again. Your measurements stay on file for 12 months in case you change your mind, but we'll stop showing up in your inbox.",
        "",
        "Reply to this email if you have a question — we read every reply.",
      ].join("\n");
      const bodyHtml = `
        <p>It&apos;s been a few months since you ran our at-home fitting and matched to <strong>${maskRefHtml}</strong>. We&apos;re cleaning up our records this week.</p>
        <p style="font-size:20px;line-height:1.3;margin:18px 0 12px 0;"><strong style="color:${BRAND_NAVY};">20% off your first order</strong></p>
        <p>Before we close your fitting, here&apos;s a final offer: code <code style="background:#fef3c7;padding:4px 10px;border-radius:4px;font-size:16px;font-weight:600;letter-spacing:0.5px;">${escapeHtml(promo)}</code> takes 20% off your first order — masks, supplies, anything in the catalog. <strong>Valid 14 days.</strong></p>
        ${renderCtaButton(`Shop with ${promo}`, ctaHref("promo", shopUrl))}
        <p style="color:${MUTED};font-size:14px;">After this email we won&apos;t reach out about this fitting again. Your measurements stay on file for 12 months in case you change your mind, but we&apos;ll stop showing up in your inbox.</p>
        <p style="color:${MUTED};font-size:14px;">Reply to this email if you have a question — we read every reply.</p>`;
      return {
        email: buildEmail(subject, preheader, bodyHtml, bodyText),
        sms: "",
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
    coldSkipped: 0,
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

  // Eligibility: opted-in row in pre-purchase ('campaign_active'),
  // re-order ('reorder_active'), OR cold-lead final-call
  // ('final_call_pending', mig 0153) stage, with a due-now
  // next_campaign_touch_at. The partial index
  // `fitter_leads_campaign_due_idx` (mig 0153) covers all three.
  const { data: leads, error } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .select(
      "id, email, phone_e164, sms_opt_in, recommended_mask_id, recommended_mask_name, recommended_mask_type, campaign_touch_count, completed_at, first_name, first_order_placed_at, journey_stage, engagement_score, click_count",
    )
    .in("journey_stage", [
      "campaign_active",
      "reorder_active",
      "final_call_pending",
    ])
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

    // Cold-lead suppression (mig 0156).
    // ---------------------------------
    // About to send T5 from 'campaign_active' AND the lead has
    // shown ZERO engagement signal through T4 → short-circuit the
    // remaining pre-purchase touches and jump straight to the T11
    // final-call holding stage. The patient still gets a strong-
    // incentive reactivation email 90 days from now; we just
    // stop pushing the soft-touch educational + sendoff emails
    // (T5 + T6) that are statistically unlikely to convert this
    // cohort.
    //
    // The 0-engagement threshold is intentionally strict: a SINGLE
    // open or click signals enough warmth to keep going. Apple
    // Mail Privacy pre-fetch noise + cached image loads mean even
    // marginally-interested patients will accumulate at least one
    // open across 4 touches.
    //
    // We do this BEFORE the regular phase-routing block so the
    // skip transition is atomic + visible from the admin queue.
    if (
      lead.journey_stage === "campaign_active" &&
      nextTouchIndex === 5 &&
      (lead.engagement_score ?? 0) === 0 &&
      (lead.click_count ?? 0) === 0
    ) {
      const t11DueAt = new Date(
        Date.now() + FINAL_CALL_OFFSET_MS,
      ).toISOString();
      const skipIso = new Date().toISOString();
      const { data: skipClaimed, error: skipErr } = await supabase
        .schema("resupply")
        .from("fitter_leads")
        .update({
          // Pin campaign_touch_count to the would-be T6 value so
          // the T11 dispatcher branch ('final_call_pending')
          // computes nextTouchIndex=11 correctly. (T11 is
          // FINAL_CALL_TOUCH_INDEX = TOTAL_ALL_TOUCHPOINTS + 1.)
          campaign_touch_count: TOTAL_TOUCHPOINTS,
          last_campaign_touch_at: skipIso,
          next_campaign_touch_at: t11DueAt,
          journey_stage: "final_call_pending",
          cold_skipped_at: skipIso,
        })
        .eq("id", lead.id)
        .eq("campaign_touch_count", lead.campaign_touch_count)
        .eq("journey_stage", "campaign_active")
        .select("id");
      if (skipErr) {
        stats.errors += 1;
        logger.warn(
          { err: skipErr.message, leadId: lead.id },
          "fitter-lead.supply-campaign: cold-skip claim failed",
        );
        continue;
      }
      if (!skipClaimed || skipClaimed.length === 0) {
        // Lost race — another worker / attribution flipped the
        // row under us. Skip this tick.
        stats.skippedClaimLost += 1;
        continue;
      }
      stats.coldSkipped += 1;
      logger.info(
        {
          event: "fitter_lead.cold_skipped",
          leadId: lead.id,
          touchSkippedFrom: 5,
          touchSkippedTo: 11,
        },
        "fitter-lead.supply-campaign: cold-skipped T5+T6 → T11",
      );
      continue;
    }

    // Phase routing:
    //   * 'campaign_active' (T1-T6) — touches anchor on completed_at.
    //     Sending T6 transitions to 'final_call_pending' with the
    //     T11 due-time scheduled +90d. (Was 'expired' before mig
    //     0153; now we give the patient one final reactivation
    //     chance before truly closing the loop.)
    //   * 'reorder_active' (T7-T10) — touches anchor on
    //     first_order_placed_at. Sending T10 transitions to terminal
    //     'converted'.
    //   * 'final_call_pending' (T11 only) — single touch at the
    //     90-day mark. Sending T11 transitions to terminal 'expired'.
    const stage = lead.journey_stage;
    const isPrePurchaseFinal =
      stage === "campaign_active" && nextTouchIndex >= TOTAL_TOUCHPOINTS;
    const isReorderFinal =
      stage === "reorder_active" && nextTouchIndex >= TOTAL_ALL_TOUCHPOINTS;
    const isFinalCallTouch = stage === "final_call_pending";

    // Compute next_campaign_touch_at and the post-send journey_stage
    // together — they're tightly coupled and clearer paired.
    let nextTouchAt: string | null = null;
    let postSendStage: LeadRow["journey_stage"] | "expired" | "converted" | null =
      null;

    if (isFinalCallTouch) {
      // T11 is the only touch in this stage. Final.
      postSendStage = "expired";
    } else if (isPrePurchaseFinal) {
      // T6 just sent. Schedule T11 90d out + flip into the final-
      // call holding stage.
      postSendStage = "final_call_pending";
      nextTouchAt = new Date(Date.now() + FINAL_CALL_OFFSET_MS).toISOString();
    } else if (isReorderFinal) {
      // T10 just sent. Terminal converted.
      postSendStage = "converted";
    } else if (stage === "campaign_active") {
      // T1-T5 — schedule next pre-purchase touch from completed_at.
      const completedAtMs = lead.completed_at
        ? new Date(lead.completed_at).getTime()
        : Date.now();
      nextTouchAt = new Date(
        completedAtMs + TOUCHPOINT_OFFSETS_MS[nextTouchIndex],
      ).toISOString();
    } else if (stage === "reorder_active") {
      // T7-T9 — schedule next re-order touch from first_order_placed_at.
      const placedAtMs = lead.first_order_placed_at
        ? new Date(lead.first_order_placed_at).getTime()
        : Date.now();
      const nextReorderIdx = nextTouchIndex - TOTAL_TOUCHPOINTS;
      nextTouchAt = new Date(
        placedAtMs + REORDER_TOUCHPOINT_OFFSETS_MS[nextReorderIdx],
      ).toISOString();
    }

    const isAnyFinal = isPrePurchaseFinal || isReorderFinal || isFinalCallTouch;

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
    if (postSendStage) claimUpdate.journey_stage = postSendStage;

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

    // Mig 0157 — deterministic A/B subject-line variant per
    // (lead, touch). Same lead always gets the same variant on
    // the same touch; bucket assignment hashes (lead_id |
    // touch_index) and mods the variant count for that touch.
    // Touches without a registered A/B test fall back to 'A'.
    const subjectVariantKey = pickSubjectVariant(lead.id, nextTouchIndex);

    // Build the unsubscribe + tracking-pixel URLs once per lead.
    // Both signed tokens include the lead_id so they can't be
    // forged or replayed against another patient.
    let unsubscribeUrl: string;
    let trackingPixelUrl: string | null = null;
    let wrapCta: ((linkKey: string) => string) | null;
    try {
      const unsubToken = signUnsubscribeToken(lead.id);
      unsubscribeUrl = `${baseUrl}/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(unsubToken)}`;
      // Open tracking pixel — minted with the SAME HMAC key, but a
      // distinct payload prefix so the two tokens can't be
      // cross-replayed. If anything in the mint fails, we still
      // ship the email — the open signal is nice-to-have, the
      // unsubscribe is mandatory.
      try {
        const openToken = signOpenTrackingToken(lead.id, nextTouchIndex);
        trackingPixelUrl = `${baseUrl}/shop/track/o?t=${encodeURIComponent(openToken)}`;
      } catch (openErr) {
        logger.warn(
          { err: openErr, leadId: lead.id },
          "fitter-lead.supply-campaign: open tracking token mint failed",
        );
      }
      // Click-tracking redirect wrapper. Mints one token per
      // (lead, touch, link_key) on demand. Same key as the open
      // pixel; distinct payload prefix 'c|' so cross-replay across
      // the open/unsubscribe/click endpoints all fail closed.
      // Mig 0157: also carries the subject_variant_key forward so
      // per-variant CTR attribution doesn't need a DB lookup.
      const safeLeadId = lead.id;
      const safeTouchIndex = nextTouchIndex;
      const safeVariantKey = subjectVariantKey;
      wrapCta = (linkKey: string): string => {
        try {
          const token = signClickTrackingToken(
            safeLeadId,
            safeTouchIndex,
            linkKey,
            safeVariantKey,
          );
          return `${baseUrl}/shop/track/c?t=${encodeURIComponent(token)}`;
        } catch (err) {
          // If we can't mint a click token, fall back to the bare
          // destination — better a working CTA without tracking
          // than a broken email.
          logger.warn(
            { err, leadId: safeLeadId, linkKey },
            "fitter-lead.supply-campaign: click token mint failed (using bare URL)",
          );
          // The composer's ctaHref() inserts the fallback URL when
          // wrapCta returns the same value as the bare; signalling
          // "no wrap" is easier here than threading a "null this
          // particular CTA" through.
          switch (linkKey) {
            case "results":
              return `${baseUrl}/results`;
            case "shop":
            case "promo":
              return `${baseUrl}/shop`;
            case "subscribe":
              return `${baseUrl}/shop/subscribe`;
            case "refer":
              return `${baseUrl}/shop/refer`;
            case "consent":
              return `${baseUrl}/consent`;
            default:
              return `${baseUrl}/shop`;
          }
        }
      };
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
      trackingPixelUrl,
      wrapCta,
      subjectVariantKey,
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
            // Mig 0157 — surface variant in SendGrid event
            // webhooks too, so ops can sanity-check at the
            // provider level.
            variant: subjectVariantKey,
          },
        });
        stats.emailed += 1;
        await recordTouch(lead.id, nextTouchIndex, "email", "sent", null, subjectVariantKey);
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
          subjectVariantKey,
        );
      }
    } else {
      stats.skippedNoEmailConfig += 1;
      await recordTouch(lead.id, nextTouchIndex, "email", "skipped", "no_sendgrid_config", subjectVariantKey);
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
          await recordTouch(lead.id, nextTouchIndex, "sms", "sent", null, subjectVariantKey);
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
            subjectVariantKey,
          );
        }
      } else {
        stats.skippedNoSmsConfig += 1;
        await recordTouch(lead.id, nextTouchIndex, "sms", "skipped", "no_twilio_config", subjectVariantKey);
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
  subjectVariantKey: string = "A",
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
        // Mig 0157 — subject-line A/B variant. Default 'A' for
        // call sites in dev/test that don't run experiments;
        // production worker passes the bucket-assigned key.
        subject_variant_key: subjectVariantKey,
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
