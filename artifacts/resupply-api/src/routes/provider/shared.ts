// Shared building blocks for the /api/provider/* tree.
//
//   * providerPortalRateLimiter — the IP-keyed defence-in-depth cap that
//     fronts every provider data route. The /api/provider tree is not
//     covered by the app-level admin/shop limiters, so this is its own
//     limiter (and the gate CodeQL js/missing-rate-limiting recognises —
//     it only credits express-rate-limit, not the custom session/CSRF
//     middleware). 300/15min per IP is well above any honest provider
//     session but well below a scripted flood.
//   * attachProviderOrgId — resolve the TENANT that owns this request's
//     host and pin it onto req.orgId, so the RTM PHI reads (which touch
//     tenant tables carrying org_id: patients / prescriptions /
//     patient_therapy_nights) are scoped to the right tenant rather than
//     the seed org. The legacy e-sign portal reads GLOBAL account/MFA
//     tables and keeps its own seed-org resolution; only the RTM routes
//     need a tenant-scoped req.orgId.

import type { NextFunction, Request, Response } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";

import { resolveSeedOrgId } from "@workspace/resupply-db";

import { requestHost } from "../../lib/request-host";
import { resolveOrgIdByHost } from "../../lib/tenant-branding";

export const providerPortalRateLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

/**
 * Resolve the tenant that owns this request's host and pin it onto
 * req.orgId. A verified custom domain (e.g. a tenant's own provider
 * portal domain) resolves to that tenant; the platform host (and any
 * miss) falls back to the seed org, so single-tenant behaviour is
 * unchanged. Fail-soft to seed org; the downstream RTM routes fail
 * CLOSED (500) only if even the seed org can't be resolved.
 *
 * Mount AFTER requireProvider so it never runs for unauthenticated
 * requests, and BEFORE the RTM data handlers that read req.orgId.
 */
export async function attachProviderOrgId(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const orgId =
    (await resolveOrgIdByHost(requestHost(req))) ??
    (await resolveSeedOrgId().catch(() => null)) ??
    undefined;
  req.orgId = orgId;
  next();
}
