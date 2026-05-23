// sendReturnStatusEmail — one helper for the two customer-facing
// transitions in the RMA workflow that the patient otherwise has to
// discover by checking /account:
//
//   * approved  — staff cleared the request; tell the patient how
//                 to send it back (carrier + tracking link), or
//                 that "no return shipment is required" when the
//                 label fields are absent (rare — staff-issued
//                 refund without intake).
//   * refunded  — the Stripe refund has been issued; tell the
//                 patient how much, in what currency, and to expect
//                 5-10 business days for it to land on the card.
//
// Privacy: subject lines are PHI-free ("Your PennPaps return is
// approved", "Your PennPaps refund is on the way"). The body
// references the order's last 4 of the Stripe session ID for
// disambiguation; we deliberately do NOT include patient name,
// address, or any prescription detail. The recipient email is
// never logged.
//
// Failure mode: returns a tagged-union result so the caller can
// branch without try/catch. NEVER throws — a SendGrid 5xx must not
// block the lifecycle transition that already succeeded in the DB.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export type ReturnStatusKind = "approved" | "refunded";

export interface SendReturnStatusEmailInput {
  kind: ReturnStatusKind;
  toEmail: string;
  /** Stripe session id (`cs_...`). Last 8 chars render in the body for disambiguation. */
  stripeSessionId: string;
  /** Resupply shop_returns row id — round-trips on customArgs for bounce correlation. */
  returnId: string;
  /** Required when kind === "refunded". USD cents. Ignored when kind === "approved". */
  refundCents?: number | null;
  /** Required when kind === "refunded". Stripe currency code (lowercase). Defaults to "usd". */
  currency?: string | null;
  /** Optional when kind === "approved" — carrier name shown next to the tracking link. */
  returnCarrier?: string | null;
  /** Optional when kind === "approved" — tracking number for the return label. */
  returnTrackingNumber?: string | null;
  /** Optional when kind === "approved" — direct link to the prepaid return label PDF. */
  returnLabelUrl?: string | null;
  /** Optional override for the public base URL. */
  baseUrlOverride?: string;
}

