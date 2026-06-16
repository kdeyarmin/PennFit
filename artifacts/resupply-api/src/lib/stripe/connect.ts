// Stripe Connect — per-tenant connected-account resolution (G5).
//
// Phase 2 routes each tenant's charges to THEIR OWN Stripe account. The
// platform `STRIPE_SECRET_KEY` stays the API credential; the connected
// account id (`organizations.stripe_account_id`, migration 0359) selects
// whose books a Checkout session / PaymentIntent lands in, via the Stripe
// SDK's per-request `{ stripeAccount }` option (the `Stripe-Account`
// header).
//
// Two directions:
//   * OUTBOUND — `stripeAccountRequestOptions(orgId)` returns the
//     `{ stripeAccount }` request option for a tenant that has a connected
//     account, or `{}` (platform account) otherwise. NULL account →
//     current single-tenant behavior, unchanged.
//   * INBOUND — `resolveOrgIdByConnectedAccount(accountId)` reverse-maps a
//     webhook event's `account` back to its owning tenant so Connect
//     events land in the right `org_id`.
//
// The `organizations` directory is GLOBAL, so it's read through the
// `.raw()` escape hatch (the org-scoped facade would wrongly filter the
// tenant directory to one org). Both directions are cached briefly so the
// per-charge / per-webhook lookup doesn't hit PostgREST every time;
// `invalidateStripeConnectCache()` drops the cache after an operator
// changes a tenant's account binding.

import type Stripe from "stripe";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../logger";

// Short TTL: a connected-account binding changes rarely (operator action),
// so a minute of staleness is fine and keeps the charge path cheap.
const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// orgId → connected account id (or null when the tenant has none).
const byOrg = new Map<string, CacheEntry<string | null>>();
// connected account id → owning orgId (or null when unknown).
const byAccount = new Map<string, CacheEntry<string | null>>();

/** Drop all cached bindings (call after changing a tenant's account id). */
export function invalidateStripeConnectCache(): void {
  byOrg.clear();
  byAccount.clear();
}

/** Internal: an unscoped Supabase client for the global org directory. */
async function rawOrgClient() {
  // Any org id yields the same unscoped `.raw()` client; the seed id is a
  // convenient, always-present handle. A missing seed org means the DB is
  // unreachable → callers treat a thrown/empty result as "no account".
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) return null;
  return getOrgScopedClient(seedOrgId).raw();
}

/**
 * The tenant's connected Stripe account id, or `null` when it has none
 * (→ charges run on the platform account, as today). Fails soft: any
 * lookup error resolves to `null` so a transient DB blip never blocks a
 * charge — it just routes to the platform account, never the WRONG one.
 */
export async function getConnectedAccountId(
  orgId: string,
): Promise<string | null> {
  const now = Date.now();
  const cached = byOrg.get(orgId);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: string | null = null;
  try {
    const raw = await rawOrgClient();
    if (raw) {
      const { data, error } = await raw
        .schema("resupply")
        .from("organizations")
        .select("stripe_account_id, stripe_charges_enabled")
        .eq("id", orgId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const row = data as {
        stripe_account_id: string | null;
        stripe_charges_enabled: boolean | null;
      } | null;
      // Only route charges to the connected account once Stripe onboarding
      // has completed (charges_enabled, flipped by the account.updated
      // webhook). A created-but-not-yet-onboarded account can't accept
      // charges, so it stays on the platform account until then.
      value =
        row?.stripe_account_id && row.stripe_charges_enabled === true
          ? row.stripe_account_id
          : null;
    }
  } catch (err) {
    logger.warn(
      { event: "stripe_connect_account_lookup_failed", err, orgId },
      "stripe-connect: connected-account lookup failed; using platform account",
    );
    value = null;
  }

  byOrg.set(orgId, { value, expiresAt: now + CACHE_TTL_MS });
  if (value)
    byAccount.set(value, { value: orgId, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Stripe SDK per-request options for a tenant: `{ stripeAccount }` when it
 * has a connected account, otherwise an empty object (platform account).
 * Pass as the SECOND argument to `stripe.checkout.sessions.create(...)` /
 * `stripe.paymentIntents.create(...)`.
 *
 * Accepts `undefined` (the type of `req.orgId` before a tenant is
 * resolved) and treats a missing tenant context the same as "no connected
 * account" → the platform account. Fail-soft: never routes money to the
 * wrong account on a missing/unknown org.
 */
export async function stripeAccountRequestOptions(
  orgId: string | undefined,
): Promise<Stripe.RequestOptions> {
  // Treat a blank / whitespace-only orgId the same as missing tenant
  // context (org ids are non-empty after trimming, per getOrgScopedClient)
  // so we skip a pointless directory lookup and don't cache under an
  // invalid key.
  if (!orgId || !orgId.trim()) return {};
  const accountId = await getConnectedAccountId(orgId);
  return accountId ? { stripeAccount: accountId } : {};
}

/**
 * Reverse lookup for inbound webhooks: the `org_id` that owns a Connect
 * event's `account`, or `null` when no tenant is bound to it. The unique
 * partial index `organizations_stripe_account_id_key` guarantees at most
 * one match. Fails soft to `null` (caller falls back to the seed org).
 */
export async function resolveOrgIdByConnectedAccount(
  accountId: string,
): Promise<string | null> {
  const now = Date.now();
  const cached = byAccount.get(accountId);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: string | null = null;
  try {
    const raw = await rawOrgClient();
    if (raw) {
      const { data, error } = await raw
        .schema("resupply")
        .from("organizations")
        .select("id")
        .eq("stripe_account_id", accountId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      value = (data as { id: string } | null)?.id ?? null;
    }
  } catch (err) {
    logger.warn(
      { event: "stripe_connect_org_lookup_failed", err },
      "stripe-connect: org-by-account lookup failed",
    );
    value = null;
  }

  byAccount.set(accountId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Bind a tenant to a freshly-created connected account (G5 onboarding).
 * Stores the `acct_…` id but leaves `stripe_charges_enabled` false until
 * Stripe's `account.updated` webhook confirms onboarding is complete — so
 * creating the account never starts routing charges to it. Invalidates the
 * caches so the next resolve sees the new binding.
 */
export async function setConnectedAccountId(
  orgId: string,
  accountId: string,
): Promise<void> {
  const raw = await rawOrgClient();
  if (!raw) throw new Error("stripe-connect: tenant directory unavailable");
  const { error } = await raw
    .schema("resupply")
    .from("organizations")
    .update({ stripe_account_id: accountId })
    .eq("id", orgId);
  if (error) throw error;
  invalidateStripeConnectCache();
}

/**
 * Flip a tenant's `stripe_charges_enabled` to match Stripe's
 * `account.updated` report (G5). Resolves the org by connected account id;
 * a no-op when no tenant is bound to it. Invalidates the caches so the
 * routing resolver sees the change immediately. Fails soft (logs) — a
 * missed flip is recovered on the next account.updated delivery.
 */
export async function setChargesEnabledByAccount(
  accountId: string,
  enabled: boolean,
): Promise<void> {
  try {
    const raw = await rawOrgClient();
    if (!raw) return;
    const { error } = await raw
      .schema("resupply")
      .from("organizations")
      .update({ stripe_charges_enabled: enabled })
      .eq("stripe_account_id", accountId);
    if (error) throw error;
    invalidateStripeConnectCache();
  } catch (err) {
    logger.warn(
      { event: "stripe_connect_charges_enabled_update_failed", err },
      "stripe-connect: charges_enabled update failed",
    );
  }
}
