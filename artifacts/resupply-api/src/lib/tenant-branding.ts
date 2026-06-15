// Per-tenant storefront branding resolver.
//
// Answers "which tenant — and which storefront name / tagline / logo —
// does a request on THIS host belong to". The public storefront calls
// GET /api/storefront-branding on first paint; the SPA then renders the
// resolving tenant's brand instead of the hardcoded PennPaps identity.
//
// Resolution:
//   * A request whose Host matches a VERIFIED custom domain resolves to
//     that tenant's branding.
//   * Everything else (the platform host, an unverified/none domain, any
//     miss or error) resolves to the SEED tenant's branding — i.e. the
//     site looks exactly as it does today.
//
// Posture mirrors lib/company-info.ts:
//   * Fail-soft — a Supabase error/timeout degrades to the seed/default
//     brand; this must never take the public storefront down.
//   * Cached for a short TTL so the unauthenticated, per-page branding
//     fetch adds no meaningful DB load.

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "./logger";
import { normalizeCustomDomain } from "./tenant-domain";

export interface StorefrontBranding {
  /** Short customer-facing brand shown in the header/hero (e.g. "PennPaps"). */
  storefrontName: string;
  /** Registered/legal company name (footer, "by …" line). */
  legalName: string;
  /** One-line storefront strapline. */
  tagline: string;
  /** Public URL of the tenant's logo, or null to use the bundled default. */
  logoUrl: string | null;
}

// Historical PennPaps identity — byte-identical to what the SPA shipped
// hardcoded, so an unseeded / unmatched host renders exactly as before.
export const DEFAULT_BRANDING: StorefrontBranding = {
  storefrontName: "PennPaps",
  legalName: "Penn Home Medical Supply",
  tagline: "Your CPAP, made simple. Fit. Shop. Resupply.",
  logoUrl: null,
};

const SEED_ORG_SLUG = "penn-home-medical";
const CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;
const VERIFIED_DOMAINS_TTL_MS = 60_000;

type OrgBrandingColumns = {
  name: string | null;
  storefront_name: string | null;
  tagline: string | null;
  logo_url: string | null;
};

