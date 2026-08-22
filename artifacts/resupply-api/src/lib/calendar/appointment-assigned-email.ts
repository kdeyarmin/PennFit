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

import {
  BREATHE_COLORS,
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";
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

/**
 * The variable dictionary the templated path hands to `renderMessage`.
 * The optional Where / Assigned-by pieces are pre-rendered — as
 * trailing-newline plain-text lines and as `<tr>` fragments — because
 * the {{var}}-only template engine can't express "omit when empty".
 * Sharing `buildFields` + the row builders with the fallback renderers
 * is what keeps the seeded template row (migration 0502) byte-identical
 * to them (pinned by seed-bodies.parity.test.ts).
 */
function buildTemplateVariables(
  input: AppointmentAssignedEmailInput,
  brandName: string,
): Record<string, string> {
  const fields = buildFields(input);
  return {
    assignee_name: fields.greetingName,
    assignee_name_html: escapeHtml(fields.greetingName),
    appointment_date: fields.date,
    appointment_time: fields.time,
    appointment_type: fields.type,
    appointment_type_html: escapeHtml(fields.type),
    when_html: escapeHtml(`${fields.date}, ${fields.time}`),
    // Plain (unescaped) "date, time" for the preheader slot, which the
    // layout escapes itself — `when_html` would double-escape there.
    when_plain: `${fields.date}, ${fields.time}`,
    location: fields.location,
    assigned_by: fields.assignedBy,
    dashboard_url: input.dashboardUrl,
    // Href slot: `brandedButton` only quote-escapes, so this must too —
    // a full escapeHtml would turn `&` into `&amp;` and break parity.
    dashboard_url_html: input.dashboardUrl.replace(/"/g, "&quot;"),
    brand_name: brandName,
    brand_name_html: escapeHtml(brandName),
    copyright_year: String(new Date().getFullYear()),
    location_line_text: fields.location ? `Where: ${fields.location}\n` : "",
    assigned_by_line_text: fields.assignedBy
      ? `Assigned by: ${fields.assignedBy}\n`
      : "",
    location_row_html: locationRowHtml(fields.location),
    assigned_by_row_html: assignedByRowHtml(fields.assignedBy),
  };
}

function renderText(
  input: AppointmentAssignedEmailInput,
  brandName = "CareMetric Breathe",
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

// Optional-row fragments, extracted so the templated path can hand them to
// `renderMessage` as pre-rendered `*_row_html` variables — the {{var}}-only
// template engine can't express "omit the row when the field is empty", and
// sharing these builders is what keeps the seeded template byte-identical
// to the fallback renderer.
function locationRowHtml(location: string): string {
  return location
    ? `<tr><td style="padding:2px 0;color:${BREATHE_COLORS.muted};">Where</td><td style="padding:2px 0 2px 16px;color:${BREATHE_COLORS.ink};font-weight:600;">${escapeHtml(
        location,
      )}</td></tr>`
    : "";
}

function assignedByRowHtml(assignedBy: string): string {
  return assignedBy
    ? `<tr><td style="padding:2px 0;color:${BREATHE_COLORS.muted};">Assigned by</td><td style="padding:2px 0 2px 16px;color:${BREATHE_COLORS.ink};">${escapeHtml(
        assignedBy,
      )}</td></tr>`
    : "";
}

/**
 * Assemble the branded body. Shared with the SEEDED template row
 * (`seed-bodies.ts`), which calls this with `{{...}}` placeholders in
 * place of the real values — that is what keeps the seeded output
 * byte-identical to this fallback path. The optional rows are
 * concatenated directly (no `filter`/`join`) so an absent row collapses
 * to the same bytes on both paths.
 */
export function appointmentAssignedBrandedHtml(parts: {
  /** Escaped slot. Seed passes `{{brand_name_html}}`. */
  brandName: string;
  /** Escaped slot (inside textParagraph). Seed passes `{{assignee_name_html}}`. */
  greetingName: string;
  /** Pre-escaped for a verbatim slot. Seed passes `{{appointment_type_html}}`. */
  typeHtml: string;
  /** Pre-escaped for a verbatim slot. Seed passes `{{when_html}}`. */
  whenHtml: string;
  /** Escaped slot. Seed passes `{{appointment_type}}`. */
  preheaderType: string;
  /** Escaped slot. Seed passes `{{when_plain}}`. */
  preheaderWhen: string;
  /** Verbatim HTML fragment (may be empty). */
  locationRowHtml: string;
  /** Verbatim HTML fragment (may be empty). */
  assignedByRowHtml: string;
  /** Button href — quote-only escape, matching `brandedButton`. */
  dashboardUrl: string;
  copyrightYear?: number | string;
}): string {
  return renderBrandedEmail({
    brandName: parts.brandName,
    brandTagline: "Company calendar",
    heading: "An appointment was scheduled for you",
    preheader: `${parts.preheaderType} on ${parts.preheaderWhen}.`,
    contentHtml:
      textParagraph(
        `Hi ${parts.greetingName}, a new appointment has been placed on your calendar.`,
      ) +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;font-family:Arial,Helvetica,sans-serif;margin:0 0 8px;">
<tr><td style="padding:2px 0;color:${BREATHE_COLORS.muted};">Type</td><td style="padding:2px 0 2px 16px;color:${BREATHE_COLORS.ink};font-weight:600;">${parts.typeHtml}</td></tr>
<tr><td style="padding:2px 0;color:${BREATHE_COLORS.muted};">When</td><td style="padding:2px 0 2px 16px;color:${BREATHE_COLORS.ink};font-weight:600;">${parts.whenHtml}</td></tr>
${parts.locationRowHtml}${parts.assignedByRowHtml}</table>`,
    button: { label: "Open the calendar", url: parts.dashboardUrl },
    footerLines: [
      `You're receiving this because a teammate assigned this appointment to you in the ${parts.brandName} admin console.`,
    ],
    copyrightName: parts.brandName,
    ...(parts.copyrightYear === undefined
      ? {}
      : { copyrightYear: parts.copyrightYear }),
  });
}

function renderHtml(
  input: AppointmentAssignedEmailInput,
  brandName = "CareMetric Breathe",
): string {
  const f = buildFields(input);
  // Chrome comes from the shared CareMetric Breathe email design system.
  return appointmentAssignedBrandedHtml({
    brandName,
    greetingName: f.greetingName,
    typeHtml: escapeHtml(f.type),
    whenHtml: escapeHtml(`${f.date}, ${f.time}`),
    preheaderType: f.type,
    preheaderWhen: `${f.date}, ${f.time}`,
    locationRowHtml: locationRowHtml(f.location),
    assignedByRowHtml: assignedByRowHtml(f.assignedBy),
    dashboardUrl: input.dashboardUrl,
  });
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
  // the seed tenant this resolves to "Penn Home Medical Supply" (its stored brand), so
  // single-tenant copy is unchanged.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const rendered = await renderMessage(
    {
      templateKey: "appointment.assigned.email",
      channel: "email",
      customerId: null,
      orgId: input.orgId,
      variables: buildTemplateVariables(input, brandName),
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
  buildTemplateVariables,
};
