// sendOrderConfirmationEmail — single-shot SendGrid confirmation
// for a paid PennPaps shop order.
//
// Fired from the Stripe webhook on checkout.session.completed (and
// async_payment_succeeded). Returns a tagged-union outcome so the
// webhook can branch without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Idempotency lives at the call site, not here. The webhook checks
// shop_orders.confirmation_email_sent_at IS NULL before invoking
// this helper and stamps it on success — so this function may be
// safely retried by the caller's own logic when needed (e.g. a
// manual replay after a SendGrid outage), but is NEVER called twice
// in normal operation.
//
// Privacy:
//   - The recipient email is never logged.
//   - Line items are PUBLIC catalog data (Stripe price/product names
//     and quantities) — safe to render in body and subject.
//   - We deliberately do NOT include any PHI; this is the cash-pay
//     shop, not the resupply outreach surface.
//   - The shipping address summary is included (city/state/postal)
//     because customers expect to see "we'll ship to ..." on a
//     confirmation. Street is included as well — it was just
//     submitted by the customer and is no more sensitive in email
//     than on the success page they just visited.
//
// Template:
//   - Subject:   "Your PennPaps order is confirmed"
//   - HTML body: brand banner ("Order confirmed"), thank-you, item
//                table (qty × name @ unit price), total, shipping
//                address block, "View order" CTA linking to the
//                order detail page on the customer success page,
//                support footer.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import type { SavedShippingAddress } from "@workspace/resupply-db";

import { withMetrics } from "../observability";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface OrderConfirmationLineItem {
  name: string;
  quantity: number;
  unitAmountCents: number;
  currency: string;
}

export interface SendOrderConfirmationEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the success page. */
  stripeSessionId: string;
  /**
   * Mirrored line items from shop_order_items (or the Stripe Session
   * if the mirror hasn't landed yet). May be empty — the body still
   * renders cleanly with a "see your order online" fallback.
   */
  items: readonly OrderConfirmationLineItem[];
  /** Order grand total. Stripe gives this on the Session. */
  amountTotalCents: number;
  /** Stripe currency code (lowercase from Stripe; we upper-case for Intl). */
  currency: string;
  /**
   * Shipping address snapshot the webhook just stored. Optional —
   * shipping-disabled SKUs land here as null and the email still
   * makes sense without an address block.
   */
  shippingAddress?: SavedShippingAddress | null;
  /**
   * Optional override for the public base URL. Defaults to
   * SHOP_PUBLIC_BASE_URL env var, then RESUPPLY_VOICE_PUBLIC_BASE_URL,
   * then https://pennpaps.com so links emitted from preview/staging
   * deploys still resolve to production.
   */
  baseUrlOverride?: string;
}

