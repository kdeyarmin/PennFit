// Back-in-stock notification email — single SendGrid message sent to
// a patient when a SKU they signed up to watch returns to stock.
// Fire-and-forget: if SendGrid is unconfigured or returns an error,
// we still stamp `notified_at` (the patient does not get a second
// chance — if delivery failed for a transient reason ops can re-add
// them; we don't want to spam on every subsequent stock save).
//
// Templated since 2026-05-08: the subject + bodyText + bodyHtml run
// through `renderMessage` with templateKey "shop.back_in_stock.email".
// Admins can edit the copy via /admin/templates without a deploy;
// fallback strings below match the previous behaviour byte-for-byte
// when no template row exists. Because back_in_stock_notifications
// holds (product_id, email) without a shop_customers customerId,
// per-customer overrides don't apply on this surface today —
// customerId is null on every send. Cross-referencing by email at
// lookup time is a separate enhancement.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import { renderMessage } from "@workspace/resupply-templates";

import { messageTemplateLookup } from "./message-templates/lookup";

export interface BackInStockEmailPayload {
  email: string;
  productId: string;
  productName: string;
  productImageUrl?: string | null;
  productUrl: string;
  priceLabel?: string | null;
}

export interface BackInStockEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The HTML img fragment when an image URL is present, empty string
 * otherwise. Pre-rendered so the template body can interpolate
 * `{{image_block_html}}` as a single token rather than carry
 * conditional logic.
 */
function renderImageBlockHtml(productImageUrl: string | null): string {
  if (!productImageUrl) return "";
  return `<tr><td align="center" style="padding:8px 0 18px;">
         <img src="${escapeHtml(productImageUrl)}" alt="" width="220" style="display:block;border-radius:10px;max-width:220px;height:auto;" />
       </td></tr>`;
}

/**
 * The HTML price fragment when a label is present, empty string
 * otherwise. Same shape as `renderImageBlockHtml`.
 */
function renderPriceBlockHtml(priceLabel: string | null): string {
  if (!priceLabel) return "";
  return `<div style="font-size:18px;font-weight:700;color:#0a1f44;margin-top:6px;">${escapeHtml(priceLabel)}</div>`;
}

function renderHtml(p: BackInStockEmailPayload): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a24a;">
          <div style="font-size:13px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">PennPaps · Back in stock</div>
          <div style="font-size:22px;color:#0a1f44;font-weight:700;margin-top:4px;">${escapeHtml(p.productName)} is available again</div>
        </td></tr>
        ${renderImageBlockHtml(p.productImageUrl ?? null)}
        <tr><td style="padding-top:18px;color:#333;font-size:15px;line-height:1.55;">
          Good news — the item you asked us to watch is back in stock at PennPaps. Stock can run low quickly, so grab one while it's available.
          ${renderPriceBlockHtml(p.priceLabel ?? null)}
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${escapeHtml(p.productUrl)}" style="display:inline-block;background:#c9a24a;color:#0a1f44;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;">View product</a>
        </td></tr>
        <tr><td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
          You're receiving this because you signed up for a back-in-stock alert on pennpaps.com. We'll only email you once per signup.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function renderText(p: BackInStockEmailPayload): string {
  const lines = [
    `${p.productName} is back in stock at PennPaps.`,
    "",
    "Stock can run low quickly, so grab one while it's available:",
    p.productUrl,
  ];
  if (p.priceLabel) lines.splice(1, 0, p.priceLabel);
  lines.push(
    "",
    "You're receiving this because you signed up for a back-in-stock alert on pennpaps.com. We only email once per signup.",
  );
  return lines.join("\n");
}

/**
 * Build the variable dictionary for the templated path. Variables
 * that go into HTML positions are pre-escaped as `*_html` siblings —
 * the template author chooses the right one for each context. Same
 * pattern we'd use for any future HTML template wrap.
 */
function buildVariables(p: BackInStockEmailPayload): Record<string, string> {
  return {
    product_name: p.productName,
    product_name_html: escapeHtml(p.productName),
    product_url: p.productUrl,
    product_url_html: escapeHtml(p.productUrl),
    price_label: p.priceLabel ?? "",
    image_block_html: renderImageBlockHtml(p.productImageUrl ?? null),
    price_block_html: renderPriceBlockHtml(p.priceLabel ?? null),
  };
}

export async function sendBackInStockEmail(
  payload: BackInStockEmailPayload,
): Promise<BackInStockEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Fallback strings preserve byte-for-byte the prior behaviour when
  // no template row exists or the lookup fails.
  const rendered = await renderMessage(
    {
      templateKey: "shop.back_in_stock.email",
      channel: "email",
      // Per the file header: this surface keys on (product_id, email)
      // without a shop_customers id, so per-customer overrides don't
      // apply today.
      customerId: null,
      variables: buildVariables(payload),
    },
    {
      subject: `Back in stock: ${payload.productName}`,
      bodyHtml: renderHtml(payload),
      bodyText: renderText(payload),
    },
    messageTemplateLookup,
  );

  try {
    await client.sendEmail({
      to: payload.email,
      subject: rendered.subject ?? "",
      html: rendered.bodyHtml ?? rendered.bodyText,
      text: rendered.bodyText,
      customArgs: {
        kind: "back_in_stock_v1",
        product_id: payload.productId,
      },
    });
    return { configured: true, delivered: true };
  } catch (err) {
    const msg =
      err instanceof EmailApiError
        ? `SendGrid ${err.status ?? "?"}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { configured: true, delivered: false, error: msg };
  }
}

// Test seam: re-export the pure renderers so the parity test can
// assert byte-identical fallback output. Keeping them un-exported
// from the module's public surface (only needed in tests) is
// possible but adds friction with the build chain; the test
// imports them via this named export.
export const __forTests = {
  renderHtml,
  renderText,
  buildVariables,
};
