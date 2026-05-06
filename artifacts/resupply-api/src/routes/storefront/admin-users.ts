/**
 * Admin team-management routes (PennPaps).
 *
 * Lets a Penn admin invite, promote, demote, or revoke teammates
 * from inside the cpap-fitter admin console — no engineer / env-
 * var change / restart required for routine staff turnover.
 *
 * The roster lives in `auth.users` directly — there's no Penn-
 * specific admin_users table (that's a Resupply concept).
 * Pending invitations are auth.users rows with status='invited'
 * and email_verified_at IS NULL. Active members are status='active'
 * (or any non-revoked row with a verified email).
 *
 * Lockout guard: an admin cannot demote or revoke themselves.
 *
 * Audit: every state-changing call writes a row via
 * `db.insert(adminAuditLogTable)`. Best-effort: we log on failure
 * but never block the user-visible operation.
 */

import { Router } from "express";
import { z } from "zod";
import {
  inviteTeamMember,
  revokeTeamMember,
  updateTeamMemberRole,
} from "@workspace/resupply-auth";

import { db, adminAuditLogTable, pool } from "../../lib/storefront/db.js";

import { logger } from "../../lib/logger.js";
import { getAuthDeps } from "../../lib/auth-deps.js";
import { requireAdminOnly } from "../../middlewares/requireAdmin.js";

const router = Router();

const inviteBody = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  role: z.enum(["admin", "agent"]),
});

const roleChangeBody = z.object({
  role: z.enum(["admin", "agent"]),
});

/** Best-effort audit write. */
async function writeAudit(
  req: import("express").Request,
  action: string,
): Promise<void> {
  try {
    await db.insert(adminAuditLogTable).values({
      adminEmail: req.adminEmail ?? "system",
      adminUserId: req.adminUserId ?? "system",
      action,
      ip: req.ip ?? null,
    });
  } catch (err) {
    logger.error({ err, action }, "Failed to write admin audit row");
  }
}

interface AuthUserRow {
  id: string;
  email_lower: string;
  display_name: string | null;
  role: string;
  status: string;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "agent";
  isSelf: boolean;
  createdAt: number;
  status: "active" | "pending" | "revoked";
  emailVerifiedAt: number | null;
}

interface PendingInviteRow {
  id: string;
  email: string;
  role: "admin" | "agent";
  createdAt: number;
}

function effectiveStatus(row: AuthUserRow): "active" | "pending" | "revoked" {
  if (row.status === "revoked") return "revoked";
  if (row.email_verified_at) return "active";
  return "pending";
}

router.get("/admin/users", requireAdminOnly, async (req, res) => {
  // List every staff row in auth.users. Penn's staff is small
  // (<200 in the foreseeable future), so we don't paginate.
  const result = await pool.query<AuthUserRow>(
    `SELECT id, email_lower, display_name, role, status,
            email_verified_at, created_at, updated_at
       FROM auth.users
      WHERE role IN ('admin', 'agent')
      ORDER BY created_at DESC`,
  );

  const members: MemberRow[] = [];
  const pendingInvitations: PendingInviteRow[] = [];

  for (const u of result.rows) {
    const role = u.role as "admin" | "agent";
    const status = effectiveStatus(u);
    if (status === "pending") {
      pendingInvitations.push({
        id: u.id,
        email: u.email_lower,
        role,
        createdAt: u.created_at.getTime(),
      });
      continue;
    }
    members.push({
      id: u.id,
      email: u.email_lower,
      name: u.display_name,
      role,
      isSelf: u.id === req.adminUserId,
      createdAt: u.created_at.getTime(),
      status,
      emailVerifiedAt: u.email_verified_at?.getTime() ?? null,
    });
  }

  await writeAudit(req, "team.list");

  res.json({
    role: req.adminRole ?? "admin",
    self: { email: req.adminEmail, userId: req.adminUserId },
    members,
    // Stage 5b retired the env-allowlist UI section. The vars
    // (PENN_ADMIN_EMAILS / PENN_AGENT_EMAILS) no longer drive
    // access; bootstrap is via the auth:bootstrap-admin CLI.
    envAllowlist: [] as Array<{ email: string; role: "admin" | "agent" }>,
    pendingInvitations,
  });
});

function buildInviteRedirectUrl(req: import("express").Request): string {
  const fromEnv = process.env.PENN_ADMIN_PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const replit = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replit) return `https://${replit}`;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}

