// /admin/team — admin/CSR team management.
//
// Endpoints (all requireAdminOnly — only role='admin' can manage team):
//   GET    /admin/team                  — list members (active + pending +
//                                           recently revoked)
//   POST   /admin/team/invite           — invite a new admin/agent by email
//   POST   /admin/team/:id/resend       — resend the invite email
//   POST   /admin/team/:id/revoke       — revoke membership; future logins
//                                           are denied immediately
//   DELETE /admin/team/:id              — delete a pending/revoked invite
//                                           entirely, as if it never
//                                           happened (active members must
//                                           be revoked first)
//   PATCH  /admin/team/:id              — update role / display name / notes
//
// Why requireAdminOnly: granting / revoking admin access is an
// auth-changing operation and shouldn't be available to agents
// (CSRs); same posture as DELETE /rules/:id.
//
// Stage 5b — invitations now go through the in-house auth path:
//   1. Admin POSTs /admin/team/invite { email, role, displayName?, notes? }
//   2. We INSERT/UPDATE an `auth.users` row (role=admin|agent,
//      status='invited') AND an `admin_users` row linked via
//      `auth_user_id`.
//   3. We issue a 7-day `password_reset` email-token and send a
//      welcome email via SendGrid — what the app is, their username
//      (sign-in email) + role, the set-password link, and the
//      role-specific getting-started guides attached as PDFs.
//   4. The user clicks the link, sets a password through the
//      existing /auth/reset-password handler, and signs in.
//
// If SendGrid isn't configured (e.g. preview / dev), the auth
// row + token are still created; the response carries `emailSent:
// false` and an `inviteLink` field so the operator can share the
// link out-of-band.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type AdminRole,
  type AdminStatus,
  type Database,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";

import {
  deleteTeamMember,
  inviteTeamMember,
  revokeTeamMember,
  updateTeamMemberRole,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../../lib/auth-deps";
import { buildInviteHelpAttachments } from "../../lib/help-docs";
import { assertAssignableLocation } from "../../lib/locations/assignable";
import { logger } from "../../lib/logger";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

type AdminUserRow = Database["resupply"]["Tables"]["admin_users"]["Row"];

/**
 * Render the role-specific getting-started help documents to attach to
 * a staff invite email. Best-effort: a render failure logs and returns
 * an empty list so the invite still goes out — an invite must never
 * fail because a help doc didn't render.
 */
async function staffInviteAttachments(role: AdminRole) {
  try {
    return await buildInviteHelpAttachments({ kind: "staff", role });
  } catch (err) {
    logger.warn(
      { err, event: "staff_invite_help_docs_render_failed", role },
      "failed to render staff invite help documents; sending invite without them",
    );
    return [];
  }
}

const router: IRouter = Router();

// B-07: 30 invite/resend sends per hour per admin. Each call mints an
// auth.email_tokens row and triggers an outbound email; 30/hour covers
// legitimate onboarding workflows while capping a compromised-account
// email-spam scenario. Keyed by adminUserId (populated by
// requireAdminOnly, which runs first) so one admin's burst doesn't
// starve other staff.
const adminInviteLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.adminUserId ?? "unknown",
  message: {
    error: "too_many_requests",
    limiter: "admin_team_invite",
    message:
      "You're sending invites too quickly. Please wait a few minutes and try again.",
  },
});

// B-07: 30 role / membership mutations per hour per admin. Covers
// /admin/team/:id/revoke (terminates all sessions for the target) and
// PATCH /admin/team/:id (role / status / displayName edits). Each call
// changes who has access to the admin surface area, so a compromised
// admin must be capped without affecting other staff. Same envelope as
// adminInviteLimiter for ops consistency.
const adminTeamMutationLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.adminUserId ?? "unknown",
  message: {
    error: "too_many_requests",
    limiter: "admin_team_mutation",
    message:
      "You're changing team members too quickly. Please wait a few minutes and try again.",
  },
});

