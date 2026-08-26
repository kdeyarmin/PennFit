// /admin/video-visits — telehealth video visits.
//
// An RT or CSR starts a browser video call with a patient for an
// equipment setup, mask troubleshooting, or a follow-up. The visit row
// is created here; the patient receives an HMAC-signed join link by
// SMS/email (mirroring the payment-link / fitter-invite delivery
// pattern — the link is ALSO returned so staff can copy/share it
// directly). Media is WebRTC peer-to-peer; the API only relays
// signaling over /resupply-api/video/signal (see lib/video/).
//
// Endpoints (requireAdmin — both admins and agents; RTs and CSRs both
// run these visits):
//   GET  /admin/video-visits                      list (open by default)
//   POST /admin/patients/:id/video-visits         create + send invite
//   POST /admin/video-visits/:id/invite           re-send the join link
//   POST /admin/video-visits/:id/join             mint staff WS token
//   POST /admin/video-visits/:id/cancel           cancel + revoke link
//   POST /admin/video-visits/:id/complete         manual completion
//
// PHI / log posture (matches patient-payment-link.ts):
//   * Audit + logs carry ids/flags only — channel, delivered,
//     visit_id, patient_id. NEVER the recipient's email/phone or the
//     signed link itself.

import { Router, type IRouter, type Request, type Response } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import { EmailConfigError } from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { createTenantSendgridClient } from "../../lib/email/tenant-sender.js";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { readSmsConfigOrNull } from "../../lib/messaging/messaging-config";
import { resolveTenantSmsClientOptions } from "../../lib/messaging/tenant-telecom";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../../lib/tenant-branding.js";
import { resolveIceServers } from "../../lib/video/ice-servers";
import { signVideoVisitToken } from "../../lib/video/video-visit-token";
import {
  adminRateLimit,
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export const VIDEO_SIGNAL_WS_PATH = "/resupply-api/video/signal";

// 30 invite sends/hour per admin caps a compromised-account spam
// scenario; same shape as the payment-link / fitter-invite limiters.
const inviteLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.adminUserId ?? "unknown",
  message: {
    error: "too_many_requests",
    limiter: "admin_video_visit_invite",
    message:
      "You're sending video visit invites too quickly. Please wait a few minutes and try again.",
  },
});

/** Public origin patient join links are built against. Prefer the
 *  tenant's verified custom domain so invites land on the tenant host
 *  (e.g. pennpaps.com), not the platform Railway / cmbreathe fallback. */
function publicBaseUrl(override?: string): string {
  return (
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://cmbreathe.com")
  ).replace(/\/$/, "");
}

async function patientJoinUrl(
  orgId: string,
  visitId: string,
  linkVersion: number,
): Promise<string> {
  const base = publicBaseUrl((await resolveTenantBaseUrl(orgId)) ?? undefined);
  const token = signVideoVisitToken(visitId, "patient", linkVersion);
  return `${base}/video-visit?token=${encodeURIComponent(token)}`;
}

/** Twilio delivery status callback for an invite SMS. The visit id
 *  rides in the query string (Twilio signs the full URL, so it's
 *  authenticated by the signature middleware) — same correlation
 *  pattern as the recall-notification sends. MUST be built on the
 *  same public base the /sms/status-callback signature middleware
 *  reconstructs (readSmsConfigOrNull), NOT publicBaseUrl() above:
 *  a different origin (e.g. SHOP_PUBLIC_BASE_URL) breaks Twilio's
 *  signature validation and every callback is rejected. */
function inviteStatusCallbackUrl(visitId: string): string | undefined {
  const base = readSmsConfigOrNull()?.publicBaseUrl;
  return base
    ? `${base}/resupply-api/sms/status-callback?videoVisitId=${encodeURIComponent(visitId)}`
    : undefined;
}

async function tryCreateSendgrid(
  orgId: string,
): Promise<Awaited<ReturnType<typeof createTenantSendgridClient>> | null> {
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default otherwise.
    return await createTenantSendgridClient(orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) return null;
    throw err;
  }
}

