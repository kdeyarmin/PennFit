// Appointment-assigned notification — a single SendGrid message sent to a
// staff member when an appointment on the company calendar is assigned to
// them. Fire-and-forget from the calendar route: a SendGrid hiccup (or a
// missing key) must NEVER fail the calendar write.
//
// PHI posture: this email is PHI-light by design — it carries the date/time,
// the appointment type, and a link to the dashboard, but NOT the patient's
// name or any clinical detail. The assignee clicks through to the calendar
// for those, matching the "no patient names in notifications" posture of the
// /admin/today worklist. `location` is included because it is operational
// (a room or a video-call link), not patient-identifying.
//
// Templated via `renderMessage` with templateKey "appointment.assigned.email";
// the fallback strings below are used verbatim when no template row exists
// (the row is optional — there is no seed for this key).

import { EmailApiError, EmailConfigError } from "@workspace/resupply-email";
import { renderMessage } from "@workspace/resupply-templates";

import { messageTemplateLookup } from "../message-templates/lookup";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";

// Human labels for the calendar event types. Kept in lock-step with the DB
// CHECK constraint in 0242_company_calendar_events.sql + the SPA's
// EVENT_TYPE_META.
const EVENT_TYPE_LABELS: Record<string, string> = {
  fitting_virtual: "Virtual fitting",
  fitting_in_person: "In-person fitting",
  setup_virtual: "Virtual setup",
  setup_in_person: "In-person setup",
  follow_up: "Follow-up",
  consultation: "Consultation",
  other: "Appointment",
};

// The practice operates in Pennsylvania (Eastern). Env-overridable so a
// relocation / multi-tz future doesn't need a code change.
const PRACTICE_TZ =
  process.env.RESUPPLY_PRACTICE_TIMEZONE?.trim() || "America/New_York";

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: PRACTICE_TZ,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: PRACTICE_TZ,
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const TIME_FMT_NO_TZ = new Intl.DateTimeFormat("en-US", {
  timeZone: PRACTICE_TZ,
  hour: "numeric",
  minute: "2-digit",
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface AppointmentAssignedEmailInput {
  toEmail: string;
  assigneeName: string | null;
  startsAt: string;
  endsAt: string;
  eventType: string;
  location: string | null;
  assignedByEmail: string | null;
  /** Absolute URL to the company calendar (built from the app base URL). */
  dashboardUrl: string;
  /**
   * Tenant the calendar event belongs to. When set, the notification is
   * sent under the tenant's own From identity (G6) and branded with the
   * tenant's storefront name; omit / undefined keeps the platform default.
   */
  orgId?: string;
}

export interface AppointmentAssignedEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
}

function typeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? "Appointment";
}

function buildFields(input: AppointmentAssignedEmailInput) {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  return {
    greetingName: input.assigneeName?.trim() || "there",
    date: DATE_FMT.format(start),
    time: `${TIME_FMT.format(start)} – ${TIME_FMT_NO_TZ.format(end)}`,
    type: typeLabel(input.eventType),
    location: input.location?.trim() || "",
    assignedBy: input.assignedByEmail?.trim() || "",
  };
}

function renderText(
  input: AppointmentAssignedEmailInput,
  brandName = "PennPaps",
): string {
  const f = buildFields(input);
  const lines = [
    `Hi ${f.greetingName},`,
    "",
    "An appointment has been scheduled for you on the company calendar.",
    "",
    `Type: ${f.type}`,
    `When: ${f.date}, ${f.time}`,
  ];
  if (f.location) lines.push(`Where: ${f.location}`);
  if (f.assignedBy) lines.push(`Assigned by: ${f.assignedBy}`);
  lines.push(
    "",
    `View it in your dashboard: ${input.dashboardUrl}`,
    "",
    `— ${brandName}`,
  );
  return lines.join("\n");
}

