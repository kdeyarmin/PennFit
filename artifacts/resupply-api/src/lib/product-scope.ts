// product-scope.ts — resolves a tenant's platform PRODUCT SCOPE from its
// active billing plan (migration 0418).
//
// A scope of "mask_fitter" means the tenant subscribed to the standalone
// Virtual Mask Fitter plan: their console + API are gated down to the
// fitter surfaces (send a fitting link → get the recommended mask + size
// back) and account essentials. Every other plan — and every tenant with
// no active subscription — resolves to "full", the normal whole-suite
// experience.
//
// Posture — fail OPEN to "full". This drives an ACCESS RESTRICTION, so the
// safe failure is to NOT restrict: a DB hiccup, a missing tenant context,
// or an unknown plan must never lock a paying tenant out of their console.
// Only an explicit, successfully-read "mask_fitter" plan scopes a tenant
// down. Resolved on EVERY admin request (requireAdmin), so it's cached to
// avoid a per-request DB round-trip. A tenant's plan scope is near-static
// (it changes only on a deliberate plan switch), so the cache runs longer
// than the feature-flag cache; a plan switch takes effect within the TTL.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "./logger";

export type ProductScope = "full" | "mask_fitter";

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  scope: ProductScope;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: drop the in-memory cache so a seeded plan change is seen
 *  immediately instead of waiting out the TTL. */
export function __clearProductScopeCacheForTests(): void {
  cache.clear();
}

/**
 * Resolve the tenant's product scope from its active billing subscription's
 * plan. Returns "full" for any plan that isn't the standalone fitter plan,
 * for tenants with no active subscription, and on ANY error (fail open).
 */
export async function resolveTenantProductScope(
  orgId: string | undefined | null,
): Promise<ProductScope> {
  const id = orgId?.trim();
  if (!id) return "full"; // no tenant context → never over-restrict

  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;

  let scope: ProductScope = "full";
  try {
    // Active subscription → plan.product_scope. PostgREST embeds the
    // referenced plan via the plan_id FK. "active"/"trialing"/"past_due"
    // are the live states (a canceled sub leaves the tenant on "full").
    const { data, error } = await getOrgScopedClient(id)
      .raw()
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select("billing_plans(product_scope)")
      .eq("org_id", id)
      .in("status", ["active", "trialing", "past_due"])
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const planScope = (
      data as {
        billing_plans?: { product_scope?: string | null } | null;
      } | null
    )?.billing_plans?.product_scope;
    if (planScope === "mask_fitter") scope = "mask_fitter";
  } catch (err) {
    logger.warn(
      {
        event: "tenant_product_scope_resolve_failed",
        orgId: id,
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "product scope resolve failed; defaulting to full (fail open)",
    );
    scope = "full";
  }

  cache.set(id, { scope, expiresAt: Date.now() + CACHE_TTL_MS });
  return scope;
}

// ── Admin surface allowlist for the mask_fitter scope ──────────────────
// Substrings a fitter-only tenant's request path MAY contain. Everything
// else under the admin API 403s. Matched against `req.originalUrl` (which
// carries the app base path, e.g. "/resupply-api/admin/fitter-invites"),
// so we test with `includes` exactly like the agreements gate in
// requireAdmin.
//
// Kept deliberately tight: the fitter itself, the fitter funnel, the
// tenant's own SUBSCRIPTION billing, account security, branding, staff
// seats, and the shell chrome the allowed pages need — but NONE of the
// operational modules (patients, orders, shop, conversations, campaigns,
// claims, analytics, therapy…).
//
// IMPORTANT — billing is enumerated, NOT prefixed. The tenant's
// self-service subscription endpoints (these six) share the "/admin/billing/"
// prefix with the ENTIRE operational claims / revenue-cycle suite
// (denials-worklist, era-ingest, claims/export-837p, statements/*,
// prior-auth-queue, eligibility-*, …). Allowing the bare "/admin/billing"
// prefix would expose all of that — including PHI-bearing 837P claim export
// — to a tenant that only bought the fitter. So we list the exact six.
const MASK_FITTER_ALLOWED_PREFIXES: readonly string[] = [
  "/admin/agreements", // onboarding accept screen (also exempted upstream)
  "/admin/fitter-invites", // THE product: send links, review results/sizes
  "/admin/fitter-leads", // fitter funnel / prospects
  // Tenant self-service subscription billing — the SIX exact endpoints the
  // /admin/billing/package page calls (platform-billing-api.ts). NOT the
  // operational claims worklists that also live under /admin/billing/.
  "/admin/billing/package",
  "/admin/billing/plans",
  "/admin/billing/subscription",
  "/admin/billing/addons",
  "/admin/billing/preview",
  "/admin/billing/usage-events",
  "/admin/storefront-branding", // brand the fitting link
  "/admin/mfa", // account security: the MFA banner runs on every admin page
  "/admin/team", // manage their own staff seats
  "/admin/inbox-counts", // sidebar badge counts (chrome)
];

/**
 * Whether a mask_fitter-scoped tenant may reach `path`. The identity
 * endpoint (`…/me`) is always allowed (the SPA needs it to even learn its
 * own scope) — guarded so it matches the top-level `/me` and not an admin
 * sub-route that merely ends in `/me` (e.g. /admin/agent-availability/me).
 * Pass `req.originalUrl` minus the query string.
 */
export function isMaskFitterAllowedPath(path: string): boolean {
  if (path.endsWith("/me") && !path.includes("/admin/")) return true;
  return MASK_FITTER_ALLOWED_PREFIXES.some((prefix) => path.includes(prefix));
}
