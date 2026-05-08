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
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  authUsers,
  getDbPool,
  getSupabaseServiceRoleClient,
  patients,
} from "@workspace/resupply-db";
import {
  issueToken,
  renderPatientPortalInviteEmail,
  revokeTeamMember,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

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
      .regex(/^\+1\d{10}$/, "Must be E.164 format starting with +1, e.g. +12155551234")
      .optional()
      .nullable(),
    address: addressSchema.optional().nullable(),
    insurancePayer: z.string().trim().min(1).max(200).optional().nullable(),
    channelPreference: z
      .enum(["sms", "email", "voice"])
      .optional()
      .nullable(),
  })
  .strict();

router.post(
  "/admin/patients/:id/portal-invite",
  requireAdmin,
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

    const db = drizzle(getDbPool());
    const patientRows = await db
      .select({
        id: patients.id,
        email: patients.email,
        legalFirstName: patients.legalFirstName,
        portalAuthUserId: patients.portalAuthUserId,
      })
      .from(patients)
      .where(eq(patients.id, patientId))
      .limit(1);

    const patient = patientRows[0];
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
    if (patient.portalAuthUserId) {
      const authRow = await db
        .select({ verified: authUsers.emailVerifiedAt })
        .from(authUsers)
        .where(eq(authUsers.id, patient.portalAuthUserId))
        .limit(1);
      if (authRow[0]?.verified) {
        res.status(409).json({
          error: "already_active",
          message:
            "This patient already has an active portal account. Revoke first if you need to re-invite.",
        });
        return;
      }
    }

    // Apply any onboarding field updates the CSR provided.
    const fieldUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (bodyParsed.data.email) fieldUpdates.email = bodyParsed.data.email;
    if ("phoneE164" in bodyParsed.data)
      fieldUpdates.phoneE164 = bodyParsed.data.phoneE164;
    if ("address" in bodyParsed.data)
      fieldUpdates.address = bodyParsed.data.address;
    if ("insurancePayer" in bodyParsed.data)
      fieldUpdates.insurancePayer = bodyParsed.data.insurancePayer;
    if ("channelPreference" in bodyParsed.data)
      fieldUpdates.channelPreference = bodyParsed.data.channelPreference;

    // Upsert resupply_auth.users (role=customer). Conflict on email_lower →
    // keep existing row (patient may have previously signed up in the
    // shop). We never downgrade an admin/agent row to customer.
    const pool = getDbPool();
    const upserted = await pool.query<{ id: string }>(
      `INSERT INTO resupply_auth.users (email_lower, role, status)
       VALUES ($1, 'customer', 'invited')
       ON CONFLICT (email_lower) DO UPDATE
         SET status = CASE WHEN resupply_auth.users.status = 'revoked' THEN 'invited'
                           ELSE resupply_auth.users.status END,
             updated_at = NOW()
       RETURNING id`,
      [emailLower],
    );
    const authUserId = upserted.rows[0]!.id;

    // Guard against a CSR inadvertently (or maliciously) supplying an
    // email that already belongs to a DIFFERENT patient's portal
    // account. Without the guard, that other patient's auth identity
    // would be stitched to this patient's record — an IDOR vector.
    //
    // The check + the patient UPDATE that actually links
    // portal_auth_user_id MUST be atomic. There is no unique
    // constraint on patients.portal_auth_user_id today (only a
    // non-unique partial index in migration 0050) so the database
    // alone can't catch a duplicate. Take a transaction-scoped
    // advisory lock keyed on the auth user id and do the check +
    // link UPDATE inside the same transaction. Concurrent invites
    // for the same target email serialize on the lock; invites for
    // other emails are unaffected.
    //
    // We deliberately do this BEFORE the token insert / email send so
    // a 409 short-circuits the rest of the flow without spending an
    // outbound email or leaving an orphan password-reset token in
    // resupply_auth.email_tokens. If the link succeeds but the email later
    // fails, emailSent=false is returned and the inviteLink is
    // surfaced for out-of-band delivery (existing contract).
    const now = new Date();
    const linked = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-invite:${authUserId}`}, 0))`,
      );
      const claimedByOther = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(
          and(
            eq(patients.portalAuthUserId, authUserId),
            ne(patients.id, patientId),
          ),
        )
        .limit(1);
      if (claimedByOther[0]) return false;
      await tx
        .update(patients)
        .set({
          ...fieldUpdates,
          portalAuthUserId: authUserId,
          portalInvitedAt: now,
          portalInvitedBy: req.adminUserId ?? null,
        })
        .where(eq(patients.id, patientId));
      return true;
    });
    if (!linked) {
      res.status(409).json({
        error: "email_already_linked",
        message:
          "This email address is already linked to a different patient's portal account. Use a different email or contact support.",
      });
      return;
    }

    // Issue a 7-day password_reset token.
    const token = issueToken();
    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);
    await pool.query(
      `INSERT INTO resupply_auth.email_tokens (token_hash, user_id, purpose, expires_at)
       VALUES ($1, $2, 'password_reset', $3)`,
      [token.hash, authUserId, expiresAt],
    );

    const deps = getAuthDeps();
    const baseUrl = deps.publicBaseUrl.replace(/\/$/, "");
    const inviteLink = `${baseUrl}/reset-password?token=${encodeURIComponent(token.raw)}`;

    const rendered = renderPatientPortalInviteEmail(
      { productName: "PennPaps", publicBaseUrl: baseUrl },
      token.raw,
      patient.legalFirstName,
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
        expires_at: expiresAt.toISOString(),
        fields_updated: Object.keys(fieldUpdates).filter(
          (k) => k !== "updatedAt",
        ),
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
  requireAdmin,
  adminInviteLimiter,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const db = drizzle(getDbPool());
    const patientRows = await db
      .select({
        id: patients.id,
        email: patients.email,
        legalFirstName: patients.legalFirstName,
        portalAuthUserId: patients.portalAuthUserId,
      })
      .from(patients)
      .where(eq(patients.id, patientId))
      .limit(1);

    const patient = patientRows[0];
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (!patient.portalAuthUserId) {
      res.status(409).json({
        error: "not_invited",
        message: "No portal invite exists for this patient. Send one first.",
      });
      return;
    }

    const authRow = await db
      .select({
        id: authUsers.id,
        emailLower: authUsers.emailLower,
        verified: authUsers.emailVerifiedAt,
      })
      .from(authUsers)
      .where(eq(authUsers.id, patient.portalAuthUserId))
      .limit(1);
    const auth = authRow[0];
    if (!auth) {
      res.status(500).json({ error: "auth_row_missing" });
      return;
    }
    if (auth.verified) {
      res.status(409).json({
        error: "already_active",
        message:
          "This patient already has an active portal account. Resend is only for pending invites.",
      });
      return;
    }

    const pool = getDbPool();
    const token = issueToken();
    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);
    await pool.query(
      `INSERT INTO resupply_auth.email_tokens (token_hash, user_id, purpose, expires_at)
       VALUES ($1, $2, 'password_reset', $3)`,
      [token.hash, auth.id, expiresAt],
    );

    const deps = getAuthDeps();
    const baseUrl = deps.publicBaseUrl.replace(/\/$/, "");
    const inviteLink = `${baseUrl}/reset-password?token=${encodeURIComponent(token.raw)}`;

    const rendered = renderPatientPortalInviteEmail(
      { productName: "PennPaps", publicBaseUrl: baseUrl },
      token.raw,
      patient.legalFirstName,
    );

    let emailSent = false;
    try {
      await deps.email({
        to: auth.emailLower,
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

    const now = new Date();
    await db
      .update(patients)
      .set({
        portalInvitedAt: now,
        portalInvitedBy: req.adminUserId ?? null,
        updatedAt: now,
      })
      .where(eq(patients.id, patientId));

    await logAudit({
      action: "patient.portal.invite_resent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: patientId,
      metadata: {
        auth_user_id: auth.id,
        email_sent: emailSent,
        expires_at: expiresAt.toISOString(),
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
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const db = drizzle(getDbPool());
    const patientRows = await db
      .select({
        id: patients.id,
        portalAuthUserId: patients.portalAuthUserId,
      })
      .from(patients)
      .where(eq(patients.id, patientId))
      .limit(1);

    const patient = patientRows[0];
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (!patient.portalAuthUserId) {
      res.status(200).json({ portalStatus: "not_invited", alreadyRevoked: true });
      return;
    }

    await revokeTeamMember(getSupabaseServiceRoleClient(), patient.portalAuthUserId);

    const now = new Date();
    await db
      .update(patients)
      .set({
        portalAuthUserId: null,
        portalInvitedAt: null,
        portalInvitedBy: null,
        updatedAt: now,
      })
      .where(eq(patients.id, patientId));

    await logAudit({
      action: "patient.portal.invite_revoked",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: patientId,
      metadata: { revoked_auth_user_id: patient.portalAuthUserId },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.portal.invite_revoked audit write failed");
    });

    res.json({ portalStatus: "not_invited" });
  },
);

export default router;
