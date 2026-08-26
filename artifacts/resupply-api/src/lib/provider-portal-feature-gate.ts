// Runtime feature gate for the provider e-signature DATA routes
// (/api/provider/* except /api/provider/auth/*).
//
// Extracted from app.ts so it can be unit-tested in isolation without
// importing the full app singleton. Mounted in app.ts in front of the
// provider portal router.
//
// Staged-rollout design: the AUTH surface (/api/provider/auth/*) stays
// reachable while the flag is OFF so invited providers can sign in /
// enroll MFA before launch — only the queue/sign/decline DATA surface
// stays dark. The gate is a no-op for any non-/api/provider path so it
// is safe to mount app-wide.

import type { NextFunction, Request, Response } from "express";

import { isFeatureEnabled } from "./feature-flags";
import { requestHost } from "./request-host";
import { resolveOrgIdByHost } from "./tenant-branding";

/**
 * Fail closed (404) when `provider.portal_enabled` is OFF for the tenant
 * the request's host resolves to. Resolves the flag against the SAME org
 * the provider DATA routes scope their reads to (the host-resolved org,
 * which `resolveOrgIdByHost` fails soft to the seed org for) so the
 * rollout gate and the data scope stay aligned per tenant — otherwise a
 * non-seed tenant would be mis-gated (its providers 404 on a flag only
 * OFF for the seed org, or vice-versa).
 *
 * `resolveOrgIdByHost` already fails soft to the seed org, so on the
 * platform host / single-tenant deployments this passes the seed org (via
 * `?? undefined`, which lets `isFeatureEnabled` apply its own seed
 * fallback) — byte-for-byte unchanged from the historical seed-org gate.
 */
export async function providerPortalFeatureGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.path.startsWith("/api/provider")) {
    next();
    return;
  }
  if (
    req.path === "/api/provider/auth" ||
    req.path.startsWith("/api/provider/auth/")
  ) {
    next();
    return;
  }
  // Pre-launch onboarding: identity + MFA enrollment must work while the
  // flag is OFF so invited providers can sign in and set up TOTP before
  // queue/sign/decline routes go live.
  if (
    req.path === "/api/provider/me" ||
    req.path === "/api/provider/mfa" ||
    req.path.startsWith("/api/provider/mfa/")
  ) {
    next();
    return;
  }
  const orgId = (await resolveOrgIdByHost(requestHost(req))) ?? undefined;
  if (!(await isFeatureEnabled("provider.portal_enabled", orgId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}
