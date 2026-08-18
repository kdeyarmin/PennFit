/**
 * Tell a patient their fitting needs another scan.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Request rescan" used to only set `review_status='rescan_requested'` on
 * the session. That reads to staff as "the patient has been asked", but
 * nothing ever reached the patient — the request sat in a queue nobody
 * outside the console could see, and the fitting quietly died there.
 *
 * So the action now actually sends: a fresh signed link over whichever
 * channel the original invite used, with copy that says why.
 *
 * FAIL-SOFT, and the caller must respect it. Delivery is best-effort and
 * this function never throws, but it DOES report whether it landed. The
 * route surfaces that to the clinician rather than swallowing it, because
 * "we asked the patient" and "we tried to ask the patient and the tenant
 * has no SMS credentials" are different clinical facts.
 *
 * PHI: the message body carries a first name and a link. No measurements,
 * no clinical detail, nothing about why the scan was inadequate beyond
 * "we need another one" — patient email and SMS are not encrypted
 * channels.
 */

import { EmailConfigError } from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { logger } from "../logger.js";
import { resolveTenantSmsClientOptions } from "../messaging/tenant-telecom.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  FITTER_INVITE_TTL_MS,
  signFitterInviteToken,
} from "../fitter-invite-token.js";

/**
 * Why we are asking for another scan. Changes only the copy — the
 * delivery mechanics, guards and link are identical.
 *
 * Keeping these in one place matters more than it looks: the difference
 * between "your scan wasn't clear" and "you told us this mask leaks" is
 * the difference between a message that reads as our problem and one
 * that reads as blaming the patient for a fit we recommended.
 */
export type RescanReason =
  | "poor_scan"
  | "reported_bad_fit"
  | "mask_discontinued";

export interface RescanDelivery {
  delivered: boolean;
  /** Machine-readable why-not, for the clinician-facing message. */
  reason:
    | null
    | "no_invite"
    | "invite_revoked"
    | "no_contact"
    | "no_channel_config"
    | "in_office_handoff"
    | "send_failed";
  /** The link, so staff can read it to the patient when sending failed. */
  link: string | null;
}

function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://cmbreathe.com")
  ).replace(/\/$/, "");
}

/**
 * Re-mint the session's invite link and send it back to the patient.
 *
 * Returns what happened. A session with no originating invite (an
 * in-office or kiosk fitting) legitimately has nobody to notify — that is
 * `no_invite`, not a failure, and the caller words it accordingly.
 */
export async function sendRescanRequest(
  orgId: string,
  fitSessionId: string,
): Promise<RescanDelivery> {
  try {
    const supabase = getOrgScopedClient(orgId);

    const { data: session } = (await supabase
      .from("fit_sessions")
      .select("fitter_invite_id")
      .eq("id", fitSessionId)
      .limit(1)
      .maybeSingle()) as { data: Record<string, unknown> | null };
    const inviteId = (session?.fitter_invite_id as string | null) ?? null;
    if (!inviteId) return { delivered: false, reason: "no_invite", link: null };
    return await sendRescanForInvite(orgId, inviteId, "poor_scan");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)), orgId },
      "rescan notification failed to send",
    );
    return { delivered: false, reason: "send_failed", link: null };
  }
}

/**
 * Send a fresh scan link against an EXISTING invite row.
 *
 * Split out from `sendRescanRequest` so callers that reach a patient by
 * some route other than a fit session — the proactive re-fit campaign,
 * which starts from a survey answer or a discontinued mask — get exactly
 * the same delivery behaviour, link minting and fail-soft contract
 * instead of a second, subtly different copy of it.
 *
 * Never throws. An in-office invite legitimately has no email or phone,
 * and reports `no_contact` rather than being treated as a failure.
 */
