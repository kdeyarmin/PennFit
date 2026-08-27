// sendQuarterlySummaryEmail — proactive 90-day therapy rollup the
// patient can forward to their physician.
//
// Why
// ---
// The numbers live in this email (nights recorded, average usage,
// Medicare-style compliance percent, average AHI, average leak). The
// account therapy tab is pull-only — almost nobody navigates there
// proactively — so this helper fires the rollup every ~90 days at the
// cadence payers ask for it.
//
// Email body shows the headline numbers inline (so the patient can
// see them without clicking) plus a CTA to /account#therapy. Do NOT
// deep-link the auth-gated JSON route /shop/me/quarterly-summary —
// it returns 401 without a session cookie.
//
// Marketing posture
// -----------------
// The patient implicitly authorized therapy-data communications
// when they linked their device. We still gate on
// communication_preferences.emailMarketing at the dispatcher level
// — if someone opts out of all marketing, they opt out of this too.

import {
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  summaryRows,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
} from "./link-base.js";

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
  /**
   * Tenant the patient belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendQuarterlySummaryEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
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
  // Summary numbers are already in this email. The CTA opens therapy
  // (auth-gated account tab) — do NOT link /resupply-api/shop/me/…
  // which returns JSON 401 without a session cookie and confuses
  // patients who click from their inbox.
  const therapyUrl = `${base}/account#therapy`;
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
    `View therapy details in your account: ${therapyUrl}`,
    `Manage these emails: ${accountUrl}#comm-prefs`,
    "",
    `—The ${brandName} team`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "90-day CPAP summary",
    heading: `${input.windowStart} — ${input.windowEnd}`,
    // The subject already says "90-day CPAP summary"; adherence numbers are
    // additional clinical detail, so they stay inside the opened email.
    preheader:
      "Your 90-day therapy rollup is ready to share with your physician.",
    contentHtml: [
      paragraph(greeting),
      textParagraph(
        "Here's your 90-day therapy rollup. Most patients save it to PDF and forward it to their primary care doctor or sleep medicine specialist — payers ask for it too.",
      ),
      summaryRows([
        { label: "Nights recorded", value: String(f.nightsRecorded) },
        {
          label: "Nights compliant (≥4 hrs)",
          value: String(f.nightsCompliant),
        },
        { label: "Adherence rate", value: `${f.compliancePct}%` },
        { label: "Avg usage", value: fmtOptHours(f.avgUsageHours) },
        { label: "Avg AHI", value: fmtOptNum(f.avgAhi) },
        { label: "Avg leak rate", value: `${fmtOptNum(f.avgLeakLMin)} L/min` },
      ]),
      textParagraph(
        "Save this email to PDF (or screenshot the numbers) and forward it to your physician when they ask for a 90-day rollup.",
      ),
    ].join("\n"),
    button: { label: "Open therapy in your account", url: therapyUrl },
    footerHtml: `<a href="${escapeHtml(accountUrl)}#comm-prefs" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Manage these emails</a>`,
    footerLines: [`The ${brandName} team`],
    copyrightName: brandName,
  });

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