export interface SendOrderConfirmationEmailResult {
  /** True iff SendGrid env vars are present. */
  configured: boolean;
  /** True iff the API call succeeded (2xx + message id present). */
  delivered: boolean;
  /** Human-readable error when delivered=false (configured=true). */
  error?: string;
  /** SendGrid X-Message-Id when delivered. */
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

function formatMoney(cents: number, currency: string): string {
  // Stripe always sends lowercase currency codes; Intl wants upper.
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function renderAddressTextLines(addr: SavedShippingAddress): string[] {
  // Address shape comes from shop-customers.ts SavedShippingAddress.
  // Fields: line1, line2?, city, state, postalCode, country.
  const lines: string[] = [];
  lines.push(addr.line1);
  if (addr.line2) lines.push(addr.line2);
  lines.push(`${addr.city}, ${addr.state} ${addr.postalCode}`);
  lines.push(addr.country);
  return lines;
}

function renderAddressHtml(addr: SavedShippingAddress): string {
  return renderAddressTextLines(addr)
    .map((l) => escapeHtml(l))
    .join("<br/>");
}

export async function sendOrderConfirmationEmail(
  input: SendOrderConfirmationEmailInput,
): Promise<SendOrderConfirmationEmailResult> {
  const {
    toEmail,
    stripeSessionId,
    items,
    amountTotalCents,
    currency,
    shippingAddress,
  } = input;

  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open here (return configured: false) — the webhook
      // logs and skips. We never throw on misconfig out of this
      // helper; a missing SendGrid key must NOT cause Stripe to
      // retry the entire webhook.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const subject = "Your PennPaps order is confirmed";

  const orderUrl = `${publicBaseUrl(input.baseUrlOverride)}/shop/checkout-success?session_id=${encodeURIComponent(stripeSessionId)}`;
  const browseUrl = `${publicBaseUrl(input.baseUrlOverride)}/shop`;

  // ---------- text body ----------
  const textLines: string[] = [
    "Thanks for your order at PennPaps. Your payment was received and we're getting it ready to ship.",
    "",
  ];
  if (items.length > 0) {
    textLines.push("Order summary:");
    for (const it of items) {
      textLines.push(
        `  - ${it.quantity} x ${it.name} (${formatMoney(it.unitAmountCents, it.currency)} each)`,
      );
    }
    textLines.push("");
  }
  textLines.push(`Total: ${formatMoney(amountTotalCents, currency)}`);
  textLines.push("");
  if (shippingAddress) {
    textLines.push("Shipping to:");
    for (const l of renderAddressTextLines(shippingAddress)) {
      textLines.push(`  ${l}`);
    }
    textLines.push("");
  }
  textLines.push(`View your order: ${orderUrl}`);
  textLines.push(`Browse the shop:  ${browseUrl}`);
  textLines.push("");
  textLines.push(
    "We'll send another email with tracking info once your order ships. " +
      "Reply to this message if you need to make a change — we read every reply.",
  );
  const text = textLines.join("\n");

  // ---------- html body ----------
  const itemRows =
    items.length > 0
      ? items
          .map(
            (it) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;">
            <div style="font-weight:600;color:#1a1a1a;">${escapeHtml(it.name)}</div>
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#555;">
            ${it.quantity} &times; ${escapeHtml(formatMoney(it.unitAmountCents, it.currency))}
          </td>
        </tr>`,
          )
          .join("")
      : `
        <tr>
          <td colspan="2" style="padding:8px 0;border-bottom:1px solid #eee;color:#555;font-size:13px;">
            Your full itemised order is available online &mdash; tap the View order button below.
          </td>
        </tr>`;

  const addressBlock = shippingAddress
    ? `
          <tr>
            <td colspan="2" style="padding-top:24px;color:#1a1a1a;font-weight:700;">Shipping to</td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:6px;color:#444;font-size:14px;line-height:1.5;">
              ${renderAddressHtml(shippingAddress)}
            </td>
          </tr>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
          <tr>
            <td style="padding-bottom:16px;border-bottom:2px solid #c9a227;">
              <div style="font-size:14px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">PennPaps</div>
              <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">Your order is confirmed</div>
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;color:#333;font-size:15px;line-height:1.5;">
              Thanks for your order. Your payment was received and we're getting it ready to ship.
            </td>
          </tr>
          <tr>
            <td style="padding-top:16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${itemRows}
                <tr>
                  <td style="padding:12px 0 0 0;font-weight:700;color:#1a1a1a;">Total</td>
                  <td style="padding:12px 0 0 0;text-align:right;font-weight:700;color:#1a1a1a;">${escapeHtml(formatMoney(amountTotalCents, currency))}</td>
                </tr>${addressBlock}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:#c9a227;color:#1a1a1a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">View order</a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:12px;">
              <a href="${escapeHtml(browseUrl)}" style="color:#7a5d00;font-size:13px;text-decoration:underline;">or browse the shop</a>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
              We'll send another email with tracking info once your order ships. Reply to this message if you need to make a change &mdash; we read every reply.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const { messageId } = await withMetrics(
      {
        name: "sendgrid.send_email",
        attrs: { kind: "shop_order_confirmation_v1" },
      },
      () =>
        client.sendEmail({
          to: toEmail,
          subject,
          html,
          text,
          customArgs: {
            kind: "shop_order_confirmation_v1",
            stripe_session_id: stripeSessionId,
          },
        }),
    );
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
