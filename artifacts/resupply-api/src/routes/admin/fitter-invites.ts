// /admin/fitter-invites — staff-initiated AI mask-fitter invitations.
//
// A CSR / fitter sends a prospective or current patient a signed link
// to run the on-device AI mask fitter. On completion the patient's
// numeric facial measurements, questionnaire answers, and mask
// recommendation are transmitted back (see ../shop/fitter-invite.ts)
// and recorded on the fitter_invites row for follow-up.
//
// Endpoints (requirePermission):
//   POST   /admin/fitter-invites             — create + send an invite
//   GET    /admin/fitter-invites             — worklist (filter by status)
//   POST   /admin/fitter-invites/:id/resend  — re-mint token + resend
//   POST   /admin/fitter-invites/:id/attach  — link a completed fitting
//                                              to a patient chart (existing
//                                              or a freshly-built one)
//   DELETE /admin/fitter-invites/:id         — revoke before completion
//
// Auto-attach happens on the public completion endpoint, not here:
// when the recipient email/phone matches exactly one patient, that
// chart is linked automatically. This route's /attach handles the
// unmatched case (no match, or ambiguous) — the worklist resolves it.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import {
  FITTER_INVITE_TTL_MS,
  signFitterInviteToken,
} from "../../lib/fitter-invite-token";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type FitterInvitesInsert =
  Database["resupply"]["Tables"]["fitter_invites"]["Insert"];
type PatientsInsert = Database["resupply"]["Tables"]["patients"]["Insert"];

const router: IRouter = Router();

// Same shape as the patient-portal-invite limiter: 30 sends/hour per
// admin caps a compromised-account spam scenario while leaving plenty
// of headroom for legitimate fitter outreach. Keyed by adminUserId.
const inviteSendLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.adminUserId ?? "unknown",
  message: {
    error: "too_many_requests",
    limiter: "admin_fitter_invite",
    message:
      "You're sending fitter invites too quickly. Please wait a few minutes and try again.",
  },
});

/** Public storefront origin the patient-facing link is built against.
 *  Mirrors the helper in the supply-campaign dispatcher so links are
 *  consistent across staff- and system-originated sends. */
function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://pennpaps.com")
  ).replace(/\/$/, "");
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

const inviteLinkFor = (token: string) =>
  `${publicBaseUrl()}/fitter-invite?t=${encodeURIComponent(token)}`;

/** Send the invite over the chosen channel. Returns whether delivery
 *  succeeded; never throws on a vendor / config failure so the caller
 *  can still hand the staff member a copy-able link. */
async function deliverInvite(opts: {
  channel: "email" | "sms";
  email: string | null;
  phone: string | null;
  name: string | null;
  link: string;
}): Promise<{ delivered: boolean; reason?: string }> {
  const greeting = opts.name ? opts.name.split(/\s+/)[0] : "there";
  try {
    if (opts.channel === "email") {
      if (!opts.email) return { delivered: false, reason: "no_email" };
      const sendgrid = tryCreateSendgrid();
      if (!sendgrid) return { delivered: false, reason: "no_email_config" };
      await sendgrid.sendEmail({
        to: opts.email,
        // No PHI in the subject line — provider subjects aren't encrypted.
        subject: "Find your best CPAP mask fit with PennPaps",
        html: renderInviteEmailHtml(greeting, opts.link),
        text: renderInviteEmailText(greeting, opts.link),
      });
      return { delivered: true };
    }
    // SMS
    if (!opts.phone) return { delivered: false, reason: "no_phone" };
    const twilio = tryCreateTwilioSms();
    if (!twilio) return { delivered: false, reason: "no_sms_config" };
    await twilio.sendSms({
      to: opts.phone,
      body: `Hi ${greeting}, PennPaps invites you to find your best CPAP mask fit — it takes about 2 minutes on your phone: ${opts.link}`,
    });
    return { delivered: true };
  } catch (err) {
    logger.warn({ err, channel: opts.channel }, "fitter-invite: send failed");
    return {
      delivered: false,
      reason: err instanceof Error ? err.message.slice(0, 120) : "send_error",
    };
  }
}