// RBAC Phase A: extended catalog. `admin_users.role` carries the
// granular value (csr, supervisor, fitter, fulfillment,
// compliance_officer, etc.); `auth.users.role` keeps the coarse
// "admin or agent" bucket via `coarseAuthRoleFor()` below.
const ROLE_VALUES: AdminRole[] = [
  "admin",
  "supervisor",
  "csr",
  "fitter",
  "fulfillment",
  "compliance_officer",
  "agent",
  "rt",
];

/** Map a granular admin role to the coarse auth.users.role bucket.
 *  Only `admin` keeps its name; every other role buckets to `agent`.
 *  The granular role drives RBAC; the coarse role only answers
 *  "is this user staff at all + are they the super-admin role." */
function coarseAuthRoleFor(role: AdminRole): "admin" | "agent" {
  return role === "admin" ? "admin" : "agent";
}

/** Human-readable role labels for the welcome email's account-details
 *  block. Same vocabulary the team page renders (admin-team.tsx
 *  ROLE_LABEL), so the email matches what the new member will see in
 *  the console; `rt` (not offered by that UI) labels as its rbac
 *  effective role, clinician. */
const ROLE_EMAIL_LABEL: Record<AdminRole, string> = {
  admin: "Super admin",
  supervisor: "Admin",
  compliance_officer: "Admin",
  csr: "Customer service rep",
  fitter: "Customer service rep",
  fulfillment: "Customer service rep",
  agent: "Customer service rep",
  rt: "Respiratory therapist",
};

const inviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: z.enum(ROLE_VALUES as [AdminRole, ...AdminRole[]]),
    displayName: z.string().trim().min(1).max(120).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
    // Optional initial password. When provided, the user is
    // created as active + email-verified with this password set,
    // and no invite email is sent. Admin is expected to convey
    // the password to the user out-of-band (in person, secure
    // chat, etc.). Min length matches sign-in.ts / change-password.
    initialPassword: z.string().min(12).max(1024).optional().nullable(),
    // Home branch (location). Optional at invite; a uuid must reference
    // an active location, null/absent leaves the member unassigned.
    locationId: z.string().uuid().nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    role: z.enum(ROLE_VALUES as [AdminRole, ...AdminRole[]]).optional(),
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    // Home branch (location); uuid assigns (validated against active
    // locations -> 422 invalid_location), null clears it.
    locationId: z.string().uuid().nullable().optional(),
  })
  .strict();

/**
 * Validate an optional location assignment from a team request body.
 * Returns true to proceed; writes the 422 and returns false when a
 * concrete id doesn't reference an active location. A null/absent id is
 * always allowed (clearing / not setting the assignment).
 */
async function checkLocationOr422(
  supabase: ResupplySupabaseClient,
  locationId: string | null | undefined,
  res: import("express").Response,
): Promise<boolean> {
  if (!locationId) return true;
  const check = await assertAssignableLocation(supabase, locationId);
  if (!check.ok) {
    res.status(422).json({
      error: "invalid_location",
      reason: check.reason,
      message:
        check.reason === "inactive"
          ? "That location has been deactivated."
          : "That location no longer exists.",
    });
    return false;
  }
  return true;
}

// Effective status returned to the team UI is computed from
// admin_users.status PLUS the linked resupply_auth.users row:
//   * admin_users.status='revoked'                  → 'revoked'
//   * resupply_auth.users.email_verified_at is set  → 'active'
//   * else                                          → 'pending'
function effectiveStatus(
  storedStatus: string,
  emailVerifiedAt: string | null,
): AdminStatus {
  if (storedStatus === "revoked") return "revoked";
  if (emailVerifiedAt) return "active";
  return "pending";
}

