// sendWinbackEmail — soft "we miss you" outreach for customers who
// haven't ordered in 6+ months.
//
// Why
// ---
// Customers who lapse for half a year are a low-cost reactivation
// target — they already know the brand, already have an account
// with a saved address (and often card), and the next purchase
// requires only a click. A tasteful win-back with a small
// re-engagement nudge ("here's what's new") recovers a
// double-digit percentage of lapsed customers in DME industry
// benchmarks.
//
// This is marketing under CAN-SPAM. The dispatcher checks
// communication_preferences.emailMarketing before calling and
// the email itself carries an unsubscribe link.
//
// Idempotency happens at the dispatcher level via the
// shop_customers.winback_sent_at column — we never send more than
// one win-back per customer per 12 months.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendWinbackEmailInput {
  toEmail: string;
  firstName?: string | null;
  /**
   * Approximate months since the customer's last order. Used only in
   * copy — "it's been about 8 months since we last shipped to you."
   */
  monthsSinceLastOrder: number;
  baseUrlOverride?: string;
}

export interface SendWinbackEmailResult {
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

export async function sendWinbackEmail(
  input: SendWinbackEmailInput,
): Promise<SendWinbackEmailResult> {
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
  const accountUrl = `${base}/account`;
  const prefsUrl = `${base}/account#comm-prefs`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const subject = "It's been a while — quick CPAP check-in";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    `It's been about ${input.monthsSinceLastOrder} months since we last shipped to you,`,
    "and we wanted to check in. CPAP supplies have replacement cadences for a",
    "reason — cushions stiffen, filters clog, hoses develop holes — and skipping",
    "replacement is the single biggest reason therapy slips.",
    "",
    "If you've stopped CPAP therapy, no judgment — we'd just love to know.",
    "If you've moved to a different supplier, also fine. If you've stayed on",
    "therapy but your supplies are due, your saved address and (often) card",
    "are still on file:",
    "",
    `Reorder: ${shopUrl}`,
    `Account: ${accountUrl}`,
    "",
    "—The PennPaps team",
    "",
    `Unsubscribe from re-engagement emails: ${prefsUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <h1 style="margin:0;font-size:20px;font-weight:600;">It&apos;s been a while</h1>
          <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">Quick CPAP check-in</p>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#3c4458;">
            It&apos;s been about <strong>${input.monthsSinceLastOrder} months</strong> since we last shipped to you, and we wanted to check in.
            CPAP supplies have replacement cadences for a reason — cushions stiffen, filters clog, hoses develop holes — and skipping replacement is the single biggest reason therapy slips.
          </p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#3c4458;">
            If you&apos;ve stopped CPAP therapy, no judgment. If you&apos;ve moved to a different supplier, also fine.
            If you&apos;ve stayed on therapy but your supplies are due, your saved address and (often) card are still on file.
          </p>
          <a href="${escapeHtml(shopUrl)}" style="display:inline-block;background:#0f1d3a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">Reorder supplies</a>
          &nbsp;
          <a href="${escapeHtml(accountUrl)}" style="display:inline-block;color:#0f1d3a;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;border:1px solid #0f1d3a;">Account settings</a>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          The PennPaps team &nbsp;·&nbsp;
          <a href="${escapeHtml(prefsUrl)}" style="color:#0f1d3a;text-decoration:none;">Unsubscribe from re-engagement emails</a>
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
      customArgs: { kind: "lapsed_customer_winback" },
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
