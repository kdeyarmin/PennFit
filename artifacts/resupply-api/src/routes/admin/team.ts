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
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { and, desc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  adminUsers,
  type AdminRole,
  type AdminStatus,
  authUsers,
  getDbPool,
} from "@workspace/resupply-db";

import {
  inviteTeamMember,
  revokeTeamMember,
  updateTeamMemberRole,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../../lib/auth-deps";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Per-admin (fall back to per-IP) rate limiter for the team-management
// surface. requireAdminOnly already gates these on a valid admin
// session — these limits are defence-in-depth so a compromised admin
// cookie cannot script bulk invites/revokes/role-changes.
const teamWriteLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.adminUserId ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
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
// admin_users.status PLUS the linked auth.users row:
//   * admin_users.status='revoked'           → 'revoked'
//   * auth.users.email_verified_at IS NOT NULL → 'active'
//   * else                                    → 'pending'
function effectiveStatus(
  storedStatus: string,
  emailVerifiedAt: Date | null,
): AdminStatus {
  if (storedStatus === "revoked") return "revoked";
  if (emailVerifiedAt) return "active";
  return "pending";
}

router.get("/admin/team", requireAdminOnly, async (_req, res) => {
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      // admin_users fields
      id: adminUsers.id,
      emailLower: adminUsers.emailLower,
      authUserId: adminUsers.authUserId,
      role: adminUsers.role,
      storedStatus: adminUsers.status,
      displayName: adminUsers.displayName,
      notes: adminUsers.notes,
      invitedBy: adminUsers.invitedBy,
      invitedAt: adminUsers.invitedAt,
      acceptedAt: adminUsers.acceptedAt,
      revokedAt: adminUsers.revokedAt,
      revokedBy: adminUsers.revokedBy,
      lastLoginAt: adminUsers.lastLoginAt,
      // joined auth.users field used to compute "active" status
      authEmailVerifiedAt: authUsers.emailVerifiedAt,
    })
    .from(adminUsers)
    .leftJoin(authUsers, eq(adminUsers.authUserId, authUsers.id))
    .orderBy(desc(adminUsers.invitedAt));
  res.json({ members: rows.map(serialize) });
});

router.post("/admin/team/invite", requireAdminOnly, teamWriteLimiter, async (req, res) => {
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
  const db = drizzle(getDbPool());
  const deps = getAuthDeps();

  // Reuse logic — three legitimate cases:
  //   * pending  → invite expired or was lost; resend.
  //   * revoked  → admin is re-inviting someone who was previously
  //                removed. Allowed; flip back to pending and clear
  //                the revoke fields.
  //   * active   → reject; admins should use PATCH to change role.
  const existing = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.emailLower, email))
    .limit(1);
  const prior = existing[0];
  if (prior) {
    // Block if the user has already accepted (auth.users row's
    // email_verified_at is non-null) — re-inviting an already-
    // active member is a role change, not an invite.
    if (prior.authUserId) {
      const auth = await db
        .select({ verified: authUsers.emailVerifiedAt })
        .from(authUsers)
        .where(eq(authUsers.id, prior.authUserId))
        .limit(1);
      if (auth[0]?.verified) {
        res.status(409).json({
          error: "already_active_member",
          message: `${email} is already an active member. Use PATCH /admin/team/:id to change their role.`,
          memberId: prior.id,
        });
        return;
      }
    }
  }

  // Mint or refresh the auth row + send the invite email.
  const invite = await inviteTeamMember(getDbPool(), deps, {
    emailLower: email,
    role,
    displayName: displayName ?? prior?.displayName ?? null,
    productName: "Resupply",
    uiPathPrefix: "/admin",
  });

  const now = new Date();
  if (prior) {
    const updated = await db
      .update(adminUsers)
      .set({
        role,
        status: "pending",
        authUserId: invite.authUserId,
        displayName: displayName ?? prior.displayName,
        notes: notes ?? prior.notes,
        invitedBy: inviterId,
        invitedAt: now,
        revokedAt: null,
        revokedBy: null,
        acceptedAt: null,
        updatedAt: now,
      })
      .where(eq(adminUsers.id, prior.id))
      .returning();
    res.status(200).json({
      member: await serializeWithAuthLookup(db, updated[0]!),
      emailSent: invite.emailSent,
      inviteLink: invite.emailSent ? null : invite.inviteLink,
    });
    return;
  }

  const inserted = await db
    .insert(adminUsers)
    .values({
      emailLower: email,
      role,
      status: "pending",
      authUserId: invite.authUserId,
      displayName: displayName ?? null,
      notes: notes ?? null,
      invitedBy: inviterId,
      invitedAt: now,
      updatedAt: now,
    })
    .returning();
  res.status(201).json({
    member: await serializeWithAuthLookup(db, inserted[0]!),
    emailSent: invite.emailSent,
    inviteLink: invite.emailSent ? null : invite.inviteLink,
  });
});

