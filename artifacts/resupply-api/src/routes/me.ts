import { Router, type IRouter } from "express";

import { permissionsForRole } from "@workspace/resupply-auth";

import { isFeatureEnabled } from "../lib/feature-flags";
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
  // the console on the next /me refetch. Fail-soft: a lookup blip yields
  // the flag's default (OFF), i.e. branch UI stays hidden.
  const multiLocationEnabled = await isFeatureEnabled("multi_location.enabled");
  res.json({
    userId: req.adminUserId ?? "",
    email: req.adminEmail ?? "",
    role: req.adminRole ?? "admin",
    permissions: permissionsForRole(role),
    // Home branch (multi-location #O1). Drives the SPA's soft default
    // branch filter; null = unassigned (treated as org-wide, no
    // restriction). Not an access gate — the server enforces nothing on
    // this value.
    locationId: req.adminLocationId ?? null,
    multiLocationEnabled,
  });
});

export default router;
