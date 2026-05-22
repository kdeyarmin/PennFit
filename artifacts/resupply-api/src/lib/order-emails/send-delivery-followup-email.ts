// sendDeliveryFollowupEmail — single-shot SendGrid notice sent ~3
// days after a paid PennPaps shop order delivers.
//
// Why
// ---
// The shipping notification fires the moment tracking is entered;
// nothing fires once the parcel actually arrives at the customer's
// door. That post-delivery touchpoint is the highest-ROI satisfaction
// signal a DME supplier has access to. CSAT-by-survey is uncommonly
// answered; a friendly "how did it go, text us back if anything's
// off" creates a clean intake for early returns and breakage reports
// before the patient gives up.
//
// Fired from the daily shop-order.delivery-followup pg-boss job.
// Idempotency lives at the call site (the worker's atomic-claim on
// shop_orders.delivery_followup_sent_at); this function can be
// retried safely but is not called twice in normal operation.
//
// Tagged-union outcome matches sendShippingNotificationEmail so the
// worker can branch without try/catch.
//
// Privacy:
//   - The recipient email is never logged.
//   - The email itself contains no PHI — it's a satisfaction prompt
//     for a cash-pay shop order, not a clinical message.
//
// Template
//   - Subject:   "How is your CPAP setup going?"
//   - HTML body: brand banner, short note acknowledging delivery,
//                CTAs: "It works great" (review link) and "Something
//                isn't right" (return-flow link). Plain-text mirror.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import { isFeatureEnabled } from "../feature-flags";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendDeliveryFollowupEmailInput {
  toEmail: string;
  stripeSessionId: string;
  /**
   * First name when known. Optional — the copy degrades gracefully
   * to "Hi there" when missing. We deliberately don't trust the
   * Stripe shipping_name field for an opener, because it can be a
   * gift-recipient name that doesn't match the email account.
   */
  firstName?: string | null;
  /**
   * shop_orders row id, used to mint signed NPS-rating links.
   * Optional: when omitted (test/legacy callers), the NPS rating
   * row is suppressed and the email renders with just the
   * yes/no/return CTAs as before.
   */
  orderId?: string | null;
  baseUrlOverride?: string;
}

export interface SendDeliveryFollowupEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

export async function sendDeliveryFollowupEmail(
  input: SendDeliveryFollowupEmailInput,
): Promise<SendDeliveryFollowupEmailResult> {
  const { toEmail, stripeSessionId, firstName, orderId } = input;

  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const base = publicBaseUrl(input.baseUrlOverride);
  const orderUrl = `${base}/shop/orders`;
  const returnsUrl = `${base}/account#returns`;
  const reviewUrl = `${base}/shop/orders?leave_review=${encodeURIComponent(stripeSessionId)}`;

  // NPS-rating links — 0..10 buttons rendered inline. Each carries an
  // HMAC-signed token that binds the score to this specific order +
  // a 30-day TTL. Importing lazily so the test harness for this
  // module can construct messages without needing the HMAC key wired
  // (the legacy worker tests do exactly this).
  // Control Center feature gate. When the NPS toggle is off we skip
  // the NPS rating block entirely; the delivery-followup email still
  // sends with the review-request + returns links so the customer-
  // facing copy doesn't lose anything else when only NPS is paused.
  const npsEnabled = await isFeatureEnabled("storefront.nps");
  let npsRow: { html: string; text: string[] } | null = null;
  if (orderId && npsEnabled) {
    try {
      const { signNpsToken } = await import("../nps-token");
      const cells = Array.from({ length: 11 }, (_, score) => {
        const token = signNpsToken(orderId, score);
        const href = `${base}/nps?orderId=${encodeURIComponent(orderId)}&score=${score}&t=${encodeURIComponent(token)}`;
        return { score, href };
      });
      const htmlRow = cells
        .map(
          (c) =>
            `<a href="${escapeHtml(c.href)}" style="display:inline-block;min-width:28px;padding:8px 0;margin:2px;text-align:center;border:1px solid #d4dae5;border-radius:6px;color:#0f1d3a;text-decoration:none;font-size:13px;font-weight:600;">${c.score}</a>`,
        )
        .join("");
      npsRow = {
        html: `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:8px 0 4px;"><tr><td>${htmlRow}</td></tr></table>
          <p style="margin:4px 0 0;font-size:11px;color:#8b95a9;display:flex;justify-content:space-between;"><span>Not at all likely</span><span>Extremely likely</span></p>`,
        text: ["", "Rate it 0-10 (tap a link):"].concat(
          cells.map((c) => `  ${c.score} → ${c.href}`),
        ),
      };
    } catch (err) {
      // Missing HMAC key → silently skip the NPS section. The
      // email still ships with the yes/no/return CTAs.
      // (getLinkHmacKey throws synchronously on env-missing.)
      void err;
    }
  }
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";

  const subject = "How is your CPAP setup going?";
  const text = [
    firstName ? `Hi ${firstName},` : "Hi there,",
    "",
    "Your PennPaps supplies should have arrived a few days ago. We wanted",
    "to check in: is the fit comfortable, the seal holding, and everything",
    "as you expected?",
    "",
    "If yes — great! We'd love a quick review:",
    reviewUrl,
    "",
    "If something isn't quite right (wrong size, damaged in transit, mask",
    "doesn't fit the way the camera tool suggested) — start a return any",
    "time within our 60-day Comfort Guarantee:",
    returnsUrl,
    "",
    "Or text us back here. We're real humans on the other side.",
    "",
    "Sleep well,",
    "The PennPaps team",
    "",
    `View your order: ${orderUrl}`,
    ...(npsRow ? npsRow.text : []),
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <h1 style="margin:0;font-size:20px;font-weight:600;">PennPaps</h1>
          <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">Your supplies arrived — how did it go?</p>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#3c4458;">
            Your PennPaps supplies should have arrived a few days ago. We wanted to check in:
            is the fit comfortable, the seal holding, and everything as you expected?
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0 8px;">
            <tr>
              <td style="padding-right:8px;">
                <a href="${escapeHtml(reviewUrl)}" style="display:block;background:#0f1d3a;color:#ffffff;text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-size:14px;font-weight:600;">It works great</a>
              </td>
              <td style="padding-left:8px;">
                <a href="${escapeHtml(returnsUrl)}" style="display:block;background:#ffffff;color:#0f1d3a;text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-size:14px;font-weight:600;border:1px solid #0f1d3a;">Something isn&apos;t right</a>
              </td>
            </tr>
          </table>
          <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#5a6478;">
            60-day Comfort Guarantee — start a return any time. Or just reply to
            this email; we&apos;re real humans on the other side.
          </p>
          ${
            npsRow
              ? `<div style="margin-top:22px;padding-top:18px;border-top:1px solid #eef0f5;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#1a1f36;">How likely are you to recommend us?</p>
            ${npsRow.html}
          </div>`
              : ""
          }
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          <a href="${escapeHtml(orderUrl)}" style="color:#0f1d3a;text-decoration:none;">View your order</a> &nbsp;·&nbsp;
          Sleep well, the PennPaps team
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const result = await client.sendEmail({
      to: toEmail,
      subject,
      text,
      html,
      customArgs: {
        kind: "shop_order_delivery_followup",
        session_id: stripeSessionId,
      },
    });
    return {
      configured: true,
      delivered: true,
      messageId: result.messageId,
    };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return {
        configured: true,
        delivered: false,
        error: err.message,
      };
    }
    throw err;
  }
}