export async function sendRescanForInvite(
  orgId: string,
  inviteId: string,
  reason: RescanReason = "poor_scan",
): Promise<RescanDelivery> {
  try {
    const supabase = getOrgScopedClient(orgId);

    const { data: invite } = (await supabase
      .from("fitter_invites")
      .select(
        "id, status, channel, recipient_email, recipient_phone_e164, recipient_name",
      )
      .eq("id", inviteId)
      .limit(1)
      .maybeSingle()) as { data: Record<string, unknown> | null };
    if (!invite) return { delivered: false, reason: "no_invite", link: null };
    if (invite.status === "revoked") {
      return { delivered: false, reason: "invite_revoked", link: null };
    }

    // A fresh token, which also extends the expiry — the original may
    // well have aged out by the time a clinician reviewed the session.
    const token = signFitterInviteToken(
      String(invite.id),
      new Date(),
      FITTER_INVITE_TTL_MS,
    );
    const link = `${publicBaseUrl()}/fitter-invite?t=${encodeURIComponent(token)}`;

    // The mailed-link window, deliberately, even for an invite that began
    // as an in-office QR.
    //
    // The 12-hour in-office window exists because a QR is DISPLAYED on a
    // staff screen in a semi-public space where it can be photographed by
    // someone it wasn't meant for. A rescan link is not displayed — it is
    // sent to the patient's own phone or inbox, which is the same exposure
    // as any other mailed invite, and the patient has left the building.
    // Holding them to 12 hours here would expire the link before most
    // people check their messages.
    //
    // Stated explicitly because the widening is otherwise invisible: the
    // row keeps channel='in_office' while carrying a 30-day token, so
    // anything that later infers a window from the channel would be wrong.
    const rescanTtlMs = FITTER_INVITE_TTL_MS;
    await supabase
      .from("fitter_invites")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + rescanTtlMs).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(invite.id));

    const name = (invite.recipient_name as string | null) ?? null;
    const greeting = name ? name.split(/\s+/)[0] : "there";
    const brandName = (await resolveBrandingByOrgId(orgId)).storefrontName;
    const channel = String(invite.channel ?? "email");

    // An in-office invite is handed back, never sent.
    //
    // "Nothing is sent" is the contract staff chose when they picked the
    // counter handover, and it does NOT follow that the row has no
    // address: the create route resolves the chart's email and phone
    // before it looks at the channel, so a patient-linked in-office invite
    // carries both. Auto-picking SMS from that would message a patient
    // over a channel nobody selected, on the strength of a contact detail
    // that is only present incidentally.
    //
    // So the clinician gets the fresh link back and decides. The result
    // shape already carries it and the console already renders "use the
    // link below", so this is the affordance that exists — it just needs
    // its own reason rather than borrowing "no_contact", which would claim
    // we had nowhere to send when we simply declined to choose.
    if (channel === "in_office") {
      return { delivered: false, reason: "in_office_handoff", link };
    }

    const phone = (invite.recipient_phone_e164 as string | null) ?? null;
    if (channel === "sms") {
      if (!phone) return { delivered: false, reason: "no_contact", link };
      let twilio;
      try {
        twilio = createTwilioSmsClient(
          await resolveTenantSmsClientOptions(orgId),
        );
      } catch (err) {
        if (err instanceof TwilioConfigError) {
          return { delivered: false, reason: "no_channel_config", link };
        }
        throw err;
      }
      await twilio.sendSms({
        to: phone,
        body: smsBody(reason, greeting, brandName, link),
      });
      return { delivered: true, reason: null, link };
    }

    const email = (invite.recipient_email as string | null) ?? null;
    if (!email) return { delivered: false, reason: "no_contact", link };
    let sendgrid;
    try {
      sendgrid = await createTenantSendgridClient(orgId);
    } catch (err) {
      if (err instanceof EmailConfigError) {
        return { delivered: false, reason: "no_channel_config", link };
      }
      throw err;
    }
    const safeBrand = brandName.replace(/[\r\n]/g, "");
    await sendgrid.sendEmail({
      to: email,
      // No PHI in the subject — provider inbox subjects aren't encrypted.
      subject: emailSubject(reason, safeBrand),
      html: renderRescanHtml(greeting, link, safeBrand, reason),
      text: renderRescanText(greeting, link, safeBrand, reason),
    });
    return { delivered: true, reason: null, link };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)), orgId },
      "rescan notification failed to send",
    );
    return { delivered: false, reason: "send_failed", link: null };
  }
}

