// requirePlatformAdmin — the platform super-admin gate (G4).
//
// One level ABOVE `requireAdmin`. A tenant admin (requireAdmin) operates
// a single DME and every request is bound to that admin's `org_id`. A
// PLATFORM admin operates the platform itself — listing/suspending
// tenants, viewing cross-tenant usage, onboarding a new DME — and is NOT
// bound to one tenant.
//
// Membership lives in the global `resupply.platform_admins` table
// (migration 0355): a platform admin is an `auth.users` row whose id is
// present there. This gate resolves the session exactly like
// `requireAdmin` (same in-house pf_session cookie → auth user), then
// checks that membership. It deliberately does NOT attach `req.orgId` —
// platform routes are cross-tenant by design and resolve a specific
// tenant explicitly per operation.
//
// Posture mirrors requireAdmin: no-store headers, fail-closed (a lookup
// error rejects rather than admits), CSRF double-submit enforced on
// mutations, and a clean 401 for an unauthenticated caller vs a 403 for
// an authenticated non-platform-admin.

import type { Request, Response, NextFunction } from "express";

import {
  SESSION_COOKIE,
  hashToken,
  isExpired,
  readCookie,
} from "@workspace/resupply-auth";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { getAuthDeps } from "../lib/auth-deps";
import { logger } from "../lib/logger";
import { enforceCsrfForAuthedMutation } from "./csrf";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** auth.users.id of the signed-in platform super-admin. */
      platformAdminUserId?: string;
      /** Email of the signed-in platform super-admin. */
      platformAdminEmail?: string | null;
    }
  }
}

interface ResolvedPlatformAdmin {
  userId: string;
  email: string | null;
}

/**
 * Resolve the request's PLATFORM admin from the pf_session cookie.
 * Returns:
 *   * a resolved admin when the session is valid AND the user is in
 *     `platform_admins`,
 *   * `"unauthenticated"` when there's no/invalid session or the user
 *     is locked/revoked (→ 401),
 *   * `"forbidden"` when the session is valid but the user is not a
 *     platform admin (→ 403).
 * Fail-closed: a repo/DB error resolves to `"unauthenticated"` (a blip
 * costs one retried request, never an unintended grant).
 */
async function resolvePlatformAdmin(
  req: Request,
): Promise<ResolvedPlatformAdmin | "unauthenticated" | "forbidden"> {
  const deps = getAuthDeps();
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return "unauthenticated";
  const tokenHash = hashToken(raw);
  if (!tokenHash) return "unauthenticated";
  try {
    const session = await deps.repo.findSessionByTokenHash(tokenHash);
    if (
      !session ||
      isExpired(
        { expiresAt: session.expiresAt, revokedAt: session.revokedAt },
        new Date(),
      )
    ) {
      return "unauthenticated";
    }
    const user = await deps.repo.findUserById(session.userId);
    if (!user || user.status === "locked" || user.status === "revoked") {
      return "unauthenticated";
    }

    // `platform_admins` is a GLOBAL (non-tenant) directory — read it via
    // the `.raw()` escape hatch (the org-scoped facade would wrongly
    // append an org_id filter to a table that has none). A missing seed
    // org means the DB is unreachable → fail closed.
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) return "unauthenticated";
    const supabase = getOrgScopedClient(seedOrgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("platform_admins")
      .select("auth_user_id")
      .eq("auth_user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (error) {
      // Fail closed on a lookup error — never admit on an unverifiable
      // membership check.
      logger.warn(
        { event: "platform_admin_lookup_errored", err: error },
        "requirePlatformAdmin: platform_admins lookup errored; failing closed",
      );
      return "unauthenticated";
    }
    if (!data) return "forbidden";
    return { userId: user.id, email: user.emailLower };
  } catch (err) {
    logger.warn(
      {
        event: "platform_admin_resolve_threw",
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "requirePlatformAdmin: resolution threw; failing closed",
    );
    return "unauthenticated";
  }
}

/**
 * Express middleware: admit only platform super-admins. 401 for an
 * unauthenticated/invalid session, 403 for an authenticated user who is
 * not a platform admin. Enforces the CSRF double-submit on mutations.
 */
export async function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
  const resolved = await resolvePlatformAdmin(req);
  if (resolved === "unauthenticated") {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  if (resolved === "forbidden") {
    res.status(403).json({ error: "Platform admin required" });
    return;
  }
  // CSRF on mutations only (safe methods pass through), same posture as
  // requireAdmin. Runs after the session resolves so an unauthenticated
  // caller still gets a clean 401.
  if (!enforceCsrfForAuthedMutation(req, res)) return;
  req.platformAdminUserId = resolved.userId;
  req.platformAdminEmail = resolved.email;
  next();
}
