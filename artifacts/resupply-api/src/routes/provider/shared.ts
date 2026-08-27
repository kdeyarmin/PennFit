// Shared building blocks for the /api/provider/* tree.
//
//   * providerPortalRateLimiter — the IP-keyed defence-in-depth cap that
//     fronts every provider data route. The /api/provider tree is not
//     covered by the app-level admin/shop limiters, so this is its own
//     limiter (and the gate CodeQL js/missing-rate-limiting recognises —
//     it only credits express-rate-limit, not the custom session/CSRF
//     middleware). 300/15min per IP is well above any honest provider
//     session but well below a scripted flood.
//   * resolveProviderTenantOrgId / attachProviderOrgId — resolve the
//     TENANT for PHI list/count/RTM routes. Brand host always wins; on
//     the platform host a session-pinned provider_active_org_id may
//     apply after re-validating an active provider_dme_links row.
//     Never soft-falls to the seed org.

import type { NextFunction, Request, Response } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
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
 * True when the provider has an active DME membership for `orgId`.
 * Uses the seed-scoped raw client (provider_dme_links is keyed by
 * provider_id + org_id — cross-tenant membership, no PHI).
 */
export async function providerHasActiveDmeLink(
  providerId: string,
  orgId: string,
): Promise<boolean> {
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) return false;
  // raw-org-scope-exempt: membership check keyed by session provider_id
  // + candidate org_id (never from the request body alone without the
  // provider gate). Same pattern as GET /api/provider/orgs.
  const { data, error } = await getOrgScopedClient(seedOrgId)
    .raw()
    .schema("resupply")
    .from("provider_dme_links")
    .select("id")
    .eq("provider_id", providerId)
    .eq("org_id", orgId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn(
      { err: error, providerId, orgId },
      "provider DME link membership lookup failed",
    );
    return false;
  }
  return data != null;
}

/**
 * Resolve the tenant for provider PHI list/count/RTM requests.
 *
 * 1. Brand host (verified custom domain / tenant subdomain) always wins.
 * 2. Else session `provider_active_org_id` if the signed-in provider still
 *    has an active `provider_dme_links` row for that org (stale pins clear).
 * 3. Else null — caller returns 403 `provider_tenant_host_required`.
 *    Never seed-org soft-fallback.
 *
 * Mount AFTER requireProvider so `req.providerAccount` /
 * `req.authSessionId` are set when the session-pin path is needed.
 */
export async function resolveProviderTenantOrgId(
  req: Pick<
    Request,
    "headers" | "hostname" | "authSessionId" | "providerAccount"
  >,
): Promise<string | null> {
  const brandOrgId = await resolveBrandOrgIdByHost(requestHost(req));
  if (brandOrgId) return brandOrgId;

  const sessionId = req.authSessionId;
  const account = req.providerAccount;
  if (!sessionId || !account) return null;

  let pinned: string | null = null;
  try {
    const session = await getAuthDeps().repo.findSessionById(sessionId);
    pinned = session?.providerActiveOrgId ?? null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)), sessionId },
      "provider active-org session lookup failed",
    );
    return null;
  }
  if (!pinned) return null;

  const ok = await providerHasActiveDmeLink(account.providerId, pinned);
  if (!ok) {
    try {
      await getAuthDeps().repo.setProviderActiveOrgId(sessionId, null);
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          sessionId,
        },
        "failed to clear stale provider active org",
      );
    }
    return null;
  }
  return pinned;
}

/**
 * Resolve the tenant and pin it onto req.orgId for RTM handlers.
 * Fails CLOSED with 403 `provider_tenant_host_required` when neither a
 * brand host nor a membership-validated session pin is available.
 */
export async function attachProviderOrgId(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const orgId = await resolveProviderTenantOrgId(req);
  if (!orgId) {
    res.status(403).json({ error: "provider_tenant_host_required" });
    return;
  }
  req.orgId = orgId;
  next();
}