function renderInviteEmailHtml(greeting: string, link: string): string {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${escapeHtml(greeting)},</p>
  <p>Your care team at <strong>PennPaps</strong> invites you to use our AI mask
  fitter to find the CPAP mask that fits you best. It takes about two minutes
  and runs entirely on your own phone or computer.</p>
  <p style="margin:24px 0">
    <a href="${escapeHtml(link)}" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Start your mask fitting</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Your camera images never leave your
  device — only the numeric measurements are shared with our team so we can
  follow up on your fit.</p>
  <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy and
  paste this link:<br>${escapeHtml(link)}</p>
  <p>— The PennPaps team</p>
  </body></html>`;
}

function renderInviteEmailText(greeting: string, link: string): string {
  return [
    `Hi ${greeting},`,
    "",
    "Your care team at PennPaps invites you to use our AI mask fitter to find",
    "the CPAP mask that fits you best. It takes about two minutes and runs",
    "entirely on your own phone or computer.",
    "",
    `Start your mask fitting: ${link}`,
    "",
    "Your camera images never leave your device — only the numeric measurements",
    "are shared with our team so we can follow up on your fit.",
    "",
    "— The PennPaps team",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const E164_RE = /^\+\d{10,15}$/;

const createBody = z
  .object({
    // Either invite a current patient (server resolves their contact)…
    patientId: z.string().uuid().optional(),
    // …or a prospect, where the sender supplies the contact directly.
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(E164_RE, "Must be E.164 format, e.g. +12155551234")
      .optional(),
    name: z.string().trim().min(1).max(200).optional(),
    channel: z.enum(["email", "sms"]),
  })
  .strict();

router.post(
  "/admin/fitter-invites",
  // Sending outreach to a patient/prospect — same scope as fitter-leads.
  requirePermission("conversations.manage"),
  inviteSendLimiter,
  adminRateLimit({ name: "fitter_invites.create", preset: "sensitive" }),
  async (req, res) => {
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

    let patientId: string | null = null;
    let recipientEmail: string | null = body.email ?? null;
    let recipientPhone: string | null = body.phoneE164 ?? null;
    let recipientName: string | null = body.name ?? null;

    // Current-patient mode: resolve contact from the chart. The sender
    // can still override email/phone/name (e.g. the chart has no email)
    // by passing them explicitly.
    if (body.patientId) {
      const { data: patient, error: patientErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, email, phone_e164, legal_first_name, legal_last_name")
        .eq("id", body.patientId)
        .limit(1)
        .maybeSingle();
      if (patientErr) throw patientErr;
      if (!patient) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
      patientId = patient.id;
      recipientEmail = recipientEmail ?? patient.email?.toLowerCase() ?? null;
      recipientPhone = recipientPhone ?? patient.phone_e164 ?? null;
      if (!recipientName) {
        const chartName = [patient.legal_first_name, patient.legal_last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        recipientName = chartName.length > 0 ? chartName : null;
      }
    }

    // The chosen channel must have a contact to deliver to.
    if (body.channel === "email" && !recipientEmail) {
      res.status(422).json({
        error: "email_required",
        message:
          "No email available to send the invite. Provide one or choose SMS.",
      });
      return;
    }
    if (body.channel === "sms" && !recipientPhone) {
      res.status(422).json({
        error: "phone_required",
        message:
          "No phone number available to send the invite. Provide one or choose email.",
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(
      Date.now() + FITTER_INVITE_TTL_MS,
    ).toISOString();
    const insert: FitterInvitesInsert = {
      patient_id: patientId,
      recipient_email: recipientEmail,
      recipient_phone_e164: recipientPhone,
      recipient_name: recipientName,
      channel: body.channel,
      status: "sent",
      invited_by_user_id: req.adminUserId ?? null,
      invited_by_email: req.adminEmail ?? null,
      sent_at: nowIso,
      expires_at: expiresIso,
    };
    const { data: row, error: insertErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .insert(insert)
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertErr) throw insertErr;
    if (!row) throw new Error("fitter_invites insert returned no rows");

    const token = signFitterInviteToken(row.id);
    const link = inviteLinkFor(token);
    const delivery = await deliverInvite({
      channel: body.channel,
      email: recipientEmail,
      phone: recipientPhone,
      name: recipientName,
      link,
    });

    await logAudit({
      action: "fitter.invite.sent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fitter_invites",
      targetId: row.id,
      metadata: {
        channel: body.channel,
        patient_id: patientId,
        delivered: delivery.delivered,
        // Counts/flags only — never the recipient's email/phone (PHI).
        prospect: patientId === null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "fitter.invite.sent audit write failed");
    });

    res.status(201).json({
      id: row.id,
      channel: body.channel,
      delivered: delivery.delivered,
      deliveryError: delivery.delivered ? null : (delivery.reason ?? null),
      // Always returned so staff can copy/share the link directly
      // (e.g. read it aloud in-office or paste into another channel).
      inviteLink: link,
    });
  },
);

const listQuery = z.object({
  status: z
    .enum([
      "all",
      "sent",
      "opened",
      "completed",
      "attached",
      "revoked",
      "expired",
    ])
    .default("all"),
});

router.get(
  "/admin/fitter-invites",
  requirePermission("patients.read"),
  adminRateLimit({ name: "fitter_invites.list", preset: "query" }),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let q = supabase
      .schema("resupply")
      .from("fitter_invites")
      .select(
        "id, patient_id, recipient_email, recipient_phone_e164, recipient_name, channel, status, invited_by_email, measurements, questionnaire_answers, recommended_mask_id, recommended_mask_name, recommended_mask_type, recommendations, auto_matched, sent_at, opened_at, completed_at, attached_at, expires_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (parsed.data.status !== "all") {
      q = q.eq("status", parsed.data.status);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ invites: data ?? [] });
  },
);

const attachBody = z
  .object({
    // Attach to an existing chart…
    patientId: z.string().uuid().optional(),
    // …or build a new chart from the captured contact. Name + DOB are
    // the minimum the patients table requires.
    createPatient: z
      .object({
        legalFirstName: z.string().trim().min(1).max(100),
        legalLastName: z.string().trim().min(1).max(100),
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => Boolean(b.patientId) !== Boolean(b.createPatient), {
    message: "Provide exactly one of patientId or createPatient.",
  });

router.post(
  "/admin/fitter-invites/:id/attach",
  // Linking a fitting to a chart edits patient data — patients.update.
  requirePermission("patients.update"),
  adminRateLimit({ name: "fitter_invites.attach", preset: "mutation" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    const parsed = attachBody.safeParse(req.body ?? {});
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

    const supabase = getSupabaseServiceRoleClient();
    const { data: invite, error: inviteErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .select("id, status, recipient_email, recipient_phone_e164")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (inviteErr) throw inviteErr;
    if (!invite) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    if (invite.status !== "completed" && invite.status !== "attached") {
      res.status(409).json({
        error: "not_completed",
        message: "Only a completed fitting can be attached to a chart.",
      });
      return;
    }

    let targetPatientId: string;
    // True when this attach built a brand-new chart and enrolled it in
    // the first-90-day onboarding program (the existing onboarding
    // flow). Surfaced in the response + audit.
    let enrolledInOnboarding = false;
    if (parsed.data.patientId) {
      const { data: patient, error: patientErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id")
        .eq("id", parsed.data.patientId)
        .limit(1)
        .maybeSingle();
      if (patientErr) throw patientErr;
      if (!patient) {
        res.status(404).json({ error: "patient_not_found" });
        return;
      }
      targetPatientId = patient.id;
    } else {
      // Build a new chart. pacware_id is NOT NULL + UNIQUE; web-
      // originated prospects have no EHR id yet, so mint a WEB- one.
      const cp = parsed.data.createPatient!;
      const newPatient: PatientsInsert = {
        pacware_id: `WEB-${idCheck.data.slice(0, 8)}`,
        legal_first_name: cp.legalFirstName,
        legal_last_name: cp.legalLastName,
        date_of_birth: cp.dateOfBirth,
        email: invite.recipient_email,
        phone_e164: invite.recipient_phone_e164,
        status: "active",
      };
      const { data: created, error: createErr } = await supabase
        .schema("resupply")
        .from("patients")
        .insert(newPatient)
        .select("id")
        .limit(1)
        .maybeSingle();
      if (createErr) {
        if ((createErr as { code?: string }).code === "23505") {
          res.status(409).json({
            error: "patient_exists",
            message:
              "A chart already exists for this prospect — attach to it instead.",
          });
          return;
        }
        throw createErr;
      }
      if (!created) throw new Error("patients insert returned no rows");
      targetPatientId = created.id;

      // Route the new prospect through the EXISTING onboarding flow —
      // enroll them in the first-90-day adherence-coaching program the
      // same way POST /admin/patients/:id/onboarding/enroll does, so a
      // fitter-sourced chart enters the standard pipeline instead of
      // sitting bare. Best-effort: the chart + fitting attach are the
      // primary outcome; a journey-insert hiccup must not 500 the
      // attach. (No active-journey precheck needed — the patient was
      // just created.)
      const { error: journeyErr } = await supabase
        .schema("resupply")
        .from("patient_onboarding_journeys")
        .insert({
          patient_id: targetPatientId,
          started_at: new Date().toISOString(),
          enrolled_by_email: req.adminEmail ?? "<unknown>",
          enrolled_by_user_id: req.adminUserId ?? null,
        });
      if (journeyErr) {
        logger.warn(
          { err: journeyErr, patient_id: targetPatientId },
          "fitter-invite attach: onboarding enrollment failed (continuing)",
        );
      } else {
        enrolledInOnboarding = true;
        await logAudit({
          action: "patient.onboarding.enroll",
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          targetTable: "patient_onboarding_journeys",
          targetId: targetPatientId,
          metadata: { patient_id: targetPatientId, source: "fitter_invite" },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        }).catch((err) => {
          logger.warn({ err }, "patient.onboarding.enroll audit write failed");
        });
      }
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .update({
        patient_id: targetPatientId,
        status: "attached",
        attached_at: nowIso,
        auto_matched: false,
        updated_at: nowIso,
      })
      .eq("id", idCheck.data);
    if (updErr) throw updErr;

    await logAudit({
      action: "fitter.invite.attached",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fitter_invites",
      targetId: idCheck.data,
      metadata: {
        patient_id: targetPatientId,
        created_chart: Boolean(parsed.data.createPatient),
        enrolled_in_onboarding: enrolledInOnboarding,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "fitter.invite.attached audit write failed");
    });

    res.json({
      id: idCheck.data,
      patientId: targetPatientId,
      status: "attached",
      enrolledInOnboarding,
    });
  },
);

router.post(
  "/admin/fitter-invites/:id/resend",
  requirePermission("conversations.manage"),
  inviteSendLimiter,
  adminRateLimit({ name: "fitter_invites.resend", preset: "sensitive" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: invite, error: inviteErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .select(
        "id, status, channel, recipient_email, recipient_phone_e164, recipient_name",
      )
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (inviteErr) throw inviteErr;
    if (!invite) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    if (invite.status === "revoked") {
      res.status(409).json({
        error: "revoked",
        message: "This invite was revoked. Create a new one instead.",
      });
      return;
    }

    // Re-mint a fresh token (extends the expiry window) and re-arm the
    // row to 'sent' so a previously-opened-but-abandoned invite reads
    // cleanly in the worklist again.
    const token = signFitterInviteToken(invite.id);
    const link = inviteLinkFor(token);
    const delivery = await deliverInvite({
      channel: invite.channel,
      email: invite.recipient_email,
      phone: invite.recipient_phone_e164,
      name: invite.recipient_name,
      link,
    });

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(
      Date.now() + FITTER_INVITE_TTL_MS,
    ).toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .update({
        status: invite.status === "completed" ? "completed" : "sent",
        sent_at: nowIso,
        expires_at: expiresIso,
        updated_at: nowIso,
      })
      .eq("id", invite.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "fitter.invite.resent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fitter_invites",
      targetId: invite.id,
      metadata: { channel: invite.channel, delivered: delivery.delivered },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "fitter.invite.resent audit write failed");
    });

    res.json({
      id: invite.id,
      delivered: delivery.delivered,
      deliveryError: delivery.delivered ? null : (delivery.reason ?? null),
      inviteLink: link,
    });
  },
);

router.delete(
  "/admin/fitter-invites/:id",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fitter_invites.revoke", preset: "destroy" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: invite, error: inviteErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .select("id, status")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (inviteErr) throw inviteErr;
    if (!invite) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    if (invite.status === "revoked") {
      res.json({ id: invite.id, status: "revoked", alreadyRevoked: true });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .update({ status: "revoked", revoked_at: nowIso, updated_at: nowIso })
      .eq("id", invite.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "fitter.invite.revoked",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fitter_invites",
      targetId: invite.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "fitter.invite.revoked audit write failed");
    });

    res.json({ id: invite.id, status: "revoked" });
  },
);

export default router;
