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
//     patient_therapy_nights) are scoped to the right tenant. Uses the
//     brand resolver (null on platform / unbound hosts) and fails CLOSED
//     rather than falling soft to the seed org — otherwise cmbreathe.com
//     / Railway would serve the seed tenant's patient PHI. Providers must
//     hit a verified tenant custom domain (or tenant subdomain).

import type { NextFunction, Request, Response } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";

import { requestHost } from "../../lib/request-host";
import { resolveBrandOrgIdByHost } from "../../lib/tenant-branding";

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
 * portal domain) or tenant subdomain resolves to that tenant. The
 * platform host and unbound domains return 403
 * `provider_tenant_host_required` — never seed-org soft-fallback.
 *
 * Mount AFTER requireProvider so it never runs for unauthenticated
 * requests, and BEFORE the RTM data handlers that read req.orgId.
 */
export async function attachProviderOrgId(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const orgId = await resolveBrandOrgIdByHost(requestHost(req));
  if (!orgId) {
    res.status(403).json({ error: "provider_tenant_host_required" });
    return;
  }
  req.orgId = orgId;
  next();
}
