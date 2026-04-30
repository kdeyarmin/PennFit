/**
 * Admin team-management routes.
 *
 * Lets a Penn admin invite, promote, demote, or revoke teammates
 * from inside the cpap-fitter admin console — no engineer / env-var
 * change / restart required for routine staff turnover.
 *
 * Authority model (single source of truth: requireAdmin.ts):
 *   1. PENN_ADMIN_EMAILS env match            → admin
 *   2. PENN_AGENT_EMAILS env match            → agent
 *   3. auth provider publicMetadata.pennRole === ...  → admin / agent
 *   4. else 403
 *
 * Env rows are deliberately NOT mutable from here. They are the
 * permanent recovery path: if auth provider metadata or this surface is
 * misconfigured, an engineer with shell access can always restore
 * admin access by editing the env var. Showing them in the UI as a
 * read-only "set in server config" badge keeps that bootstrap path
 * visible to operators.
 *
 * Lockout guard: an admin cannot demote or revoke themselves. There
 * is no "admin count" in we could rely on (env-allowlisted
 * admins live entirely outside the auth provider), so the simplest invariant is
 * "you can't fire yourself" — at minimum the actor remains.
 *
 * Audit: every state-changing call writes a row to admin_audit_log
 * via the existing pattern (try/catch, logger.error on failure, do
 * NOT block the response — auditing is best-effort, never a hard
 * dependency of the user-visible operation).
 */

import { Router } from "express";
import { z } from "zod";
import { clerkClient } from "@clerk/express";
import { db, adminAuditLogTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  readPennRole,
  getEnvAllowlists,
  requireAdminOnly,
  PENN_ROLE_METADATA_KEY,
  type PennRole,
} from "../middlewares/requireAdmin.js";

const router = Router();

// ---------- shared helpers ----------

const inviteBody = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  role: z.enum(["admin", "agent"]),
});

const roleChangeBody = z.object({
  role: z.enum(["admin", "agent"]),
});

/**
 * Best-effort audit write. Mirrors the pattern in routes/admin.ts
 * (and reminders.ts): log the failure, never throw, never block the
 * caller's response. The user already saw the operation succeed; an
 * audit gap is preferable to a 500 that masks a successful mutation.
 */
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

/** Pick the user's primary email. Falls back to the first address. */
function primaryEmail(user: {
  primaryEmailAddressId: string | null;
  emailAddresses: ReadonlyArray<{ id: string; emailAddress: string }>;
}): string | null {
  const primaryId = user.primaryEmailAddressId;
  const primary =
    user.emailAddresses.find((e) => e.id === primaryId) ??
    user.emailAddresses[0];
  return primary?.emailAddress?.toLowerCase() ?? null;
}