router.post("/admin/users/invite", requireAdminOnly, async (req, res) => {
  const parsed = inviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Please enter a valid email address and pick a role.",
      details: parsed.error.issues.map((i) => i.message),
    });
    return;
  }
  const { email, role } = parsed.data;

  // Block re-inviting an already-active member.
  const existing = await pool.query<{
    id: string;
    role: string;
    status: string;
    email_verified_at: Date | null;
  }>(
    `SELECT id, role, status, email_verified_at
       FROM auth.users
      WHERE email_lower = $1
      LIMIT 1`,
    [email],
  );
  const prior = existing.rows[0];
  if (
    prior &&
    prior.status === "active" &&
    prior.email_verified_at &&
    (prior.role === "admin" || prior.role === "agent")
  ) {
    res.status(409).json({
      error:
        "That person already has access. Use Change role on their existing entry instead of re-inviting.",
    });
    return;
  }

  const deps = getAuthDeps();
  const invite = await inviteTeamMember(pool, deps, {
    emailLower: email,
    role,
    displayName: null,
    productName: "PennFit",
    publicBaseUrl: buildInviteRedirectUrl(req),
  });

  await writeAudit(req, `team.invite role=${role} email=${email}`);
  res.status(201).json({
    id: invite.authUserId,
    email,
    role,
    createdAt: Date.now(),
    emailSent: invite.emailSent,
    inviteLink: invite.emailSent ? null : invite.inviteLink,
  });
});

router.patch(
  "/admin/users/:userId/role",
  requireAdminOnly,
  async (req, res) => {
    const userId = req.params.userId;
    if (!userId || typeof userId !== "string") {
      res.status(400).json({ error: "Missing user id." });
      return;
    }
    const parsed = roleChangeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Pick a valid role." });
      return;
    }
    const { role } = parsed.data;

    if (userId === req.adminUserId) {
      res.status(400).json({
        error:
          "You can't change your own role. Ask another admin to do it for you.",
      });
      return;
    }

    const lookup = await pool.query<{ email_lower: string }>(
      `SELECT email_lower FROM auth.users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    const targetEmail = lookup.rows[0]?.email_lower ?? "(unknown)";

    const ok = await updateTeamMemberRole(pool, userId, role);
    if (!ok) {
      res.status(404).json({ error: "Could not find that teammate." });
      return;
    }

    await writeAudit(req, `team.role_change to=${role} user=${targetEmail}`);
    res.json({ ok: true, userId, role });
  },
);

router.delete("/admin/users/:userId", requireAdminOnly, async (req, res) => {
  const userId = req.params.userId;
  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "Missing user id." });
    return;
  }
  if (userId === req.adminUserId) {
    res.status(400).json({
      error:
        "You can't remove yourself. Ask another admin to revoke your access if you really mean it.",
    });
    return;
  }

  const lookup = await pool.query<{ email_lower: string }>(
    `SELECT email_lower FROM auth.users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const targetEmail = lookup.rows[0]?.email_lower ?? "(unknown)";

  await revokeTeamMember(pool, userId);

  await writeAudit(req, `team.revoke user=${targetEmail}`);
  res.json({ ok: true, userId });
});

router.delete(
  "/admin/users/invitations/:invId",
  requireAdminOnly,
  async (req, res) => {
    const invId = req.params.invId;
    if (!invId || typeof invId !== "string") {
      res.status(400).json({ error: "Missing invitation id." });
      return;
    }

    // After Stage 5b, "invitations" are auth.users rows with
    // status='invited'. Cancelling an invitation = setting
    // status='revoked' (which prevents the user from
    // accepting + makes the email_token consumption a no-op).
    const lookup = await pool.query<{
      email_lower: string;
      status: string;
    }>(`SELECT email_lower, status FROM auth.users WHERE id = $1 LIMIT 1`, [
      invId,
    ]);
    const row = lookup.rows[0];
    if (!row) {
      res.status(404).json({
        error: "Could not cancel that invitation. It may already be gone.",
      });
      return;
    }
    if (row.status === "active") {
      res.status(409).json({
        error:
          "That account has already accepted the invite. Use Remove instead.",
      });
      return;
    }

    await revokeTeamMember(pool, invId);

    await writeAudit(req, `team.invitation_revoke email=${row.email_lower}`);
    res.json({ ok: true, invitationId: invId });
  },
);

export default router;
