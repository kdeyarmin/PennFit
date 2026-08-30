/**
 * Follow up on a mask-fitter invite that went quiet.
 *
 * WHY THIS EXISTS
 * ---------------
 * Sending someone a fitter link was, until migration 0536, a single
 * message into the dark. Nothing in the worker tree read
 * `fitter_invites`, so a link nobody opened simply aged out, and a
 * fitting somebody FINISHED but never turned into a request just sat
 * there — the most expensive silence in the funnel, because the clinical
 * work is already done.
 *
 * Two follow-ups, deliberately different in kind:
 *
 *   * `unstarted` / `abandoned` — the link still works. The message
 *     carries a fresh signed link so the patient can pick up where they
 *     left off, and it is the same shape as the invitation they already
 *     have. Copy is written as a reminder, never as a reprimand: people
 *     who put a health task off are not procrastinators, they are people
 *     with a lot on.
 *
 *   * `no_request` — the fitting is DONE. There is deliberately NO link
 *     here, and that is the whole design decision in this file. The
 *     patient's next step under `fitter.lead_capture_only` is the
 *     /fit-request form, which is a `Guarded*` route reading the fitter
 *     store out of per-tab sessionStorage. That state is gone days
 *     later, so a link would either dead-end on the invite gate or drop
 *     them back at the START of a fitting they already completed —
 *     asking someone to redo two minutes of face scanning we already
 *     have the numbers for. So this one gives them a phone number and an
 *     invitation to reply, and the matching staff alert makes sure
 *     somebody calls.
 *
 * FAIL-SOFT, and the caller must respect it. Neither sender throws, but
 * both report whether delivery landed, because the sweep stamps the
 * invite either way and the staff alert records what actually reached
 * the patient.
 *
 * PHI: message bodies carry a first name, a brand, a phone number and
 * (for the live-link case) a signed link. No measurements, no mask name,
 * no clinical finding — patient email and SMS are not encrypted
 * channels. Vendor errors are logged by SHAPE only: Twilio embeds the
 * recipient's number verbatim in invalid-number messages.
 */

