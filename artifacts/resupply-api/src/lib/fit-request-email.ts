// Fit-request emails — the two messages that go out when a patient
// finishes the mask fitter and asks the DME to take it from there.
//
//   1. A NOTIFICATION to the tenant's lead mailbox with everything the
//      patient told us plus the mask they were shown, so a CSR can pick
//      the request up without opening the console.
//   2. A CONFIRMATION to the patient, because the fitter no longer ends
//      with an order number. Without it the flow's last screen is the
//      only acknowledgement they ever get, and a patient who closes the
//      tab has no way to tell whether it went through.
//
// Both share one client, so a missing SendGrid key short-circuits
// cleanly and the route still 200s — the request is already in the
// database by then, and the queue is the system of record.
//
// PHI: the date of birth and member ID are in the BODY only. Subject
// lines reach mail-server logs and lock-screen banners, so they carry
// neither the patient's name nor any identifier.

import {
  BREATHE_COLORS,
  EmailApiError,
  EmailConfigError,
  escapeHtml,
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

export interface FitRequestEmailPayload {
  requestType: "full_details" | "callback";
  fullName: string;
  email: string;
  phone: string;
  preferredContactMethod: "phone" | "email" | "text";
  preferredContactTime?: string | null;
  dateOfBirth?: string | null;
  insuranceCarrier?: string | null;
  memberId?: string | null;
  groupNumber?: string | null;
  prescribingPhysician?: string | null;
  notes?: string | null;
  population: "adult" | "pediatric";
  recommendedMaskName?: string | null;
  recommendedMaskSize?: string | null;
  /** Tenant the request belongs to — decides the From identity + brand. */
  orgId?: string;
}

export interface SendFitRequestEmailsResult {
  configured: boolean;
  notificationDelivered: boolean;
  confirmationDelivered: boolean;
  error?: string;
}

const CONTACT_METHOD_LABEL: Record<
  FitRequestEmailPayload["preferredContactMethod"],
  string
> = {
  phone: "Phone call",
  email: "Email",
  text: "Text message",
};

async function teamRecipient(
  orgId: string | undefined,
): Promise<string | null> {
  // Same destination as the insurance-verification queue: both are
  // top-of-funnel requests worked by the same CSR cohort, and a tenant
  // that has configured one mailbox has configured it for both.
  return (
    (await resolveOrgNotificationEmail(orgId, "lead_notification_email")) ||
    process.env.INSURANCE_LEAD_NOTIFICATION_EMAIL ||
    process.env.SENDGRID_FROM_EMAIL ||
    null
  );
}

function notificationRows(
  payload: FitRequestEmailPayload,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Patient name", payload.fullName],
    ["Email", payload.email],
    ["Phone", payload.phone],
    [
      "Prefers",
      payload.preferredContactTime
        ? `${CONTACT_METHOD_LABEL[payload.preferredContactMethod]} — ${payload.preferredContactTime}`
        : CONTACT_METHOD_LABEL[payload.preferredContactMethod],
    ],
    [
      "Fitting for",
      payload.population === "pediatric" ? "A child (under 18)" : "An adult",
    ],
  ];
  if (payload.dateOfBirth) rows.push(["Date of birth", payload.dateOfBirth]);
  if (payload.recommendedMaskName) {
    rows.push([
      "Mask shown",
      payload.recommendedMaskSize
        ? `${payload.recommendedMaskName} (size ${payload.recommendedMaskSize})`
        : payload.recommendedMaskName,
    ]);
  }
  if (payload.insuranceCarrier)
    rows.push(["Insurance carrier", payload.insuranceCarrier]);
  if (payload.memberId) rows.push(["Member ID", payload.memberId]);
  if (payload.groupNumber) rows.push(["Group number", payload.groupNumber]);
  if (payload.prescribingPhysician)
    rows.push(["Sleep / prescribing provider", payload.prescribingPhysician]);
  if (payload.notes) rows.push(["Notes", payload.notes]);
  return rows;
}

function renderNotificationHtml(
  payload: FitRequestEmailPayload,
  brandName: string,
  baseUrl: string,
): string {
  const tableRows = notificationRows(payload)
    .map(
      ([k, v]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid ${BREATHE_COLORS.hairline};color:${BREATHE_COLORS.muted};font-size:13px;width:38%;vertical-align:top;">${escapeHtml(k)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${BREATHE_COLORS.hairline};color:${BREATHE_COLORS.ink};font-weight:500;">${escapeHtml(v)}</td>
        </tr>`,
    )
    .join("");

  const lede =
    payload.requestType === "callback"
      ? "A patient finished a mask fitting and asked for a call back. They did not fill in insurance details — that is expected for this request type."
      : "A patient finished a mask fitting and sent their details so you can place the order for them.";

  return renderBrandedEmail({
    brandName,
    brandTagline: "Mask fitting request",
    heading: `New fit request from ${payload.fullName}`,
    preheader: `${payload.fullName} finished a mask fitting and is waiting to hear from you.`,
    contentHtml: [
      paragraph(escapeHtml(lede)),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BREATHE_COLORS.hairline};border-radius:8px;margin-top:8px;">${tableRows}</table>`,
    ].join("\n"),
    button: {
      label: "Open the fit request queue",
      url: `${baseUrl}/admin/fitter-requests`,
    },
    footerLines: [
      `Logged at ${new Date().toISOString()}. Nothing has been ordered — this is a request for a person to work.`,
    ],
    copyrightName: brandName,
  });
}