router.get("/admin/team", requireAdminOnly, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  // The original SQL path LEFT JOINed admin_users → auth.users
  // for each row's `email_verified_at`. PostgREST has no JOIN, so
  // we fetch admin_users first then bulk-fetch the auth rows by
  // auth_user_id.
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select(
      "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
    )
    .order("invited_at", { ascending: false });
  if (error) throw error;

  const authIds = (rows ?? [])
    .map((r) => r.auth_user_id)
    .filter((v): v is string => v !== null);
  const verifiedByAuthId = await fetchVerifiedAtMap(supabase, authIds);
  const credentialByAuthId = await fetchInviteCredentialMap(supabase, authIds);

  res.json({
    members: (rows ?? []).map((r) =>
      serialize(
        r,
        verifiedByAuthId.get(r.auth_user_id ?? "") ?? null,
        credentialByAuthId.get(r.auth_user_id ?? "") ?? null,
      ),
    ),
  });
});

router.post(
  "/admin/team/invite",
  requireAdminOnly,
  adminInviteLimiter,
  async (req, res) => {
    const parsed = inviteBody.safeParse(req.body);
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
    const { email, role, displayName, notes, initialPassword, locationId } =
      parsed.data;
    const useInitialPassword =
      typeof initialPassword === "string" && initialPassword.length >= 12;
    const inviterId = req.adminUserId ?? null;
    const supabase = getSupabaseServiceRoleClient();
    const deps = getAuthDeps();

    if (!(await checkLocationOr422(supabase, locationId, res))) return;

    // Reuse logic — three legitimate cases:
    //   * pending  → invite expired or was lost; resend.
    //   * revoked  → admin is re-inviting someone who was previously
    //                removed. Allowed; flip back to pending and clear
    //                the revoke fields.
    //   * active   → reject; admins should use PATCH to change role.
    const { data: prior, error: priorErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .eq("email_lower", email)
      .limit(1)
      .maybeSingle();
    if (priorErr) throw priorErr;
    if (prior?.auth_user_id) {
      // Block if the user has already accepted (auth row's
      // email_verified_at is non-null) — re-inviting an already-active
      // member is a role change, not an invite.
      const { data: auth, error: authErr } = await supabase
        .schema("resupply_auth")
        .from("users")
        .select("email_verified_at")
        .eq("id", prior.auth_user_id)
        .limit(1)
        .maybeSingle();
      if (authErr) throw authErr;
      if (auth?.email_verified_at) {
        res.status(409).json({
          error: "already_active_member",
          message: `${email} is already an active member. Use PATCH /admin/team/:id to change their role.`,
          memberId: prior.id,
        });
        return;
      }
    }

    // Mint or refresh the auth row + send the invite email. The
    // coarse `auth.users.role` only cares about admin-vs-agent;
    // the granular role lands on admin_users.role below.
    const invite = await inviteTeamMember(supabase, deps, {
      emailLower: email,
      role: coarseAuthRoleFor(role),
      roleLabel: ROLE_EMAIL_LABEL[role],
      displayName: displayName ?? prior?.display_name ?? null,
      productName: "Resupply",
      uiPathPrefix: "/admin",
      initialPassword: useInitialPassword
        ? (initialPassword as string)
        : undefined,
      // Attach the new member's role-specific getting-started guides.
      // Skipped automatically on the initialPassword path (no email).
      attachments: useInitialPassword
        ? undefined
        : await staffInviteAttachments(role),
    });

    const nowIso = new Date().toISOString();
    // When the admin sets an initial password, the user is
    // sign-in-ready immediately, so mirror that on admin_users:
    // status='active' and accepted_at=now (instead of pending).
    const memberStatus = useInitialPassword ? "active" : "pending";
    const memberAcceptedAt = useInitialPassword ? nowIso : null;
    if (prior) {
      const { data: updated, error: updateErr } = await supabase
        .schema("resupply")
        .from("admin_users")
        .update({
          role,
          status: memberStatus,
          auth_user_id: invite.authUserId,
          display_name: displayName ?? prior.display_name,
          notes: notes ?? prior.notes,
          // Re-invite keeps the prior branch unless this invite explicitly sets (or clears) one.
          location_id:
            locationId !== undefined ? locationId : prior.location_id,
          invited_by: inviterId,
          invited_at: nowIso,
          revoked_at: null,
          revoked_by: null,
          accepted_at: memberAcceptedAt,
          updated_at: nowIso,
        })
        .eq("id", prior.id)
        .select(
          "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
        )
        .limit(1)
        .maybeSingle();
      if (updateErr) throw updateErr;
      if (!updated) throw new Error("admin_users update returned no rows");
      res.status(200).json({
        member: await serializeWithAuthLookup(supabase, updated),
        emailSent: invite.emailSent,
        inviteLink: invite.emailSent ? null : invite.inviteLink,
        signInReady: invite.signInReady,
      });
      return;
    }

    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .insert({
        email_lower: email,
        role,
        status: memberStatus,
        auth_user_id: invite.authUserId,
        display_name: displayName ?? null,
        notes: notes ?? null,
        location_id: locationId ?? null,
        invited_by: inviterId,
        invited_at: nowIso,
        accepted_at: memberAcceptedAt,
        updated_at: nowIso,
      })
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .limit(1)
      .maybeSingle();
    if (insertErr) throw insertErr;
    if (!inserted) throw new Error("admin_users insert returned no rows");
    res.status(201).json({
      member: await serializeWithAuthLookup(supabase, inserted),
      emailSent: invite.emailSent,
      inviteLink: invite.emailSent ? null : invite.inviteLink,
      signInReady: invite.signInReady,
    });
  },
);

router.post(
  "/admin/team/:id/resend",
  requireAdminOnly,
  adminInviteLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: `Member is in ${row.status} state; only pending invites can be resent.`,
      });
      return;
    }

    const deps = getAuthDeps();
    const invite = await inviteTeamMember(supabase, deps, {
      emailLower: row.email_lower,
      role: coarseAuthRoleFor(row.role as AdminRole),
      roleLabel: ROLE_EMAIL_LABEL[row.role as AdminRole],
      displayName: row.display_name,
      productName: "Resupply",
      uiPathPrefix: "/admin",
      attachments: await staffInviteAttachments(row.role as AdminRole),
    });

    const nowIso = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({
        auth_user_id: invite.authUserId,
        invited_at: nowIso,
        invited_by: req.adminUserId ?? null,
        updated_at: nowIso,
      })
      .eq("id", id)
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) throw new Error("admin_users update returned no rows");
    res.json({
      member: await serializeWithAuthLookup(supabase, updated),
      emailSent: invite.emailSent,
      inviteLink: invite.emailSent ? null : invite.inviteLink,
    });
  },
);

