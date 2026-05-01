import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import {
  SESSION_COOKIE,
  hashToken,
  isExpired,
  readCookie,
} from "@workspace/resupply-auth";

import { getAuthDepsOrNull } from "../lib/auth-deps";

/**
 * requireAdmin — gate for the admin API.
 *
 * Resolution order for the role of the signed-in user (first match
 * wins):
 *   1. Email is in `PENN_ADMIN_EMAILS`           → admin
 *   2. Email is in `PENN_AGENT_EMAILS`           → agent
 *   3. the auth provider `publicMetadata.pennRole === "admin"` → admin
 *   4. the auth provider `publicMetadata.pennRole === "agent"` → agent
 *   5. otherwise                                  → 403
 *
 * The env-var allowlist is checked FIRST on purpose. It's the
 * permanent recovery / bootstrap path: even if auth provider metadata gets
 * mis-configured (or the very first admin needs to be seeded before
 * anyone can sign in), an engineer can always set `PENN_ADMIN_EMAILS`
 * and recover. The Clerk-metadata path is what the in-app "Team"
 * page writes when an admin invites a new teammate — convenient for
 * day-to-day team management, but not a single point of failure.
 *
 * The allowlists are comma-separated env vars, e.g.
 *   PENN_ADMIN_EMAILS="dr.smith@pennhomemedical.com,billing@pennhomemedical.com"
 *   PENN_AGENT_EMAILS="csr1@pennhomemedical.com,csr2@pennhomemedical.com"
 *
 * Roles:
 *   - `admin` — full privileges. Includes the team-management
 *     endpoints in `routes/admin-users.ts`.
 *   - `agent` — junior role for customer-service staff. Identical
 *     to `admin` everywhere EXCEPT routes that explicitly opt in to
 *     admin-only via `requireAdminOnly` (e.g. team management,
 *     future destructive operations).
 *
 * Behavior when neither env-var allowlist is set AND no the auth provider
 * metadata role is found:
 *   - In `NODE_ENV=development` we allow any signed-in user as
 *     `admin`. This makes the local dev loop bearable — no env vars
 *     to manage.
 *   - In production we DENY all requests with a 503 "admin not
 *     configured" response. Better to have no admin than an
 *     accidentally world-open admin if a deploy ships without any
 *     allowlist mechanism. Every prod deploy MUST seed at least one
 *     admin via `PENN_ADMIN_EMAILS` before relying on Clerk-metadata
 *     management.
 *
 * On success we attach `req.adminEmail`, `req.adminUserId`, and
 * `req.adminRole` so route handlers can write audit-log rows
 * without re-fetching the user.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminEmail?: string;
      adminUserId?: string;
      adminRole?: "admin" | "agent";
    }
  }
}

function parseEmailList(envVar: string): string[] | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function parseAdminAllowlist(): string[] | null {
  return parseEmailList("PENN_ADMIN_EMAILS");
}

function parseAgentAllowlist(): string[] | null {
  return parseEmailList("PENN_AGENT_EMAILS");
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // In-house auth path — see resupply-api's requireAdmin for the
  // canonical comment. When AUTH_PROVIDER is "dual" or "in_house"
  // and the request carries a valid pf_session cookie, derive
  // adminEmail / adminUserId / adminRole from auth.users and skip
  // the Clerk path entirely.
  const inHouse = await tryInHouseAdmin(req);
  if (inHouse) {
    req.adminEmail = inHouse.email;
    req.adminUserId = inHouse.userId;
    req.adminRole = inHouse.role;
    next();
    return;
  }

  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }

  // Look up the user to get their primary verified email AND any
  // pennRole stamped on auth provider publicMetadata. Both are needed for
  // role resolution below; we make exactly one auth lookup per
  // request (the call is cached aggressively by @clerk/express).
  //
  // We REQUIRE the primary email to be verified — otherwise an
  // attacker who can sign up with someone else's address (without
  // proving control) could match the env allowlist. the auth provider marks an
  // email "verified" only after the user clicks the verification
  // link or enters the code.
  let email: string | undefined;
  let metadataRole: "admin" | "agent" | undefined;
  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    if (primary?.verification?.status !== "verified") {
      res.status(403).json({
        error:
          "Your primary email address is not verified. Please verify it from your account settings before accessing the admin.",
      });
      return;
    }
    email = primary.emailAddress?.toLowerCase();
    metadataRole = readPennRoleFromMetadata(user.publicMetadata);
  } catch (_err) {
    res.status(401).json({ error: "Could not verify your identity. Please sign in again." });
    return;
  }

  if (!email) {
    res.status(403).json({ error: "Your account has no verified email address." });
    return;
  }

  const adminAllowlist = parseAdminAllowlist();
  const agentAllowlist = parseAgentAllowlist();

  let role: "admin" | "agent";
  if (adminAllowlist !== null && adminAllowlist.includes(email)) {
    role = "admin";
  } else if (agentAllowlist !== null && agentAllowlist.includes(email)) {
    role = "agent";
  } else if (metadataRole !== undefined) {
    // No env-var match, but the user has been promoted via the
    // in-app Team page (which writes auth provider publicMetadata).
    role = metadataRole;
  } else if (adminAllowlist === null) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({
        error:
          "Admin access is not configured on this server. Set PENN_ADMIN_EMAILS to a comma-separated list of admin emails.",
      });
      return;
    }
    // dev fallback — any signed-in user is an admin so the local dev
    // loop is bearable (no env vars to manage).
    role = "admin";
  } else {
    res.status(403).json({ error: "This account is not authorized for admin access." });
    return;
  }

  req.adminEmail = email;
  req.adminUserId = userId;
  req.adminRole = role;
  next();
}

async function tryInHouseAdmin(req: Request): Promise<{
  email: string;
  userId: string;
  role: "admin" | "agent";
} | null> {
  const deps = getAuthDepsOrNull();
  if (!deps) return null;
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  if (!tokenHash) return null;
  try {
    const session = await deps.repo.findSessionByTokenHash(tokenHash);
    if (!session) return null;
    if (
      isExpired(
        { expiresAt: session.expiresAt, revokedAt: session.revokedAt },
        new Date(),
      )
    ) {
      return null;
    }
    const user = await deps.repo.findUserById(session.userId);
    if (!user) return null;
    if (user.status === "locked" || user.status === "revoked") return null;
    if (user.role !== "admin" && user.role !== "agent") return null;
    return { email: user.emailLower, userId: user.id, role: user.role };
  } catch {
    // Transient repo error: fall through to the Clerk path rather
    // than surfacing an opaque 500 here. The Clerk path will return
    // a structured response for whichever failure mode it sees.
    return null;
  }
}

/**
 * Read `publicMetadata.pennRole` defensively. the auth provider types
 * `publicMetadata` as a free-form `Record<string, unknown>` so we
 * narrow here rather than at every call site. Anything other than
 * the two known role strings is treated as "no role" and the
 * resolver continues to the next path (env fallback / 403).
 */
