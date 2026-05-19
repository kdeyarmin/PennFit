// sendCaregiverNotificationEmail — secondary copy of a shipping /
// delivery-followup notification sent to the patient's designated
// authorized contact.
//
// Why a dedicated helper (not a BCC)
// ----------------------------------
// BCC blends the caregiver into the patient's send and gives them
// the same body — "Your supplies have shipped" reads oddly to a
// caregiver who didn't order anything. A separate, correctly-
// addressed email ("PennPaps just shipped supplies to Maria") is
// less confusing AND lets us include a one-tap "remove me as
// caregiver" link that doesn't make sense in the patient's copy.
//
// Audit posture
// -------------
// The dispatcher logs the same `kind` customArg on both messages so
// the SendGrid event log can correlate the patient send + the
// caregiver copy via the order id.
//
// HIPAA scope
// -----------
// We deliberately limit this surface to "supplies status" — shipped
// + delivered events. Claim / EOB / billing-detail communications
// stay patient-only unless and until we add a separate claim-scope
// caregiver opt-in. The patient's UI section makes the scope
// explicit.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export type CaregiverEventKind = "shipped" | "delivered";

export interface SendCaregiverNotificationEmailInput {
  /** Caregiver's email — distinct from the patient's. */
  toEmail: string;
  /** Display name of the caregiver. */
  caregiverName: string;
  /** Display name of the patient ("Maria"). Optional — degrades
   *  gracefully to "your contact" when missing. */
  patientFirstName?: string | null;
  kind: CaregiverEventKind;
  /** Tracking details — included on 'shipped' only. */
  carrier?: string | null;
  trackingNumber?: string | null;
  baseUrlOverride?: string;
}

export interface SendCaregiverNotificationEmailResult {
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

interface Copy {
  subject: string;
  headline: string;
  body: string;
}

function copyFor(
  kind: CaregiverEventKind,
  patientLabel: string,
  carrier: string | null | undefined,
  trackingNumber: string | null | undefined,
): Copy {
  if (kind === "shipped") {
    const trail =
      carrier && trackingNumber
        ? ` (${carrier} ${trackingNumber})`
        : "";
    return {
      subject: `Shipped: PennPaps supplies for ${patientLabel}`,
      headline: `Supplies are on the way to ${patientLabel}`,
      body: `PennPaps just shipped a CPAP supplies order to ${patientLabel}${trail}. We're sending this to you because ${patientLabel} listed you as a designated contact for shipment updates.`,
    };
  }
  return {
    subject: `Delivered: PennPaps supplies for ${patientLabel}`,
    headline: `Delivered to ${patientLabel}`,
    body: `According to the carrier, ${patientLabel}'s PennPaps supplies have been delivered. We're sending this to you because ${patientLabel} listed you as a designated contact for shipment updates.`,
  };
}

export async function sendCaregiverNotificationEmail(
  input: SendCaregiverNotificationEmailInput,
): Promise<SendCaregiverNotificationEmailResult> {
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
  const removeUrl = `${base}/account#caregiver`;
  const patientLabel = input.patientFirstName?.trim() || "your contact";
  const copy = copyFor(
    input.kind,
    patientLabel,
    input.carrier,
    input.trackingNumber,
  );
  const greeting = `Hi ${escapeHtml(input.caregiverName.split(" ")[0] ?? input.caregiverName)},`;

  const text = [
    `Hi ${input.caregiverName.split(" ")[0] ?? input.caregiverName},`,
    "",
    copy.body,
    "",
    "If you'd rather not receive these, ask the account holder to remove you",
    `from their designated contacts: ${removeUrl}`,
    "",
    "—The PennPaps team",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <p style="margin:0;font-size:12px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;">Designated contact update</p>
          <h1 style="margin:6px 0 0;font-size:20px;font-weight:600;">${escapeHtml(copy.headline)}</h1>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#3c4458;">${escapeHtml(copy.body)}</p>
          <p style="margin:18px 0 0;font-size:12px;color:#8b95a9;">
            If you&apos;d rather not receive these, ask the account holder to
            <a href="${escapeHtml(removeUrl)}" style="color:#0f1d3a;">remove you</a> from their designated contacts.
          </p>
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
      subject: copy.subject,
      text,
      html,
      customArgs: {
        kind: "caregiver_notification",
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
      return { configured: true, delivered: false, error: err.message };
    }
    throw err;
  }
}