export interface SendReturnStatusEmailResult {
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

function formatMoney(cents: number, currency: string): string {
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

function lastChars(id: string, n: number): string {
  return id.length <= n ? id : id.slice(-n);
}

function buildApprovedBody(
  input: SendReturnStatusEmailInput,
  myReturnsUrl: string,
): { subject: string; html: string; text: string } {
  const orderTail = lastChars(input.stripeSessionId, 8);
  const subject = "Your PennPaps return is approved";

  // Carrier + tracking + label panel are conditional — staff sometimes
  // approves a return without issuing a label (e.g. exchange where the
  // customer keeps the original item). Render whichever fields are
  // present so the email reads cleanly in either shape.
  const carrier = input.returnCarrier?.trim();
  const tracking = input.returnTrackingNumber?.trim();
  const labelUrl = input.returnLabelUrl?.trim();

  const textParts: string[] = [
    "Good news — your return is approved.",
    "",
    `Order: ...${orderTail}`,
    "",
  ];
  if (labelUrl) {
    textParts.push(`Print your prepaid return label: ${labelUrl}`);
  }
  if (carrier || tracking) {
    textParts.push(
      `Carrier: ${carrier ?? "—"}${tracking ? ` (tracking ${tracking})` : ""}`,
    );
  }
  if (!labelUrl && !carrier && !tracking) {
    textParts.push(
      "No return shipment is required — our team will be in touch about next steps.",
    );
  }
  textParts.push("");
  textParts.push(`See all your returns: ${myReturnsUrl}`);
  const text = textParts.join("\n");

  const labelBlock = labelUrl
    ? `<tr><td style="padding-top:16px;"><a href="${escapeHtml(labelUrl)}" style="display:inline-block;background:#c9a227;color:#1a1a1a;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">Print your return label</a></td></tr>`
    : "";
  const carrierBlock =
    carrier || tracking
      ? `<tr><td style="padding-top:12px;color:#555;font-size:14px;">Carrier: <strong>${escapeHtml(carrier ?? "—")}</strong>${tracking ? ` &middot; Tracking: <strong>${escapeHtml(tracking)}</strong>` : ""}</td></tr>`
      : "";
  const noShipmentBlock =
    !labelUrl && !carrier && !tracking
      ? `<tr><td style="padding-top:12px;color:#555;font-size:14px;">No return shipment is required &mdash; our team will be in touch about next steps.</td></tr>`
      : "";

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
      <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a227;">
        <div style="font-size:14px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">PennPaps</div>
        <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">Your return is approved</div>
      </td></tr>
      <tr><td style="padding-top:20px;color:#333;font-size:15px;line-height:1.5;">
        Good news &mdash; we've approved your return on order <strong>&hellip;${escapeHtml(orderTail)}</strong>.
      </td></tr>
      ${labelBlock}
      ${carrierBlock}
      ${noShipmentBlock}
      <tr><td style="padding-top:24px;"><a href="${escapeHtml(myReturnsUrl)}" style="color:#7a5d00;font-size:13px;text-decoration:underline;">View all your returns</a></td></tr>
      <tr><td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
        You're receiving this because you opened a return request at PennPaps. Reply to this email and our team will help.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

  return { subject, html, text };
}

function buildRefundedBody(
  input: SendReturnStatusEmailInput,
  myReturnsUrl: string,
): { subject: string; html: string; text: string } {
  const cents = input.refundCents ?? 0;
  const currency = (input.currency ?? "usd").toLowerCase();
  const amount = formatMoney(cents, currency);
  const orderTail = lastChars(input.stripeSessionId, 8);
  const subject = "Your PennPaps refund is on the way";

  const text = [
    `We've issued your refund of ${amount}.`,
    "",
    `Order: ...${orderTail}`,
    "",
    "Refunds typically take 5-10 business days to land back on the card you paid with. The amount will appear on your statement under PennPaps.",
    "",
    `See all your returns: ${myReturnsUrl}`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
      <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a227;">
        <div style="font-size:14px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">PennPaps</div>
        <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">Refund issued</div>
      </td></tr>
      <tr><td style="padding-top:20px;color:#333;font-size:15px;line-height:1.5;">
        We've issued your refund of <strong>${escapeHtml(amount)}</strong> on order <strong>&hellip;${escapeHtml(orderTail)}</strong>.
      </td></tr>
      <tr><td style="padding-top:16px;color:#555;font-size:14px;line-height:1.5;">
        Refunds typically take <strong>5-10 business days</strong> to land back on the card you paid with. The amount will appear on your statement under <strong>PennPaps</strong>.
      </td></tr>
      <tr><td style="padding-top:24px;"><a href="${escapeHtml(myReturnsUrl)}" style="color:#7a5d00;font-size:13px;text-decoration:underline;">View all your returns</a></td></tr>
      <tr><td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
        Questions? Reply to this email and our team will help.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

  return { subject, html, text };
}

export async function sendReturnStatusEmail(
  input: SendReturnStatusEmailInput,
): Promise<SendReturnStatusEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    return {
      configured: false,
      delivered: false,
      error: err instanceof Error ? err.message : "email_client_init_failed",
    };
  }

  const myReturnsUrl = `${publicBaseUrl(input.baseUrlOverride)}/account/returns`;
  const body =
    input.kind === "approved"
      ? buildApprovedBody(input, myReturnsUrl)
      : buildRefundedBody(input, myReturnsUrl);

  try {
    const { messageId } = await client.sendEmail({
      to: input.toEmail,
      subject: body.subject,
      html: body.html,
      text: body.text,
      customArgs: {
        kind:
          input.kind === "approved"
            ? "return_approved_v1"
            : "return_refunded_v1",
        return_id: input.returnId,
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
