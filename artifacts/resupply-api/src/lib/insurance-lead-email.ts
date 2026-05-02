// Insurance lead-capture emails — sends two SendGrid messages per
// submission of the public /insurance lead form:
//
//   1. A NOTIFICATION email to the PennPaps team (the verifications
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
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

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
}

export interface SendInsuranceLeadEmailsResult {
  configured: boolean;
  notificationDelivered: boolean;
  confirmationDelivered: boolean;
  error?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Email address that receives the team-side notification. Defaults to
 * the SendGrid From address (info@pennpaps.com) so a fresh deploy
 * always has a working destination — operations can override with
 * INSURANCE_LEAD_NOTIFICATION_EMAIL once a dedicated verifications
 * mailbox exists.
 */
function teamRecipient(): string | null {
  return (
    process.env.INSURANCE_LEAD_NOTIFICATION_EMAIL ||
    process.env.SENDGRID_FROM_EMAIL ||
    null
  );
}

function renderNotificationHtml(payload: InsuranceLeadPayload): string {
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
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;font-size:13px;width:38%;vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#1a1a1a;font-weight:500;">${escapeHtml(v)}</td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:28px;max-width:640px;">
        <tr><td style="padding-bottom:14px;border-bottom:2px solid #c9a227;">
          <div style="font-size:13px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">PennPaps · Insurance verification request</div>
          <div style="font-size:20px;color:#1a1a1a;font-weight:700;margin-top:4px;">New lead from ${escapeHtml(payload.fullName)}</div>
        </td></tr>
        <tr><td style="padding-top:18px;color:#333;font-size:14px;line-height:1.55;">
          A patient just submitted the insurance verification form on <a href="https://pennpaps.com/insurance" style="color:#7a5d00;">pennpaps.com/insurance</a>. Please call back within <strong>one business day</strong>.
        </td></tr>
        <tr><td style="padding-top:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;">${tableRows}</table>
        </td></tr>
        <tr><td style="padding-top:20px;color:#888;font-size:12px;line-height:1.4;">
          Logged at ${escapeHtml(new Date().toISOString())}. Reply directly to this email to reach the patient.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function renderNotificationText(payload: InsuranceLeadPayload): string {
  const lines = [
    "New PennPaps insurance verification request",
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

function renderConfirmationHtml(payload: InsuranceLeadPayload): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a227;">
          <div style="font-size:14px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">PennPaps</div>
          <div style="font-size:22px;color:#1a1a1a;font-weight:700;margin-top:4px;">We have your verification request</div>
        </td></tr>
        <tr><td style="padding-top:20px;color:#333;font-size:15px;line-height:1.55;">
          Thanks ${escapeHtml(payload.fullName.split(/\s+/)[0] || "there")} — we received your insurance verification request and a member of the PennPaps team will reach out within <strong>one business day</strong> to confirm your benefits and walk you through the next step.
        </td></tr>
        <tr><td style="padding-top:14px;color:#333;font-size:14px;line-height:1.55;">
          We'll never charge you anything until we've confirmed your coverage and told you what (if anything) is owed out of pocket. There's no obligation to proceed.
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="https://pennpaps.com/insurance" style="display:inline-block;background:#c9a227;color:#1a1a1a;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;">How insurance works at PennPaps</a>
        </td></tr>
        <tr><td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
          Need to reach us sooner? Reply to this email or visit <a href="https://pennpaps.com/faq" style="color:#7a5d00;">pennpaps.com/faq</a>.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function renderConfirmationText(payload: InsuranceLeadPayload): string {
  const first = payload.fullName.split(/\s+/)[0] || "there";
  return [
    `Thanks ${first} — we received your PennPaps insurance verification request.`,
    "",
    "A member of our team will reach out within one business day to confirm your benefits and walk you through the next step.",
    "",
    "We won't charge you anything until we've confirmed your coverage and told you what (if anything) is owed out of pocket. There's no obligation to proceed.",
    "",
    "How insurance works at PennPaps: https://pennpaps.com/insurance",
    "",
    "Need to reach us sooner? Reply to this email or visit https://pennpaps.com/faq.",
  ].join("\n");
}

export async function sendInsuranceLeadEmails(
  payload: InsuranceLeadPayload,
): Promise<SendInsuranceLeadEmailsResult> {
  let client;
  try {
    client = createSendgridClient();
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

  const team = teamRecipient();
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
        html: renderNotificationHtml(payload),
        text: renderNotificationText(payload),
        replyTo: payload.email,
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
      subject: "We have your PennPaps insurance verification request",
      html: renderConfirmationHtml(payload),
      text: renderConfirmationText(payload),
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
