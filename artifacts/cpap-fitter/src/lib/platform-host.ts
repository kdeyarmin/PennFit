// Is the SPA being served on the platform's OWN home host?
//
// CareMetric Breathe is the platform/parent product; its home domain is
// `cmbreathe.com` (with the Railway-generated `*.up.railway.app` host as
// the deploy/preview fallback). A TENANT storefront is reached either
// through a verified custom domain (e.g. `pennpaps.com`) or a
// `<slug>.cmbreathe.com` subdomain — neither of which is the apex.
//
// On the platform home, `/` shows the Breathe marketing + super-admin
// sign-in surface instead of the patient storefront. Everywhere else `/`
// stays the tenant storefront, so single-tenant behavior is unchanged.
//
// Host-only check (no network round-trip) so the root route can decide
// what to render on first paint without a flash. Mirrors the server's
// `platformSubdomainBases()` default of `cmbreathe.com`
// (artifacts/resupply-api/src/lib/tenant-domain.ts).

/** The platform apex host(s). `www.` is stripped before comparison. */
const PLATFORM_APEX_HOSTS: ReadonlySet<string> = new Set(["cmbreathe.com"]);

/**
 * True ONLY for the platform's public production apex (`cmbreathe.com`,
 * with or without `www.`). Unlike {@link isPlatformHomeHost} this
 * deliberately EXCLUDES the Railway `*.up.railway.app` deploy/preview
 * hosts: those serve the same marketing content but must not be indexed
 * by search engines (staging/duplicate content), so only the canonical
 * apex is treated as the indexable home. Used to gate the `noindex` meta
 * on the Breathe marketing pages.
 */
export function isPlatformApexHost(
  hostname: string = typeof window !== "undefined"
    ? window.location.hostname
    : "",
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return PLATFORM_APEX_HOSTS.has(host.replace(/^www\./, ""));
}

/**
 * True when `hostname` is the platform's own home host (the CareMetric
 * Breathe apex or its Railway fallback), false for a tenant storefront
 * host (custom domain or `<slug>.cmbreathe.com` subdomain) and for local
 * dev (`localhost`), which keeps showing the patient storefront.
 */
export function isPlatformHomeHost(
  hostname: string = typeof window !== "undefined"
    ? window.location.hostname
    : "",
): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  const bare = host.replace(/^www\./, "");
  if (PLATFORM_APEX_HOSTS.has(bare)) return true;
  // Tenants never live under up.railway.app, so any such host is the
  // platform's own deploy/preview environment.
  if (bare === "up.railway.app" || bare.endsWith(".up.railway.app")) {
    return true;
  }
  return false;
}
