// /admin/patients/:id/portal-invite — invite a patient to create their
// self-service portal account.
//
// Endpoints (requireAdmin — agents/CSRs can send invites):
//   POST   /admin/patients/:id/portal-invite          — send invite + optionally
//                                                       update required onboarding
//                                                       fields on the patient row
//   POST   /admin/patients/:id/portal-invite/resend   — reissue token + resend email
//   DELETE /admin/patients/:id/portal-invite          — revoke portal access
//
// Invite flow:
//   1. CSR opens the patient Portal tab, fills in any missing required
//      fields (email, phone, address, insurance payer, channel pref),
//      and clicks "Send invite".
//   2. We upsert an resupply_auth.users row (role=customer, status=invited) and
//      issue a 7-day password_reset token.
//   3. A patient-specific "Set up your portal" email is sent. If
//      SendGrid isn't configured, emailSent=false and inviteLink is
//      returned for out-of-band delivery.
//   4. patients.portal_auth_user_id is linked; portal_invited_at /
//      portal_invited_by are stamped.
//
// Portal status (returned on GET /patients/:id) is computed from the
// linked resupply_auth.users row — no separate status column to keep in sync.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
} from "@workspace/resupply-db";
import {
  bufferToHexBytea,
  issueToken,
  renderPatientPortalInviteEmail,
  revokeTeamMember,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type PatientUpdate = Database["resupply"]["Tables"]["patients"]["Update"];

const router: IRouter = Router();

// B-07: 30 invite sends per hour per admin. Each call triggers one
// email or SMS; 30/hour covers legitimate CSR workflows while capping
// a compromised-account email-spam scenario. Keyed by adminUserId
// (populated by requireAdmin, which runs first) so one CSR's burst
// doesn't starve other staff.
const adminInviteLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.adminUserId ?? "unknown",
  message: {
    error: "too_many_requests",
    limiter: "admin_portal_invite",
    message:
      "You're sending invites too quickly. Please wait a few minutes and try again.",
  },
});

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const patientIdParam = z.string().uuid();

const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(2).max(50),
    postalCode: z.string().trim().min(1).max(20),
    country: z.string().trim().min(2).max(60).default("US"),
  })
  .strict();

