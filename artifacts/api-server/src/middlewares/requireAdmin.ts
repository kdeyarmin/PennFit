// requireAdmin — gate for the PennPaps admin API.
//
// The middleware resolves the session via the in-house pf_session
// cookie. `auth.users.role` is authoritative: 'admin' or 'agent'
// passes; 'customer' is rejected as 401; everything else
// (locked / revoked / unknown) is rejected as 401.
//
// Roles:
//   - `admin` — full privileges. Includes the team-management
//     endpoints in `routes/admin-users.ts`.
//   - `agent` — junior role for customer-service staff. Identical
//     to `admin` everywhere EXCEPT routes that explicitly opt in
//     to admin-only via `requireAdminOnly`.
//
// First-admin bootstrap: there is no env-var allowlist. Use
// `pnpm --filter @workspace/scripts auth:bootstrap-admin
// --email=<addr> --role=admin` to seed the very first admin
// against a fresh DB.

import type { Request, Response, NextFunction } from "express";

import {
  SESSION_COOKIE,
  hashToken,
  isExpired,
  readCookie,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../lib/auth-deps";

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
  } catch {
    // Transient repo error → 401. The SPA reloads /me, the next
    // attempt sees a healthier DB.
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

// Stage 5b retired the legacy `readPennRole` / `getEnvAllowlists`
// / `PENN_ROLE_METADATA_KEY` helpers along with the legacy
// admin-users.ts route. Identity now lives entirely on
// `auth.users.role`; PENN_ADMIN_EMAILS / PENN_AGENT_EMAILS env
// vars are no longer consulted by the middleware. Bootstrap a
// fresh DB with `pnpm --filter @workspace/scripts auth:bootstrap-admin
// --email=<addr> --role=admin`.