async function tryCreateTwilioSms(
  orgId: string,
): Promise<ReturnType<typeof createTwilioSmsClient> | null> {
  try {
    // Send under the tenant's own number / Messaging Service when it has
    // one (G7); falls back to the platform env default otherwise.
    return createTwilioSmsClient(await resolveTenantSmsClientOptions(orgId));
  } catch (err) {
    if (err instanceof TwilioConfigError) return null;
    throw err;
  }
}

// Patient-facing invite copy lives in a pure module so it can be rendered
// (e.g. by the message-preview gallery) without importing this route.
// Re-exported here because existing callers and tests import them from
// this path.
import {
  escapeHtml,
  formatWhen,
  renderInviteEmailHtml,
  renderInviteEmailText,
} from "../../lib/video-visits/invite-email";

// Re-exported because existing callers and tests import them from here.
export { escapeHtml, formatWhen, renderInviteEmailHtml, renderInviteEmailText };

/** Deliver the join link over the chosen channel. Never throws on a
 *  vendor/config failure — the staff member always gets a copy-able
 *  link back regardless. `delivered: true` means the VENDOR accepted
 *  the send; for SMS the carrier-side outcome arrives later on the
 *  status callback (correlated by visitId) and lands in the visit's
 *  invite_delivery_status. */
async function deliverInvite(opts: {
  visitId: string;
  channel: "email" | "sms";
  orgId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  practiceName: string;
  scheduledAt: string | null;
  link: string;
}): Promise<{ delivered: boolean; reason?: string; messageSid?: string }> {
  const greeting = opts.firstName?.trim() ? opts.firstName.trim() : "there";
  const when = formatWhen(opts.scheduledAt);
  try {
    if (opts.channel === "email") {
      if (!opts.email) return { delivered: false, reason: "no_email" };
      const sendgrid = await tryCreateSendgrid(opts.orgId);
      if (!sendgrid) return { delivered: false, reason: "no_email_config" };
      await sendgrid.sendEmail({
        to: opts.email,
        // No PHI in the subject line — provider subjects aren't encrypted.
        subject: `Your video visit link from ${opts.practiceName.replace(/[\r\n]/g, "")}`,
        html: renderInviteEmailHtml(
          greeting,
          opts.practiceName,
          when,
          opts.link,
        ),
        text: renderInviteEmailText(
          greeting,
          opts.practiceName,
          when,
          opts.link,
        ),
      });
      return { delivered: true };
    }
    if (!opts.phone) return { delivered: false, reason: "no_phone" };
    const twilio = await tryCreateTwilioSms(opts.orgId);
    if (!twilio) return { delivered: false, reason: "no_sms_config" };
    const statusCallbackUrl = inviteStatusCallbackUrl(opts.visitId);
    const sent = await twilio.sendSms({
      to: opts.phone,
      body: when
        ? `Hi ${greeting}, this is ${opts.practiceName}. Your video visit is set for ${when}. Join from your phone or computer: ${opts.link}`
        : `Hi ${greeting}, this is ${opts.practiceName}. Join your secure video visit from your phone or computer: ${opts.link}`,
      ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
    });
    return { delivered: true, messageSid: sent.messageSid };
  } catch (err) {
    logger.warn(
      { err, channel: opts.channel },
      "video-visit invite send failed",
    );
    return {
      delivered: false,
      reason: err instanceof Error ? err.message.slice(0, 120) : "send_error",
    };
  }
}

export interface VisitListRow {
  id: string;
  patient_id: string | null;
  purpose: string;
  notes: string | null;
  status: string;
  scheduled_at: string | null;
  created_by_email: string | null;
  link_version: number;
  invite_channel: string | null;
  invite_delivered: boolean | null;
  invite_delivery_status: string | null;
  invite_delivery_error_code: string | null;
  staff_joined_at: string | null;
  patient_joined_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone_e164: string | null;
  patients: {
    legal_first_name: string | null;
    legal_last_name: string | null;
  } | null;
}

