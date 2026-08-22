// sendCaregiverNotificationEmail — secondary copy of a shipping /
// delivery-followup notification sent to the patient's designated
// authorized contact.
//
// Why a dedicated helper (not a BCC)
// ----------------------------------
// BCC blends the caregiver into the patient's send and gives them
// the same body — "Your supplies have shipped" reads oddly to a
// caregiver who didn't order anything. A separate, correctly-
// addressed email ("Penn Home Medical Supply just shipped supplies to Maria") is
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
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

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
  /**
   * Tenant the order belongs to. When set and the tenant has its own
   * From identity (migration 0360), the notification is sent under it
   * (G6) and the copy carries the tenant's storefront brand; otherwise
   * the platform default From/brand is used. Omit / undefined leaves the
   * platform default unchanged.
   */
  orgId?: string;
}

export interface SendCaregiverNotificationEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
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
  brandName: string,
): Copy {
  if (kind === "shipped") {
    const trail =
      carrier && trackingNumber ? ` (${carrier} ${trackingNumber})` : "";
    return {
      subject: `Shipped: ${brandName} supplies for ${patientLabel}`,
      headline: `Supplies are on the way to ${patientLabel}`,
      body: `${brandName} just shipped a CPAP supplies order to ${patientLabel}${trail}. We're sending this to you because ${patientLabel} listed you as a designated contact for shipment updates.`,
    };
  }
  return {
    subject: `Delivered: ${brandName} supplies for ${patientLabel}`,
    headline: `Delivered to ${patientLabel}`,
    body: `According to the carrier, ${patientLabel}'s ${brandName} supplies have been delivered. We're sending this to you because ${patientLabel} listed you as a designated contact for shipment updates.`,
  };
}

export async function sendCaregiverNotificationEmail(
  input: SendCaregiverNotificationEmailInput,
): Promise<SendCaregiverNotificationEmailResult> {
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
  // copy is unchanged; a second tenant's notification carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const removeUrl = `${base}/account#caregiver`;
  const patientLabel = input.patientFirstName?.trim() || "your contact";
  const copy = copyFor(
    input.kind,
    patientLabel,
    input.carrier,
    input.trackingNumber,
    brandName,
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
    `—The ${brandName} team`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "Designated contact update",
    heading: copy.headline,
    preheader: copy.body,
    contentHtml: [
      paragraph(greeting),
      textParagraph(copy.body),
      paragraph(
        `If you&#39;d rather not receive these, ask the account holder to <a href="${escapeHtml(
          removeUrl,
        )}" style="color:${BREATHE_COLORS.blue};">remove you</a> from their designated contacts.`,
      ),
    ].join("\n"),
    footerLines: [`The ${brandName} team`],
    copyrightName: brandName,
  });

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
