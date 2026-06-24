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
import {
  getSupabaseServiceRoleClient,
  resolveSeedOrgId,
} from "@workspace/resupply-db";

import { getAuthDeps } from "../lib/auth-deps";
import { hasPendingAgreements } from "../lib/agreements/status";
import { logger } from "../lib/logger";
import {
  isLockedAllowedPath,
  isMaskFitterAllowedPath,
  resolveTenantProductScope,
} from "../lib/product-scope";
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
      /**
       * Tenant (organization) the request operates within — multi-tenant
       * Phase 0. Attached by `requireAdmin` / `requireSignedIn`. While the
       * platform is single-tenant this always resolves to the seed org;
       * once `admin_users` / `shop_customers` carry their own `org_id`
       * (later backfill batches) it is read per-user. NOT yet an access
       * gate (nothing filters on it until the scoped-wrapper cutover).
       * Declared once here; `requireSignedIn` sets it without redeclaring.
       */
      orgId?: string;
      /**
       * True when the request runs under platform-admin act-as-tenant
       * impersonation (G4). Handlers/audit can branch on this; mutations
       * still run (full read/write), but downstream audit rows should
       * record `impersonatorUserId` so the action stays attributable.
       */
      impersonation?: boolean;
      /** Platform admin's auth.users.id when `impersonation` is true. */
      impersonatorUserId?: string | null;
    }
  }
}

/**
 * Mandatory-MFA policy, captured ONCE at module load (deploy-time policy,
 * matching routes/admin/mfa.ts:readEnforcementModeFromEnv). When set, an
 * admin/agent with NO verified MFA enrollment is blocked from the entire
 * admin API surface except the enrollment + identity endpoints — the
 * server-side companion to the SPA's enrollment banner. To re-arm, redeploy.
 */
const MFA_REQUIRED_FOR_ADMINS: boolean = (() => {
  const v = process.env.AUTH_REQUIRE_MFA_FOR_ADMINS?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
})();

/**
 * Paths an admin with no MFA enrollment must STILL reach so they can learn
 * they must enroll (`/me`, `/admin/mfa/status`) and complete enrollment
 * (`/admin/mfa/enroll/*`). The whole `/admin/mfa/` subtree is allowed — an
 * unenrolled admin can't disable/regenerate what they don't have, so it's
 * harmless and avoids brittle per-endpoint matching. Everything else is
 * blocked while the mandatory-MFA policy is on and the admin is unenrolled.
 */
