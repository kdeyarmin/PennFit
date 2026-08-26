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

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
} from "./link-base.js";

export interface SendFitterOrderConfirmationInput {
  toEmail: string;
  /** Optional first name for the greeting. */
  firstName?: string | null;
  /** Six-letter reference shown to the patient on /order-success. */
  orderReference: string;
  /** Mask the patient picked. */
  maskName: string;
  maskManufacturer?: string | null;
  /** Recommended size from the fitter, when the clinical path supplied one. */
  maskSize?: string | null;
  /** Optional override; otherwise pulled from env. */
  baseUrlOverride?: string;
  /**
   * Tenant the order belongs to. When set and the tenant has its own
   * From identity (migration 0360), the confirmation is sent under it
   * (G6); otherwise the platform default From is used.
   */
  orgId?: string;
}

export interface SendFitterOrderConfirmationResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

export async function sendFitterOrderConfirmationEmail(
  input: SendFitterOrderConfirmationInput,
): Promise<SendFitterOrderConfirmationResult> {
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

  // Brand the signature with the tenant's own storefront name (G6). Seed
  // tenant → "Penn Home Medical Supply" (unchanged); a second tenant → its own brand.
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
  // Public track page — /account is auth-gated and would bounce
  // unsigned-in patients to sign-in before they could look up the ref.
  const trackUrl = `${base}/track-order`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const maskLine = input.maskManufacturer
    ? `${input.maskManufacturer} ${input.maskName}`
    : input.maskName;
  const sizeLine = input.maskSize?.trim()
    ? `Recommended size: ${input.maskSize.trim()}`
    : null;

  const subject = `Order received — ${input.orderReference}`;

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    `We received your CPAP mask order. Reference: ${input.orderReference}`,
    "",
    `Selected mask: ${maskLine}`,
    ...(sizeLine ? [sizeLine] : []),
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
    `Track your order anytime: ${trackUrl}`,
    "",
    "Reply to this email if you have any questions — a real human picks",
    "it up.",
    "",
    `—The ${brandName} team`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "Order received",
    heading: `Reference ${input.orderReference}`,
    // Subject is deliberately generic ("Order received — <ref>"), and the
    // preheader shows next to it on lock screens — so it must not name the
    // mask. The selection stays inside the opened email.
    preheader: `We received your order and will pick it up within one business day.`,
    contentHtml: [
      paragraph(greeting),
      textParagraph(
        "Thanks — we received your CPAP mask order and a real human will pick it up within one business day.",
      ),
      infoPanel({
        title: "Selected mask",
        html:
          `<div style="font-size:16px;font-weight:600;color:${BREATHE_COLORS.ink};">${escapeHtml(
            maskLine,
          )}</div>` +
          (sizeLine
            ? `<div style="margin-top:6px;font-size:13px;">${escapeHtml(sizeLine)}</div>`
            : ""),
      }),
      subheading("What happens next"),
      `<ol style="margin:0 0 18px;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${BREATHE_COLORS.body};">
<li style="margin:0 0 6px;">We verify your insurance benefits. (Within 1 business day.)</li>
<li style="margin:0 0 6px;">We coordinate the prescription with your physician.</li>
<li style="margin:0;">We ship the mask once both are squared away &mdash; you&#39;ll get a separate email with tracking when it leaves our warehouse.</li>
</ol>`,
      textParagraph(
        "You don't need to do anything yet. If we hit a snag with insurance or the prescription, we'll reach out before charging anything.",
      ),
    ].join("\n"),
    button: { label: "Track your order", url: trackUrl },
    footerLines: [
      "Reply to this email with questions — a real human picks it up.",
      `The ${brandName} team`,
    ],
    copyrightName: brandName,
  });

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
