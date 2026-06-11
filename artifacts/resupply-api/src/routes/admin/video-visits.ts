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

import { Router, type IRouter, type Request } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { readPracticeName } from "../../lib/messaging/messaging-config";
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

/** Public origin patient join links are built against. Mirrors the
 *  helper in patient-payment-link.ts so staff-originated links are
 *  consistent across features. */
function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://pennpaps.com")
  ).replace(/\/$/, "");
}

function patientJoinUrl(visitId: string, linkVersion: number): string {
  const token = signVideoVisitToken(visitId, "patient", linkVersion);
  return `${publicBaseUrl()}/video-visit?token=${encodeURIComponent(token)}`;
}

function tryCreateSendgrid(): ReturnType<typeof createSendgridClient> | null {
  try {
    return createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) return null;
    throw err;
  }
}

function tryCreateTwilioSms(): ReturnType<typeof createTwilioSmsClient> | null {
  try {
    return createTwilioSmsClient();
  } catch (err) {
    if (err instanceof TwilioConfigError) return null;
    throw err;
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatWhen(scheduledAt: string | null): string | null {
  if (!scheduledAt) return null;
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function renderInviteEmailHtml(
  greeting: string,
  practiceName: string,
  when: string | null,
  link: string,
): string {
  const whenLine = when
    ? `<p style="margin:0 0 12px"><strong>When:</strong> ${escapeHtml(when)}</p>`
    : "";
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${escapeHtml(greeting)},</p>
  <p>Your care team at <strong>${escapeHtml(practiceName)}</strong> has set up a
  secure video visit to help you with your equipment. You can join from your
  phone, tablet, or computer — no app to install, just a camera and microphone.</p>
  ${whenLine}
  <p style="margin:24px 0">
    <a href="${escapeHtml(link)}" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Join your video visit</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Your browser will ask permission to
  use your camera and microphone when you join. The call is encrypted
  end-to-end and is never recorded.</p>
  <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy and
  paste this link:<br>${escapeHtml(link)}</p>
  <p>— The ${escapeHtml(practiceName)} team</p>
  </body></html>`;
}

function renderInviteEmailText(
  greeting: string,
  practiceName: string,
  when: string | null,
  link: string,
): string {
  return [
    `Hi ${greeting},`,
    "",
    `Your care team at ${practiceName} has set up a secure video visit to help`,
    "you with your equipment. You can join from your phone, tablet, or",
    "computer — no app to install, just a camera and microphone.",
    ...(when ? ["", `When: ${when}`] : []),
    "",
    `Join your video visit: ${link}`,
    "",
    "Your browser will ask permission to use your camera and microphone when",
    "you join. The call is encrypted end-to-end and is never recorded.",
    "",
    `— The ${practiceName} team`,
  ].join("\n");
}

/** Deliver the join link over the chosen channel. Never throws on a
 *  vendor/config failure — the staff member always gets a copy-able
 *  link back regardless. */
async function deliverInvite(opts: {
  channel: "email" | "sms";
  email: string | null;
  phone: string | null;
  firstName: string | null;
  practiceName: string;
  scheduledAt: string | null;
  link: string;
}): Promise<{ delivered: boolean; reason?: string }> {
  const greeting = opts.firstName?.trim() ? opts.firstName.trim() : "there";
  const when = formatWhen(opts.scheduledAt);
  try {
    if (opts.channel === "email") {
      if (!opts.email) return { delivered: false, reason: "no_email" };
      const sendgrid = tryCreateSendgrid();
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
    const twilio = tryCreateTwilioSms();
    if (!twilio) return { delivered: false, reason: "no_sms_config" };
    await twilio.sendSms({
      to: opts.phone,
      body: when
        ? `Hi ${greeting}, this is ${opts.practiceName}. Your video visit is set for ${when}. Join from your phone or computer: ${opts.link}`
        : `Hi ${greeting}, this is ${opts.practiceName}. Join your secure video visit from your phone or computer: ${opts.link}`,
    });
    return { delivered: true };
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

interface VisitListRow {
  id: string;
  patient_id: string;
  purpose: string;
  notes: string | null;
  status: string;
  scheduled_at: string | null;
  created_by_email: string | null;
  link_version: number;
  invite_channel: string | null;
  invite_delivered: boolean | null;
  staff_joined_at: string | null;
  patient_joined_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  patients: {
    legal_first_name: string | null;
    legal_last_name: string | null;
  } | null;
}

function toApiVisit(r: VisitListRow) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName:
      [r.patients?.legal_first_name, r.patients?.legal_last_name]
        .filter(Boolean)
        .join(" ") || null,
    purpose: r.purpose,
    notes: r.notes,
    status: r.status,
    scheduledAt: r.scheduled_at,
    createdByEmail: r.created_by_email,
    inviteChannel: r.invite_channel,
    inviteDelivered: r.invite_delivered,
    staffJoinedAt: r.staff_joined_at,
    patientJoinedAt: r.patient_joined_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
  };
}

const VISIT_SELECT =
  "id, patient_id, purpose, notes, status, scheduled_at, created_by_email, link_version, invite_channel, invite_delivered, staff_joined_at, patient_joined_at, started_at, ended_at, created_at, patients(legal_first_name, legal_last_name)";

// adminReadRateLimiter (a direct express-rate-limit instance) runs
// BEFORE requireAdmin — the auth gate does a DB-backed session lookup,
// so a limiter placed after it would leave that read unprotected (and
// CodeQL's js/missing-rate-limiting flags exactly that ordering).
router.get(
  "/admin/video-visits",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const includeClosed = req.query.include === "closed";
    let query = supabase
      .schema("resupply")
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

const createBody = z
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
    if (!(await isFeatureEnabled("telehealth.video"))) {
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
    const body = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
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

    // SMS to a non-active patient could violate a STOP opt-out (TCPA) —
    // refuse, mirroring patient-payment-link.ts. Email has no STOP
    // concept.
    if (body.channel === "sms" && patient.status !== "active") {
      res.status(409).json({
        error: "patient_not_active",
        message: `Patient status is "${patient.status}". SMS is disabled for non-active patients (STOP opt-out).`,
      });
      return;
    }

    const recipientEmail = body.email ?? patient.email?.toLowerCase() ?? null;
    const recipientPhone = body.phoneE164 ?? patient.phone_e164 ?? null;
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

    const { data: created, error: insertErr } = await supabase
      .schema("resupply")
      .from("video_visits")
      .insert({
        patient_id: patient.id,
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

    const joinUrl = patientJoinUrl(visit.id, visit.link_version);

    let delivered = false;
    let deliveryError: string | null = null;
    if (body.channel !== "none") {
      const delivery = await deliverInvite({
        channel: body.channel,
        email: recipientEmail,
        phone: recipientPhone,
        firstName: patient.legal_first_name ?? null,
        practiceName: readPracticeName(),
        scheduledAt: visit.scheduled_at,
        link: joinUrl,
      });
      delivered = delivery.delivered;
      deliveryError = delivery.delivered ? null : (delivery.reason ?? null);
      await supabase
        .schema("resupply")
        .from("video_visits")
        .update({ invite_delivered: delivered })
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
        patient_id: patient.id,
        purpose: body.purpose,
        channel: body.channel,
        delivered,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.video_visit.created audit write failed");
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
    if (!(await isFeatureEnabled("telehealth.video"))) {
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
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("video_visits")
      .select(
        "id, patient_id, purpose, notes, status, scheduled_at, created_by_email, link_version, invite_channel, invite_delivered, staff_joined_at, patient_joined_at, started_at, ended_at, created_at, patients(legal_first_name, legal_last_name, status, email, phone_e164)",
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
    if (body.channel === "sms" && visit.patients?.status !== "active") {
      res.status(409).json({
        error: "patient_not_active",
        message:
          "SMS is disabled for non-active patients (STOP opt-out). Use email or copy the link.",
      });
      return;
    }
    const recipientEmail =
      body.email ?? visit.patients?.email?.toLowerCase() ?? null;
    const recipientPhone = body.phoneE164 ?? visit.patients?.phone_e164 ?? null;
    if (body.channel === "email" && !recipientEmail) {
      res.status(422).json({ error: "email_required" });
      return;
    }
    if (body.channel === "sms" && !recipientPhone) {
      res.status(422).json({ error: "phone_required" });
      return;
    }

    const joinUrl = patientJoinUrl(visit.id, visit.link_version);
    const delivery = await deliverInvite({
      channel: body.channel,
      email: recipientEmail,
      phone: recipientPhone,
      firstName: visit.patients?.legal_first_name ?? null,
      practiceName: readPracticeName(),
      scheduledAt: visit.scheduled_at,
      link: joinUrl,
    });

    await supabase
      .schema("resupply")
      .from("video_visits")
      .update({
        invite_channel: body.channel,
        invite_delivered: delivery.delivered,
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
      logger.warn({ err }, "patient.video_visit.invited audit write failed");
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
    if (!(await isFeatureEnabled("telehealth.video"))) {
      res.status(503).json({ error: "feature_disabled" });
      return;
    }
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
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
      patientJoinUrl: patientJoinUrl(visit.id, visit.link_version),
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
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
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
      .schema("resupply")
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
      logger.warn({ err }, "patient.video_visit.cancelled audit write failed");
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
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
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
      .schema("resupply")
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
      logger.warn({ err }, "patient.video_visit.completed audit write failed");
    });

    res.json({ ok: true });
  },
);

export default router;