/** Compose a human-friendly display name; falls back to the email. */
function displayName(user: {
  firstName: string | null;
  lastName: string | null;
}): string | null {
  const parts = [user.firstName, user.lastName].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * If `email` is in either env allowlist, return the env-derived role.
 * Mutating auth provider metadata for such an email is a no-op for effective
 * access (env wins in `requireAdmin`), so the routes refuse the call
 * up front with a clear "ask an engineer to edit env" message rather
 * than silently letting the operator believe access changed.
 */
function envRoleFor(email: string): PennRole | null {
  const env = getEnvAllowlists();
  if (env.admins.includes(email)) return "admin";
  if (env.agents.includes(email)) return "agent";
  return null;
}

// ---------- GET /admin/users ----------

/**
 * Returns the current Penn-access roster from THREE sources in one
 * payload so the team page can render them as three sections without
 * three round-trips:
 *
 *   - members: auth users with `publicMetadata.pennRole` set —
 *     the in-app-managed teammates, mutable via the routes below.
 *   - envAllowlist: synthetic rows for emails listed in the env
 *     vars — read-only, badged "set in server config".
 *   - pendingInvitations: open the auth provider invitations carrying a
 *     `pennRole` claim — show in a "pending" section so admins can
 *     cancel mistyped invites.
 *
 * Available to BOTH admin and agent (read-only): agents need to be
 * able to see who they share access with, but only admins see the
 * mutate buttons (enforced both server-side and in the UI).
 *
 * Audited as `team.list` so we can spot reconnaissance — a bored
 * agent fishing the staff roster repeatedly stands out.
 */
router.get("/admin/users", async (req, res) => {
  // the auth provider's getUserList does not support filtering by metadata, so
  // we page through and filter in memory. Penn's staff is small
  // (<200 users in the foreseeable future), and the auth provider caps page size
  // at 500. One page is overwhelmingly likely to be enough; we still
  // loop defensively up to a hard cap to avoid a runaway in case of
  // future growth.
  const PAGE_SIZE = 200;
  const HARD_CAP_PAGES = 10;

  // Build env lookup once so we can both (a) emit synthesized env
  // rows and (b) tag each the auth provider row whose email is also in env so
  // the UI knows mutating their metadata is a no-op (env wins).
  const env = getEnvAllowlists();
  const envByEmail = new Map<string, PennRole>();
  for (const e of env.admins) envByEmail.set(e, "admin");
  for (const e of env.agents) {
    if (!envByEmail.has(e)) envByEmail.set(e, "agent");
  }

  type TeamMemberRow = {
    id: string;
    email: string;
    name: string | null;
    role: PennRole;
    isSelf: boolean;
    createdAt: number;
    lastSignInAt: number | null;
    /**
     * If the user's email is also in PENN_ADMIN_EMAILS or
     * PENN_AGENT_EMAILS, surface that role here. The UI uses this
     * to disable role-change / remove for the row, because env
     * always wins — mutating auth provider metadata for an env-allowlisted
     * user wouldn't actually change their effective access.
     */
    envOverride: PennRole | null;
  };

  const members: TeamMemberRow[] = [];
  for (let page = 0; page < HARD_CAP_PAGES; page++) {
    const batch = await clerkClient.users.getUserList({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      orderBy: "-created_at",
    });
    const rows = batch.data ?? [];
    for (const u of rows) {
      const role = readPennRole(u.publicMetadata);
      if (!role) continue;
      const email = primaryEmail(u);
      if (!email) continue;
      members.push({
        id: u.id,
        email,
        name: displayName(u),
        role,
        isSelf: u.id === req.adminUserId,
        createdAt: u.createdAt,
        lastSignInAt: u.lastSignInAt ?? null,
        envOverride: envByEmail.get(email) ?? null,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Synthesize env-allowlist rows. We do not deduplicate against
  // auth users because both signals are independently meaningful:
  // an email may be both env-allowlisted (the safety net) AND
  // metadata-tagged (the in-app record). Showing both rows makes
  // that overlap explicit instead of silently hiding the env entry.
  const envAllowlist = [
    ...env.admins.map((email) => ({ email, role: "admin" as const })),
    ...env.agents.map((email) => ({ email, role: "agent" as const })),
  ];

  // Pending invitations carrying a pennRole claim. Clerk's
  // `status: "pending"` filter excludes accepted/revoked/expired.
  type PendingInviteRow = {
    id: string;
    email: string;
    role: PennRole;
    createdAt: number;
  };
  const pendingInvitations: PendingInviteRow[] = [];
  try {
    const invites = await clerkClient.invitations.getInvitationList({
      status: "pending",
      limit: 100,
      orderBy: "-created_at",
    });
    for (const inv of invites.data ?? []) {
      const role = readPennRole(inv.publicMetadata);
      if (!role) continue;
      pendingInvitations.push({
        id: inv.id,
        email: inv.emailAddress.toLowerCase(),
        role,
        createdAt: inv.createdAt,
      });
    }
  } catch (err) {
    // Don't fail the whole roster fetch just because the invitation
    // listing hiccupped — the active-teammate view is still useful
    // on its own. Log loudly so we notice in production.
    logger.error({ err }, "Failed to fetch invitation list");
  }

  await writeAudit(req, "team.list");

  res.json({
    role: req.adminRole ?? "admin",
    self: { email: req.adminEmail, userId: req.adminUserId },
    members,
    envAllowlist,
    pendingInvitations,
  });
});

// ---------- POST /admin/users/invite ----------

/**
 * Build the redirect URL the invitee lands on after clicking the
 * the invitation link. We prefer the canonical published domain
 * (REPLIT_DOMAINS) and fall back to the request origin so dev-mode
 * invites work too. Either way the link points at /admin so the
 * accepted user immediately lands in the console they were granted
 * access to.
 */
function buildInviteRedirectUrl(req: import("express").Request): string {
  const fromEnv = process.env.PENN_ADMIN_PUBLIC_BASE_URL?.trim();
  if (fromEnv) return `${fromEnv.replace(/\/+$/, "")}/admin`;

  const replit = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replit) return `https://${replit}/admin`;

  // Last-ditch: derive from the inbound request. This is what local
  // dev hits because REPLIT_DOMAINS is only set by the Replit
  // platform on deployed instances.
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}/admin`;
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

  // Env-allowlist conflict: that email already has effective access
  // via env, and changing auth provider metadata won't alter it. Refuse
  // up front so the operator isn't fooled by a "success" toast.
  const envRole = envRoleFor(email);
  if (envRole) {
    res.status(409).json({
      error: `That email is already set in server config as ${envRole}. Ask an engineer to update the env allowlist instead.`,
    });
    return;
  }

  // Pre-check existing auth users:
  //   - has pennRole already → refuse (use "Change role" instead).
  //   - exists but no pennRole → adopt them in place by stamping
  //     publicMetadata.pennRole. the auth provider would reject createInvitation
  //     for an already-existing identity (and a fresh invite is the
  //     wrong UX anyway — the person already has an account).
  try {
    const existing = await clerkClient.users.getUserList({
      emailAddress: [email],
      limit: 5,
    });
    // SECURITY: the auth provider's getUserList({emailAddress}) matches users
    // by ANY email on the account (primary OR secondary). We must
    // only consider users whose PRIMARY email equals the invited
    // address — otherwise an attacker (or just a typo) could stamp
    // pennRole onto an account whose verified primary identity is
    // a totally different person. requireAdmin separately requires
    // the primary email be verified, so primary-only is the right
    // axis to gate adoption on.
    const matches = (existing.data ?? []).filter(
      (u) => primaryEmail(u) === email,
    );
    const alreadyTagged = matches.find(
      (u) => readPennRole(u.publicMetadata) !== undefined,
    );
    if (alreadyTagged) {
      res.status(409).json({
        error:
          "That person already has access. Use Change role on their existing entry instead of re-inviting.",
      });
      return;
    }
    const noRoleYet = matches[0];
    if (noRoleYet) {
      try {
        await clerkClient.users.updateUserMetadata(noRoleYet.id, {
          publicMetadata: { [PENN_ROLE_METADATA_KEY]: role },
        });
      } catch (err) {
        logger.error(
          { err, userId: noRoleYet.id, email, role },
          "In-place promote failed",
        );
        res.status(502).json({
          error:
            "That email already has an account but we couldn't grant them access. Please try again.",
        });
        return;
      }
      await writeAudit(req, `team.invite role=${role} email=${email} adopted=true`);
      res.status(200).json({
        adopted: true as const,
        userId: noRoleYet.id,
        email,
        role,
      });
      return;
    }
  } catch (err) {
    // Don't block the invite on a failed pre-check — the auth provider will
    // also enforce uniqueness on the invite call itself. Just log.
    logger.warn({ err, email }, "Pre-invite duplicate check failed");
  }

  try {
    const invitation = await clerkClient.invitations.createInvitation({
      emailAddress: email,
      publicMetadata: { [PENN_ROLE_METADATA_KEY]: role },
      redirectUrl: buildInviteRedirectUrl(req),
      notify: true,
      ignoreExisting: false,
    });
    await writeAudit(req, `team.invite role=${role} email=${email}`);
    res.status(201).json({
      id: invitation.id,
      email: invitation.emailAddress.toLowerCase(),
      role,
      createdAt: invitation.createdAt,
    });
  } catch (err) {
    // Surface Clerk's message when it's safe (duplicate-invite,
    // invalid-email). Default to a friendly generic message.
    const message =
      err instanceof Error && /already|duplicate|exists/i.test(err.message)
        ? "That email already has a pending invitation. Cancel it first if you want to re-send."
        : "Could not send the invitation. Please try again.";
    logger.error({ err, email, role }, "Invitation failed");
    res.status(502).json({ error: message });
  }
});

// ---------- PATCH /admin/users/:userId/role ----------

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
      // Lockout guard: prevent the active admin from demoting
      // themselves to agent (or no-op-promoting). They'd lose the
      // ability to undo it without an engineer touching the env.
      res.status(400).json({
        error:
          "You can't change your own role. Ask another admin to do it for you.",
      });
      return;
    }

    let targetEmail: string;
    try {
      const user = await clerkClient.users.getUser(userId);
      targetEmail = primaryEmail(user) ?? "(unknown)";
      // Env-allowlist conflict — env wins, so a metadata change here
      // would silently do nothing for effective access. Refuse so
      // the operator gets honest feedback instead of a fake success.
      const envRole = envRoleFor(targetEmail);
      if (envRole) {
        res.status(409).json({
          error: `${targetEmail} is also set in server config as ${envRole}. Their access is controlled by the env allowlist — ask an engineer to change it there.`,
        });
        return;
      }
      await clerkClient.users.updateUserMetadata(userId, {
        publicMetadata: { [PENN_ROLE_METADATA_KEY]: role },
      });
    } catch (err) {
      logger.error({ err, userId, role }, "Role change failed");
      res.status(502).json({ error: "Could not update that teammate's role." });
      return;
    }

    await writeAudit(req, `team.role_change to=${role} user=${targetEmail}`);
    res.json({ ok: true, userId, role });
  },
);

// ---------- DELETE /admin/users/:userId ----------

/**
 * Revokes Penn access by clearing `pennRole` from the user's the auth provider
 * publicMetadata. We do NOT delete the auth user — they may use
 * the same identity for the patient-facing pages, and a future
 * re-grant should not require re-creating the account.
 */
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

  let targetEmail: string;
  try {
    const user = await clerkClient.users.getUser(userId);
    targetEmail = primaryEmail(user) ?? "(unknown)";
    // Env-allowlist conflict — clearing pennRole would not actually
    // revoke access because env wins in requireAdmin. Refuse with a
    // clear message instead of letting the row silently re-appear
    // on the next refetch.
    const envRole = envRoleFor(targetEmail);
    if (envRole) {
      res.status(409).json({
        error: `${targetEmail} is also set in server config as ${envRole}. Their access can't be removed from this page — ask an engineer to take them out of the env allowlist.`,
      });
      return;
    }
    // Setting the key to null tells the auth provider to drop it. We keep the
    // shape (an object, not undefined) so the request itself stays
    // a PATCH-style merge on Clerk's side rather than a wholesale
    // metadata replacement.
    await clerkClient.users.updateUserMetadata(userId, {
      publicMetadata: { [PENN_ROLE_METADATA_KEY]: null },
    });
  } catch (err) {
    logger.error({ err, userId }, "Revoke failed");
    res.status(502).json({ error: "Could not remove that teammate." });
    return;
  }

  await writeAudit(req, `team.revoke user=${targetEmail}`);
  res.json({ ok: true, userId });
});

// ---------- DELETE /admin/users/invitations/:invId ----------

router.delete(
  "/admin/users/invitations/:invId",
  requireAdminOnly,
  async (req, res) => {
    const invId = req.params.invId;
    if (!invId || typeof invId !== "string") {
      res.status(400).json({ error: "Missing invitation id." });
      return;
    }

    let targetEmail = "(unknown)";
    try {
      const revoked = await clerkClient.invitations.revokeInvitation(invId);
      targetEmail = revoked.emailAddress?.toLowerCase() ?? "(unknown)";
    } catch (err) {
      logger.error({ err, invId }, "Invitation revoke failed");
      res
        .status(502)
        .json({ error: "Could not cancel that invitation. It may already be gone." });
      return;
    }

    await writeAudit(req, `team.invitation_revoke email=${targetEmail}`);
    res.json({ ok: true, invitationId: invId });
  },
);

export default router;
