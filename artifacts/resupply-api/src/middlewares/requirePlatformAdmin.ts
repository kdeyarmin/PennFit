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
 * Is `userId` in the global `platform_admins` directory?
 *
 * Returns `"unknown"` — never `false` — when the directory cannot be read, so
 * callers fail closed on an unverifiable membership rather than treating a DB
 * blip as "not a platform admin" (which for a deny-gate reads as "admit").
 */
export async function isPlatformAdminUser(
  userId: string,
): Promise<boolean | "unknown"> {
  try {
    // `platform_admins` is a GLOBAL (non-tenant) directory — read it via the
    // `.raw()` escape hatch, since the org-scoped facade would append an
    // org_id filter to a table that has none.
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) return "unknown";
    const { data, error } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("platform_admins")
      .select("auth_user_id")
      .eq("auth_user_id", userId)
      .limit(1)
      .maybeSingle();
    if (error) {
      logger.warn(
        { event: "platform_admin_lookup_errored", err: error },
        "isPlatformAdminUser: platform_admins lookup errored",
      );
      return "unknown";
    }
    return data !== null;
  } catch (err) {
    logger.warn(
      {
        event: "platform_admin_resolve_threw",
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "isPlatformAdminUser: resolution threw",
    );
    return "unknown";
  }
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

    // Fail closed on an unverifiable membership check — never admit.
    const member = await isPlatformAdminUser(user.id);
    if (member === "unknown") return "unauthenticated";
    if (!member) return "forbidden";
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

/**
 * Second-factor gate for a route that lives on the TENANT admin mount but
 * writes a platform-GLOBAL table (one with no `org_id`).
 *
 * Chain it after `requireAdminOnly` / `requirePermission(...)`: the upstream
 * gate resolves the session, `req.orgId`, and CSRF, and this one additionally
 * requires the same user to be a platform super-admin. Composing rather than
 * swapping in `requirePlatformAdmin` keeps `req.orgId` populated, so the audit
 * row still records which tenant console the change was made from.
 *
 * Needed because `.eq("id", …)` on a table without `org_id` is not scoped by
 * anything: the org-scoped client cannot narrow it, so any tenant admin
 * holding a row id could otherwise rewrite reference data that every other
 * tenant reads. Fails closed when membership cannot be verified.
 */
export async function requirePlatformAdminForGlobalWrite(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.adminUserId;
  if (!userId) {
    // No upstream admin gate ran — refuse rather than assume.
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  const member = await isPlatformAdminUser(userId);
  if (member === "unknown") {
    res.status(503).json({ error: "authorization_unavailable" });
    return;
  }
  if (!member) {
    res.status(403).json({
      error: "platform_admin_required",
      message:
        "This catalog is shared by every tenant and is managed by the platform.",
    });
    return;
  }
  next();
}