router.post(
  "/admin/team/:id/revoke",
  requireAdminOnly,
  adminTeamMutationLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }
    if (row.status === "revoked") {
      res.status(200).json({
        member: await serializeWithAuthLookup(supabase, row),
        alreadyRevoked: true,
      });
      return;
    }
    // Defensive: don't let an admin revoke themselves — that locks
    // them out of the very console they're using. They'd recover
    // via the auth:bootstrap-admin CLI.
    if (row.auth_user_id && row.auth_user_id === req.adminUserId) {
      res.status(409).json({
        error: "cannot_revoke_self",
        message:
          "You can't revoke your own admin access. Have another admin revoke your seat.",
      });
      return;
    }
    // Last-admin lockout: refuse to revoke the only remaining
    // active admin. The self-revoke guard above protects admin-A
    // from locking themselves out, but admin-A can revoke admin-B
    // and strand the org. Count active admin rows and block when
    // this revoke would zero them out.
    if (row.role === "admin" && row.status === "active") {
      const { count, error: countErr } = await supabase
        .schema("resupply")
        .from("admin_users")
        .select("id", { count: "exact", head: true })
        .eq("role", "admin")
        .eq("status", "active");
      if (countErr) throw countErr;
      if ((count ?? 0) <= 1) {
        res.status(409).json({
          error: "cannot_revoke_last_admin",
          message:
            "This is the only active admin. Promote another team member to admin before revoking this seat.",
        });
        return;
      }
    }

    if (row.auth_user_id) {
      await revokeTeamMember(supabase, row.auth_user_id);
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update({
        status: "revoked",
        revoked_at: nowIso,
        revoked_by: req.adminUserId ?? null,
        updated_at: nowIso,
      })
      .eq("id", id)
      .neq("status", "revoked")
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    res.json({
      member: await serializeWithAuthLookup(supabase, updated ?? row),
    });
  },
);

