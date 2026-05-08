/**
 * Admin team-management routes (PennPaps).
 *
 * Lets a Penn admin invite, promote, demote, or revoke teammates
 * from inside the cpap-fitter admin console — no engineer / env-
 * var change / restart required for routine staff turnover.
 *
 * The roster lives in `resupply_auth.users` directly — there's no Penn-
 * specific admin_users table (that's a Resupply concept).
 * Pending invitations are resupply_auth.users rows with status='invited'
 * and email_verified_at IS NULL. Active members are status='active'
 * (or any non-revoked row with a verified email).
 *
 * Lockout guard: an admin cannot demote or revoke themselves.
 *
 * Audit: every state-changing call writes a row via the Supabase
 * client (best-effort: we log on failure but never block the
 * user-visible operation).
 *
 * Fully on the Supabase JS client — both the route-level reads and
 * the inviteTeamMember / revokeTeamMember / updateTeamMemberRole
 * helpers from @workspace/resupply-auth (ported in the same series
 * of commits).
 */

import { Router, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import {
  inviteTeamMember,
  revokeTeamMember,
  updateTeamMemberRole,
} from "@workspace/resupply-auth";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { getAuthDeps } from "../../lib/auth-deps.js";
import { requireAdminOnly } from "../../middlewares/requireAdmin.js";

const router = Router();

const adminUsersReadLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.adminUserId ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});
const adminUsersWriteLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.adminUserId ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

const inviteBody = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  role: z.enum(["admin", "agent"]),
});

const roleChangeBody = z.object({
  role: z.enum(["admin", "agent"]),
});

// Best-effort admin audit write. Writes to `resupply.audit_log` via
// the Supabase client. Failures are intentionally swallowed: the
// caller has already committed the user-visible side effect by the
// time we're called, and a propagated error would 500 a successful
// invite/role-change. We DO emit a structured ERROR with a stable
// `event` tag so a logging consumer can alert on systemic admin-audit
// outages (`event=admin_audit_write_failed`, count > N over M minutes).
async function writeAudit(
  req: import("express").Request,
  action: string,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("audit_log")
      .insert({
        operator_email: req.adminEmail ?? "system",
        action,
        ip: req.ip ?? null,
      });
    if (error) throw error;
  } catch (err) {
    const pgCode =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof err.code === "string"
        ? err.code
        : null;

    logger.error(
      {
        event: "admin_audit_write_failed",
        action,
        adminUserId: req.adminUserId ?? null,
        errName: err instanceof Error ? err.name : typeof err,
        pgCode,
        ...(err instanceof Error ? { err } : {}),
      },
      "Failed to write admin audit row",
    );
  }
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

function effectiveStatus(row: {
  status: string;
  email_verified_at: string | null;
}): "active" | "pending" | "revoked" {
  if (row.status === "revoked") return "revoked";
  if (row.email_verified_at) return "active";
  return "pending";
}

router.get("/admin/users", requireAdminOnly, adminUsersReadLimiter, async (req, res) => {
  // List every staff row in resupply_auth.users. Penn's staff is small
  // (<200 in the foreseeable future), so we don't paginate.
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select(
      "id, email_lower, display_name, role, status, email_verified_at, created_at, updated_at",
    )
    .in("role", ["admin", "agent"])
    .order("created_at", { ascending: false });

  if (error) {
    logger.error(
      { event: "admin_users_list_failed", err: error },
      "Failed to list admin users",
    );
    res.status(500).json({ error: "Could not load the team list." });
    return;
  }

  const members: MemberRow[] = [];
  const pendingInvitations: PendingInviteRow[] = [];

  for (const u of data ?? []) {
    const role = u.role as "admin" | "agent";
    const status = effectiveStatus(u);
    const createdAtMs = new Date(u.created_at).getTime();
    if (status === "pending") {
      pendingInvitations.push({
        id: u.id,
        email: u.email_lower,
        role,
        createdAt: createdAtMs,
      });
      continue;
    }
    members.push({
      id: u.id,
      email: u.email_lower,
      name: u.display_name,
      role,
      isSelf: u.id === req.adminUserId,
      createdAt: createdAtMs,
      status,
      emailVerifiedAt: u.email_verified_at
        ? new Date(u.email_verified_at).getTime()
        : null,
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

router.post("/admin/users/invite", requireAdminOnly, adminUsersWriteLimiter, async (req, res) => {
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
  const supabase = getSupabaseServiceRoleClient();
  const { data: existingRows, error: existingErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, role, status, email_verified_at")
    .eq("email_lower", email)
    .limit(1);
  if (existingErr) {
    logger.error(
      { event: "admin_invite_lookup_failed", err: existingErr },
      "Failed to look up existing user",
    );
    res.status(500).json({ error: "Could not check for an existing account." });
    return;
  }
  const prior = existingRows?.[0];
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
  const invite = await inviteTeamMember(supabase, deps, {
    emailLower: email,
    role,
    displayName: null,
    productName: "PennFit",
    publicBaseUrl: buildInviteRedirectUrl(req),
    uiPathPrefix: "/admin",
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
  adminUsersWriteLimiter,
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

    const supabase = getSupabaseServiceRoleClient();
    const { data: lookup } = await supabase
      .schema("resupply_auth")
      .from("users")
      .select("email_lower")
      .eq("id", userId)
      .limit(1)
      .maybeSingle();
    const targetEmail = lookup?.email_lower ?? "(unknown)";

    const ok = await updateTeamMemberRole(supabase, userId, role);
    if (!ok) {
      res.status(404).json({ error: "Could not find that teammate." });
      return;
    }

    await writeAudit(req, `team.role_change to=${role} user=${targetEmail}`);
    res.json({ ok: true, userId, role });
  },
);

router.delete("/admin/users/:userId", requireAdminOnly, adminUsersWriteLimiter, async (req, res) => {
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

  const supabase = getSupabaseServiceRoleClient();
  const { data: lookup } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("email_lower")
    .eq("id", userId)
    .limit(1)
    .maybeSingle();
  const targetEmail = lookup?.email_lower ?? "(unknown)";

  await revokeTeamMember(supabase, userId);

  await writeAudit(req, `team.revoke user=${targetEmail}`);
  res.json({ ok: true, userId });
});

router.delete(
  "/admin/users/invitations/:invId",
  requireAdminOnly,
  adminUsersWriteLimiter,
  async (req, res) => {
    const invId = req.params.invId;
    if (!invId || typeof invId !== "string") {
      res.status(400).json({ error: "Missing invitation id." });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row } = await supabase
      .schema("resupply_auth")
      .from("users")
      .select("email_lower, status")
      .eq("id", invId)
      .limit(1)
      .maybeSingle();
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

    await revokeTeamMember(supabase, invId);

    await writeAudit(req, `team.invitation_revoke email=${row.email_lower}`);
    res.json({ ok: true, invitationId: invId });
  },
);

export default router;
