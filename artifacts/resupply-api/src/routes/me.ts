import { Router, type IRouter } from "express";

import { permissionsForRole } from "@workspace/resupply-auth";

import { getPendingAgreementTypes } from "../lib/agreements/status";
import { isFeatureEnabled, listDisabledFeatures } from "../lib/feature-flags";
import { resolveTenantProductScope } from "../lib/product-scope";
import { adminReadRateLimiter } from "../middlewares/admin-rate-limit";
import { requireAdmin } from "../middlewares/requireAdmin";

// /resupply-api/me — admin identity smoke endpoint.
//
// Why this exists:
//   The dashboard needs a single, cheap call after sign-in to ask
//   "am I authorized as an admin on THIS server, what email
//   does the API see for me, and at what privilege level?". That
//   answer drives:
//     - Whether to show the admin UI at all (200 = show, 403 =
//       render the friendly "not authorized" screen).
//     - What email to display in the dashboard chrome ("Signed in as
//       info@pennpaps.com").
//     - Whether to render destructive UI affordances. `role: "agent"`
//       hides/disables Delete buttons so customer-service agents
//       never see a control they cannot use.
//
//   We deliberately do NOT echo the session token, the full
//   auth user object, or the admin allowlist — only the three
//   identifiers the UI legitimately needs to render. Even an attacker
//   who steals a session cookie should learn nothing from /me beyond
//   what they already know (their own email + the auth provider id + role).
//
// Auth:
//   `requireAdmin` runs first. By the time the handler executes,
//   it has already proven:
//     1. There is a valid session (else 401),
//     2. The session's primary email is verified (else 403),
//     3. The email is on the admin OR agent allowlist (else 403),
//   AND attached `adminEmail`, `adminUserId`, `adminRole`, and
//   `adminGranularRole` to `req`. The handler itself never reaches the
//   auth provider and never re-validates.
//
// `permissions`:
//   The granular RBAC keys the caller's role carries (derived from
//   `adminGranularRole` via the catalog in resupply-auth/rbac.ts). The
//   admin SPA reads this to hide nav entries the role can't use — e.g.
//   the super-admin-only System Configuration page is gated on
//   `system.config.manage`, which only super_admin holds. The set is
//   non-sensitive (it's a list of action names, not a grant of access
//   — the server still enforces every gate); surfacing it just keeps
//   the UI from showing controls that would 403.

const router: IRouter = Router();

router.get("/me", adminReadRateLimiter, requireAdmin, async (req, res) => {
  // All fields are guaranteed to be set by requireAdmin on the success
  // path; the `??` is a belt-and-braces guard so a future refactor that
  // breaks that contract surfaces as an empty string / "admin" default
  // (which the dashboard will treat as a hard error in the email case,
  // and a safe default in the role case) rather than as `undefined`
  // serialized to `null`.
  const role = req.adminGranularRole ?? req.adminRole ?? "admin";
  // Whether the multi-branch feature is turned on for this company
  // (Control Center flag, seeded OFF). The SPA reads this to show/hide
  // the entire branch UI — Locations page, branch pickers, list filter.
  // Cached ~5s in isFeatureEnabled; a flip in the Control Center reaches
  // the console on the next /me refetch. In production the lookup fails closed
  // (returns false) on DB errors, so branch UI stays hidden during outages.
  const multiLocationEnabled = await isFeatureEnabled(
    "multi_location.enabled",
    req.orgId,
  );
  // Onboarding agreements gate (G16). The required agreements (BAA +
  // platform terms) this tenant hasn't yet signed at the current version.
  // The SPA blocks the console with an accept screen until this is empty.
  // Fails closed (all required types pending) when the tenant context or
  // DB lookup is unavailable — an unsigned tenant must never slip through.
  const pendingAgreements = await getPendingAgreementTypes(req.orgId);
  // Platform product scope from the tenant's active billing plan (migration
  // 0419). "mask_fitter" = the standalone Virtual Mask Fitter plan; the SPA
  // reads this to render the fitter-only nav + redirect away from console
  // pages the backend would 403. "full" for every normal whole-suite
  // tenant. Impersonation sessions resolve to "full" upstream so support
  // staff see the entire console of a scoped tenant.
  const productScope = req.impersonation
    ? "full"
    : await resolveTenantProductScope(req.orgId);
  // App modules + every other flag this tenant has switched OFF. The SPA
  // subtracts these from the sidebar so an operator only navigates the
  // parts of the product they actually use (`module.*`), and so a page
  // whose feature is off stops advertising itself. Purely presentational
  // — the server-side permission gates are unchanged, and the lookup
  // reports NOTHING disabled if it can't read the table, so a DB blip
  // shows the full console rather than an empty one.
  const disabledFeatures = await listDisabledFeatures(req.orgId);
  res.json({
    userId: req.adminUserId ?? "",
    email: req.adminEmail ?? "",
    role: req.adminRole ?? "admin",
    permissions: permissionsForRole(role),
    productScope,
    // Home branch (multi-location #O1). Drives the SPA's soft default
    // branch filter; null = unassigned (treated as org-wide, no
    // restriction). Not an access gate — the server enforces nothing on
    // this value.
    locationId: req.adminLocationId ?? null,
    multiLocationEnabled,
    // Platform-admin impersonation (G4). True when this admin session is a
    // platform super-admin acting AS a tenant; `orgId` is then the
    // impersonated tenant. The SPA reads this to render the persistent
    // "you are impersonating — stop" banner. NULL/false for every normal
    // tenant-admin session.
    impersonation: req.impersonation === true,
    impersonatedOrgId: req.impersonation === true ? (req.orgId ?? null) : null,
    pendingAgreements,
    disabledFeatures,
  });
});

export default router;
