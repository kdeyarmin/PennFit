// product-scope.ts — resolves a tenant's platform PRODUCT SCOPE from its
// active billing plan (migration 0419).
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
// avoid a per-request DB round-trip. Because this drives an ACCESS
// restriction, the TTL is kept short (matching the feature-flag cache
// posture) so a plan switch — upgrade out of the fitter scope, or downgrade
// into it — takes effect within seconds, not a minute.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "./logger";

export type ProductScope = "full" | "mask_fitter" | "locked";

const CACHE_TTL_MS = 5_000;

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
 * Whether the tenant payment wall is enforced. OFF by default — the
 * `organizations.billing_required` flag (migration 0427) has NO effect until
 * an operator opts in with BILLING_PAYWALL_ENFORCED, so the column can be
 * shipped and backfilled safely before the wall goes live. The operator must
 * have platform Stripe billing configured before enabling it (the
 * `invoice.paid` webhook is what clears the flag); otherwise a flagged tenant
 * has no way to unlock.
 */
function isPaywallEnforced(): boolean {
  const v = process.env.BILLING_PAYWALL_ENFORCED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve the tenant's product scope. Order:
 *   1. "locked" — payment wall (when enforced): a tenant flagged
 *      `billing_required` that hasn't paid yet, restricted to billing +
 *      account surfaces until the `invoice.paid` webhook clears the flag. An
 *      unpaid tenant is locked regardless of which plan they chose.
 *   2. "mask_fitter" — the standalone Virtual Mask Fitter plan.
 *   3. "full" — every other plan, no active subscription, or ANY error.
 *
 * Fails OPEN to "full" on any error (this drives an ACCESS RESTRICTION, so the
 * safe failure is to NOT restrict — a DB hiccup must never lock a tenant out).
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
    // 1. Payment wall (opt-in, env-gated). Checked first — an unpaid tenant is
    // locked regardless of plan. A read error throws into the fail-open catch
    // below, so a hiccup never locks anyone out.
    if (isPaywallEnforced()) {
      const { data: org, error: orgErr } = await getOrgScopedClient(id)
        .raw()
        .schema("resupply")
        .from("organizations")
        .select("billing_required")
        .eq("id", id)
        .maybeSingle();
      if (orgErr) throw orgErr;
      if (
        (org as { billing_required?: boolean } | null)?.billing_required ===
        true
      ) {
        cache.set(id, {
          scope: "locked",
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return "locked";
      }
    }

    // 2. Active subscription → plan.product_scope. PostgREST embeds the
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

/**
 * Resolve the tenant's CURRENT billing plan CODE (e.g. "launch", "growth")
 * from its active subscription — the companion to `resolveTenantProductScope`
 * above, which only needs the coarse `product_scope`. Used by the Control
 * Center "apply recommended preset" action to pick the right feature-flag
 * bundle for the tenant's plan.
 *
 * Returns `null` when the tenant has no active subscription (or on any read
 * error) — the caller treats "no plan" as "no preset to apply" rather than
 * failing. Not cached: this backs an infrequent, explicit admin action, not a
 * per-request hot path.
 */
export async function resolveTenantPlanCode(
  orgId: string | undefined | null,
): Promise<string | null> {
  const id = orgId?.trim();
  if (!id) return null;
  try {
    const { data, error } = await getOrgScopedClient(id)
      .raw()
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select("billing_plans(code)")
      .eq("org_id", id)
      .in("status", ["active", "trialing", "past_due"])
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const code = (
      data as { billing_plans?: { code?: string | null } | null } | null
    )?.billing_plans?.code;
    return code ?? null;
  } catch (err) {
    logger.warn(
      {
        event: "tenant_plan_code_resolve_failed",
        orgId: id,
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "tenant plan code resolve failed; treating as no plan",
    );
    return null;
  }
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
  "/admin/fitter-requests", // fittings waiting for staff to place the order
  // The clinical fitting core. These ARE the product for a fitter-only
  // tenant — the RT review queue, the downloadable fit report, the mask
  // catalog they fit against, and their own formulary.
  //
  // Note the paths: the review queue lives at /admin/fit-sessions rather
  // than the more natural-looking /admin/clinical/fit-sessions precisely
  // so it can be allowlisted here. "/admin/clinical/" is deliberately NOT
  // on this list — it fronts order-joined worklists a fitter-only tenant
  // has no data for — so co-locating the queue there would 403 exactly
  // the customers this plan exists to serve.
  "/admin/fit-sessions",
  "/admin/fitter/catalog",
  "/admin/fitter/formulary",
  "/admin/fitter/safety-screens",
  // The fitter outcome report — acceptance/override/dispense rates. This
  // is the number the product is sold on, and the fitter-only tenants are
  // exactly the customers who ask for it. The EXACT route only: the bare
  // "/admin/analytics" prefix would open every other analytics worklist
  // (substring match), which a fitter-only tenant has no data for.
  "/admin/analytics/fitter-outcomes",
  // Inbound referrals from the provider portal. A fitter-only DME that
  // receives referrals is exactly the customer the portal exists for, so
  // omitting this would 403 them out of their own inbound queue.
  //
  // Deliberately NOT "/admin/referrals": this list is matched by
  // SUBSTRING, so that prefix would also have allowed the unrelated
  // pre-existing "/admin/referrals/scan-attribution" sweep (patient-to-
  // patient attribution) through the fitter-only gate.
  "/admin/provider-referrals",
  // Tenant self-service subscription billing — the SIX exact endpoints the
  // /admin/billing/package page calls (platform-billing-api.ts). NOT the
  // operational claims worklists that also live under /admin/billing/.
  "/admin/billing/package",
  "/admin/billing/plans",
  "/admin/billing/subscription",
  "/admin/billing/addons",
  "/admin/billing/preview",
  "/admin/billing/usage-events",
  // Control Center's backing API. The clinical fitter ships behind
  // `fitter.*` flags the tenant flips themselves once their RT has signed
  // off the size bands they dispense — without this they would have to ask
  // us to enable the product they bought. Flags are per-org config for
  // their OWN org, and a flag for a module this scope cannot reach is
  // inert, so this grants no operational surface.
  "/admin/feature-flags",
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

// ── Admin surface allowlist for the "locked" (unpaid) scope ────────────
// Tighter than the mask_fitter allowlist: an unpaid tenant may ONLY reach the
// surfaces needed to choose a plan + pay and to secure their account — nothing
// operational, and not even the fitter, branding, or staff-seat management
// (those open up once they're paid and on a real scope). Same `includes`
// match against `req.originalUrl` as the mask_fitter gate.
//
// Billing is enumerated, NOT prefixed, for the same reason as the mask_fitter
// list: "/admin/billing/" also fronts the operational claims/revenue-cycle
// suite (incl. PHI-bearing 837P export), which must stay blocked here.
const LOCKED_ALLOWED_PREFIXES: readonly string[] = [
  "/admin/agreements", // onboarding accept screen
  // Tenant self-service subscription billing — the page where they pick a
  // plan and complete payment to unlock. The SAME six the mask_fitter gate
  // allows, plus the hosted "Pay now" Checkout endpoint, never the operational
  // claims worklists under /admin/billing/.
  "/admin/billing/package",
  "/admin/billing/plans",
  "/admin/billing/subscription",
  "/admin/billing/checkout", // hosted Stripe Checkout "Pay now" → unlock
  "/admin/billing/addons",
  "/admin/billing/preview",
  "/admin/billing/usage-events",
  "/admin/mfa", // account security (the MFA banner runs on every admin page)
  "/admin/inbox-counts", // sidebar badge counts (chrome)
];

/**
 * Whether a "locked" (unpaid) tenant may reach `path`. The identity endpoint
 * (`…/me`) is always allowed so the SPA can learn its own scope and render the
 * payment-required state. Pass `req.originalUrl` minus the query string.
 */
export function isLockedAllowedPath(path: string): boolean {
  if (path.endsWith("/me") && !path.includes("/admin/")) return true;
  return LOCKED_ALLOWED_PREFIXES.some((prefix) => path.includes(prefix));
}
