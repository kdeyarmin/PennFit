// Insurance lead-capture emails — sends two SendGrid messages per
// submission of the public /insurance lead form:
//
//   1. A NOTIFICATION email to the Penn Home Medical Supply team (the verifications
//      mailbox) containing the full form payload so a CSR can call
//      back within one business day.
//   2. A CONFIRMATION email to the patient acknowledging receipt and
//      setting an SLA expectation ("we'll call within 1 business day"),
//      so they don't think the form failed and resubmit.
//
// Both calls share one createSendgridClient() — so a missing API key
// short-circuits cleanly and the route still returns 200 (the request
// is queued in the audit log either way; CSRs work the team inbox + a
// future dashboard, never lose a lead).
//
// Privacy: the patient's member ID is treated as low-sensitivity (it
// alone is not PHI in the strict sense — it's the same digits that
// appear on a paper insurance card the patient hands to any pharmacy).
// We still keep it OUT of the subject line and never log it.

import {
  BREATHE_COLORS,
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  infoPanel,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "./email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveOrgNotificationEmail,
  resolveTenantBaseUrl,
} from "./tenant-branding.js";

/** Strip the scheme + trailing slash for inline link-text display. */
function displayHost(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export interface InsuranceLeadPayload {
  fullName: string;
  email: string;
  phone: string;
  /** Free-form date string as the patient typed it, e.g. "1959-04-12". */
  dateOfBirth: string;
  insuranceCarrier: string;
  memberId: string;
  groupNumber?: string | null;
  prescribingPhysician?: string | null;
  notes?: string | null;
  /**
   * Tenant the lead belongs to (host-resolved). When set, the confirmation
   * goes out under the tenant's own From identity (G6) and the copy is
   * branded with the tenant's storefront name; omit → platform default.
   */
  orgId?: string;
}

export interface SendInsuranceLeadEmailsResult {
  configured: boolean;
  notificationDelivered: boolean;
  confirmationDelivered: boolean;
  error?: string;
}

/**
 * Email address that receives the team-side notification. Defaults to
 * the SendGrid From address (info@pennpaps.com) so a fresh deploy
 * always has a working destination — operations can override with
 * INSURANCE_LEAD_NOTIFICATION_EMAIL once a dedicated verifications
 * mailbox exists.
 */
async function teamRecipient(
  orgId: string | undefined,
): Promise<string | null> {
  // The tenant's own verifications inbox when set (migration 0379), else the
  // platform env default (the seed operator's mailbox).
  return (
    (await resolveOrgNotificationEmail(orgId, "lead_notification_email")) ||
    process.env.INSURANCE_LEAD_NOTIFICATION_EMAIL ||
    process.env.SENDGRID_FROM_EMAIL ||
    null
  );
}

function renderNotificationHtml(
  payload: InsuranceLeadPayload,
  brandName: string,
  baseUrl: string,
): string {
  const rows: Array<[string, string]> = [
    ["Patient name", payload.fullName],
    ["Email", payload.email],
    ["Phone", payload.phone],
    ["Date of birth", payload.dateOfBirth],
    ["Insurance carrier", payload.insuranceCarrier],
    ["Member ID", payload.memberId],
  ];
  if (payload.groupNumber) rows.push(["Group number", payload.groupNumber]);
  if (payload.prescribingPhysician)
    rows.push(["Sleep / prescribing provider", payload.prescribingPhysician]);
  if (payload.notes) rows.push(["Notes", payload.notes]);

  const tableRows = rows
    .map(
      ([k, v]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid ${BREATHE_COLORS.hairline};color:${BREATHE_COLORS.muted};font-size:13px;width:38%;vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${BREATHE_COLORS.hairline};color:${BREATHE_COLORS.ink};font-weight:500;">${escapeHtml(v)}</td>
        </tr>`,
    )
    .join("");

  // Chrome comes from the shared CareMetric Breathe email design system.
  return renderBrandedEmail({
    brandName,
    brandTagline: "Insurance verification request",
    heading: `New lead from ${payload.fullName}`,
    preheader: `${payload.fullName} submitted the insurance verification form — call back within one business day.`,
    contentHtml: [
      paragraph(
        `A patient just submitted the insurance verification form on <a href="${escapeHtml(
          baseUrl,
        )}/insurance" style="color:${BREATHE_COLORS.blue};">${escapeHtml(
          displayHost(baseUrl),
        )}/insurance</a>. Please call back within <strong>one business day</strong>.`,
      ),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BREATHE_COLORS.hairline};border-radius:8px;margin-top:8px;">${tableRows}</table>`,
    ].join("\n"),
    footerLines: [
      `Logged at ${new Date().toISOString()}. Reply directly to this email to reach the patient.`,
    ],
    copyrightName: brandName,
  });
}

function renderNotificationText(
  payload: InsuranceLeadPayload,
  brandName: string,
): string {
  const lines = [
    `New ${brandName} insurance verification request`,
    "",
    `Patient: ${payload.fullName}`,
    `Email:   ${payload.email}`,
    `Phone:   ${payload.phone}`,
    `DOB:     ${payload.dateOfBirth}`,
    `Carrier: ${payload.insuranceCarrier}`,
    `Member:  ${payload.memberId}`,
  ];
  if (payload.groupNumber) lines.push(`Group:   ${payload.groupNumber}`);
  if (payload.prescribingPhysician)
    lines.push(`Sleep provider: ${payload.prescribingPhysician}`);
  if (payload.notes) lines.push(`Notes:   ${payload.notes}`);
  lines.push("", "Please call back within 1 business day.");
  return lines.join("\n");
}