function isMfaEnrollmentAllowedPath(path: string): boolean {
  return path.includes("/admin/mfa/") || path.endsWith("/me");
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
  /** Tenant from admin_users.org_id (multi-tenant Phase 0). Null for
   *  legacy rows not yet backfilled; the middleware falls back to the
   *  seed org so single-tenant behavior is unchanged. */
  orgId: string | null;
  /** True when this is a platform-admin act-as-tenant session (G4). */
  impersonation?: boolean;
  /** The platform admin's auth.users.id behind an impersonation session. */
  impersonatorUserId?: string | null;
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

    // ── Platform-admin act-as-tenant impersonation (G4) ───────────────
    // An impersonation session carries the target tenant on the session
    // row (mintable ONLY by the platform-gated POST /platform/tenants/
    // :id/impersonate). When present we bind the request to THAT org with
    // full tenant-admin access — and DON'T run the admin_users lookup,
    // because the platform admin has no admin_users row in the target
    // tenant (their own row would resolve the wrong org). The DB role
    // 'admin' maps to the `super_admin` effective role (all permissions),
    // matching the full-read/write support contract. `impersonatorUserId`
    // makes every downstream action attributable to the real human.
    if (session.impersonatedOrgId) {
      // Re-verify the impersonator is STILL an active platform admin on
      // EVERY request. Without this, a live act-as-tenant cookie keeps full
      // tenant-admin access for up to the session TTL after the human is
      // removed from `platform_admins` — revoking a compromised/departed
      // platform admin would not immediately cut their cross-tenant access.
      // The session's userId IS the platform admin's auth user id (the mint
      // sets userId === impersonatorUserId === platformAdminUserId). Fail
      // closed on a lookup error or a non-member. `platform_admins` is a
      // GLOBAL directory, so read it via the service-role client (no org
      // filter); this file is allowlisted for that direct call.
      try {
        const svc = getSupabaseServiceRoleClient();
        const { data: pa, error: paErr } = await svc
          .schema("resupply")
          .from("platform_admins")
          .select("auth_user_id")
          .eq("auth_user_id", user.id)
          .limit(1)
          .maybeSingle();
        if (paErr || !pa) {
          logger.warn(
            {
              event: "resupply_impersonation_platform_admin_revoked",
              impersonatorUserId: user.id,
              hadLookupError: Boolean(paErr),
            },
            "requireAdmin: impersonator is no longer an active platform admin; rejecting impersonation session",
          );
          return null;
        }
      } catch (err) {
        logger.warn(
          { event: "resupply_impersonation_platform_admin_check_failed", err },
          "requireAdmin: platform_admins re-check threw; failing closed",
        );
        return null;
      }
      return {
        email: user.emailLower,
        userId: user.id,
        role: "admin",
        granularRole: "admin",
        locationId: null,
        orgId: session.impersonatedOrgId,
        impersonation: true,
        impersonatorUserId: session.impersonatorUserId,
      };
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
    let orgId: string | null = null;
    try {
      const supabase = getSupabaseServiceRoleClient();
      const { data, error } = await supabase
        .schema("resupply")
        .from("admin_users")
        .select("role, location_id, org_id")
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
      orgId = data?.org_id ?? null;
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
      orgId,
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
  if (admin.impersonation) {
    req.impersonation = true;
    req.impersonatorUserId = admin.impersonatorUserId ?? null;
  }
  // Multi-tenant Phase 0: attach the tenant context. Prefer the
  // per-user admin_users.org_id (backfilled in migration 0330); fall
  // back to the seed org for legacy rows not yet backfilled so
  // single-tenant behavior is unchanged. Resolved best-effort and
  // logged — NOT fail-closed — because nothing enforces org_id yet, so
  // a resolution hiccup must not take down the entire admin surface.
  // Enforcement (fail-closed) arrives with the scoped-wrapper cutover
  // (Phase 0 workstream C).
  const orgId = admin.orgId ?? (await resolveSeedOrgId());
  if (orgId) {
    req.orgId = orgId;
  } else {
    logger.warn(
      { event: "resupply_admin_org_resolve_failed", adminUserId: admin.userId },
      "requireAdmin: could not resolve tenant org_id (attached none)",
    );
  }

  // Onboarding agreements gate (G16). A tenant that hasn't signed the
  // required agreements (BAA + platform terms) is blocked from the admin
  // API itself — not just the SPA — so the compliance gate can't be
  // bypassed by calling endpoints directly with a valid session. The
  // endpoints needed to SEE and COMPLETE signing are allowlisted, and
  // platform-admin act-as-tenant sessions are exempt (support staff must
  // reach an unsigned tenant to help them). Fail-closed on a lookup error,
  // matching the /me `pendingAgreements` posture. Skipped entirely when no
  // org could be resolved (single-tenant boot before the seed is cached) —
  // there's nothing to gate on.
  if (req.orgId && req.impersonation !== true) {
    const path = req.originalUrl.split("?")[0] ?? "";
    const isAgreementsEndpoint = path.includes("/admin/agreements");
    const isIdentityEndpoint = path.endsWith("/me");
    if (
      !isAgreementsEndpoint &&
      !isIdentityEndpoint &&
      (await hasPendingAgreements(req.orgId))
    ) {
      res.status(403).json({
        error: "agreements_required",
        message:
          "Your organization must accept the required agreements before using the console.",
      });
      return;
    }
  }

  // Mandatory-MFA enforcement (server-side companion to the SPA banner).
  // When AUTH_REQUIRE_MFA_FOR_ADMINS is set, an admin/agent with NO verified
  // MFA enrollment is blocked from the entire admin API surface EXCEPT the
  // MFA-enrollment endpoints + the `/me` identity probe — so a freshly
  // seeded admin can still sign in and enroll, but cannot otherwise act
  // password-only. Without this, the env flag was UI-only: an unenrolled
  // admin could call every requireAdmin route directly (curl / scripted
  // client / compromised extension), making the "MFA required" policy
  // cosmetic. Mirrors the provider portal's requireProviderMfaEnrolled gate.
  // Impersonation sessions are exempt — the platform admin already cleared
  // MFA at their own sign-in, and they have no MFA row in the target tenant.
  // OFF by default (flag unset), so default deploys pay no extra DB round-trip.
  if (MFA_REQUIRED_FOR_ADMINS && req.impersonation !== true) {
    const path = req.originalUrl.split("?")[0] ?? "";
    if (!isMfaEnrollmentAllowedPath(path)) {
      const deps = getAuthDeps();
      let hasVerifiedMfa: boolean;
      try {
        hasVerifiedMfa = deps.mfa
          ? Boolean(await deps.mfa.findActiveSecret(admin.userId))
          : false;
      } catch (err) {
        // Can't confirm enrollment → fail closed. The enrollment endpoints
        // are allowlisted above and don't reach this probe, so a blocked
        // admin can still navigate to set up MFA.
        logger.warn(
          {
            event: "resupply_admin_mfa_enrollment_probe_failed",
            adminUserId: admin.userId,
            err,
          },
          "requireAdmin: MFA enrollment probe failed; failing closed",
        );
        res.status(403).json({
          error: "mfa_enrollment_required",
          message:
            "Two-factor authentication must be set up before you can use the console.",
        });
        return;
      }
      if (!hasVerifiedMfa) {
        res.status(403).json({
          error: "mfa_enrollment_required",
          message:
            "Two-factor authentication must be set up before you can use the console.",
        });
        return;
      }
    }
  }

  // Product-scope gate (standalone Virtual Mask Fitter plan, migration
  // 0419). A tenant on a scoped-down plan may only reach the fitter +
  // account-essential surfaces; every other admin route 403s. This is a
  // NO-OP for "full" — which is every existing tenant and every tenant
  // with no active subscription — so the only requests it can restrict are
  // those of a DME deliberately placed on the mask_fitter plan. The
  // resolver fails OPEN to "full", so a DB hiccup never locks anyone out.
  // Platform-admin act-as-tenant sessions are exempt: support staff must
  // reach the whole console to help a scoped tenant. The `/me` identity
  // endpoint is always allowed so the SPA can learn its own scope and
  // render the fitter-only chrome.
  if (req.orgId && req.impersonation !== true) {
    const scope = await resolveTenantProductScope(req.orgId);
    if (scope === "locked") {
      // Payment wall (migration 0427, env-gated): a self-serve tenant that
      // hasn't paid yet may only reach billing/checkout + account surfaces
      // until their first invoice is paid (the invoice.paid webhook clears
      // the flag). Resolver fails OPEN to "full", so this never fires on a
      // DB hiccup.
      const path = req.originalUrl.split("?")[0] ?? "";
      if (!isLockedAllowedPath(path)) {
        res.status(403).json({
          error: "product_scope_restricted",
          message:
            "Your account is pending payment. Choose a plan and complete payment to unlock your console.",
          productScope: "locked",
        });
        return;
      }
    } else if (scope === "mask_fitter") {
      const path = req.originalUrl.split("?")[0] ?? "";
      if (!isMaskFitterAllowedPath(path)) {
        res.status(403).json({
          error: "product_scope_restricted",
          message:
            "Your plan includes the Virtual Mask Fitter only. Upgrade to unlock the full console.",
          productScope: "mask_fitter",
        });
        return;
      }
    }
  }

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