export function toApiVisit(r: VisitListRow) {
  return {
    id: r.id,
    patientId: r.patient_id,
    // Display name for the visit's subject: the patient's chart name,
    // or the typed-in guest name for no-chart (guest) visits.
    patientName:
      [r.patients?.legal_first_name, r.patients?.legal_last_name]
        .filter(Boolean)
        .join(" ") ||
      r.guest_name ||
      null,
    isGuest: !r.patient_id,
    purpose: r.purpose,
    notes: r.notes,
    status: r.status,
    scheduledAt: r.scheduled_at,
    createdByEmail: r.created_by_email,
    inviteChannel: r.invite_channel,
    inviteDelivered: r.invite_delivered,
    // Carrier-side outcome from the Twilio status callback (SMS only;
    // null until a callback lands). invite_delivered above only means
    // "vendor accepted the send".
    inviteDeliveryStatus: r.invite_delivery_status,
    inviteDeliveryErrorCode: r.invite_delivery_error_code,
    staffJoinedAt: r.staff_joined_at,
    patientJoinedAt: r.patient_joined_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
  };
}

const VISIT_SELECT =
  "id, patient_id, purpose, notes, status, scheduled_at, created_by_email, link_version, invite_channel, invite_delivered, invite_delivery_status, invite_delivery_error_code, staff_joined_at, patient_joined_at, started_at, ended_at, created_at, guest_name, guest_email, guest_phone_e164, patients(legal_first_name, legal_last_name)";

// adminReadRateLimiter (a direct express-rate-limit instance) runs
// BEFORE requireAdmin — the auth gate does a DB-backed session lookup,
// so a limiter placed after it would leave that read unprotected (and
// CodeQL's js/missing-rate-limiting flags exactly that ordering).
router.get(
  "/admin/video-visits",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const includeClosed = req.query.include === "closed";
    let query = supabase
      .from("video_visits")
      .select(VISIT_SELECT)
      .order("created_at", { ascending: false })
      .limit(200);
    if (!includeClosed) {
      query = query.in("status", ["scheduled", "in_progress"]);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      visits: ((data ?? []) as unknown as VisitListRow[]).map(toApiVisit),
    });
  },
);

const E164_RE = /^\+\d{10,15}$/;

export const createBody = z
  .object({
    purpose: z.enum(["setup", "troubleshooting", "follow_up", "other"]),
    channel: z.enum(["email", "sms", "none"]),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    // Staff-facing context only ("walk through humidifier setup"). It
    // never renders to the patient.
    notes: z.string().trim().max(2000).optional(),
    // Optional contact overrides when the chart has none on file.
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(E164_RE, "Must be E.164 format, e.g. +12155551234")
      .optional(),
  })
  .strict();

type CreateBody = z.infer<typeof createBody>;

interface PatientSubject {
  kind: "patient";
  id: string;
  status: string;
  email: string | null;
  phone_e164: string | null;
  legal_first_name: string | null;
}

interface GuestSubject {
  kind: "guest";
  name: string;
}

/** Shared create path for chart-backed and guest (no-chart) visits:
 *  resolve the invite recipient, insert the row, deliver the link,
 *  audit, and respond. Both POST routes below are thin wrappers. */