import {
  EmailConfigError,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { getCompanyInfo } from "../company-info.js";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { logger } from "../logger.js";
import { resolveTenantSmsClientOptions } from "../messaging/tenant-telecom.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import { signFitterInviteToken } from "../fitter-invite-token.js";

/** Which silence we are breaking. Selects the copy only. */
export type FollowupReason =
  /** Link delivered, never opened. */
  | "unstarted"
  /** Opened and started, never finished. */
  | "abandoned"
  /** Fitting finished; no request and no order followed. */
  | "no_request";

export interface FollowupDelivery {
  delivered: boolean;
  /**
   * Machine-readable why-not, recorded on the staff alert.
   *
   * `no_contact` and `link_unavailable` are deliberately separate. Both
   * end in "nothing was sent", but they are different problems with
   * different fixes — one is "we have no way to reach this person", the
   * other is "this tenant has no verified domain, so no invite link can
   * be minted for anyone". Collapsing them would tell an operator to go
   * looking for a missing email address when every address is fine.
   */
  reason:
    | null
    | "no_contact"
    | "link_unavailable"
    | "no_channel_config"
    | "in_office_handoff"
    | "send_failed";
  /** Which channel actually carried it (or would have). */
  channel: "email" | "sms" | null;
}

export interface FollowupTarget {
  orgId: string;
  inviteId: string;
  channel: string;
  recipientEmail: string | null;
  recipientPhoneE164: string | null;
  recipientName: string | null;
  /**
   * Which channels the caller has already cleared for consent, DND and
   * the TCPA send window. The sender does no consent work of its own —
   * the sweep owns that, because it is the thing that read the patient's
   * preferences.
   */
  allowEmail: boolean;
  allowSms: boolean;
  /**
   * Tenant link origin (verified custom domain, or the platform host for
   * the seed tenant). Required for the two live-link reasons; ignored
   * for `no_request`, which sends no link.
   */
  linkBase?: string | null;
  /**
   * How long the invite row itself has left. The minted token is given
   * exactly this TTL so the signature and `fitter_invites.expires_at`
   * expire together — the ROW is the real gate (see
   * routes/shop/fitter-invite.ts), so a longer-lived token would
   * advertise a link that dead-ends before it expires.
   */
  linkTtlMs?: number;
}

const FIRST_NAME_RE = /\s+/;

function firstNameOf(name: string | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "there";
  return trimmed.split(FIRST_NAME_RE)[0] ?? "there";
}

/** Strip CR/LF before a value reaches a mail header. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/**
 * Pick the channel to follow up on.
 *
 * Preference is the channel the ORIGINAL invite used, because that is
 * the thread the patient is already in — a text follow-up to an email
 * invitation reads as a different company. Falling back to the other
 * channel when the first is unavailable is still better than silence.
 *
 * `in_office` never auto-picks. The row carries a chart's email and
 * phone incidentally (the create route resolves them before it looks at
 * the channel), and "nothing is sent" was the contract staff chose at
 * the counter. Same posture as `sendRescanForInvite`.
 */
function pickChannel(target: FollowupTarget): "email" | "sms" | null {
  const emailOk = target.allowEmail && Boolean(target.recipientEmail);
  const smsOk = target.allowSms && Boolean(target.recipientPhoneE164);
  if (target.channel === "sms") {
    if (smsOk) return "sms";
    return emailOk ? "email" : null;
  }
  if (emailOk) return "email";
  return smsOk ? "sms" : null;
}

/**
 * Send one follow-up. Never throws.
 */
export async function sendFitterFollowup(
  target: FollowupTarget,
  reason: FollowupReason,
): Promise<FollowupDelivery> {
  try {
    if (target.channel === "in_office") {
      return { delivered: false, reason: "in_office_handoff", channel: null };
    }
    const channel = pickChannel(target);
    if (!channel) {
      return { delivered: false, reason: "no_contact", channel: null };
    }

    const greeting = firstNameOf(target.recipientName);
    const brandName = (await resolveBrandingByOrgId(target.orgId))
      .storefrontName;

    // The two live-link reasons need a link; `no_request` needs a phone
    // number. Resolve only what this reason actually uses so a tenant
    // with no verified domain can still send the no-link follow-up.
    let link: string | null = null;
    if (reason !== "no_request") {
      if (!target.linkBase || !target.linkTtlMs || target.linkTtlMs <= 0) {
        return { delivered: false, reason: "link_unavailable", channel };
      }
      const token = signFitterInviteToken(
        target.inviteId,
        new Date(),
        target.linkTtlMs,
      );
      link = `${target.linkBase}/fitter-invite?t=${encodeURIComponent(token)}`;
    }

    const company =
      reason === "no_request" ? await getCompanyInfo(target.orgId) : null;
    const phoneDisplay = company?.supportPhoneDisplay || null;

    // Try the preferred channel, then fall back to the other one the
    // caller already permitted.
    //
    // A definitive CONFIGURATION failure is not a reason to give up: the
    // sweep has already spent this round's stamp by the time we are
    // called, and nothing ever clears a stamp. So a tenant with no
    // Twilio credentials but working SendGrid would silently lose every
    // follow-up for an SMS-originated invite — permanently, not until
    // they fixed it. Only a config refusal falls through; a vendor
    // rejecting the send is a real answer and stops here.
    const order: Array<"email" | "sms"> =
      channel === "sms" ? ["sms", "email"] : ["email", "sms"];
    let lastReason: FollowupDelivery["reason"] = "no_contact";
    let lastChannel: "email" | "sms" | null = channel;
    for (const attempt of order) {
      if (attempt === "sms") {
        if (!target.allowSms || !target.recipientPhoneE164) continue;
        let twilio;
        try {
          twilio = createTwilioSmsClient(
            await resolveTenantSmsClientOptions(target.orgId),
          );
        } catch (err) {
          if (err instanceof TwilioConfigError) {
            lastReason = "no_channel_config";
            lastChannel = attempt;
            continue;
          }
          throw err;
        }
        await twilio.sendSms({
          to: target.recipientPhoneE164,
          body: smsBody(reason, greeting, brandName, link, phoneDisplay),
        });
        return { delivered: true, reason: null, channel: attempt };
      }

      if (!target.allowEmail || !target.recipientEmail) continue;
      let sendgrid;
      try {
        sendgrid = await createTenantSendgridClient(target.orgId);
      } catch (err) {
        if (err instanceof EmailConfigError) {
          lastReason = "no_channel_config";
          lastChannel = attempt;
          continue;
        }
        throw err;
      }
      const safeBrand = headerSafe(brandName);
      await sendgrid.sendEmail({
        to: target.recipientEmail,
        // No PHI in the subject line — inbox subjects aren't encrypted.
        subject: emailSubject(reason, safeBrand),
        html: renderFollowupHtml(
          reason,
          greeting,
          safeBrand,
          link,
          phoneDisplay,
        ),
        text: renderFollowupText(
          reason,
          greeting,
          safeBrand,
          link,
          phoneDisplay,
        ),
      });
      return { delivered: true, reason: null, channel: attempt };
    }
    return { delivered: false, reason: lastReason, channel: lastChannel };
  } catch (err) {
    logger.warn(
      {
        orgId: target.orgId,
        reason,
        errName: err instanceof Error ? err.name : "unknown",
        status: (err as { status?: number }).status ?? null,
        code: (err as { code?: number | string }).code ?? null,
      },
      "fitter follow-up failed to send",
    );
    return { delivered: false, reason: "send_failed", channel: null };
  }
}

/**
 * The sentences that differ by reason, written once and shared by the
 * HTML and text renderers so the two can never drift.
 *
 * `abandoned` names the fact that they started, because being told
 * "you're nearly there" is the difference between resuming and starting
 * over. `no_request` opens by saying the work is DONE — the patient's
 * mental model is that they finished, and a message that reads like a
 * request to do the fitting again would be both wrong and dispiriting.
 */
function reasonCopy(reason: FollowupReason): {
  heading: string;
  lead: string;
  body: string;
  cta: string;
} {
  switch (reason) {
    case "abandoned":
      return {
        heading: "You were nearly there",
        lead: "you started your mask fitting but didn't get to the end.",
        body: "Your link still works, and it picks up from the beginning of a two-minute process — nothing you'd need to prepare for. Finding the right mask is the single biggest thing that makes CPAP comfortable enough to keep using.",
        cta: "Finish your mask fitting",
      };
    case "no_request":
      return {
        heading: "Your mask fitting is ready",
        lead: "you finished your mask fitting — thank you.",
        body: "We have your results and the mask that fits you best. The next step is ours: we check what your insurance covers and get it ordered for you. We just need a quick word with you first.",
        cta: "",
      };
    case "unstarted":
    default:
      return {
        heading: "Your mask fitting is waiting",
        lead: "we sent you a link to find your best-fitting CPAP mask, and it's still open.",
        body: "It takes about two minutes on your own phone or computer, and your camera images never leave your device — only the measurements are shared with our team. Getting the fit right is the single biggest thing that makes CPAP comfortable enough to keep using.",
        cta: "Start your mask fitting",
      };
  }
}

function emailSubject(reason: FollowupReason, brandName: string): string {
  switch (reason) {
    case "abandoned":
      return `You're nearly done — finish your mask fitting with ${brandName}`;
    case "no_request":
      return `Your mask fitting results are ready — ${brandName}`;
    case "unstarted":
    default:
      return `A reminder from ${brandName}: your mask fitting is waiting`;
  }
}

function smsBody(
  reason: FollowupReason,
  greeting: string,
  brandName: string,
  link: string | null,
  phoneDisplay: string | null,
): string {
  if (reason === "no_request") {
    const call = phoneDisplay ? ` Call us at ${phoneDisplay}` : " Reply here";
    return `Hi ${greeting}, ${brandName} here — we have your mask fitting results and we'd like to get your mask ordered.${call} and we'll check your coverage and take it from there. Reply STOP to opt out.`;
  }
  if (reason === "abandoned") {
    return `Hi ${greeting}, you were nearly done with your ${brandName} mask fitting — it takes about a minute to finish: ${link} Reply STOP to opt out.`;
  }
  return `Hi ${greeting}, a reminder from ${brandName}: your mask fitting link is still open and takes about 2 minutes on your phone: ${link} Reply STOP to opt out.`;
}

function contactLine(phoneDisplay: string | null): string {
  return phoneDisplay
    ? `Call us at ${phoneDisplay}, or just reply to this email and we'll get straight back to you.`
    : "Just reply to this email and we'll get straight back to you.";
}

function renderFollowupHtml(
  reason: FollowupReason,
  greeting: string,
  brandName: string,
  link: string | null,
  phoneDisplay: string | null,
): string {
  const copy = reasonCopy(reason);
  const content = [
    textParagraph(`Hi ${greeting},`),
    paragraph(
      `<strong>${escapeHtml(brandName)}</strong> — ${escapeHtml(copy.lead)}`,
    ),
    paragraph(escapeHtml(copy.body)),
  ];
  if (reason === "no_request") {
    content.push(paragraph(escapeHtml(contactLine(phoneDisplay))));
  }
  const footerLines =
    reason === "no_request"
      ? [
          "Nothing has been ordered or billed — we always confirm your coverage with you first.",
          `— The ${brandName} team`,
        ]
      : [
          "Your camera images never leave your device — only the numeric measurements are shared with our team so we can follow up on your fit.",
          `If the button doesn't work, copy and paste this link: ${link ?? ""}`,
          `— The ${brandName} team`,
        ];
  return renderBrandedEmail({
    brandName,
    heading: copy.heading,
    preheader: `${brandName} — ${copy.lead}`,
    contentHtml: content.join("\n"),
    button: link && copy.cta ? { label: copy.cta, url: link } : undefined,
    footerLines,
    copyrightName: brandName,
  });
}

function renderFollowupText(
  reason: FollowupReason,
  greeting: string,
  brandName: string,
  link: string | null,
  phoneDisplay: string | null,
): string {
  const copy = reasonCopy(reason);
  const lines = [`Hi ${greeting},`, "", `${brandName} — ${copy.lead}`, ""];
  lines.push(copy.body, "");
  if (reason === "no_request") {
    lines.push(contactLine(phoneDisplay), "");
    lines.push(
      "Nothing has been ordered or billed — we always confirm your coverage with you first.",
      "",
    );
  } else {
    lines.push(`${copy.cta}: ${link ?? ""}`, "");
    lines.push(
      "Your camera images never leave your device — only the numeric",
      "measurements are shared with our team so we can follow up on your fit.",
      "",
    );
  }
  lines.push(`— The ${brandName} team`);
  return lines.join("\n");
}
