// /admin/team — admin/CSR team management.
//
// Endpoints (all requireAdminOnly — only role='admin' can manage team):
//   GET    /admin/team                  — list members (active + pending +
//                                           recently revoked)
//   POST   /admin/team/invite           — invite a new admin/agent by email
//   POST   /admin/team/:id/resend       — resend the Clerk invitation
//   POST   /admin/team/:id/revoke       — revoke membership; future logins
//                                           are denied immediately
//   PATCH  /admin/team/:id              — update role / display name / notes
//
// Why requireAdminOnly: granting / revoking admin access is an
// auth-changing operation and shouldn't be available to agents
// (CSRs); same posture as DELETE /rules/:id.
//
// Invite flow:
//   1. Admin POSTs /admin/team/invite { email, role, displayName?, notes? }
//   2. We INSERT an admin_users row (status='pending', clerk_user_id=null).
//   3. We ask Clerk to create an Invitation. The Clerk invitation email
//      contains a magic link to our sign-up page; clicking it routes
//      the user through Clerk's sign-up flow with the invited email
//      pre-filled.
//   4. When the user later signs in, requireAdmin matches the email,
//      flips the row to status='active', and stamps clerk_user_id +
//      accepted_at + last_login_at.
//
// If the Clerk SDK isn't configured (missing CLERK_SECRET_KEY in
// preview / dev), we still create the DB row — the user just has to
// sign up manually. The endpoint surfaces a `clerkInviteSent: false`
// flag so the UI can show "We couldn't send the invite email — share
// the sign-up link with this person directly".

import { Router, type IRouter } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { clerkClient } from "@clerk/express";
import { z } from "zod";

import {
  adminUsers,
  type AdminRole,
  type AdminStatus,
  getDbPool,
} from "@workspace/resupply-db";

import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

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

router.get("/admin/team", requireAdminOnly, async (_req, res) => {
  const db = drizzle(getDbPool());
  const rows = await db
    .select()
    .from(adminUsers)
    .orderBy(desc(adminUsers.invitedAt));
  res.json({ members: rows.map(serialize) });
});

router.post("/admin/team/invite", requireAdminOnly, async (req, res) => {
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

  // Reuse the existing row if one is already there for this email.
  // Three legitimate reuse cases:
  //   * pending  → the invite expired or was lost; resend.
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
  if (prior && prior.status === "active") {
    res.status(409).json({
      error: "already_active_member",
      message: `${email} is already an active member. Use PATCH /admin/team/:id to change their role.`,
      memberId: prior.id,
    });
    return;
  }

  // Create the Clerk invitation. Returning a successful response
  // even if Clerk fails (clerkInviteSent: false) — admins can resend
  // later or share the sign-up link manually.
  let clerkInvitationId: string | null = null;
  let clerkInviteSent = false;
  try {
    const inv = await clerkClient.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: deriveRedirectUrl(),
      publicMetadata: { resupplyRole: role, invitedBy: inviterId ?? "" },
    });
    clerkInvitationId = inv.id;
    clerkInviteSent = true;
  } catch (err) {
    req.log?.warn(
      { event: "team_invite_clerk_failed", err: err instanceof Error ? err.message : String(err) },
      "Clerk invitation API failed",
    );
  }

  const now = new Date();
  if (prior) {
    const updated = await db
      .update(adminUsers)
      .set({
        role,
        status: "pending",
        clerkInvitationId,
        displayName: displayName ?? prior.displayName,
        notes: notes ?? prior.notes,
        invitedBy: inviterId,
        invitedAt: now,
        revokedAt: null,
        revokedBy: null,
        acceptedAt: null,
        // clerk_user_id stays as-is — if the user previously accepted
        // and was later revoked, we keep the linkage so re-acceptance
        // doesn't double-create a Clerk user.
        updatedAt: now,
      })
      .where(eq(adminUsers.id, prior.id))
      .returning();
    res
      .status(200)
      .json({ member: serialize(updated[0]!), clerkInviteSent });
    return;
  }

  const inserted = await db
    .insert(adminUsers)
    .values({
      emailLower: email,
      role,
      status: "pending",
      clerkInvitationId,
      displayName: displayName ?? null,
      notes: notes ?? null,
      invitedBy: inviterId,
      invitedAt: now,
      updatedAt: now,
    })
    .returning();
  res.status(201).json({ member: serialize(inserted[0]!), clerkInviteSent });
});