function renderConfirmationHtml(
  payload: InsuranceLeadPayload,
  brandName: string,
  baseUrl: string,
): string {
  const firstName = payload.fullName.split(/\s+/)[0] || "there";
  // Chrome comes from the shared CareMetric Breathe email design system.
  return renderBrandedEmail({
    brandName,
    heading: "We have your verification request",
    preheader: `We received your insurance verification request — the ${brandName} team will reach out within one business day.`,
    contentHtml: [
      paragraph(
        `Thanks ${escapeHtml(
          firstName,
        )} — we received your insurance verification request and a member of the ${escapeHtml(
          brandName,
        )} team will reach out within <strong>one business day</strong> to confirm your benefits and walk you through the next step.`,
      ),
      textParagraph(
        "We'll never charge you anything until we've confirmed your coverage and told you what (if anything) is owed out of pocket. There's no obligation to proceed.",
      ),
    ].join("\n"),
    button: {
      label: `How insurance works at ${brandName}`,
      url: `${baseUrl}/insurance`,
    },
    footerHtml: `Need to reach us sooner? Reply to this email or visit <a href="${escapeHtml(
      baseUrl,
    )}/faq" style="color:${BREATHE_COLORS.blue};">${escapeHtml(displayHost(baseUrl))}/faq</a>.`,
    copyrightName: brandName,
  });
}

function renderConfirmationText(
  payload: InsuranceLeadPayload,
  brandName: string,
  baseUrl: string,
): string {
  const first = payload.fullName.split(/\s+/)[0] || "there";
  return [
    `Thanks ${first} — we received your ${brandName} insurance verification request.`,
    "",
    "A member of our team will reach out within one business day to confirm your benefits and walk you through the next step.",
    "",
    "We won't charge you anything until we've confirmed your coverage and told you what (if anything) is owed out of pocket. There's no obligation to proceed.",
    "",
    `How insurance works at ${brandName}: ${baseUrl}/insurance`,
    "",
    `Need to reach us sooner? Reply to this email or visit ${baseUrl}/faq.`,
  ].join("\n");
}

export async function sendInsuranceLeadEmails(
  payload: InsuranceLeadPayload,
): Promise<SendInsuranceLeadEmailsResult> {
  let client;
  try {
    // Send under the tenant's own From identity when configured (G6); falls
    // back to the platform default when the tenant has none / orgId is unset.
    client = await createTenantSendgridClient(payload.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return {
        configured: false,
        notificationDelivered: false,
        confirmationDelivered: false,
        error: err.message,
      };
    }
    throw err;
  }

  // Brand the copy with the tenant's storefront name (seed → "Penn Home Medical Supply").
  const brandName = (await resolveBrandingByOrgId(payload.orgId))
    .storefrontName;
  // Point the /insurance + /faq links at the tenant's own verified custom
  // domain when it has one (seed → pennpaps.com, unchanged).
  const baseUrl =
    (await resolveTenantBaseUrl(payload.orgId)) ?? "https://cmbreathe.com";
  const team = await teamRecipient(payload.orgId);
  let notificationDelivered = false;
  let confirmationDelivered = false;
  const errors: string[] = [];

  if (team) {
    try {
      await client.sendEmail({
        to: team,
        // Subject deliberately omits the patient's name. Email
        // subjects are logged by mail servers and visible in
        // notification banners on locked phones — keep PHI in the
        // body, behind the recipient's mailbox auth.
        subject: "New insurance verification request",
        html: renderNotificationHtml(payload, brandName, baseUrl),
        text: renderNotificationText(payload, brandName),
        // DO NOT set replyTo to payload.email. The /insurance-lead
        // form is unauthenticated, so anyone can submit an arbitrary
        // address; a "Reply" by the CSR would then send PHI / a
        // verification quote to whoever the attacker chose. The
        // patient's real email is rendered in the body (HTML + text)
        // for the CSR to copy-paste into their own reply.
        customArgs: { kind: "insurance_lead_notification_v1" },
      });
      notificationDelivered = true;
    } catch (err) {
      const msg =
        err instanceof EmailApiError
          ? `SendGrid ${err.status ?? "?"}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      errors.push(`notification: ${msg}`);
    }
  } else {
    errors.push("notification: no team recipient configured");
  }

  try {
    await client.sendEmail({
      to: payload.email,
      subject: `We have your ${brandName} insurance verification request`,
      html: renderConfirmationHtml(payload, brandName, baseUrl),
      text: renderConfirmationText(payload, brandName, baseUrl),
      customArgs: { kind: "insurance_lead_confirmation_v1" },
    });
    confirmationDelivered = true;
  } catch (err) {
    const msg =
      err instanceof EmailApiError
        ? `SendGrid ${err.status ?? "?"}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    errors.push(`confirmation: ${msg}`);
  }

  return {
    configured: true,
    notificationDelivered,
    confirmationDelivered,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}
