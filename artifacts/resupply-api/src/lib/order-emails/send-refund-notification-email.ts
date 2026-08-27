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

import {
  EmailApiError,
  EmailConfigError,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
} from "./link-base.js";

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

  const base = await resolvePatientEmailLinkBase(
    input.orgId,
    input.baseUrlOverride,
  );
  if (!base) {
    return {
      configured: true,
      delivered: false,
      error: TENANT_DOMAIN_REQUIRED,
    };
  }
  const orderUrl = `${base}/contact`;

  const lead = isPartial
    ? `We've issued a partial refund of ${amount} to your original payment method.`
    : `We've refunded ${amount} to your original payment method.`;

  // ---------- text body ----------
  const text = [
    lead,
    "",
    "Refunds typically take 5–10 business days to appear on your statement, depending on your bank.",
    "",
    `Questions about your order? ${orderUrl}`,
    "",
    "Questions about this refund? Just reply to this message and we'll help.",
  ].join("\n");

  // ---------- html body ----------
  // Chrome comes from the shared CareMetric Breathe email design system;
  // this builder supplies only copy.
  const html = renderBrandedEmail({
    brandName,
    heading: isPartial ? "Partial refund issued" : "Refund issued",
    preheader: lead,
    contentHtml: [
      textParagraph(lead),
      textParagraph(
        "Refunds typically take 5–10 business days to appear on your statement, depending on your bank.",
      ),
    ].join("\n"),
    button: { label: "Contact us", url: orderUrl },
    footerLines: [
      "Questions about this refund? Reply to this message and we'll help.",
    ],
    copyrightName: brandName,
  });

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
