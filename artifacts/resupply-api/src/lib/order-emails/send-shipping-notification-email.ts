// sendShippingNotificationEmail — single-shot SendGrid notice that
// a paid PennPaps shop order has shipped.
//
// Fired from the admin POST /admin/shop/orders/:orderId/tracking
// endpoint after the carrier + tracking number are stamped on the
// order row. Returns a tagged-union outcome so the route can branch
// without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Idempotency lives at the call site, not here. The admin route
// checks shop_orders.shipping_email_sent_at against a "did this
// tracking actually change?" condition before invoking this helper
// and stamps it on success — so this function may be safely retried
// by the caller's own logic when needed (e.g. an admin manually
// re-pressing the button after a SendGrid outage), but is NEVER
// called twice in normal operation.
//
// Privacy:
//   - The recipient email is never logged.
//   - The tracking number, carrier name and shipping address are
//     PUBLIC operational data — safe to render in body.
//   - We deliberately do NOT include any PHI; this is the cash-pay
//     shop, not the resupply outreach surface.
//
// Template:
//   - Subject:   "Your PennPaps order has shipped"
//   - HTML body: brand banner ("On its way"), short note, tracking
//                box (carrier + number, with a public carrier-tracking
//                link when the carrier is known), shipping address
//                summary, "View order" CTA, support footer.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import type { SavedShippingAddress } from "@workspace/resupply-db";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendShippingNotificationEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the order page. */
  stripeSessionId: string;
  /** Free-form carrier label entered by admin (e.g. "UPS", "USPS"). */
  carrier: string;
  /** Carrier-specific tracking number entered by admin. */
  trackingNumber: string;
  /**
   * Address snapshot from shop_orders.shipping_address_json. Optional —
   * shipping-disabled SKUs land here as null and the email still
   * makes sense without an address block.
   */
  shippingAddress?: SavedShippingAddress | null;
  /**
   * Optional override for the public base URL. Defaults to
   * SHOP_PUBLIC_BASE_URL env var, then RESUPPLY_VOICE_PUBLIC_BASE_URL,
   * then https://pennpaps.com.
   */
  baseUrlOverride?: string;
}

export interface SendShippingNotificationEmailResult {
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

/**
 * Map a free-form carrier label to a public tracking URL. Returns
 * null for carriers we don't have a template for; the email then
 * renders the bare number with no link (still informative).
 *
 * The match is intentionally loose (lowercase, accepts common
 * synonyms) so admin typos like "ups " or "U.P.S." still produce a
 * usable link.
 */
export function getCarrierTrackingUrl(
  carrier: string,
  trackingNumber: string,
): string | null {
  const c = carrier.trim().toLowerCase().replace(/[^a-z]/g, "");
  const num = encodeURIComponent(trackingNumber.trim());
  if (!num) return null;
  switch (c) {
    case "ups":
      return `https://www.ups.com/track?tracknum=${num}`;
    case "usps":
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${num}`;
    case "fedex":
    case "federalexpress":
      return `https://www.fedex.com/fedextrack/?trknbr=${num}`;
    case "dhl":
    case "dhlexpress":
      return `https://www.dhl.com/en/express/tracking.html?AWB=${num}`;
    default:
      return null;
  }
}

function renderAddressTextLines(addr: SavedShippingAddress): string[] {
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

export async function sendShippingNotificationEmail(
  input: SendShippingNotificationEmailInput,
): Promise<SendShippingNotificationEmailResult> {
  const { toEmail, stripeSessionId, carrier, trackingNumber, shippingAddress } =
    input;

  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open here (return configured: false) — the admin route
      // logs and skips. We never throw on misconfig; a missing
      // SendGrid key must NOT 500 the admin tracking endpoint.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const subject = "Your PennPaps order has shipped";

  const orderUrl = `${publicBaseUrl(input.baseUrlOverride)}/shop/checkout-success?session_id=${encodeURIComponent(stripeSessionId)}`;
  const trackingUrl = getCarrierTrackingUrl(carrier, trackingNumber);

  // ---------- text body ----------
  const textLines: string[] = [
    "Good news — your PennPaps order has shipped and is on its way.",
    "",
    `Carrier:  ${carrier}`,
    `Tracking: ${trackingNumber}`,
  ];
  if (trackingUrl) {
    textLines.push(`Track:    ${trackingUrl}`);
  }
  textLines.push("");
  if (shippingAddress) {
    textLines.push("Shipping to:");
    for (const l of renderAddressTextLines(shippingAddress)) {
      textLines.push(`  ${l}`);
    }
    textLines.push("");
  }
  textLines.push(`View your order: ${orderUrl}`);
  textLines.push("");
  textLines.push(
    "If anything looks off (wrong address, wrong items), reply to this " +
      "message right away and we'll sort it out.",
  );
  const text = textLines.join("\n");

  // ---------- html body ----------
  const trackingButton = trackingUrl
    ? `
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="${escapeHtml(trackingUrl)}" style="display:inline-block;background:#c9a227;color:#1a1a1a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">Track package</a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:8px;">
              <a href="${escapeHtml(orderUrl)}" style="color:#7a5d00;font-size:13px;text-decoration:underline;">or view your full order</a>
            </td>
          </tr>`
    : `
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:#c9a227;color:#1a1a1a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">View order</a>
            </td>
          </tr>`;

  const addressBlock = shippingAddress
    ? `
          <tr>
            <td style="padding-top:24px;color:#1a1a1a;font-weight:700;">Shipping to</td>
          </tr>
          <tr>
            <td style="padding-top:6px;color:#444;font-size:14px;line-height:1.5;">
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
              <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">On its way</div>
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;color:#333;font-size:15px;line-height:1.5;">
              Good news &mdash; your PennPaps order has shipped.
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7e8;border:1px solid #ecdfa6;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;color:#5a4400;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;font-weight:700;">Tracking</td>
                </tr>
                <tr>
                  <td style="padding:0 16px 14px 16px;color:#1a1a1a;font-size:15px;line-height:1.5;">
                    <div><strong>${escapeHtml(carrier)}</strong></div>
                    <div style="font-family:Menlo,Consolas,monospace;font-size:14px;color:#333;margin-top:2px;">${escapeHtml(trackingNumber)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${addressBlock}
              </table>
            </td>
          </tr>${trackingButton}
          <tr>
            <td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
              If anything looks off &mdash; wrong address, wrong items &mdash; reply to this message right away and we'll sort it out.
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
        kind: "shop_shipping_notification_v1",
        stripe_session_id: stripeSessionId,
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