function trimmed(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function mapBranding(row: OrgBrandingColumns | null): StorefrontBranding {
  if (!row) return DEFAULT_BRANDING;
  const legalName = trimmed(row.name) || DEFAULT_BRANDING.legalName;
  return {
    storefrontName: trimmed(row.storefront_name) || legalName,
    legalName,
    tagline: trimmed(row.tagline) || DEFAULT_BRANDING.tagline,
    logoUrl: trimmed(row.logo_url) || null,
  };
}

class BrandingLookupTimeout extends Error {
  constructor() {
    super("branding_lookup_timeout");
    this.name = "BrandingLookupTimeout";
  }
}

async function withTimeout<T>(p: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BrandingLookupTimeout()),
      LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────
// Branding cache, keyed by normalized host ("" = seed/default).
// ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  branding: StorefrontBranding;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

async function loadSeedBranding(): Promise<StorefrontBranding> {
  const orgId = await resolveSeedOrgId();
  if (!orgId) throw new Error("tenant context missing");
  // The `organizations` directory is the GLOBAL tenant table (keyed by
  // id = the tenant); reach it via `.raw()` so the org-scoped facade
  // doesn't wrongly append an org_id filter.
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await withTimeout(
    supabase
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("name, storefront_name, tagline, logo_url")
      .eq("slug", SEED_ORG_SLUG)
      .limit(1)
      .maybeSingle(),
  );
  if (error) throw error;
  return mapBranding(data);
}

async function loadBrandingForHost(host: string): Promise<StorefrontBranding> {
  const normalized = normalizeCustomDomain(host);
  if (!normalized) return loadSeedBranding();

  const orgId = await resolveSeedOrgId();
  if (!orgId) throw new Error("tenant context missing");
  // GLOBAL `organizations` directory — reach via `.raw()` (see loadSeedBranding).
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await withTimeout(
    supabase
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("name, storefront_name, tagline, logo_url")
      .eq("custom_domain", normalized)
      .eq("custom_domain_status", "verified")
      .eq("status", "active")
      .limit(1)
      .maybeSingle(),
  );
  if (error) throw error;
  // No verified tenant on this host → the default site (seed brand).
  if (!data) return loadSeedBranding();
  return mapBranding(data);
}

/**
 * The effective storefront branding for a request host. Cached ~60s per
 * host; never throws (any failure degrades to the seed/default brand).
 */
export async function resolveBrandingByHost(
  host: string | undefined,
): Promise<StorefrontBranding> {
  const key = normalizeCustomDomain(host ?? "") ?? "";
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.branding;

  let branding: StorefrontBranding;
  try {
    branding = key ? await loadBrandingForHost(key) : await loadSeedBranding();
  } catch (err) {
    const normalized =
      err instanceof Error ? err : new Error(String(err ?? "unknown"));
    logger.warn(
      { event: "tenant_branding_load_failed", err: normalized },
      "tenant branding load failed; falling back to default brand",
    );
    branding = DEFAULT_BRANDING;
  }
  cache.set(key, { branding, expiresAt: now + CACHE_TTL_MS });
  return branding;
}

/** Drop the branding cache so an admin save is visible on the next read. */
export function invalidateBrandingCache(): void {
  cache.clear();
}

// ────────────────────────────────────────────────────────────────────
// Verified-custom-domain set — consumed by the CORS allowlist so a
// tenant's own domain is an accepted Origin without a redeploy.
// ────────────────────────────────────────────────────────────────────

let verifiedDomains = new Set<string>();
let verifiedDomainsExpiresAt = 0;
let verifiedRefreshInFlight: Promise<void> | null = null;

async function reloadVerifiedDomains(): Promise<void> {
  try {
    const orgId = await resolveSeedOrgId();
    if (!orgId) throw new Error("tenant context missing");
    // GLOBAL `organizations` directory — reach via `.raw()` (see loadSeedBranding).
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await withTimeout(
      supabase
        .raw()
        .schema("resupply")
        .from("organizations")
        .select("custom_domain")
        .eq("custom_domain_status", "verified")
        .eq("status", "active"),
    );
    if (error) throw error;
    const next = new Set<string>();
    for (const row of data ?? []) {
      const d = trimmed(row.custom_domain);
      if (d) next.add(d);
    }
    verifiedDomains = next;
    verifiedDomainsExpiresAt = Date.now() + VERIFIED_DOMAINS_TTL_MS;
  } catch (err) {
    // Keep the last-known set; just back off the retry window so a flaky
    // DB doesn't hammer on every request.
    verifiedDomainsExpiresAt = Date.now() + 5_000;
    logger.warn(
      {
        event: "verified_domains_reload_failed",
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "verified custom-domain reload failed; keeping last-known set",
    );
  }
}

function kickVerifiedDomainsRefresh(): void {
  if (verifiedRefreshInFlight) return;
  verifiedRefreshInFlight = reloadVerifiedDomains().finally(() => {
    verifiedRefreshInFlight = null;
  });
}

/**
 * Synchronously report whether an Origin is a verified custom domain.
 * Backed by a cached set refreshed in the background — the CORS callback
 * must stay sync, so a cold/stale cache triggers a refresh for NEXT time
 * and answers from the last-known set now. Force a refresh right after a
 * verify with `refreshVerifiedCustomDomains()`.
 */
export function isVerifiedCustomDomainOrigin(origin: string): boolean {
  if (Date.now() >= verifiedDomainsExpiresAt) kickVerifiedDomainsRefresh();
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return verifiedDomains.has(host);
}

/** Force-refresh the verified-domain set (call after a domain verifies). */
export async function refreshVerifiedCustomDomains(): Promise<void> {
  await reloadVerifiedDomains();
}

/** Warm the verified-domain cache at boot (fire-and-forget). */
export function warmVerifiedCustomDomains(): void {
  kickVerifiedDomainsRefresh();
}

/** Test-only: reset all module caches between cases. */
export function __resetTenantBrandingForTests(): void {
  cache.clear();
  verifiedDomains = new Set<string>();
  verifiedDomainsExpiresAt = 0;
  verifiedRefreshInFlight = null;
}
