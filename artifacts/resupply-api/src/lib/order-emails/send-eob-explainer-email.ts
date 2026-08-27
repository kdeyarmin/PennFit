// sendEobExplainerEmail — patient-facing explainer when an EOB
// (Explanation of Benefits) event posts to one of their insurance
// claims.
//
// Why
// ---
// Patients open an EOB from the payer and don't understand any of
// it. "Allowed amount? Coinsurance? Adjustment?" Then they call us.
// Pre-empting that call with our own plain-language explainer is the
// single biggest billing-question deflection in DME, with the side
// benefit of building trust that we're not hiding the math.
//
// Fired from POST /patients/:id/insurance-claims/:claimId/events
// when the event_type is one of:
//
//   * 'paid'         — claim is fully paid; explain what was billed,
//                      what insurance covered, and what the patient
//                      owes.
//   * 'partial_pay'  — explain the gap.
//   * 'denied'       — explain why and what the next steps are
//                      (appeal / patient pays / write-off).
//
// Best-effort: a SendGrid outage must not 500 the event POST. The
// route catches and logs.

import {
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
} from "./link-base.js";

export type EobEventKind = "paid" | "partial_pay" | "denied";

export interface SendEobExplainerEmailInput {
  toEmail: string;
  firstName?: string | null;
  kind: EobEventKind;
  payerName: string;
  claimNumber?: string | null;
  dateOfService: string;
  totals: {
    billedCents: number;
    allowedCents: number;
    paidCents: number;
    patientResponsibilityCents: number;
  };
  denialReason?: string | null;
  baseUrlOverride?: string;
  /**
   * Tenant the patient/claim belongs to. When set and the tenant has its
   * own From identity (migration 0360), the email is sent under it (G6)
   * and the copy carries the tenant's storefront brand; otherwise the
   * platform default From/brand is used. Omit / undefined leaves it
   * unchanged.
   */
  orgId?: string;
}

export interface SendEobExplainerEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function subjectFor(kind: EobEventKind): string {
  if (kind === "paid")
    return "Insurance paid your claim — here's the breakdown";
  if (kind === "partial_pay") return "Update on your insurance claim";
  return "Your insurance claim was denied — next steps";
}

function leadFor(kind: EobEventKind, payerName: string): string {
  if (kind === "paid") {
    return `${payerName} processed your claim and paid their portion. Here's the breakdown so the EOB they mail you isn't a puzzle.`;
  }
  if (kind === "partial_pay") {
    return `${payerName} processed your claim and paid part of it. The remaining balance is your responsibility under your plan.`;
  }
  return `${payerName} denied your claim. We don't bill you yet — there are usually next steps that can change that outcome.`;
}

export async function sendEobExplainerEmail(
  input: SendEobExplainerEmailInput,
): Promise<SendEobExplainerEmailResult> {
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
  const accountUrl = `${base}/account`;
  const supportUrl = `${base}/account#messages`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const subject = subjectFor(input.kind);
  const lead = leadFor(input.kind, input.payerName);

  const t = input.totals;
  const breakdownRows = [
    { label: "We billed your insurance", value: fmtMoney(t.billedCents) },
    {
      label: "Your plan's allowed amount",
      value: fmtMoney(t.allowedCents),
    },
    { label: "Insurance paid", value: fmtMoney(t.paidCents) },
    {
      label: "Your responsibility",
      value: fmtMoney(t.patientResponsibilityCents),
    },
  ];

  const dosLine = `Date of service: ${input.dateOfService}${
    input.claimNumber ? ` · Claim #${input.claimNumber}` : ""
  }`;

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    lead,
    "",
    dosLine,
    "",
    ...breakdownRows.map((r) => `${r.label}: ${r.value}`),
    "",
    input.kind === "denied" && input.denialReason
      ? `Denial reason: ${input.denialReason}`
      : null,
    input.kind === "denied"
      ? "We'll review the denial and let you know what we can do next — file an appeal, gather more documentation, or work out a path forward together. You don't need to take action yet."
      : null,
    "",
    "Questions about this? Open a chat from your account or reply to this email.",
    "",
    `View on your account: ${accountUrl}`,
    "",
    `—The ${brandName} billing team`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const rowsHtml = breakdownRows
    .map(
      (r) =>
        `<tr><td style="padding:6px 8px;font-family:Arial,Helvetica,sans-serif;color:${BREATHE_COLORS.muted};font-size:14px;">${escapeHtml(r.label)}</td><td style="padding:6px 8px;text-align:right;font-family:Arial,Helvetica,sans-serif;font-variant-numeric:tabular-nums;font-size:14px;font-weight:600;color:${BREATHE_COLORS.ink};">${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");

  const denialBlock =
    input.kind === "denied"
      ? `
        ${input.denialReason ? `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${BREATHE_COLORS.muted};"><strong>Denial reason:</strong> ${escapeHtml(input.denialReason)}</p>` : ""}
        <p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:${BREATHE_COLORS.body};">
          We&apos;ll review the denial and let you know what we can do next — file an appeal, gather more documentation, or work out a path forward together. <strong>You don&apos;t need to take action yet.</strong>
        </p>`
      : "";

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: dosLine,
    heading: subject,
    preheader: lead,
    contentHtml: [
      paragraph(greeting),
      textParagraph(lead),
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:1px solid ${BREATHE_COLORS.hairline};border-radius:8px;border-collapse:separate;border-spacing:0;">
${rowsHtml}
</table>`,
      denialBlock,
      paragraph(
        `Questions about this? <a href="${escapeHtml(supportUrl)}" style="color:${BREATHE_COLORS.blue};">Open a chat</a> or reply to this email — we&#39;ll get you a human.`,
      ),
    ].join("\n"),
    footerHtml: `<a href="${escapeHtml(accountUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">View on your account</a>`,
    footerLines: [`The ${brandName} billing team`],
    copyrightName: brandName,
  });

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject,
      text,
      html,
      customArgs: {
        kind: "eob_explainer",
        event: input.kind,
      },
    });
    return {
      configured: true,
      delivered: true,
      messageId: result.messageId,
    };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return {
        configured: true,
        delivered: false,
        error: err.message,
      };
    }
    throw err;
  }
}