// Required onboarding fields the CSR can provide or update when
// sending the invite. email is required if the patient has none on
// file. All other fields are optional but filled in here so the
// patient record is complete before the patient logs in.
const inviteBody = z
  .object({
    // Portal login email. Required if the patient row has no email.
    // If omitted, the patient's existing email is used.
    email: z.string().trim().toLowerCase().email().optional(),

    // Onboarding fields the CSR can fill in / update at invite time.
    phoneE164: z
      .string()
      .trim()
      .regex(
        /^\+1\d{10}$/,
        "Must be E.164 format starting with +1, e.g. +12155551234",
      )
      .optional()
      .nullable(),
    address: addressSchema.optional().nullable(),
    insurancePayer: z.string().trim().min(1).max(200).optional().nullable(),
    channelPreference: z.enum(["sms", "email", "voice"]).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/patients/:id/portal-invite",
  // Mints a portal access invite (sends an email + writes a token).
  // `patients.update` scope.
  requirePermission("patients.update"),
  adminInviteLimiter,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const bodyParsed = inviteBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, email, legal_first_name, portal_auth_user_id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    // Resolve the email to use for the portal account.
    const emailLower = bodyParsed.data.email ?? patient.email?.toLowerCase();
    if (!emailLower) {
      res.status(422).json({
        error: "email_required",
        message:
          "This patient has no email address on file. Provide one in the invite form.",
      });
      return;
    }

    // If there is already an active portal account (email_verified_at
    // set) block re-invite — the CSR should use Delete+Resend flow.
    if (patient.portal_auth_user_id) {
      const { data: authRow, error: authErr } = await supabase
        .schema("resupply_auth")
        .from("users")
        .select("email_verified_at")
        .eq("id", patient.portal_auth_user_id)
        .limit(1)
        .maybeSingle();
      if (authErr) throw authErr;
      if (authRow?.email_verified_at) {
        res.status(409).json({
          error: "already_active",
          message:
            "This patient already has an active portal account. Revoke first if you need to re-invite.",
        });
        return;
      }
    }

    // Apply any onboarding field updates the CSR provided.
    const fieldUpdates: PatientUpdate = {
      updated_at: new Date().toISOString(),
    };
    const fieldsUpdatedKeys: string[] = [];
    if (bodyParsed.data.email) {
      fieldUpdates.email = bodyParsed.data.email;
      fieldsUpdatedKeys.push("email");
    }
    if ("phoneE164" in bodyParsed.data) {
      fieldUpdates.phone_e164 = bodyParsed.data.phoneE164 ?? null;
      fieldsUpdatedKeys.push("phoneE164");
    }
    if ("address" in bodyParsed.data) {
      fieldUpdates.address = (bodyParsed.data.address ??
        null) as unknown as Json;
      fieldsUpdatedKeys.push("address");
    }
    if ("insurancePayer" in bodyParsed.data) {
      fieldUpdates.insurance_payer = bodyParsed.data.insurancePayer ?? null;
      fieldsUpdatedKeys.push("insurancePayer");
    }
    if ("channelPreference" in bodyParsed.data) {
      fieldUpdates.channel_preference =
        bodyParsed.data.channelPreference ?? null;
      fieldsUpdatedKeys.push("channelPreference");
    }

    // Upsert resupply_auth.users (role=customer). The original raw SQL
    // used a CASE inside ON CONFLICT to flip 'revoked' → 'invited'
    // while leaving other statuses untouched. PostgREST has neither
    // ON CONFLICT-CASE nor RETURNING-with-CASE, so we read-then-write:
    // look up the row, decide JS-side, upsert with onConflict
    // 'email_lower'. We never downgrade an admin/agent role to
    // customer.
    const { data: existingAuth, error: existingAuthErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .select("id, role, status")
      .eq("email_lower", emailLower)
      .limit(1)
      .maybeSingle();
    if (existingAuthErr) throw existingAuthErr;

    let authUserId: string;
    if (existingAuth) {
      const nextStatus =
        existingAuth.status === "revoked" ? "invited" : existingAuth.status;
      const { error: updateAuthErr } = await supabase
        .schema("resupply_auth")
        .from("users")
        .update({
          status: nextStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingAuth.id);
      if (updateAuthErr) throw updateAuthErr;
      authUserId = existingAuth.id;
    } else {
      const { data: insertedAuth, error: insertAuthErr } = await supabase
        .schema("resupply_auth")
        .from("users")
        .insert({
          email_lower: emailLower,
          role: "customer",
          status: "invited",
        })
        .select("id")
        .limit(1)
        .maybeSingle();
      if (insertAuthErr) throw insertAuthErr;
      if (!insertedAuth) {
        throw new Error("resupply_auth.users insert returned no rows");
      }
      authUserId = insertedAuth.id;
    }

    // Guard against a CSR inadvertently (or maliciously) supplying an
    // email that already belongs to a DIFFERENT patient's portal
    // account. The original SQL path took a transaction-scoped
    // pg_advisory_xact_lock keyed on the auth user id and ran the
    // check + UPDATE in one transaction. PostgREST has no
    // transactions and no advisory locks, so we accept a narrow race
    // window: two near-simultaneous invites for the same target email
    // could each pass the "claimed by other" check. A migration to an
    // RPC that wraps the transaction is the long-term answer.
    const { data: claimedByOther, error: claimedErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("portal_auth_user_id", authUserId)
      .neq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (claimedErr) throw claimedErr;
    if (claimedByOther) {
      res.status(409).json({
        error: "email_already_linked",
        message:
          "This email address is already linked to a different patient's portal account. Use a different email or contact support.",
      });
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const { error: linkErr } = await supabase
      .schema("resupply")
      .from("patients")
      .update({
        ...fieldUpdates,
        portal_auth_user_id: authUserId,
        portal_invited_at: nowIso,
        portal_invited_by: req.adminUserId ?? null,
      })
      .eq("id", patientId);
    if (linkErr) throw linkErr;

    // Issue a 7-day password_reset token. The hash column is bytea —
    // PostgREST round-trips bytea as `\x<hex>` JSON strings.
    const token = issueToken();
    const expiresAtIso = new Date(
      Date.now() + INVITE_TOKEN_TTL_MS,
    ).toISOString();
    const { error: tokenErr } = await supabase
      .schema("resupply_auth")
      .from("email_tokens")
      .insert({
        token_hash: bufferToHexBytea(token.hash),
        user_id: authUserId,
        purpose: "password_reset",
        expires_at: expiresAtIso,
      });
    if (tokenErr) throw tokenErr;

    const deps = getAuthDeps();
    const baseUrl = deps.publicBaseUrl.replace(/\/$/, "");
    const inviteLink = `${baseUrl}/reset-password?token=${encodeURIComponent(token.raw)}`;

    const rendered = renderPatientPortalInviteEmail(
      { productName: "PennPaps", publicBaseUrl: baseUrl },
      token.raw,
      patient.legal_first_name,
    );

    let emailSent = false;
    try {
      await deps.email({
        to: emailLower,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      emailSent = true;
    } catch (err) {
      logger.warn(
        { err, patient_id: patientId },
        "patient portal invite email send failed",
      );
    }

    await logAudit({
      action: "patient.portal.invite_issued",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: patientId,
      metadata: {
        auth_user_id: authUserId,
        email_sent: emailSent,
        expires_at: expiresAtIso,
        fields_updated: fieldsUpdatedKeys,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.portal.invite_issued audit write failed");
    });

    res.status(201).json({
      portalAuthUserId: authUserId,
      portalStatus: "pending",
      emailSent,
      inviteLink: emailSent ? null : inviteLink,
    });
  },
);

router.post(
  "/admin/patients/:id/portal-invite/resend",
  requirePermission("patients.update"),
  adminInviteLimiter,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, email, legal_first_name, portal_auth_user_id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (!patient.portal_auth_user_id) {
      res.status(409).json({
        error: "not_invited",
        message: "No portal invite exists for this patient. Send one first.",
      });
      return;
    }

    const { data: auth, error: authErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .select("id, email_lower, email_verified_at")
      .eq("id", patient.portal_auth_user_id)
      .limit(1)
      .maybeSingle();
    if (authErr) throw authErr;
    if (!auth) {
      res.status(500).json({ error: "auth_row_missing" });
      return;
    }
    if (auth.email_verified_at) {
      res.status(409).json({
        error: "already_active",
        message:
          "This patient already has an active portal account. Resend is only for pending invites.",
      });
      return;
    }

    const token = issueToken();
    const expiresAtIso = new Date(
      Date.now() + INVITE_TOKEN_TTL_MS,
    ).toISOString();
    const { error: tokenErr } = await supabase
      .schema("resupply_auth")
      .from("email_tokens")
      .insert({
        token_hash: bufferToHexBytea(token.hash),
        user_id: auth.id,
        purpose: "password_reset",
        expires_at: expiresAtIso,
      });
    if (tokenErr) throw tokenErr;

    const deps = getAuthDeps();
    const baseUrl = deps.publicBaseUrl.replace(/\/$/, "");
    const inviteLink = `${baseUrl}/reset-password?token=${encodeURIComponent(token.raw)}`;

    const rendered = renderPatientPortalInviteEmail(
      { productName: "PennPaps", publicBaseUrl: baseUrl },
      token.raw,
      patient.legal_first_name,
    );

    let emailSent = false;
    try {
      await deps.email({
        to: auth.email_lower,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      emailSent = true;
    } catch (err) {
      logger.warn(
        { err, patient_id: patientId },
        "patient portal invite resend email failed",
      );
    }

    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .schema("resupply")
      .from("patients")
      .update({
        portal_invited_at: nowIso,
        portal_invited_by: req.adminUserId ?? null,
        updated_at: nowIso,
      })
      .eq("id", patientId);
    if (stampErr) throw stampErr;

    await logAudit({
      action: "patient.portal.invite_resent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: patientId,
      metadata: {
        auth_user_id: auth.id,
        email_sent: emailSent,
        expires_at: expiresAtIso,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.portal.invite_resent audit write failed");
    });

    res.json({
      portalStatus: "pending",
      emailSent,
      inviteLink: emailSent ? null : inviteLink,
    });
  },
);

router.delete(
  "/admin/patients/:id/portal-invite",
  // Revokes an outstanding invite. `patients.update` scope.
  requirePermission("patients.update"),
  adminRateLimit({ name: "patient_portal_invite.revoke", preset: "destroy" }),
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, portal_auth_user_id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (!patient.portal_auth_user_id) {
      res
        .status(200)
        .json({ portalStatus: "not_invited", alreadyRevoked: true });
      return;
    }

    await revokeTeamMember(supabase, patient.portal_auth_user_id);

    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .schema("resupply")
      .from("patients")
      .update({
        portal_auth_user_id: null,
        portal_invited_at: null,
        portal_invited_by: null,
        updated_at: nowIso,
      })
      .eq("id", patientId);
    if (stampErr) throw stampErr;

    await logAudit({
      action: "patient.portal.invite_revoked",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: patientId,
      metadata: { revoked_auth_user_id: patient.portal_auth_user_id },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.portal.invite_revoked audit write failed");
    });

    res.json({ portalStatus: "not_invited" });
  },
);

export default router;