router.post("/admin/team/:id/resend", requireAdminOnly, async (req, res) => {
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

  // Revoke the old Clerk invite if we had one (Clerk doesn't allow
  // two open invites for the same email), then issue a fresh one.
  if (row.clerkInvitationId) {
    try {
      await clerkClient.invitations.revokeInvitation(row.clerkInvitationId);
    } catch (err) {
      req.log?.warn(
        { event: "team_resend_revoke_old_failed", err: err instanceof Error ? err.message : String(err) },
        "Could not revoke prior Clerk invitation; creating new one anyway",
      );
    }
  }

  let clerkInvitationId: string | null = null;
  let clerkInviteSent = false;
  try {
    const inv = await clerkClient.invitations.createInvitation({
      emailAddress: row.emailLower,
      redirectUrl: deriveRedirectUrl(),
      publicMetadata: { resupplyRole: row.role, invitedBy: req.adminUserId ?? "" },
    });
    clerkInvitationId = inv.id;
    clerkInviteSent = true;
  } catch (err) {
    req.log?.warn(
      { event: "team_resend_create_failed", err: err instanceof Error ? err.message : String(err) },
      "Clerk invitation API failed on resend",
    );
  }

  const updated = await db
    .update(adminUsers)
    .set({
      clerkInvitationId,
      invitedAt: new Date(),
      invitedBy: req.adminUserId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(adminUsers.id, id))
    .returning();
  res.json({ member: serialize(updated[0]!), clerkInviteSent });
});

router.post("/admin/team/:id/revoke", requireAdminOnly, async (req, res) => {
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
    res.status(200).json({ member: serialize(row), alreadyRevoked: true });
    return;
  }
  // Defensive: don't let an admin revoke themselves — that locks them
  // out of the very console they're using. They'd recover via the env-
  // var bootstrap, but only if env vars are configured.
  if (row.clerkUserId && row.clerkUserId === req.adminUserId) {
    res.status(409).json({
      error: "cannot_revoke_self",
      message: "You can't revoke your own admin access. Have another admin revoke your seat.",
    });
    return;
  }

  if (row.clerkInvitationId && row.status === "pending") {
    try {
      await clerkClient.invitations.revokeInvitation(row.clerkInvitationId);
    } catch (err) {
      req.log?.warn(
        { event: "team_revoke_clerk_failed", err: err instanceof Error ? err.message : String(err) },
        "Could not revoke Clerk invitation; row will be marked revoked anyway",
      );
    }
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
  res.json({ member: serialize(updated[0] ?? row) });
});

router.patch("/admin/team/:id", requireAdminOnly, async (req, res) => {
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
  // Refuse to demote yourself from admin to agent — same self-lock-out
  // concern as revoke.
  if (parsed.data.role === "agent") {
    const rows = await db
      .select({
        clerkUserId: adminUsers.clerkUserId,
        currentRole: adminUsers.role,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1);
    const row = rows[0];
    if (
      row &&
      row.currentRole === "admin" &&
      row.clerkUserId === req.adminUserId
    ) {
      res.status(409).json({
        error: "cannot_demote_self",
        message: "You can't demote yourself to agent. Have another admin do it.",
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
  res.json({ member: serialize(updated[0]!) });
});

function deriveRedirectUrl(): string {
  const base =
    process.env.RESUPPLY_DASHBOARD_PUBLIC_BASE_URL ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    "https://pennpaps.com";
  return `${base.replace(/\/$/, "")}/admin/sign-up`;
}

function serialize(row: typeof adminUsers.$inferSelect) {
  return {
    id: row.id,
    email: row.emailLower,
    clerkUserId: row.clerkUserId,
    role: row.role as AdminRole,
    status: row.status as AdminStatus,
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

export default router;