function readPennRoleFromMetadata(
  metadata: unknown,
): "admin" | "agent" | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const raw = (metadata as Record<string, unknown>).pennRole;
  if (raw === "admin" || raw === "agent") return raw;
  return undefined;
}

export type PennRole = "admin" | "agent";

export const PENN_ROLE_METADATA_KEY = "pennRole" as const;

/**
 * Helper for `routes/admin-users.ts` so the team-management endpoints
 * use the SAME parse logic the gate uses. Single source of truth for
 * what a "valid" role string is.
 */
export function readPennRole(metadata: unknown): PennRole | undefined {
  return readPennRoleFromMetadata(metadata);
}

/**
 * Helper that returns the env-var allowlist parsed into the same
 * shape used by the gate, so the team page can render those rows as
 * read-only "set in server config" entries without re-implementing
 * the parser.
 */
export function getEnvAllowlists(): {
  admins: string[];
  agents: string[];
} {
  return {
    admins: parseAdminAllowlist() ?? [],
    agents: parseAgentAllowlist() ?? [],
  };
}

/**
 * requireAdminOnly — stricter gate that admits only `role === "admin"`.
 *
 * Wraps `requireAdmin` so all the spoofing defenses and the auth provider error
 * handling stay in one place. Use on routes whose effects are not
 * safely reversible by a customer-service agent. The cpap-fitter
 * admin has no such routes today; this is wired in advance so future
 * destructive operations can opt in cleanly.
 */
export async function requireAdminOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let advanced = false;
  await requireAdmin(req, res, () => {
    advanced = true;
  });
  if (!advanced) return;
  if (req.adminRole !== "admin") {
    res.status(403).json({
      error:
        "This action requires admin privileges. Customer-service agents cannot perform destructive operations.",
    });
    return;
  }
  next();
}