router.delete(
  "/admin/team/:id",
  requireAdminOnly,
  adminTeamMutationLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }
    // Defensive: an active self can't be deleted anyway (gate below),
    // but keep the explicit guard so a revoked-self edge state can't
    // erase the very account servicing this request.
    if (row.auth_user_id && row.auth_user_id === req.adminUserId) {
      res.status(409).json({
        error: "cannot_delete_self",
        message: "You can't delete your own seat.",
      });
      return;
    }
    // Only pending / revoked rows are deletable. An active member
    // holds live access (sessions, credentials) — force the revoke
    // path first, which carries the self-revoke and last-admin
    // guards and terminates sessions.
    let emailVerifiedAt: string | null = null;
    if (row.auth_user_id) {
      const { data: auth, error: authErr } = await supabase
        .schema("resupply_auth")
        .from("users")
        .select("email_verified_at")
        .eq("id", row.auth_user_id)
        .limit(1)
        .maybeSingle();
      if (authErr) throw authErr;
      emailVerifiedAt = auth?.email_verified_at ?? null;
    }
    if (effectiveStatus(row.status, emailVerifiedAt) === "active") {
      res.status(409).json({
        error: "member_active",
        message:
          "This member is active. Revoke their access first, then delete.",
      });
      return;
    }

    // Auth-side cleanup first: a crash between the two deletes then
    // leaves a visible (re-deletable) roster row rather than an
    // invisible orphaned identity. When the identity row is shared
    // with any non-staff login, it is demoted back to 'customer'
    // instead of deleted so the invite doesn't take the person's
    // other account with it.
    let authUserDeleted = false;
    let authUserDemotedToCustomer = false;
    if (row.auth_user_id) {
      const preserve = await authUserHasNonStaffOwner(
        supabase,
        row.auth_user_id,
      );
      const cleanup = await deleteTeamMember(supabase, row.auth_user_id, {
        preserveAsCustomer: preserve,
      });
      authUserDeleted = cleanup.authUserDeleted;
      authUserDemotedToCustomer = cleanup.authUserDemotedToCustomer;
    }

    const { error: deleteErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .delete()
      .eq("id", id);
    if (deleteErr) throw deleteErr;

    logger.info(
      {
        event: "admin_team_member_deleted",
        memberId: id,
        deletedBy: req.adminUserId ?? null,
        priorStatus: row.status,
        authUserDeleted,
        authUserDemotedToCustomer,
      },
      "admin team invite deleted",
    );
    res.json({ deleted: true, id, authUserDeleted, authUserDemotedToCustomer });
  },
);

