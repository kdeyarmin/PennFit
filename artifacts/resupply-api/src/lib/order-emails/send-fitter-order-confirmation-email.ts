// sendFitterOrderConfirmationEmail — patient-facing confirmation
// email fired right after a fitter order is successfully delivered
// to the fulfillment team.
//
// Why
// ---
// /api/orders today emails the fulfillment team (sendOrderToPenn)
// and renders an in-app "Order received" success card. The patient
// gets nothing in their inbox — no written record of the reference,
// the mask they chose, or what happens next. That's the source of
// the most common inbound CSR question after an order ("did you
// receive my order?") and a meaningful trust gap.
//
// This helper closes the loop:
//
//   1. Mirrors back the order reference + mask name so the patient
//      can search their inbox for it later.
//   2. Sets a clear "what happens next" expectation — insurance
//      verification within 1 business day, then prescription
//      coordination, then shipping.
//   3. Provides a clean fall-back contact path (reply-to the email
//      or visit /account).
//
// Fail-open posture
// -----------------
// A SendGrid outage or missing-config must NOT 5xx the order POST.
// The patient's primary expectation is that the fulfillment team
// received the order — the confirmation email is a comfort signal
// on top of that. The route calls this best-effort.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendFitterOrderConfirmationInput {
  toEmail: string;
  /** Optional first name for the greeting. */
  firstName?: string | null;
  /** Six-letter reference shown to the patient on /order-success. */
  orderReference: string;
  /** Mask the patient picked. */
  maskName: string;
  maskManufacturer?: string | null;
  /** Optional override; otherwise pulled from env. */
  baseUrlOverride?: string;
}

export interface SendFitterOrderConfirmationResult {
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

export async function sendFitterOrderConfirmationEmail(
  input: SendFitterOrderConfirmationInput,
): Promise<SendFitterOrderConfirmationResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const base = publicBaseUrl(input.baseUrlOverride);
  const accountUrl = `${base}/account`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const maskLine = input.maskManufacturer
    ? `${input.maskManufacturer} ${input.maskName}`
    : input.maskName;

  const subject = `Order received — ${input.orderReference}`;

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    `We received your CPAP mask order. Reference: ${input.orderReference}`,
    "",
    `Selected mask: ${maskLine}`,
    "",
    "What happens next:",
    "  1. We verify your insurance benefits. (Within 1 business day.)",
    "  2. We coordinate the prescription with your physician.",
    "  3. We ship the mask once both are squared away. You'll get a",
    "     separate email with tracking when it leaves our warehouse.",
    "",
    "You don't need to do anything yet. If we hit a snag with insurance",
    "or the prescription, we'll reach out before charging anything.",
    "",
    `Track or update your order anytime: ${accountUrl}`,
    "",
    "Reply to this email if you have any questions — a real human picks",
    "it up.",
    "",
    "—The PennPaps team",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <p style="margin:0;font-size:12px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;">Order received</p>
          <h1 style="margin:6px 0 0;font-size:22px;font-weight:600;">Reference ${escapeHtml(input.orderReference)}</h1>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#3c4458;">
            Thanks — we received your CPAP mask order and a real human will pick it up within one business day.
          </p>
          <div style="margin:0 0 18px;padding:14px 16px;border-radius:8px;background:#0f1d3a08;">
            <p style="margin:0;font-size:12px;color:#5a6478;text-transform:uppercase;letter-spacing:0.06em;">Selected mask</p>
            <p style="margin:4px 0 0;font-size:16px;font-weight:600;color:#1a1f36;">${escapeHtml(maskLine)}</p>
          </div>
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#1a1f36;">What happens next</p>
          <ol style="margin:0 0 18px;padding:0 0 0 20px;font-size:13px;line-height:1.6;color:#3c4458;">
            <li>We verify your insurance benefits. (Within 1 business day.)</li>
            <li>We coordinate the prescription with your physician.</li>
            <li>We ship the mask once both are squared away &mdash; you&apos;ll get a separate email with tracking when it leaves our warehouse.</li>
          </ol>
          <p style="margin:0 0 18px;font-size:13px;line-height:1.55;color:#3c4458;">
            You don&apos;t need to do anything yet. If we hit a snag with insurance or the prescription, we&apos;ll reach out before charging anything.
          </p>
          <a href="${escapeHtml(accountUrl)}" style="display:inline-block;background:#0f1d3a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">Track in my account</a>
          <p style="margin:18px 0 0;font-size:12px;color:#8b95a9;">
            Reply to this email with questions &mdash; a real human picks it up.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          The PennPaps team
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject,
      text,
      html,
      customArgs: {
        kind: "fitter_order_confirmation",
        order_reference: input.orderReference,
      },
    });
    return {
      configured: true,
      delivered: true,
      messageId: result.messageId,
    };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return { configured: true, delivered: false, error: err.message };
    }
    throw err;
  }
}
