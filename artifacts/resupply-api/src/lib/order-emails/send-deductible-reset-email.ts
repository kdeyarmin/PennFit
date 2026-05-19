// sendDeductibleResetEmail — late-fall "stock up before Jan 1" push.
//
// Why
// ---
// US insurance deductibles and out-of-pocket maxes reset on January 1
// for the vast majority of plans. Patients who hit their deductible
// pay $0 out-of-pocket for in-network supplies through year-end, but
// drop back to full coinsurance / deductible the moment the calendar
// flips. A November "stock up now while you're still in-network and
// the deductible is satisfied" reminder is industry standard for
// any DME supplier and a meaningful Q4 revenue lever.
//
// This is marketing under CAN-SPAM (it's promoting a transaction
// the patient hasn't asked for yet). The dispatcher checks
// communication_preferences.emailMarketing before calling this
// helper, and the email itself carries an unsubscribe link to
// /account#comm-prefs.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendDeductibleResetEmailInput {
  toEmail: string;
  firstName?: string | null;
  baseUrlOverride?: string;
}

export interface SendDeductibleResetEmailResult {
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

export async function sendDeductibleResetEmail(
  input: SendDeductibleResetEmailInput,
): Promise<SendDeductibleResetEmailResult> {
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
  const shopUrl = `${base}/shop`;
  const prefsUrl = `${base}/account#comm-prefs`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const subject = "Use your benefits before January 1";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    "Your insurance deductible and out-of-pocket max reset on January 1.",
    "If you've already hit them this year, supplies you order before",
    "the calendar flips are likely $0 out-of-pocket — and full price",
    "in January.",
    "",
    "Common stock-up list:",
    "  • Replacement cushion or full mask",
    "  • Hose (annual replacement under most plans)",
    "  • Filters (every 1-3 months)",
    "",
    "Bookmark a reorder while it's covered:",
    shopUrl,
    "",
    "—The PennPaps team",
    "",
    `Unsubscribe from year-end reminders: ${prefsUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <h1 style="margin:0;font-size:20px;font-weight:600;">Use your benefits before January&nbsp;1</h1>
          <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">Your deductible resets when the calendar flips.</p>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#3c4458;">
            Your insurance deductible and out-of-pocket max reset on January&nbsp;1.
            If you&apos;ve already hit them this year, supplies you order before the
            calendar flips are likely <strong>$0 out-of-pocket</strong> — and full
            price in January.
          </p>
          <div style="margin:18px 0;padding:14px 16px;border-radius:8px;background:#0f1d3a08;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#1a1f36;">Common stock-up list</p>
            <ul style="margin:0;padding:0 0 0 18px;font-size:13px;line-height:1.55;color:#3c4458;">
              <li>Replacement cushion or full mask</li>
              <li>Hose (annual replacement under most plans)</li>
              <li>Filters (every 1-3 months)</li>
            </ul>
          </div>
          <a href="${escapeHtml(shopUrl)}" style="display:inline-block;background:#0f1d3a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">Bookmark your reorder</a>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          The PennPaps team &nbsp;·&nbsp;
          <a href="${escapeHtml(prefsUrl)}" style="color:#0f1d3a;text-decoration:none;">Unsubscribe from year-end reminders</a>
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
      customArgs: { kind: "deductible_reset" },
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