async function createVisitAndRespond(
  req: Request,
  res: Response,
  body: CreateBody,
  subject: PatientSubject | GuestSubject,
): Promise<void> {
  // SMS to a non-active patient could violate a STOP opt-out (TCPA) —
  // refuse, mirroring patient-payment-link.ts. Email has no STOP
  // concept. Guests have no STOP ledger; this staff-initiated,
  // one-off transactional invite is the contact's requested service.
  if (
    subject.kind === "patient" &&
    body.channel === "sms" &&
    subject.status !== "active"
  ) {
    res.status(409).json({
      error: "patient_not_active",
      message: `Patient status is "${subject.status}". SMS is disabled for non-active patients (STOP opt-out).`,
    });
    return;
  }

  const recipientEmail =
    body.email ??
    (subject.kind === "patient"
      ? (subject.email?.toLowerCase() ?? null)
      : null);
  const recipientPhone =
    body.phoneE164 ??
    (subject.kind === "patient" ? (subject.phone_e164 ?? null) : null);
  if (body.channel === "email" && !recipientEmail) {
    res.status(422).json({
      error: "email_required",
      message:
        "No email available to send the visit link. Provide one, choose SMS, or copy the link.",
    });
    return;
  }
  if (body.channel === "sms" && !recipientPhone) {
    res.status(422).json({
      error: "phone_required",
      message:
        "No phone number available to send the visit link. Provide one, choose email, or copy the link.",
    });
    return;
  }

  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const { data: created, error: insertErr } = await supabase
    .from("video_visits")
    .insert({
      patient_id: subject.kind === "patient" ? subject.id : null,
      guest_name: subject.kind === "guest" ? subject.name : null,
      guest_email: subject.kind === "guest" ? recipientEmail : null,
      guest_phone_e164: subject.kind === "guest" ? recipientPhone : null,
      purpose: body.purpose,
      notes: body.notes ?? null,
      scheduled_at: body.scheduledAt ?? null,
      created_by_admin_user_id: req.adminUserId ?? null,
      created_by_email: req.adminEmail ?? null,
      invite_channel: body.channel,
    })
    .select(VISIT_SELECT)
    .single();
  if (insertErr) throw insertErr;
  const visit = created as unknown as VisitListRow;

  const joinUrl = await patientJoinUrl(orgId, visit.id, visit.link_version);

  const greetingName =
    subject.kind === "patient"
      ? (subject.legal_first_name ?? null)
      : (subject.name.split(/\s+/)[0] ?? null);

  let delivered = false;
  let deliveryError: string | null = null;
  if (body.channel !== "none") {
    const delivery = await deliverInvite({
      visitId: visit.id,
      channel: body.channel,
      orgId,
      email: recipientEmail,
      phone: recipientPhone,
      firstName: greetingName,
      practiceName: (await resolveBrandingByOrgId(orgId)).storefrontName,
      scheduledAt: visit.scheduled_at,
      link: joinUrl,
    });
    delivered = delivery.delivered;
    deliveryError = delivery.delivered ? null : (delivery.reason ?? null);
    await supabase
      .from("video_visits")
      .update({
        invite_delivered: delivered,
        // SMS only — the status callback correlates by visit id and
        // can land before this write, so it also stamps the SID.
        invite_twilio_message_sid: delivery.messageSid ?? null,
      })
      .eq("id", visit.id);
    visit.invite_delivered = delivered;
  }

  await logAudit({
    action: "patient.video_visit.created",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "video_visits",
    targetId: visit.id,
    metadata: {
      visit_id: visit.id,
      patient_id: subject.kind === "patient" ? subject.id : null,
      guest: subject.kind === "guest",
      purpose: body.purpose,
      channel: body.channel,
      delivered,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn(
      { err: redactDbErr(err) },
      "patient.video_visit.created audit write failed",
    );
  });

  res.status(201).json({
    visit: toApiVisit(visit),
    // Always returned so staff can copy/share the link directly —
    // and so the link is still usable when SMS/email isn't
    // configured in this environment.
    joinUrl,
    delivered,
    deliveryError,
  });
}

// On every mutation below, adminWriteRateLimiter (direct
// express-rate-limit) runs BEFORE requireAdmin for the same reason as
// the GET above; the per-admin inviteLimiter / adminRateLimit budgets
// stay AFTER the gate where req.adminUserId is populated.
router.post(
  "/admin/patients/:id/video-visits",
  adminWriteRateLimiter,
  requireAdmin,
  inviteLimiter,
  adminRateLimit({ name: "video_visits.create", preset: "mutation" }),
  async (req, res) => {
    if (!(await isFeatureEnabled("telehealth.video", req.orgId))) {
      res.status(503).json({ error: "feature_disabled" });
      return;
    }
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: patient, error: patientErr } = await supabase
      .from("patients")
      .select("id, status, email, phone_e164, legal_first_name")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    await createVisitAndRespond(req, res, parsed.data, {
      kind: "patient",
      ...patient,
    });
  },
);

// Universal create — the header "start a video visit" button. Accepts
// EITHER an existing patient (patientId) OR a typed-in guest who isn't
// in the system yet (guestName + the email/phoneE164 contact fields).
const universalCreateBody = createBody
  .extend({
    patientId: z.string().uuid().optional(),
    guestName: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasPatientId = Boolean(val.patientId);
    const hasGuestName = Boolean(val.guestName);
    if (hasPatientId === hasGuestName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of patientId or guestName.",
        path: ["patientId"],
      });
    }
    // Guests have no chart to fall back on, so the chosen delivery
    // channel must come with its contact up front — fail at validation
    // with a precise path instead of a late 422 from the create path.
    if (hasGuestName && val.channel === "sms" && !val.phoneE164) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An SMS invite for a guest needs phoneE164.",
        path: ["phoneE164"],
      });
    }
    if (hasGuestName && val.channel === "email" && !val.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An email invite for a guest needs email.",
        path: ["email"],
      });
    }
  });