router.patch(
  "/admin/team/:id",
  requireAdminOnly,
  adminTeamMutationLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // Refuse to demote yourself out of the admin role — same
    // self-lock-out concern as revoke. With Phase A's wider role
    // catalog, ANY change away from admin is a self-demote, not
    // just admin→agent.
    if (parsed.data.role && parsed.data.role !== "admin") {
      const { data: row, error: lookupErr } = await supabase
        .schema("resupply")
        .from("admin_users")
        .select("auth_user_id, role")
        .eq("id", id)
        .limit(1)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (row && row.role === "admin" && row.auth_user_id === req.adminUserId) {
        res.status(409).json({
          error: "cannot_demote_self",
          message:
            "You can't demote yourself out of the admin role. Have another admin do it.",
        });
        return;
      }
      // Last-admin lockout: refuse to demote the only remaining
      // active admin. The self-demote guard above protects against
      // admin-A demoting themselves, but admin-A can still demote
      // admin-B and then strand the org with zero admins (the only
      // recovery path is the bootstrap CLI). Count active admin rows
      // and block the demote when this is the last one.
      if (row && row.role === "admin") {
        const { count, error: countErr } = await supabase
          .schema("resupply")
          .from("admin_users")
          .select("id", { count: "exact", head: true })
          .eq("role", "admin")
          .eq("status", "active");
        if (countErr) throw countErr;
        if ((count ?? 0) <= 1) {
          res.status(409).json({
            error: "cannot_demote_last_admin",
            message:
              "This is the only active admin. Promote another team member to admin before demoting this one.",
          });
          return;
        }
      }
    }
    if (!(await checkLocationOr422(supabase, parsed.data.locationId, res)))
      return;
    const updateValues: Database["resupply"]["Tables"]["admin_users"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (parsed.data.role !== undefined) updateValues.role = parsed.data.role;
    if (parsed.data.displayName !== undefined)
      updateValues.display_name = parsed.data.displayName;
    if (parsed.data.notes !== undefined) updateValues.notes = parsed.data.notes;
    if ("locationId" in parsed.data)
      updateValues.location_id = parsed.data.locationId ?? null;
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update(updateValues)
      .eq("id", id)
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at, location_id",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }
    // Mirror the role change on resupply_auth.users so requireAdmin
    // sees the coarse bucket. Granular role already landed on
    // admin_users.role above.
    if (parsed.data.role && updated.auth_user_id) {
      await updateTeamMemberRole(
        supabase,
        updated.auth_user_id,
        coarseAuthRoleFor(parsed.data.role),
      );
    }
    res.json({ member: await serializeWithAuthLookup(supabase, updated) });
  },
);

type AdminListRow = Pick<
  AdminUserRow,
  | "id"
  | "email_lower"
  | "auth_user_id"
  | "role"
  | "status"
  | "display_name"
  | "notes"
  | "invited_by"
  | "invited_at"
  | "accepted_at"
  | "revoked_at"
  | "revoked_by"
  | "last_login_at"
  | "location_id"
>;

interface InviteCredentialStamps {
  setByAdminAt: string | null;
  expiryReminderSentAt: string | null;
  expiredNoticeSentAt: string | null;
}

function serialize(
  row: AdminListRow,
  emailVerifiedAt: string | null,
  credential: InviteCredentialStamps | null,
) {
  const status = effectiveStatus(row.status, emailVerifiedAt);
  // Surface invite-expiry notifier stamps only while the row is
  // still a pending admin-typed invite. Same predicate the worker
  // uses (must_change + set_by_admin_at IS NOT NULL is implied by
  // `setByAdminAt` being present in the map). Stamps that predate
  // the current `set_by_admin_at` are stale leftovers from a prior
  // invite and are treated as null so the UI doesn't claim a fresh
  // re-invite was already notified.
  const fresh =
    status === "pending" && credential && credential.setByAdminAt
      ? credential
      : null;
  const setByAdminMs = fresh?.setByAdminAt
    ? new Date(fresh.setByAdminAt).getTime()
    : null;
  const freshStamp = (stamp: string | null): string | null => {
    if (!stamp || setByAdminMs === null) return null;
    return new Date(stamp).getTime() >= setByAdminMs ? stamp : null;
  };
  return {
    id: row.id,
    email: row.email_lower,
    authUserId: row.auth_user_id,
    role: row.role as AdminRole,
    status,
    displayName: row.display_name,
    notes: row.notes,
    invitedBy: row.invited_by,
    // PostgREST returns timestamptz as ISO string already.
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    lastLoginAt: row.last_login_at,
    locationId: row.location_id,
    expiryReminderSentAt: freshStamp(fresh?.expiryReminderSentAt ?? null),
    expiredNoticeSentAt: freshStamp(fresh?.expiredNoticeSentAt ?? null),
  };
}

