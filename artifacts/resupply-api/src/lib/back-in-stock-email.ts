// Back-in-stock notification email — single SendGrid message sent to
// a patient when a SKU they signed up to watch returns to stock.
// Fire-and-forget: if SendGrid is unconfigured or returns an error,
// we still stamp `notified_at` (the patient does not get a second
// chance — if delivery failed for a transient reason ops can re-add
// them; we don't want to spam on every subsequent stock save).

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

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

function renderHtml(p: BackInStockEmailPayload): string {
  const img = p.productImageUrl
    ? `<tr><td align="center" style="padding:8px 0 18px;">
         <img src="${escapeHtml(p.productImageUrl)}" alt="" width="220" style="display:block;border-radius:10px;max-width:220px;height:auto;" />
       </td></tr>`
    : "";
  const price = p.priceLabel
    ? `<div style="font-size:18px;font-weight:700;color:#0a1f44;margin-top:6px;">${escapeHtml(p.priceLabel)}</div>`
    : "";
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a24a;">
          <div style="font-size:13px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">PennPaps · Back in stock</div>
          <div style="font-size:22px;color:#0a1f44;font-weight:700;margin-top:4px;">${escapeHtml(p.productName)} is available again</div>
        </td></tr>
        ${img}
        <tr><td style="padding-top:18px;color:#333;font-size:15px;line-height:1.55;">
          Good news — the item you asked us to watch is back in stock at PennPaps. Stock can run low quickly, so grab one while it's available.
          ${price}
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
  try {
    await client.sendEmail({
      to: payload.email,
      subject: `Back in stock: ${payload.productName}`,
      html: renderHtml(payload),
      text: renderText(payload),
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