function renderNotificationText(
  payload: FitRequestEmailPayload,
  brandName: string,
  baseUrl: string,
): string {
  const lines = [
    `New ${brandName} mask fitting request`,
    "",
    ...notificationRows(payload).map(([k, v]) => `${k}: ${v}`),
    "",
    "Nothing has been ordered — this is a request for a person to work.",
    `Queue: ${baseUrl}/admin/fitter-requests`,
  ];
  return lines.join("\n");
}

function renderConfirmationHtml(
  payload: FitRequestEmailPayload,
  brandName: string,
  baseUrl: string,
): string {
  const firstName = payload.fullName.split(/\s+/)[0] || "there";
  const maskLine = payload.recommendedMaskName
    ? paragraph(
        `The fitting matched you with the <strong>${escapeHtml(
          payload.recommendedMaskName,
        )}</strong>${
          payload.recommendedMaskSize
            ? ` in size ${escapeHtml(payload.recommendedMaskSize)}`
            : ""
        }. We'll confirm that's the right choice before anything is ordered.`,
      )
    : "";

  return renderBrandedEmail({
    brandName,
    heading: "We have your fitting request",
    preheader: `We received your mask fitting request — the ${brandName} team will be in touch within one business day.`,
    contentHtml: [
      paragraph(
        `Thanks ${escapeHtml(firstName)} — we received your mask fitting and a member of the ${escapeHtml(
          brandName,
        )} team will be in touch within <strong>one business day</strong>.`,
      ),
      maskLine,
      textParagraph(
        "Nothing has been ordered and nothing has been billed. We'll check your coverage, confirm the fit, and tell you what (if anything) is owed before we send anything out.",
      ),
    ]
      .filter(Boolean)
      .join("\n"),
    footerHtml: `Need to reach us sooner? Reply to this email or visit <a href="${escapeHtml(
      baseUrl,
    )}/faq" style="color:${BREATHE_COLORS.blue};">${escapeHtml(
      baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    )}/faq</a>.`,
    copyrightName: brandName,
  });
}

function renderConfirmationText(
  payload: FitRequestEmailPayload,
  brandName: string,
  baseUrl: string,
): string {
  const first = payload.fullName.split(/\s+/)[0] || "there";
  const lines = [
    `Thanks ${first} — we received your ${brandName} mask fitting request.`,
    "",
    "A member of our team will be in touch within one business day.",
  ];
  if (payload.recommendedMaskName) {
    lines.push(
      "",
      `The fitting matched you with the ${payload.recommendedMaskName}${
        payload.recommendedMaskSize
          ? ` in size ${payload.recommendedMaskSize}`
          : ""
      }. We'll confirm that's the right choice before anything is ordered.`,
    );
  }
  lines.push(
    "",
    "Nothing has been ordered and nothing has been billed. We'll check your coverage, confirm the fit, and tell you what (if anything) is owed before we send anything out.",
    "",
    `Need to reach us sooner? Reply to this email or visit ${baseUrl}/faq.`,
  );
  return lines.join("\n");
}

export async function sendFitRequestEmails(
  payload: FitRequestEmailPayload,
): Promise<SendFitRequestEmailsResult> {
  let client;
  try {
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

  const brandName = (await resolveBrandingByOrgId(payload.orgId))
    .storefrontName;
  const baseUrl =
    (await resolveTenantBaseUrl(payload.orgId)) ?? "https://cmbreathe.com";
  const team = await teamRecipient(payload.orgId);
  let notificationDelivered = false;
  let confirmationDelivered = false;
  const errors: string[] = [];

  const describe = (err: unknown): string =>
    err instanceof EmailApiError
      ? `SendGrid ${err.status ?? "?"}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);

  if (team) {
    try {
      await client.sendEmail({
        to: team,
        subject: "New mask fitting request",
        html: renderNotificationHtml(payload, brandName, baseUrl),
        text: renderNotificationText(payload, brandName, baseUrl),
        // Deliberately no replyTo. The submitting form is patient-facing
        // and the address is whatever was typed into it, so a CSR hitting
        // Reply must not be aimed at an attacker-chosen mailbox. The real
        // address is in the body to copy.
        customArgs: { kind: "fit_request_notification_v1" },
      });
      notificationDelivered = true;
    } catch (err) {
      errors.push(`notification: ${describe(err)}`);
    }
  } else {
    errors.push("notification: no team recipient configured");
  }

  try {
    await client.sendEmail({
      to: payload.email,
      subject: `We have your ${brandName} fitting request`,
      html: renderConfirmationHtml(payload, brandName, baseUrl),
      text: renderConfirmationText(payload, brandName, baseUrl),
      customArgs: { kind: "fit_request_confirmation_v1" },
    });
    confirmationDelivered = true;
  } catch (err) {
    errors.push(`confirmation: ${describe(err)}`);
  }

  return {
    configured: true,
    notificationDelivered,
    confirmationDelivered,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}