/**
 * True when an auth identity row is shared with a non-staff login.
 * Invites reuse any existing resupply_auth.users row by email_lower,
 * so the row backing a staff invite may also back:
 *   * a shop-customer account (shop_customers.auth_user_id),
 *   * a patient-portal login (patients.portal_auth_user_id), or
 *   * a provider-portal account (provider_portal_accounts.auth_user_id).
 * The latter two are soft references (no FK), so a hard delete would
 * silently break that person's portal sign-in. DELETE /admin/team/:id
 * demotes the identity back to role='customer' (the role all three
 * owners use) instead of deleting it whenever any of these exist.
 */
async function authUserHasNonStaffOwner(
  supabase: ResupplySupabaseClient,
  authUserId: string,
): Promise<boolean> {
  const [customer, patient, provider] = await Promise.all([
    supabase
      .schema("resupply")
      .from("shop_customers")
      .select("id")
      .eq("auth_user_id", authUserId)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("portal_auth_user_id", authUserId)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .select("id")
      .eq("auth_user_id", authUserId)
      .limit(1)
      .maybeSingle(),
  ]);
  if (customer.error) throw customer.error;
  if (patient.error) throw patient.error;
  if (provider.error) throw provider.error;
  return Boolean(customer.data || patient.data || provider.data);
}

/**
 * Bulk lookup of `email_verified_at` for a set of auth user ids.
 * Returns a Map keyed on auth user id; missing ids resolve to null.
 */
async function fetchVerifiedAtMap(
  supabase: ResupplySupabaseClient,
  ids: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (ids.length === 0) return result;
  const { data, error } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, email_verified_at")
    .in("id", ids);
  if (error) throw error;
  for (const r of data ?? []) {
    result.set(r.id, r.email_verified_at);
  }
  return result;
}

/**
 * Variant for handlers that just received an UPDATE / INSERT
 * RETURNING result — those rows don't carry the joined
 * resupply_auth.users.email_verified_at field, so we look it up
 * here. One extra query per response is fine — these are admin
 * actions, not hot-path reads.
 */
async function serializeWithAuthLookup(
  supabase: ResupplySupabaseClient,
  row: AdminListRow,
): Promise<ReturnType<typeof serialize>> {
  let emailVerifiedAt: string | null = null;
  if (row.auth_user_id) {
    const { data: auth, error } = await supabase
      .schema("resupply_auth")
      .from("users")
      .select("email_verified_at")
      .eq("id", row.auth_user_id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    emailVerifiedAt = auth?.email_verified_at ?? null;
  }
  const credentialMap = row.auth_user_id
    ? await fetchInviteCredentialMap(supabase, [row.auth_user_id])
    : null;
  const credential = row.auth_user_id
    ? (credentialMap?.get(row.auth_user_id) ?? null)
    : null;
  return serialize(row, emailVerifiedAt, credential);
}

/**
 * Bulk lookup of invite-expiry notifier stamps for a set of auth
 * user ids. Reads `set_by_admin_at` alongside the two stamp columns
 * so callers can drop stale stamps that predate the current invite
 * (see the worker's `invite-password-expiry-notify` for the same
 * predicate). Missing ids (no password_credentials row yet, or the
 * user has rotated their password and we cleared `set_by_admin_at`)
 * resolve to absent — the UI will show no notifier badges for them.
 */
async function fetchInviteCredentialMap(
  supabase: ResupplySupabaseClient,
  ids: string[],
): Promise<Map<string, InviteCredentialStamps>> {
  const result = new Map<string, InviteCredentialStamps>();
  if (ids.length === 0) return result;
  const { data, error } = await supabase
    .schema("resupply_auth")
    .from("password_credentials")
    .select(
      "user_id, set_by_admin_at, expiry_reminder_sent_at, expired_notice_sent_at",
    )
    .in("user_id", ids);
  if (error) throw error;
  for (const r of data ?? []) {
    result.set(r.user_id, {
      setByAdminAt: r.set_by_admin_at,
      expiryReminderSentAt: r.expiry_reminder_sent_at,
      expiredNoticeSentAt: r.expired_notice_sent_at,
    });
  }
  return result;
}

export default router;
