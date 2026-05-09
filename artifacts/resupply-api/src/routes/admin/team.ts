// /admin/team — admin/CSR team management.
//
// Endpoints (all requireAdminOnly — only role='admin' can manage team):
//   GET    /admin/team                  — list members (active + pending +
//                                           recently revoked)
//   POST   /admin/team/invite           — invite a new admin/agent by email
//   POST   /admin/team/:id/resend       — resend the invite email
//   POST   /admin/team/:id/revoke       — revoke membership; future logins
//                                           are denied immediately
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
//      "set your PennPaps password" email via SendGrid.
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
  inviteTeamMember,
  revokeTeamMember,
  updateTeamMemberRole,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../../lib/auth-deps";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

type AdminUserRow = Database["resupply"]["Tables"]["admin_users"]["Row"];

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

const ROLE_VALUES: AdminRole[] = ["admin", "agent"];
const inviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: z.enum(ROLE_VALUES as [AdminRole, ...AdminRole[]]),
    displayName: z.string().trim().min(1).max(120).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

const patchBody = z
  .object({
    role: z.enum(ROLE_VALUES as [AdminRole, ...AdminRole[]]).optional(),
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

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
  // The original Drizzle path LEFT JOINed admin_users → auth.users
  // for each row's `email_verified_at`. PostgREST has no JOIN, so
  // we fetch admin_users first then bulk-fetch the auth rows by
  // auth_user_id.
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select(
      "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
    )
    .order("invited_at", { ascending: false });
  if (error) throw error;

  const verifiedByAuthId = await fetchVerifiedAtMap(
    supabase,
    (rows ?? [])
      .map((r) => r.auth_user_id)
      .filter((v): v is string => v !== null),
  );

  res.json({
    members: (rows ?? []).map((r) =>
      serialize(r, verifiedByAuthId.get(r.auth_user_id ?? "") ?? null),
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
    const { email, role, displayName, notes } = parsed.data;
    const inviterId = req.adminUserId ?? null;
    const supabase = getSupabaseServiceRoleClient();
    const deps = getAuthDeps();

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
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
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

    // Mint or refresh the auth row + send the invite email.
    const invite = await inviteTeamMember(supabase, deps, {
      emailLower: email,
      role,
      displayName: displayName ?? prior?.display_name ?? null,
      productName: "Resupply",
      uiPathPrefix: "/admin",
    });

    const nowIso = new Date().toISOString();
    if (prior) {
      const { data: updated, error: updateErr } = await supabase
        .schema("resupply")
        .from("admin_users")
        .update({
          role,
          status: "pending",
          auth_user_id: invite.authUserId,
          display_name: displayName ?? prior.display_name,
          notes: notes ?? prior.notes,
          invited_by: inviterId,
          invited_at: nowIso,
          revoked_at: null,
          revoked_by: null,
          accepted_at: null,
          updated_at: nowIso,
        })
        .eq("id", prior.id)
        .select(
          "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
        )
        .limit(1)
        .maybeSingle();
      if (updateErr) throw updateErr;
      if (!updated) throw new Error("admin_users update returned no rows");
      res.status(200).json({
        member: await serializeWithAuthLookup(supabase, updated),
        emailSent: invite.emailSent,
        inviteLink: invite.emailSent ? null : invite.inviteLink,
      });
      return;
    }

    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .insert({
        email_lower: email,
        role,
        status: "pending",
        auth_user_id: invite.authUserId,
        display_name: displayName ?? null,
        notes: notes ?? null,
        invited_by: inviterId,
        invited_at: nowIso,
        updated_at: nowIso,
      })
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
      )
      .limit(1)
      .maybeSingle();
    if (insertErr) throw insertErr;
    if (!inserted) throw new Error("admin_users insert returned no rows");
    res.status(201).json({
      member: await serializeWithAuthLookup(supabase, inserted),
      emailSent: invite.emailSent,
      inviteLink: invite.emailSent ? null : invite.inviteLink,
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
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
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
      role: row.role as AdminRole,
      displayName: row.display_name,
      productName: "Resupply",
      uiPathPrefix: "/admin",
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
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
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
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
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
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    res.json({
      member: await serializeWithAuthLookup(supabase, updated ?? row),
    });
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
    // Refuse to demote yourself from admin to agent — same self-
    // lock-out concern as revoke.
    if (parsed.data.role === "agent") {
      const { data: row, error: lookupErr } = await supabase
        .schema("resupply")
        .from("admin_users")
        .select("auth_user_id, role")
        .eq("id", id)
        .limit(1)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (
        row &&
        row.role === "admin" &&
        row.auth_user_id === req.adminUserId
      ) {
        res.status(409).json({
          error: "cannot_demote_self",
          message:
            "You can't demote yourself to agent. Have another admin do it.",
        });
        return;
      }
    }
    const updateValues: Database["resupply"]["Tables"]["admin_users"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (parsed.data.role !== undefined) updateValues.role = parsed.data.role;
    if (parsed.data.displayName !== undefined)
      updateValues.display_name = parsed.data.displayName;
    if (parsed.data.notes !== undefined) updateValues.notes = parsed.data.notes;
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("admin_users")
      .update(updateValues)
      .eq("id", id)
      .select(
        "id, email_lower, auth_user_id, role, status, display_name, notes, invited_by, invited_at, accepted_at, revoked_at, revoked_by, last_login_at",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }
    // Mirror the role change on resupply_auth.users so requireAdmin sees it.
    if (parsed.data.role && updated.auth_user_id) {
      await updateTeamMemberRole(supabase, updated.auth_user_id, parsed.data.role);
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
>;

function serialize(row: AdminListRow, emailVerifiedAt: string | null) {
  const status = effectiveStatus(row.status, emailVerifiedAt);
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
  };
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
  return serialize(row, emailVerifiedAt);
}

export default router;