/**
 * The one paragraph that differs by reason, as plain sentences reused by
 * both the HTML and text renderers so the two can never drift apart.
 *
 * `reported_bad_fit` deliberately owns the problem ("the mask we
 * recommended isn't sealing") rather than putting it on the patient.
 * They already did the work of telling us; the reply should not read as
 * though they wore it wrong.
 */
function reasonCopy(reason: RescanReason): {
  subject: (brand: string) => string;
  lead: string;
  sms: (greeting: string, brand: string, link: string) => string;
} {
  switch (reason) {
    case "reported_bad_fit":
      return {
        subject: (brand) => `Let's get your mask fit right — ${brand}`,
        lead:
          "You told us the mask we recommended isn't sealing properly. " +
          "That's on us to fix, and the quickest way is a fresh scan so we " +
          "can look again with your current measurements.",
        sms: (greeting, brand, link) =>
          `Hi ${greeting}, ${brand} here. You told us your mask isn't ` +
          `sealing right — let's fix that. A fresh two-minute scan and ` +
          `we'll look again: ${link}`,
      };
    case "mask_discontinued":
      return {
        subject: (brand) => `A newer mask option for you — ${brand}`,
        lead:
          "The mask you're using has been discontinued by its manufacturer, " +
          "so supplies for it will get harder to find over time. A fresh " +
          "scan lets us match you to a current model before that becomes a " +
          "problem.",
        sms: (greeting, brand, link) =>
          `Hi ${greeting}, ${brand} here. Your mask model is being ` +
          `discontinued, so let's find your best current option — a ` +
          `two-minute scan: ${link}`,
      };
    default:
      return {
        subject: (brand) => `One more scan for your mask fitting with ${brand}`,
        lead:
          "Your care team would like one more scan before recommending a " +
          "mask — the first one didn't give us a clear enough measurement " +
          "to be confident in the fit.",
        sms: (greeting, brand, link) =>
          `Hi ${greeting}, ${brand} here. Your care team would like one ` +
          `more mask-fitting scan to make sure we get your fit right — it ` +
          `takes about two minutes: ${link}`,
      };
  }
}

function emailSubject(reason: RescanReason, brandName: string): string {
  return reasonCopy(reason).subject(brandName);
}

function smsBody(
  reason: RescanReason,
  greeting: string,
  brandName: string,
  link: string,
): string {
  return reasonCopy(reason).sms(greeting, brandName, link);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRescanHtml(
  greeting: string,
  link: string,
  brandName: string,
  reason: RescanReason,
): string {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${escapeHtml(greeting)},</p>
  <p><strong>${escapeHtml(brandName)}</strong> here.
  ${escapeHtml(reasonCopy(reason).lead)}</p>
  <p>It takes about two minutes and runs entirely on your own phone or
  computer. Somewhere with good, even lighting helps a lot.</p>
  <p style="margin:24px 0">
    <a href="${escapeHtml(link)}" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Take another scan</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Your camera images never leave your
  device — only the numeric measurements are shared with our team.</p>
  <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy and
  paste this link into your browser:<br>${escapeHtml(link)}</p>
  </body></html>`;
}

function renderRescanText(
  greeting: string,
  link: string,
  brandName: string,
  reason: RescanReason,
): string {
  return [
    `Hi ${greeting},`,
    "",
    `${brandName} here. ${reasonCopy(reason).lead}`,
    "",
    "It takes about two minutes and runs entirely on your own phone or",
    "computer. Somewhere with good, even lighting helps a lot.",
    "",
    link,
    "",
    "Your camera images never leave your device — only the numeric",
    "measurements are shared with our team.",
  ].join("\n");
}
