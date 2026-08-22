// sendDeliveryFollowupEmail — single-shot SendGrid notice sent ~3
// days after a paid Penn Home Medical Supply shop order delivers.
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
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { isFeatureEnabled } from "../feature-flags";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

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
  /**
   * Tenant the order belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendDeliveryFollowupEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
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
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's email carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
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
            `<a href="${escapeHtml(c.href)}" style="display:inline-block;min-width:28px;padding:8px 0;margin:2px;text-align:center;border:1px solid ${BREATHE_COLORS.hairline};border-radius:6px;font-family:Arial,Helvetica,sans-serif;color:${BREATHE_COLORS.blue};text-decoration:none;font-size:13px;font-weight:600;">${c.score}</a>`,
        )
        .join("");
      npsRow = {
        html: `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:8px 0 4px;"><tr><td>${htmlRow}</td></tr></table>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:4px 0 0;"><tr><td align="left" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${BREATHE_COLORS.faint};">Not at all likely</td><td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${BREATHE_COLORS.faint};">Extremely likely</td></tr></table>`,
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
    `Your ${brandName} supplies should have arrived a few days ago. We wanted`,
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
    `The ${brandName} team`,
    "",
    `View your order: ${orderUrl}`,
    ...(npsRow ? npsRow.text : []),
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  // The two side-by-side choices stay a hand-built table: this is the one
  // email with a genuine either/or, so neither is the single primary CTA
  // the shared button models.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "Your supplies arrived — how did it go?",
    heading: "How did it go?",
    preheader: `Your ${brandName} supplies should have arrived — is the fit comfortable?`,
    contentHtml: [
      paragraph(greeting),
      textParagraph(
        `Your ${brandName} supplies should have arrived a few days ago. We wanted to check in: is the fit comfortable, the seal holding, and everything as you expected?`,
      ),
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0 8px;">
<tr>
<td style="padding-right:8px;">
<a href="${escapeHtml(reviewUrl)}" style="display:block;background:${BREATHE_COLORS.blue};color:#ffffff;text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;">It works great</a>
</td>
<td style="padding-left:8px;">
<a href="${escapeHtml(returnsUrl)}" style="display:block;background:#ffffff;color:${BREATHE_COLORS.blue};text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;border:1px solid ${BREATHE_COLORS.blue};">Something isn&#39;t right</a>
</td>
</tr>
</table>`,
      paragraph(
        "60-day Comfort Guarantee — start a return any time. Or just reply to this email; we&#39;re real humans on the other side.",
      ),
      npsRow
        ? `<div style="margin-top:22px;padding-top:18px;border-top:1px solid ${BREATHE_COLORS.hairline};">
<p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:600;color:${BREATHE_COLORS.ink};">How likely are you to recommend us?</p>
${npsRow.html}
</div>`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    footerHtml: `<a href="${escapeHtml(orderUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">View your order</a>`,
    footerLines: [`Sleep well, the ${brandName} team`],
    copyrightName: brandName,
  });

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
