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
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  escapeHtml,
  infoPanel,
  paragraph,
  renderBrandedEmail,
  subheading,
  textParagraph,
} from "@workspace/resupply-email";

import {
  type PayerEstimate,
  formatEstimateRange,
} from "../insurance-estimates/data";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
} from "./link-base.js";

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
  /**
   * Tenant the lead belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendInsuranceEstimateEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

export async function sendInsuranceEstimateEmail(
  input: SendInsuranceEstimateEmailInput,
): Promise<SendInsuranceEstimateEmailResult> {
  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's email carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const { estimate } = input;
  const base = await resolvePatientEmailLinkBase(
    input.orgId,
    input.baseUrlOverride,
  );
  if (!base) {
    return {
      configured: true,
      delivered: false,
      error: TENANT_DOMAIN_REQUIRED,
    };
  }
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
    `—The ${brandName} team`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  // The two next-step choices stay a hand-built table — they are a genuine
  // either/or, not one primary CTA.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "Coverage estimate",
    heading: estimate.label,
    preheader: `Typical patient pays ${range} per resupply, post-deductible.`,
    contentHtml: [
      infoPanel({
        tone: "info",
        html: `<div style="text-align:center;">
<p style="margin:0;font-size:13px;color:${BREATHE_COLORS.muted};">Typical patient pays per resupply (post-deductible)</p>
<p style="margin:6px 0 0;font-size:28px;font-weight:700;color:${BREATHE_COLORS.ink};">${escapeHtml(range)}</p>
</div>`,
      }),
      textParagraph(estimate.note),
      input.zip
        ? paragraph(
            `ZIP we have on file for you: <strong>${escapeHtml(input.zip)}</strong>`,
          )
        : "",
      `<p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-style:italic;color:${BREATHE_COLORS.muted};">This is an estimate, not a quote. We verify your specific plan&#39;s DME benefit before any charge.</p>`,
      subheading("What's next"),
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 6px;">
<tr>
<td style="padding-right:8px;">
<a href="${escapeHtml(consentUrl)}" style="display:block;background:${BREATHE_COLORS.blue};color:#ffffff;text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;">Start at-home mask fitting</a>
</td>
<td style="padding-left:8px;">
<a href="${escapeHtml(insuranceFullFormUrl)}" style="display:block;background:#ffffff;color:${BREATHE_COLORS.blue};text-decoration:none;text-align:center;padding:12px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;border:1px solid ${BREATHE_COLORS.blue};">Verify my plan</a>
</td>
</tr>
</table>`,
    ]
      .filter(Boolean)
      .join("\n"),
    footerLines: [`The ${brandName} team`],
    copyrightName: brandName,
  });

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
