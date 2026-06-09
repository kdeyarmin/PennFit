// sendReadyForPickupEmail — single-shot SendGrid notice that a paid
// PennPaps in-store-pickup order is ready to collect.
//
// The pickup analogue of sendShippingNotificationEmail. Fired from the
// admin POST /admin/shop/orders/:orderId/ready-for-pickup endpoint after
// ready_for_pickup_at is stamped. Returns the same tagged result shape
// so the route can branch without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Idempotency lives at the call site (the route claims
// ready_for_pickup_email_sent_at atomically), exactly like the shipping
// notification.
//
// Privacy:
//   - The recipient email is never logged.
//   - The location name/address/phone are PUBLIC business contact info.
//   - No PHI — this is the cash-pay shop.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface PickupLocationForEmail {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phoneE164: string | null;
}

export interface SendReadyForPickupEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the order page. */
  stripeSessionId: string;
  /** The location the customer collects from. */
  location: PickupLocationForEmail;
  /** Optional override for the public base URL. */
  baseUrlOverride?: string;
}

export interface SendReadyForPickupEmailResult {
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

function locationTextLines(loc: PickupLocationForEmail): string[] {
  const lines: string[] = [loc.name];
  if (loc.addressLine1) lines.push(loc.addressLine1);
  if (loc.addressLine2) lines.push(loc.addressLine2);
  const cityLine = [loc.city, loc.state].filter(Boolean).join(", ");
  const cityState = [cityLine, loc.postalCode].filter(Boolean).join(" ").trim();
  if (cityState) lines.push(cityState);
  if (loc.phoneE164) lines.push(`Phone: ${loc.phoneE164}`);
  return lines;
}

function locationHtml(loc: PickupLocationForEmail): string {
  return locationTextLines(loc)
    .map((l) => escapeHtml(l))
    .join("<br/>");
}

export async function sendReadyForPickupEmail(
  input: SendReadyForPickupEmailInput,
): Promise<SendReadyForPickupEmailResult> {
  const { toEmail, stripeSessionId, location } = input;

  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open — the admin route logs and skips. A missing SendGrid
      // key must NOT 500 the ready-for-pickup endpoint.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const subject = "Your PennPaps order is ready for pickup";
  const orderUrl = `${publicBaseUrl(input.baseUrlOverride)}/shop/checkout-success?session_id=${encodeURIComponent(stripeSessionId)}`;

  // ---------- text body ----------
  const textLines: string[] = [
    "Good news — your PennPaps order is ready to pick up.",
    "",
    "Pick up at:",
    ...locationTextLines(location).map((l) => `  ${l}`),
    "",
    "Please bring a photo ID matching the order. " +
      "If someone else is collecting on your behalf, let us know in advance.",
    "",
    `View your order: ${orderUrl}`,
  ];
  const text = textLines.join("\n");

  // ---------- html body ----------
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
              <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">Ready for pickup</div>
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;color:#333;font-size:15px;line-height:1.5;">
              Good news &mdash; your PennPaps order is ready to pick up.
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7e8;border:1px solid #ecdfa6;border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;color:#5a4400;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;font-weight:700;">Pick up at</td>
                </tr>
                <tr>
                  <td style="padding:0 16px 14px 16px;color:#1a1a1a;font-size:15px;line-height:1.5;">
                    ${locationHtml(location)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:#c9a227;color:#1a1a1a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">View order</a>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
              Please bring a photo ID matching the order. If someone else is collecting on your behalf, let us know in advance.
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
        kind: "shop_ready_for_pickup_v1",
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
