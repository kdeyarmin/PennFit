// requireAdmin — gate for the resupply admin API.
//
// Stage 5a — Clerk fall-through retired. The middleware now
// resolves the session strictly via the in-house pf_session
// cookie. `auth.users.role` is authoritative: 'admin' or 'agent'
// passes; 'customer' is rejected as 403; everything else
// (locked / revoked / unknown) is rejected as 401.
//
// Roles:
//   - `admin` — full privileges. Includes the team-management
//     endpoints in `routes/admin/team.ts`.
//   - `agent` — junior role for customer-service staff. Identical
//     to `admin` everywhere EXCEPT routes that explicitly opt in
//     to admin-only via `requireAdminOnly` (e.g. team management,
//     destructive deletes such as `DELETE /rules/:id`).
//
// On success we attach `req.adminEmail`, `req.adminUserId`, and
// `req.adminRole` so route handlers and the audit logger can
// record "who did this and at what privilege level" without
// re-fetching the user.
//
// First-admin bootstrap: there is no env-var allowlist anymore.
// Use `pnpm --filter @workspace/scripts auth:bootstrap-admin
// --email=<addr>` (see scripts/src/auth-bootstrap-admin.ts) to
// seed the very first admin against a fresh DB.

import type { Request, Response, NextFunction } from "express";

import {
  SESSION_COOKIE,
  hashToken,
  isExpired,
  readCookie,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../lib/auth-deps";
import { logger } from "../lib/logger";

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

interface ResolvedAdmin {
  email: string;
  userId: string;
  role: "admin" | "agent";
}

/**
 * Resolve the request's admin context from the in-house
 * pf_session cookie. Returns null when no cookie is present, the
 * cookie is invalid (expired / revoked / unknown user), the user
 * is locked / revoked, or the user is a `customer` (not staff).
 * On a transient repo error we log and return null — the
 * middleware translates that to 401.
 */
async function resolveAdmin(req: Request): Promise<ResolvedAdmin | null> {
  const deps = getAuthDeps();
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  if (!tokenHash) return null;
  try {
    const session = await deps.repo.findSessionByTokenHash(tokenHash);
    if (
      !session ||
      isExpired(
        { expiresAt: session.expiresAt, revokedAt: session.revokedAt },
        new Date(),
      )
    ) {
      return null;
    }
    const user = await deps.repo.findUserById(session.userId);
    if (!user || user.status === "locked" || user.status === "revoked") {
      return null;
    }
    if (user.role !== "admin" && user.role !== "agent") {
      return null;
    }
    return { email: user.emailLower, userId: user.id, role: user.role };
  } catch (err) {
    logger.warn(
      {
        event: "resupply_admin_in_house_lookup_failed",
        err: err instanceof Error ? err.message : "unknown",
      },
      "requireAdmin: in-house session lookup failed",
    );
    return null;
  }
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const admin = await resolveAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  req.adminEmail = admin.email;
  req.adminUserId = admin.userId;
  req.adminRole = admin.role;
  next();
}

/**
 * requireAdminOnly — stricter gate that admits only
 * `role === "admin"`. Wraps `requireAdmin` so a single source of
 * truth handles the resolve + the `req` attach.
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
