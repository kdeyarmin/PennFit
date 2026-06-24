// sendRefundNotificationEmail — single-shot SendGrid notice that a refund
// has been issued on a shop order.
//
// Fired (via sendRefundNotificationIfNew) from the Stripe charge.refunded
// webhook for refunds that aren't already notified by the returns RMA flow
// — i.e. admin order refunds and refunds issued directly in the Stripe
// dashboard, which previously sent the customer nothing.
//
// Returns a tagged-union outcome so the caller can branch without
// try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Privacy: the recipient email is never logged. The refunded amount is
// the customer's own billing data — safe to render. No PHI.

import { EmailApiError, EmailConfigError } from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export interface SendRefundNotificationEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the order page. */
  stripeSessionId: string | null;
  /** Refunded amount in the smallest currency unit (cents). */
  amountRefundedCents: number | null;
  currency: string | null;
  /** True when the refund is less than the order total (partial). */
  isPartial: boolean;
  baseUrlOverride?: string;
  /** Tenant the order belongs to (G6 sender/brand). */
  orgId?: string;
}

export interface SendRefundNotificationEmailResult {
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

function formatAmount(cents: number | null, currency: string | null): string {
  if (cents == null) return "your refund";
  const major = (cents / 100).toFixed(2);
  const cur = (currency ?? "usd").toUpperCase();
  return cur === "USD" ? `$${major}` : `${major} ${cur}`;
}

export async function sendRefundNotificationEmail(
  input: SendRefundNotificationEmailInput,
): Promise<SendRefundNotificationEmailResult> {
  const { toEmail, stripeSessionId, isPartial } = input;

  let client;
  try {
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open (configured:false) — caller logs and skips. A missing
      // SendGrid key must NOT fail the refund webhook.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const amount = formatAmount(input.amountRefundedCents, input.currency);
  const subject = isPartial
    ? `A partial refund was issued on your ${brandName} order`
    : `Your ${brandName} order was refunded`;

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const orderUrl = stripeSessionId
    ? `${base}/shop/checkout-success?session_id=${encodeURIComponent(stripeSessionId)}`
    : `${base}/account/orders`;

  const lead = isPartial
    ? `We've issued a partial refund of ${amount} to your original payment method.`
    : `We've refunded ${amount} to your original payment method.`;

  // ---------- text body ----------
  const text = [
    lead,
    "",
    "Refunds typically take 5–10 business days to appear on your statement, depending on your bank.",
    "",
    `View your order: ${orderUrl}`,
    "",
    "Questions about this refund? Just reply to this message and we'll help.",
  ].join("\n");

  // ---------- html body ----------
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
          <tr>
            <td style="padding-bottom:16px;border-bottom:2px solid #6b7280;">
              <div style="font-size:14px;letter-spacing:0.08em;color:#4b5563;text-transform:uppercase;font-weight:600;">${escapeHtml(brandName)}</div>
              <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">${isPartial ? "Partial refund issued" : "Refund issued"}</div>
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;color:#333;font-size:15px;line-height:1.5;">
              ${escapeHtml(lead)}
            </td>
          </tr>
          <tr>
            <td style="padding-top:12px;color:#555;font-size:14px;line-height:1.5;">
              Refunds typically take 5&ndash;10 business days to appear on your statement, depending on your bank.
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:#374151;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">View order</a>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
              Questions about this refund? Reply to this message and we'll help.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const { messageId } = await client.sendEmail({
      to: toEmail,
      subject,
      html,
      text,
      customArgs: {
        kind: "shop_refund_notification_v1",
        ...(stripeSessionId ? { stripe_session_id: stripeSessionId } : {}),
      },
    });
    return { configured: true, delivered: true, messageId };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return {
        configured: true,
        delivered: false,
        error: `SendGrid ${err.status ?? "?"}: ${err.message}`,
      };
    }
    return {
      configured: true,
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