router.post("/admin/team/:id/resend", requireAdminOnly, teamWriteLimiter, async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const db = drizzle(getDbPool());
  const rows = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, id))
    .limit(1);
  const row = rows[0];
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
  const invite = await inviteTeamMember(getDbPool(), deps, {
    emailLower: row.emailLower,
    role: row.role as AdminRole,
    displayName: row.displayName,
    productName: "Resupply",
    uiPathPrefix: "/admin",
  });

  const updated = await db
    .update(adminUsers)
    .set({
      authUserId: invite.authUserId,
      invitedAt: new Date(),
      invitedBy: req.adminUserId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(adminUsers.id, id))
    .returning();
  res.json({
    member: await serializeWithAuthLookup(db, updated[0]!),
    emailSent: invite.emailSent,
    inviteLink: invite.emailSent ? null : invite.inviteLink,
  });
});

router.post("/admin/team/:id/revoke", requireAdminOnly, teamWriteLimiter, async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const db = drizzle(getDbPool());
  const rows = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "member_not_found" });
    return;
  }
  if (row.status === "revoked") {
    res.status(200).json({
      member: await serializeWithAuthLookup(db, row),
      alreadyRevoked: true,
    });
    return;
  }
  // Defensive: don't let an admin revoke themselves — that locks
  // them out of the very console they're using. They'd recover
  // via the auth:bootstrap-admin CLI.
  if (row.authUserId && row.authUserId === req.adminUserId) {
    res.status(409).json({
      error: "cannot_revoke_self",
      message:
        "You can't revoke your own admin access. Have another admin revoke your seat.",
    });
    return;
  }

  if (row.authUserId) {
    await revokeTeamMember(getDbPool(), row.authUserId);
  }

  const now = new Date();
  const updated = await db
    .update(adminUsers)
    .set({
      status: "revoked",
      revokedAt: now,
      revokedBy: req.adminUserId ?? null,
      updatedAt: now,
    })
    .where(and(eq(adminUsers.id, id), ne(adminUsers.status, "revoked")))
    .returning();
  res.json({
    member: await serializeWithAuthLookup(db, updated[0] ?? row),
  });
});

router.patch("/admin/team/:id", requireAdminOnly, teamWriteLimiter, async (req, res) => {
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
  const db = drizzle(getDbPool());
  // Refuse to demote yourself from admin to agent — same self-
  // lock-out concern as revoke.
  if (parsed.data.role === "agent") {
    const rows = await db
      .select({
        authUserId: adminUsers.authUserId,
        currentRole: adminUsers.role,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1);
    const row = rows[0];
    if (
      row &&
      row.currentRole === "admin" &&
      row.authUserId === req.adminUserId
    ) {
      res.status(409).json({
        error: "cannot_demote_self",
        message:
          "You can't demote yourself to agent. Have another admin do it.",
      });
      return;
    }
  }
  const updated = await db
    .update(adminUsers)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(adminUsers.id, id))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "member_not_found" });
    return;
  }
  // Mirror the role change on auth.users so requireAdmin sees it.
  if (parsed.data.role && updated[0]!.authUserId) {
    await updateTeamMemberRole(
      getDbPool(),
      updated[0]!.authUserId,
      parsed.data.role,
    );
  }
  res.json({ member: await serializeWithAuthLookup(db, updated[0]!) });
});

type Db = ReturnType<typeof drizzle>;

interface SerializableRow {
  id: string;
  emailLower: string;
  authUserId: string | null;
  role: string;
  storedStatus?: string;
  status?: string;
  displayName: string | null;
  notes: string | null;
  invitedBy: string | null;
  invitedAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  lastLoginAt: Date | null;
  authEmailVerifiedAt?: Date | null;
}

function serialize(row: SerializableRow) {
  const stored = row.storedStatus ?? row.status ?? "pending";
  const status = effectiveStatus(stored, row.authEmailVerifiedAt ?? null);
  return {
    id: row.id,
    email: row.emailLower,
    authUserId: row.authUserId,
    role: row.role as AdminRole,
    status,
    displayName: row.displayName,
    notes: row.notes,
    invitedBy: row.invitedBy,
    invitedAt: row.invitedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

/**
 * Variant for handlers that just received an UPDATE / INSERT
 * RETURNING result — those rows don't carry the joined
 * auth.users.email_verified_at field, so we look it up here.
 * One extra query per response is fine — these are admin actions,
 * not hot-path reads.
 */
async function serializeWithAuthLookup(
  db: Db,
  row: typeof adminUsers.$inferSelect,
): Promise<ReturnType<typeof serialize>> {
  let emailVerifiedAt: Date | null = null;
  if (row.authUserId) {
    const auth = await db
      .select({ verified: authUsers.emailVerifiedAt })
      .from(authUsers)
      .where(eq(authUsers.id, row.authUserId))
      .limit(1);
    emailVerifiedAt = auth[0]?.verified ?? null;
  }
  return serialize({ ...row, authEmailVerifiedAt: emailVerifiedAt });
}

export default router;
