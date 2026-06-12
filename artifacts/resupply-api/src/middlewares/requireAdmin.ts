// requireAdmin — gate for the resupply admin API.
//
// The middleware resolves the session via the in-house pf_session
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
  type Permission,
  SESSION_COOKIE,
  hashToken,
  isExpired,
  readCookie,
  roleHasPermission,
} from "@workspace/resupply-auth";
import type { AdminRole } from "@workspace/resupply-db";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { getAuthDeps } from "../lib/auth-deps";
import { logger } from "../lib/logger";
import { enforceCsrfForAuthedMutation } from "./csrf";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminEmail?: string;
      adminUserId?: string;
      /**
       * Coarse role bucket from `auth.users.role` — "admin" or
       * "agent". This is the staff-or-not gate that has existed
       * since the cutover and is still authoritative for whether
       * the caller has reached the admin surface AT ALL.
       */
      adminRole?: "admin" | "agent";
      /**
       * Fine-grained role from `admin_users.role` — Phase A RBAC.
       * Falls back to `adminRole` when the admin_users row hasn't
       * been migrated yet (legacy pre-cutover rows). Use this for
       * permission decisions via `requirePermission(perm)`.
       */
      adminGranularRole?: AdminRole;
      /**
       * Home branch (location) of the signed-in staff member, from
       * `admin_users.location_id` (multi-location #O1). Null when
       * unassigned. Drives the soft default branch filter in the SPA;
       * NOT an access gate (unassigned staff see everything).
       */
      adminLocationId?: string | null;
    }
  }
}

interface ResolvedAdmin {
  email: string;
  userId: string;
  role: "admin" | "agent";
  /**
   * From admin_users.role. Defaults to the coarse `role` value
   * only when NO admin_users row exists — legacy rows pre-dating
   * Phase A are treated as their coarse role (admin → admin,
   * agent → agent), preserving backwards-compat. A FAILED lookup
   * rejects the request instead (fail closed, P2-19).
   */
  granularRole: AdminRole;
  /** Home branch from admin_users.location_id; null when unassigned
   *  or the lookup fails (treated as org-wide / no restriction). */
  locationId: string | null;
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

    // Look up the granular role from admin_users.
    //
    // Two distinct outcomes (app-review 2026-06-10, P2-19):
    //   * NO ROW (lookup succeeded, nothing matched) — legacy
    //     pre-Phase-A account that was never migrated into
    //     admin_users. Fall back to the coarse role: that's the
    //     same access the user had before Phase A, so the fallback
    //     can't grant anything new.
    //   * LOOKUP FAILED (PostgREST error or thrown) — we cannot
    //     know the user's real granular role. Falling back to the
    //     coarse role here would let a deliberately DOWNGRADED
    //     staffer (admin→csr in admin_users) regain super_admin for
    //     the duration of any admin_users read hiccup. Fail closed:
    //     reject the request (401), same posture as a failed
    //     session lookup. The blip costs one retried request, not a
    //     privilege escalation.
    let granularRole: AdminRole = user.role;
    let locationId: string | null = null;
    try {
      const supabase = getSupabaseServiceRoleClient();
      const { data, error } = await supabase
        .schema("resupply")
        .from("admin_users")
        .select("role, location_id")
        .eq("auth_user_id", user.id)
        .limit(1)
        .maybeSingle();
      if (error) {
        logger.warn(
          {
            event: "resupply_admin_granular_role_lookup_failed",
            err: error,
          },
          "requireAdmin: admin_users.role lookup errored; failing closed",
        );
        return null;
      }
      if (data?.role) {
        granularRole = data.role as AdminRole;
      }
      locationId = data?.location_id ?? null;
    } catch (err) {
      logger.warn(
        {
          event: "resupply_admin_granular_role_lookup_failed",
          err,
        },
        "requireAdmin: admin_users.role lookup threw; failing closed",
      );
      return null;
    }

    return {
      email: user.emailLower,
      userId: user.id,
      role: user.role,
      granularRole,
      locationId,
    };
  } catch (err) {
    logger.warn(
      {
        event: "resupply_admin_in_house_lookup_failed",
        err,
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
  // Set Cache-Control: no-store on every admin-gated response so a
  // cached admin payload can't be re-rendered from the browser
  // back-button / "Reopen closed tab" after sign-out. Individual
  // download handlers already set this header on their own
  // responses; centralising it here covers the JSON surfaces
  // (/admin/me, list endpoints, etc.) that an attacker with
  // physical access to the device would otherwise see flash.
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Pragma", "no-cache");
  const admin = await resolveAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  // Every admin-gated mutation must also clear the double-submit CSRF
  // check. requireAdminOnly and requirePermission both delegate through
  // requireAdmin, so enforcing it here guarantees CSRF coverage for the
  // entire admin surface — including routes mounted OUTSIDE the /admin
  // path prefix (e.g. PATCH /resupply-api/patients/:id, the
  // /conversations/:id/* actions, /sms|/email/send-reminder,
  // /voice/place-call) that the app-level requireCsrfOnAdminMutations
  // gate doesn't match. Safe methods pass through; the check runs only
  // after the session resolves so an unauthenticated caller still gets a
  // clean 401 (not a 403). Returns false only after sending the 403.
  if (!enforceCsrfForAuthedMutation(req, res)) return;
  req.adminEmail = admin.email;
  req.adminUserId = admin.userId;
  req.adminRole = admin.role;
  req.adminGranularRole = admin.granularRole;
  req.adminLocationId = admin.locationId;
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

/**
 * requirePermission(perm) — granular RBAC gate (Phase A).
 *
 * Chains `requireAdmin` (so we have a resolved staff user + the
 * adminGranularRole on req), then consults the catalog in
 * lib/resupply-auth/src/rbac.ts. Permits the request iff the
 * granular role carries the named permission.
 *
 *   router.post(
 *     "/admin/returns/:id/approve",
 *     requirePermission("returns.approve"),
 *     handler,
 *   );
 *
 * Failure modes:
 *   * 401 — no session (delegated to requireAdmin).
 *   * 403 with code "permission_denied" — session present but
 *     role lacks the permission. The body includes which
 *     permission was required so a UI can render a useful error
 *     ("you need the supervisor role to approve returns").
 *
 * NOTE: the body intentionally surfaces the required permission
 * key but NOT the caller's role — the role is in the audit log
 * for the failed call; leaking it in the response would help an
 * attacker enumerate which role they need to compromise.
 */
export function requirePermission(perm: Permission) {
  return async function handlePermissionGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let advanced = false;
    await requireAdmin(req, res, () => {
      advanced = true;
    });
    if (!advanced) return;

    const role = req.adminGranularRole;
    if (!role) {
      // Defensive: requireAdmin should have populated this. If it
      // didn't, refuse — failing closed is the right posture for a
      // permission gate.
      res.status(403).json({
        error: "permission_denied",
        message: "Your account doesn't have permission for this action.",
        requiredPermission: perm,
      });
      return;
    }
    if (!roleHasPermission(role, perm)) {
      logger.info(
        {
          event: "rbac_permission_denied",
          adminUserId: req.adminUserId,
          role,
          requiredPermission: perm,
          method: req.method,
          path: req.originalUrl,
        },
        "requirePermission: role lacks permission",
      );
      res.status(403).json({
        error: "permission_denied",
        message: "Your account doesn't have permission for this action.",
        requiredPermission: perm,
      });
      return;
    }
    next();
  };
}
