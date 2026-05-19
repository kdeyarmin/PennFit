// sendQuarterlySummaryEmail — proactive 90-day therapy rollup the
// patient can forward to their physician.
//
// Why
// ---
// /shop/me/quarterly-summary already renders the full HTML rollup —
// nights recorded, average usage hours, Medicare-style compliance
// percent, average AHI, average leak rate. The endpoint is pull-only:
// the patient has to navigate to /account and click into it, which
// almost nobody does proactively. This helper fires the rollup as
// an email every ~90 days so it lands in the inbox at the cadence
// payers ask for it.
//
// Email body shows the headline numbers inline (so the patient can
// see them without clicking) plus a "view the full version" CTA
// into /shop/me/quarterly-summary for the printer-friendly HTML
// they can save to PDF and send to their MD.
//
// Marketing posture
// -----------------
// The patient implicitly authorized therapy-data communications
// when they linked their device. We still gate on
// communication_preferences.emailMarketing at the dispatcher level
// — if someone opts out of all marketing, they opt out of this too.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface QuarterlyFields {
  nightsRecorded: number;
  nightsCompliant: number;
  compliancePct: number;
  avgUsageHours: number | null;
  avgAhi: number | null;
  avgLeakLMin: number | null;
}

export interface SendQuarterlySummaryEmailInput {
  toEmail: string;
  firstName?: string | null;
  /** YYYY-MM-DD bounds inclusive. */
  windowStart: string;
  windowEnd: string;
  fields: QuarterlyFields;
  baseUrlOverride?: string;
}

export interface SendQuarterlySummaryEmailResult {
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

function fmtOptHours(v: number | null): string {
  return v == null ? "—" : `${v} hrs`;
}
function fmtOptNum(v: number | null): string {
  return v == null ? "—" : String(v);
}

export async function sendQuarterlySummaryEmail(
  input: SendQuarterlySummaryEmailInput,
): Promise<SendQuarterlySummaryEmailResult> {
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
  const fullSummaryUrl = `${base}/resupply-api/shop/me/quarterly-summary`;
  const accountUrl = `${base}/account`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const f = input.fields;

  const subject = `Your 90-day CPAP summary (${input.windowStart} – ${input.windowEnd})`;

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    `Here is your 90-day CPAP usage summary from ${input.windowStart} to ${input.windowEnd}.`,
    "Most patients save this to PDF and forward it to their primary care doctor",
    "or sleep medicine specialist — payers ask for it too.",
    "",
    `Nights recorded:    ${f.nightsRecorded}`,
    `Nights compliant:   ${f.nightsCompliant} (>=4 hours)`,
    `Adherence:          ${f.compliancePct}%`,
    `Avg usage:          ${fmtOptHours(f.avgUsageHours)}`,
    `Avg AHI:            ${fmtOptNum(f.avgAhi)}`,
    `Avg leak rate:      ${fmtOptNum(f.avgLeakLMin)} L/min`,
    "",
    `Print-friendly version (HTML, save to PDF in your browser): ${fullSummaryUrl}`,
    `Manage these emails: ${accountUrl}#comm-prefs`,
    "",
    "—The PennPaps team",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <p style="margin:0;font-size:12px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;">90-day CPAP summary</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:600;">${escapeHtml(input.windowStart)} &mdash; ${escapeHtml(input.windowEnd)}</h1>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#3c4458;">
            Here&apos;s your 90-day therapy rollup. Most patients save it to PDF and forward it to their primary care doctor or sleep medicine specialist &mdash; payers ask for it too.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:1px solid #eef0f5;border-radius:8px;border-collapse:separate;border-spacing:0;">
            <tr><td style="padding:8px 12px;color:#5a6478;font-size:13px;">Nights recorded</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;">${f.nightsRecorded}</td></tr>
            <tr><td style="padding:8px 12px;color:#5a6478;font-size:13px;">Nights compliant (&ge;4 hrs)</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;">${f.nightsCompliant}</td></tr>
            <tr><td style="padding:8px 12px;color:#5a6478;font-size:13px;">Adherence rate</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;">${f.compliancePct}%</td></tr>
            <tr><td style="padding:8px 12px;color:#5a6478;font-size:13px;">Avg usage</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;">${escapeHtml(fmtOptHours(f.avgUsageHours))}</td></tr>
            <tr><td style="padding:8px 12px;color:#5a6478;font-size:13px;">Avg AHI</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;">${escapeHtml(fmtOptNum(f.avgAhi))}</td></tr>
            <tr><td style="padding:8px 12px;color:#5a6478;font-size:13px;">Avg leak rate</td><td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;">${escapeHtml(fmtOptNum(f.avgLeakLMin))} L/min</td></tr>
          </table>
          <p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:#3c4458;">
            For the printer-friendly version you can save to PDF and email to your physician:
          </p>
          <p style="margin:8px 0 0;">
            <a href="${escapeHtml(fullSummaryUrl)}" style="display:inline-block;background:#0f1d3a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">Open the full summary</a>
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          The PennPaps team &nbsp;&middot;&nbsp;
          <a href="${escapeHtml(accountUrl)}#comm-prefs" style="color:#0f1d3a;text-decoration:none;">Manage these emails</a>
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
      customArgs: { kind: "quarterly_therapy_summary" },
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