router.post(
  "/admin/video-visits",
  adminWriteRateLimiter,
  requireAdmin,
  inviteLimiter,
  adminRateLimit({ name: "video_visits.create_universal", preset: "mutation" }),
  async (req, res) => {
    if (!(await isFeatureEnabled("telehealth.video", req.orgId))) {
      res.status(503).json({ error: "feature_disabled" });
      return;
    }
    const parsed = universalCreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const body = parsed.data;
    if (body.patientId) {
      const orgId = req.orgId;
      if (!orgId) {
        res.status(500).json({ error: "tenant_context_missing" });
        return;
      }
      const supabase = getOrgScopedClient(orgId);
      const { data: patient, error: patientErr } = await supabase
        .from("patients")
        .select("id, status, email, phone_e164, legal_first_name")
        .eq("id", body.patientId)
        .limit(1)
        .maybeSingle();
      if (patientErr) throw patientErr;
      if (!patient) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
      await createVisitAndRespond(req, res, body, {
        kind: "patient",
        ...patient,
      });
      return;
    }
    await createVisitAndRespond(req, res, body, {
      kind: "guest",
      name: body.guestName!,
    });
  },
);

const inviteBody = z
  .object({
    channel: z.enum(["email", "sms"]),
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(E164_RE, "Must be E.164 format, e.g. +12155551234")
      .optional(),
  })
  .strict();

