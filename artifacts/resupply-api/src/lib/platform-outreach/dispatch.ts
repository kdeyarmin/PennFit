// Pure-ish helpers for the platform outreach send worker.
//
// Batch sizing + status-transition gates are identical to the per-tenant
// bulk-campaign engine, so we reuse those directly rather than fork them.
// What's specific here is the email-body assembly (CAN-SPAM footer +
// one-click unsubscribe link) and the SendGrid custom-args envelope.

import {
  batchSizeForThrottle,
  isLegalCampaignTransition,
  TICK_INTERVAL_SECONDS,
  TICKS_PER_MINUTE,
  type CampaignStatus,
} from "../bulk-campaigns/dispatch-helpers.js";

import { signPlatformUnsubscribeToken } from "./unsubscribe-token.js";

export {
  batchSizeForThrottle,
  isLegalCampaignTransition,
  TICK_INTERVAL_SECONDS,
  TICKS_PER_MINUTE,
  type CampaignStatus,
};

export const PLATFORM_EMAIL_TICK_JOB = "platform-email.send-tick";

/** SendGrid custom_args echoed back on every event webhook for the
 *  message, so an inbound webhook can correlate delivered/bounced to the
 *  campaign + recipient row. */
export function customArgsFor(
  campaignId: string,
  recipientRowId: string,
): Record<string, string> {
  return {
    platform_email_campaign_id: campaignId,
    platform_email_recipient_id: recipientRowId,
  };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** The public base URL the unsubscribe link points at — the platform's
 *  own host. Empty when neither env var is set (links are then omitted). */
export function platformPublicBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return stripTrailingSlash(
    env.REMINDER_PUBLIC_BASE_URL ??
      env.SHOP_PUBLIC_BASE_URL ??
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : ""),
  );
}

/** Build the one-click unsubscribe URL for a saved contact, or null when
 *  there's no contact id (ad-hoc / tenant recipients) or no base URL. */
export function unsubscribeUrlForContact(
  contactId: string | null,
  baseUrl = platformPublicBaseUrl(),
): string | null {
  if (!contactId || !baseUrl) return null;
  const token = signPlatformUnsubscribeToken(contactId);
  return `${baseUrl}/resupply-api/platform-unsubscribe?t=${encodeURIComponent(
    token,
  )}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface OutreachBodyInput {
  bodyHtml: string | null;
  bodyText: string;
  /** One-click unsubscribe URL for saved contacts, else null. */
  unsubscribeUrl: string | null;
}

/**
 * Assemble the final HTML + text bodies with a CAN-SPAM footer. A saved
 * contact gets a one-click unsubscribe link; ad-hoc / tenant recipients
 * (no contact row to flag) get a reply-to-opt-out instruction instead.
 */
export function buildOutreachBody(input: OutreachBodyInput): {
  html: string;
  text: string;
} {
  const baseHtml = input.bodyHtml ?? `<p>${escapeHtml(input.bodyText)}</p>`;
  const footerLine = input.unsubscribeUrl
    ? `You're receiving this from CareMetric Breathe. Unsubscribe: ${input.unsubscribeUrl}`
    : `You're receiving this from CareMetric Breathe. To stop receiving these emails, reply with "UNSUBSCRIBE".`;
  const footerHtml = input.unsubscribeUrl
    ? `You're receiving this from CareMetric Breathe. <a href="${escapeHtml(
        input.unsubscribeUrl,
      )}">Unsubscribe</a>.`
    : `You're receiving this from CareMetric Breathe. To stop receiving these emails, reply with "UNSUBSCRIBE".`;

  return {
    html: `${baseHtml}\n<hr/>\n<p style="font-size:12px;color:#888">${footerHtml}</p>`,
    text: `${input.bodyText}\n\n—\n${footerLine}`,
  };
}
