// sendInsuranceEstimateEmail — transactional confirmation for the
// /insurance/estimate quick-coverage check.
//
// Why
// ---
// The patient typed their payer + email into the estimator. We owe
// them a written acknowledgement that:
//
//   1. Documents the range we showed them on the page (so they
//      have it in writing and can share it with a spouse).
//   2. Sets a clear expectation about the next step ("we verify
//      your specific plan within one business day").
//   3. Gives them a low-friction path to either start the camera
//      fitting (/consent) or submit the full insurance form so we
//      can actually run their member-id.
//
// Under CAN-SPAM this is transactional — the patient explicitly
// requested a written estimate when they hit submit. The full
// estimator-page form intentionally doesn't have a marketing
// opt-in; downstream campaigns require the patient to opt in
// later (via /consent or /account#comm-prefs).

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import {
  type PayerEstimate,
  formatEstimateRange,
} from "../insurance-estimates/data";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendInsuranceEstimateEmailInput {
  toEmail: string;
  estimate: PayerEstimate;
  /**
   * Optional ZIP code the patient typed on the form. Persisted on
   * the lead row's notes column server-side; included in the email
   * so the patient can confirm we have the right service area.
   */
  zip?: string | null;
  baseUrlOverride?: string;
}

export interface SendInsuranceEstimateEmailResult {
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

export async function sendInsuranceEstimateEmail(
  input: SendInsuranceEstimateEmailInput,
): Promise<SendInsuranceEstimateEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const { estimate } = input;
  const base = publicBaseUrl(input.baseUrlOverride);
  const consentUrl = `${base}/consent`;
  const insuranceFullFormUrl = `${base}/insurance`;
  const range = formatEstimateRange(estimate);

  const subject = `Your CPAP coverage estimate — ${estimate.label}`;

  const text = [
    "Hi,",
    "",
    `You asked for a quick CPAP-supplies coverage estimate for ${estimate.label}.`,
    "",
    `Most patients on this plan pay ${range} per quarterly resupply after the deductible is met.`,
    "",
    estimate.note,
    "",
    input.zip ? `ZIP we have on file for you: ${input.zip}` : "",
    "",
    "This is an estimate, not a quote. We verify your specific plan's DME benefit before any charge.",
    "",
    "What's next:",
    `  • Start the at-home mask fitting (your insurance carrier on file): ${consentUrl}`,
    `  • Submit your member-id so we can verify in 1 business day: ${insuranceFullFormUrl}`,
    "",
    "—The PennPaps team",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <p style="margin:0;font-size:12px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;">Coverage estimate</p>
          <h1 style="margin:6px 0 0;font-size:22px;font-weight:600;">${escapeHtml(estimate.label)}</h1>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <div style="margin:0 0 18px;padding:18px;border-radius:10px;background:#0f1d3a08;text-align:center;">
            <p style="margin:0;font-size:13px;color:#5a6478;">Typical patient pays per resupply (post-deductible)</p>
            <p style="margin:6px 0 0;font-size:28px;font-weight:700;color:#0f1d3a;">${escapeHtml(range)}</p>
          </div>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#3c4458;">
            ${escapeHtml(estimate.note)}
          </p>
          ${input.zip ? `<p style="margin:0 0 16px;font-size:13px;color:#5a6478;">ZIP we have on file for you: <strong>${escapeHtml(input.zip)}</strong></p>` : ""}
          <p style="margin:0 0 18px;font-size:12px;font-style:italic;color:#8b95a9;">
            This is an estimate, not a quote. We verify your specific plan&apos;s DME benefit before any charge.
          </p>
          <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#1a1f36;">What&apos;s next</p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 6px;">
            <tr>
              <td style="padding-right:8px;">
                <a href="${escapeHtml(consentUrl)}" style="display:block;background:#0f1d3a;color:#ffffff;text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-size:14px;font-weight:600;">Start at-home mask fitting</a>
              </td>
              <td style="padding-left:8px;">
                <a href="${escapeHtml(insuranceFullFormUrl)}" style="display:block;background:#ffffff;color:#0f1d3a;text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-size:14px;font-weight:600;border:1px solid #0f1d3a;">Verify my plan</a>
              </td>
            </tr>
          </table>
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
        kind: "insurance_estimate",
        payer_slug: estimate.slug,
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