router.post(
  "/admin/video-visits/:id/invite",
  adminWriteRateLimiter,
  requireAdmin,
  inviteLimiter,
  adminRateLimit({ name: "video_visits.invite", preset: "mutation" }),
  async (req, res) => {
    if (!(await isFeatureEnabled("telehealth.video", req.orgId))) {
      res.status(503).json({ error: "feature_disabled" });
      return;
    }
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = inviteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const body = parsed.data;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("video_visits")
      .select(
        "id, patient_id, purpose, notes, status, scheduled_at, created_by_email, link_version, invite_channel, invite_delivered, invite_delivery_status, invite_delivery_error_code, staff_joined_at, patient_joined_at, started_at, ended_at, created_at, guest_name, guest_email, guest_phone_e164, patients(legal_first_name, legal_last_name, status, email, phone_e164)",
      )
      .eq("id", idCheck.data)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const visit = data as unknown as VisitListRow & {
      patients: {
        legal_first_name: string | null;
        legal_last_name: string | null;
        status: string;
        email: string | null;
        phone_e164: string | null;
      } | null;
    };
    if (visit.status === "cancelled" || visit.status === "completed") {
      res.status(409).json({ error: "visit_closed" });
      return;
    }
    // TCPA guard applies to chart-backed visits only — guests have no
    // STOP ledger and the invite is a staff-initiated transactional
    // message for a service they requested.
    if (
      body.channel === "sms" &&
      visit.patient_id &&
      visit.patients?.status !== "active"
    ) {
      res.status(409).json({
        error: "patient_not_active",
        message:
          "SMS is disabled for non-active patients (STOP opt-out). Use email or copy the link.",
      });
      return;
    }
    const recipientEmail =
      body.email ??
      visit.patients?.email?.toLowerCase() ??
      visit.guest_email?.toLowerCase() ??
      null;
    const recipientPhone =
      body.phoneE164 ??
      visit.patients?.phone_e164 ??
      visit.guest_phone_e164 ??
      null;
    if (body.channel === "email" && !recipientEmail) {
      res.status(422).json({ error: "email_required" });
      return;
    }
    if (body.channel === "sms" && !recipientPhone) {
      res.status(422).json({ error: "phone_required" });
      return;
    }

    const joinUrl = await patientJoinUrl(orgId, visit.id, visit.link_version);
    const delivery = await deliverInvite({
      visitId: visit.id,
      channel: body.channel,
      orgId,
      email: recipientEmail,
      phone: recipientPhone,
      firstName:
        visit.patients?.legal_first_name ??
        visit.guest_name?.split(/\s+/)[0] ??
        null,
      practiceName: (await resolveBrandingByOrgId(orgId)).storefrontName,
      scheduledAt: visit.scheduled_at,
      link: joinUrl,
    });

    await supabase
      .from("video_visits")
      .update({
        invite_channel: body.channel,
        invite_delivered: delivery.delivered,
        invite_delivery_status: null,
        invite_delivery_error_code: null,
        invite_twilio_message_sid: delivery.messageSid ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", visit.id);

    await logAudit({
      action: "patient.video_visit.invited",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "video_visits",
      targetId: visit.id,
      metadata: {
        visit_id: visit.id,
        patient_id: visit.patient_id,
        channel: body.channel,
        delivered: delivery.delivered,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "patient.video_visit.invited audit write failed",
      );
    });

    res.json({
      joinUrl,
      delivered: delivery.delivered,
      deliveryError: delivery.delivered ? null : (delivery.reason ?? null),
    });
  },
);

router.post(
  "/admin/video-visits/:id/join",
  adminWriteRateLimiter,
  requireAdmin,
  adminRateLimit({ name: "video_visits.join", preset: "mutation" }),
  async (req, res) => {
    if (!(await isFeatureEnabled("telehealth.video", req.orgId))) {
      res.status(503).json({ error: "feature_disabled" });
      return;
    }
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("video_visits")
      .select(VISIT_SELECT)
      .eq("id", idCheck.data)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const visit = data as unknown as VisitListRow;
    if (visit.status === "cancelled" || visit.status === "completed") {
      res.status(409).json({ error: "visit_closed" });
      return;
    }
    // The WS upgrade can't ride the admin session cookie middleware, so
    // the staff seat authenticates with a short-lived signed token.
    const staffToken = signVideoVisitToken(
      visit.id,
      "staff",
      visit.link_version,
    );
    res.json({
      visit: toApiVisit(visit),
      staffToken,
      wsPath: VIDEO_SIGNAL_WS_PATH,
      iceServers: await resolveIceServers(),
      patientJoinUrl: await patientJoinUrl(orgId, visit.id, visit.link_version),
    });
  },
);

router.post(
  "/admin/video-visits/:id/cancel",
  adminWriteRateLimiter,
  requireAdmin,
  adminRateLimit({ name: "video_visits.cancel", preset: "mutation" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("video_visits")
      .select("id, patient_id, status, link_version")
      .eq("id", idCheck.data)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (data.status === "completed" || data.status === "cancelled") {
      res.status(409).json({ error: "visit_closed" });
      return;
    }
    // Bumping link_version revokes every outstanding patient link; the
    // signaling handler also re-checks status on connect.
    const { error: updateErr } = await supabase
      .from("video_visits")
      .update({
        status: "cancelled",
        link_version: data.link_version + 1,
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (updateErr) throw updateErr;

    await logAudit({
      action: "patient.video_visit.cancelled",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "video_visits",
      targetId: data.id,
      metadata: { visit_id: data.id, patient_id: data.patient_id },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "patient.video_visit.cancelled audit write failed",
      );
    });

    res.json({ ok: true });
  },
);

router.post(
  "/admin/video-visits/:id/complete",
  adminWriteRateLimiter,
  requireAdmin,
  adminRateLimit({ name: "video_visits.complete", preset: "mutation" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("video_visits")
      .select("id, patient_id, status")
      .eq("id", idCheck.data)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (data.status === "completed" || data.status === "cancelled") {
      res.status(409).json({ error: "visit_closed" });
      return;
    }
    const { error: updateErr } = await supabase
      .from("video_visits")
      .update({
        status: "completed",
        ended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (updateErr) throw updateErr;

    await logAudit({
      action: "patient.video_visit.completed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "video_visits",
      targetId: data.id,
      metadata: { visit_id: data.id, patient_id: data.patient_id },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "patient.video_visit.completed audit write failed",
      );
    });

    res.json({ ok: true });
  },
);

export default router;
