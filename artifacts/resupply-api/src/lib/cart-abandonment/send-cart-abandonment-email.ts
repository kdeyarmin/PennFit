// sendCartAbandonmentEmail — single-shot SendGrid nudge for a
// signed-in shop visitor who left items in their cart >24h ago.
//
// Runs from the admin dispatcher (POST /admin/shop/abandoned-carts/
// send-due). Returns a tagged-union outcome so the dispatcher can
// branch without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Privacy:
//   - The recipient email is never logged.
//   - The cart contents (Stripe price/product IDs, names, qty) are
//     PUBLIC catalog data — safe to render in the body.
//   - We deliberately do NOT include any PHI; this is the cash-pay
//     shop, not the resupply outreach surface, so there's none to
//     leak. The subject line mentions item count only.
//
// Template:
//   - Subject:   "You left {N} items in your PennPaps cart"
//   - HTML body: brand banner, item list (qty × name @ unit price),
//                subtotal, primary CTA "Return to your cart" linking
//                to ${SHOP_PUBLIC_BASE_URL}/shop/cart?resume=1, footer
//                "You're receiving this because you started a checkout
//                at PennPaps. Reply STOP if you don't want to hear
//                about your cart again." (the STOP wording is for
//                customer reassurance — there's no opt-out wiring in
//                v1; one nudge per cart-event is the entire policy).

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import type { ShopAbandonedCartItem } from "@workspace/resupply-db";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendCartAbandonmentEmailInput {
  toEmail: string;
  items: readonly ShopAbandonedCartItem[];
  subtotalCents: number;
  currency: string;
  /**
   * Optional override for the public base URL. Defaults to
   * SHOP_PUBLIC_BASE_URL env var, falling back to https://pennpaps.com
   * so links emitted from preview/staging deploys still resolve to
   * production.
   */
  baseUrlOverride?: string;
}

export interface SendCartAbandonmentEmailResult {
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
    // Unknown currency code: fall back to plain "$X.XX".
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

export async function sendCartAbandonmentEmail(
  input: SendCartAbandonmentEmailInput,
): Promise<SendCartAbandonmentEmailResult> {
  const { toEmail, items, subtotalCents, currency } = input;

  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open here (return configured: false) — the dispatcher
      // logs and skips. We never throw on misconfig out of this
      // helper; the admin route surfaces the configured flag so the
      // operator sees the warning.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const itemCount = items.reduce((sum, it) => sum + it.quantity, 0);
  const subject = `You left ${itemCount} item${itemCount === 1 ? "" : "s"} in your PennPaps cart`;

  const cartUrl = `${publicBaseUrl(input.baseUrlOverride)}/shop/cart?resume=1`;
  const browseUrl = `${publicBaseUrl(input.baseUrlOverride)}/shop`;

  // Plain-text body — many corporate filters drop HTML-only mail.
  const textLines: string[] = [
    `You still have ${itemCount} item${itemCount === 1 ? "" : "s"} waiting in your cart at PennPaps.`,
    "",
  ];
  for (const it of items) {
    textLines.push(
      `  - ${it.quantity} x ${it.name} (${formatMoney(it.unitAmountCents, it.currency)} each)` +
        (it.mode === "subscription" && it.recurringIntervalLabel
          ? ` -- subscribe & ship every ${it.recurringIntervalLabel}`
          : ""),
    );
  }
  textLines.push("");
  textLines.push(`Subtotal: ${formatMoney(subtotalCents, currency)}`);
  textLines.push("");
  textLines.push(`Return to your cart: ${cartUrl}`);
  textLines.push(`Browse the shop: ${browseUrl}`);
  textLines.push("");
  textLines.push(
    "You're receiving this because you started a checkout at PennPaps. " +
      "We send one of these per cart at most.",
  );
  const text = textLines.join("\n");

  // HTML body — sober, brand-consistent. Inline styles only (most
  // mail clients strip <style> blocks).
  const itemRows = items
    .map(
      (it) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;">
            <div style="font-weight:600;color:#1a1a1a;">${escapeHtml(it.name)}</div>
            ${
              it.mode === "subscription" && it.recurringIntervalLabel
                ? `<div style="font-size:12px;color:#7a5d00;margin-top:2px;">Subscribe &amp; ship every ${escapeHtml(it.recurringIntervalLabel)}</div>`
                : ""
            }
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#555;">
            ${it.quantity} &times; ${escapeHtml(formatMoney(it.unitAmountCents, it.currency))}
          </td>
        </tr>`,
    )
    .join("");

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
              <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">You left items in your cart</div>
            </td>
          </tr>
          <tr>
            <td style="padding-top:20px;color:#333;font-size:15px;line-height:1.5;">
              You started a checkout at PennPaps but didn't finish. Your cart is still saved &mdash; pick up right where you left off.
            </td>
          </tr>
          <tr>
            <td style="padding-top:16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${itemRows}
                <tr>
                  <td style="padding:12px 0 0 0;font-weight:700;color:#1a1a1a;">Subtotal</td>
                  <td style="padding:12px 0 0 0;text-align:right;font-weight:700;color:#1a1a1a;">${escapeHtml(formatMoney(subtotalCents, currency))}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;">
              <a href="${escapeHtml(cartUrl)}" style="display:inline-block;background:#c9a227;color:#1a1a1a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">Return to your cart</a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:12px;">
              <a href="${escapeHtml(browseUrl)}" style="color:#7a5d00;font-size:13px;text-decoration:underline;">or browse the shop</a>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
              You're receiving this because you started a checkout at PennPaps. We send one of these per cart at most.
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
      customArgs: { kind: "cart_abandonment_v1" },
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