function renderHtml(
  input: AppointmentAssignedEmailInput,
  brandName = "PennPaps",
): string {
  const f = buildFields(input);
  const locationRow = f.location
    ? `<tr><td style="padding:2px 0;color:#888;">Where</td><td style="padding:2px 0 2px 16px;color:#0a1f44;font-weight:600;">${escapeHtml(
        f.location,
      )}</td></tr>`
    : "";
  const assignedByRow = f.assignedBy
    ? `<tr><td style="padding:2px 0;color:#888;">Assigned by</td><td style="padding:2px 0 2px 16px;color:#0a1f44;">${escapeHtml(
        f.assignedBy,
      )}</td></tr>`
    : "";
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a24a;">
          <div style="font-size:13px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">${escapeHtml(
            brandName,
          )} · Company calendar</div>
          <div style="font-size:22px;color:#0a1f44;font-weight:700;margin-top:4px;">An appointment was scheduled for you</div>
        </td></tr>
        <tr><td style="padding-top:18px;color:#333;font-size:15px;line-height:1.55;">
          Hi ${escapeHtml(f.greetingName)}, a new appointment has been placed on your calendar.
        </td></tr>
        <tr><td style="padding-top:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;">
            <tr><td style="padding:2px 0;color:#888;">Type</td><td style="padding:2px 0 2px 16px;color:#0a1f44;font-weight:600;">${escapeHtml(
              f.type,
            )}</td></tr>
            <tr><td style="padding:2px 0;color:#888;">When</td><td style="padding:2px 0 2px 16px;color:#0a1f44;font-weight:600;">${escapeHtml(
              `${f.date}, ${f.time}`,
            )}</td></tr>
            ${locationRow}
            ${assignedByRow}
          </table>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="${escapeHtml(
            input.dashboardUrl,
          )}" style="display:inline-block;background:#c9a24a;color:#0a1f44;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;">Open the calendar</a>
        </td></tr>
        <tr><td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
          You're receiving this because a teammate assigned this appointment to you in the ${escapeHtml(
            brandName,
          )} admin console.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

/**
 * Send the assignment notification. Fire-and-forget friendly: returns a
 * result object instead of throwing, so the caller can `void` it without an
 * unhandled rejection. Degrades cleanly when SendGrid is unconfigured.
 */
export async function sendAppointmentAssignedEmail(
  input: AppointmentAssignedEmailInput,
): Promise<AppointmentAssignedEmailResult> {
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

  // Brand the notification with the tenant's own storefront name (G6). For
  // the seed tenant this resolves to "PennPaps" (its stored brand), so
  // single-tenant copy is unchanged.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const fields = buildFields(input);
  const rendered = await renderMessage(
    {
      templateKey: "appointment.assigned.email",
      channel: "email",
      customerId: null,
      variables: {
        assignee_name: fields.greetingName,
        appointment_date: fields.date,
        appointment_time: fields.time,
        appointment_type: fields.type,
        location: fields.location,
        assigned_by: fields.assignedBy,
        dashboard_url: input.dashboardUrl,
        dashboard_url_html: escapeHtml(input.dashboardUrl),
      },
    },
    {
      subject: "An appointment was scheduled for you",
      bodyHtml: renderHtml(input, brandName),
      bodyText: renderText(input, brandName),
    },
    messageTemplateLookup,
  );

  try {
    await client.sendEmail({
      to: input.toEmail,
      subject: rendered.subject ?? "An appointment was scheduled for you",
      html: rendered.bodyHtml ?? rendered.bodyText,
      text: rendered.bodyText,
      customArgs: { kind: "appointment_assigned_v1" },
    });
    return { configured: true, delivered: true };
  } catch (err) {
    const msg =
      err instanceof EmailApiError
        ? `SendGrid ${err.status ?? "?"}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { configured: true, delivered: false, error: msg };
  }
}

// Test seam: the pure renderers, so the unit test can assert PHI-light
// content + the dashboard link without a SendGrid round-trip.
export const __forTests = {
  renderText,
  renderHtml,
  typeLabel,
};
