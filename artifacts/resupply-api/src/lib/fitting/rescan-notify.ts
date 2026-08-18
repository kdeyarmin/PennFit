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

export interface RescanDelivery {
  delivered: boolean;
  /** Machine-readable why-not, for the clinician-facing message. */
  reason:
    | null
    | "no_invite"
    | "invite_revoked"
    | "no_contact"
    | "no_channel_config"
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
    const token = signFitterInviteToken(String(invite.id));
    const link = `${publicBaseUrl()}/fitter-invite?t=${encodeURIComponent(token)}`;

    await supabase
      .from("fitter_invites")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + FITTER_INVITE_TTL_MS).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(invite.id));

    const name = (invite.recipient_name as string | null) ?? null;
    const greeting = name ? name.split(/\s+/)[0] : "there";
    const brandName = (await resolveBrandingByOrgId(orgId)).storefrontName;
    const channel = String(invite.channel ?? "email");

    if (channel === "sms") {
      const phone = (invite.recipient_phone_e164 as string | null) ?? null;
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
        body:
          `Hi ${greeting}, ${brandName} here. Your care team would like one ` +
          `more mask-fitting scan to make sure we get your fit right — it ` +
          `takes about two minutes: ${link}`,
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
      subject: `One more scan for your mask fitting with ${safeBrand}`,
      html: renderRescanHtml(greeting, link, safeBrand),
      text: renderRescanText(greeting, link, safeBrand),
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
): string {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${escapeHtml(greeting)},</p>
  <p>Thanks for completing your mask fitting with
  <strong>${escapeHtml(brandName)}</strong>. Your care team would like one more
  scan before recommending a mask — the first one didn't give us a clear
  enough measurement to be confident in the fit.</p>
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
): string {
  return [
    `Hi ${greeting},`,
    "",
    `Thanks for completing your mask fitting with ${brandName}. Your care`,
    "team would like one more scan before recommending a mask — the first",
    "one didn't give us a clear enough measurement to be confident in the",
    "fit.",
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
