// Host-aware sitemap + robots. One SPA bundle is served to every host, so
// `/sitemap.xml` and `/robots.txt` must be resolved per request — a static
// file cannot be correct for more than one of them.
//
// Three host classes, dispatched in app.ts ahead of express.static:
//
//   1. Platform apex (cmbreathe.com) — the CareMetric Breathe marketing
//      site. Gets the generated /breathe sitemap below. Mirrors the
//      frontend `isPlatformApexHost()` noindex gate
//      (cpap-fitter/src/lib/platform-host.ts).
//
//   2. Platform deploy/preview hosts (*.up.railway.app) — the same content
//      on a non-canonical hostname, i.e. duplicate content. The SPA already
//      marks these `noindex`; robots.txt says `Disallow: /` to match and no
//      sitemap is served.
//
//   3. Everything else — a TENANT storefront, reached through a verified
//      custom domain (pennpaps.com) or a <slug>.cmbreathe.com subdomain.
//      Served the hand-maintained public/sitemap.xml and public/robots.txt
//      with every URL rewritten to the requesting host's own origin.
//
// Why (3) rewrites rather than serving the file as-is: the static files are
// checked in with one tenant's domain baked into them (they predate
// multi-tenancy). Served verbatim, the SECOND tenant's domain would publish
// the FIRST tenant's URLs and advertise `Sitemap: https://<other-tenant>/
// sitemap.xml` — a cross-domain sitemap that search engines discard, and a
// brand leak between competitors on one platform. Rewriting the origin makes
// each host authoritative for itself while keeping public/sitemap.xml the
// single hand-maintained source of the PATH list (guarded against route
// drift by cpap-fitter/src/sitemap.drift.test.ts).

/** The canonical platform apex host (mirrors platform-host.ts on the SPA). */
export const PLATFORM_APEX_HOST = "cmbreathe.com";
export const PLATFORM_APEX_ORIGIN = `https://${PLATFORM_APEX_HOST}`;

// The crawlable Breathe marketing routes. MUST stay in lockstep with the
// `/breathe/*` routes in cpap-fitter/src/App.tsx — the drift test in
// platform-sitemap.test.ts fails if a route is added/removed without
// updating this list.
export const BREATHE_SITEMAP_PATHS: readonly string[] = [
  "/breathe",
  "/breathe/product",
  "/breathe/integrations",
  "/breathe/why",
  "/breathe/compare",
  "/breathe/features",
  "/breathe/resupply-engine",
  "/breathe/mask-fitting",
  "/breathe/ai-voice",
  "/breathe/communications",
  "/breathe/get-paid",
  "/breathe/clinical",
  "/breathe/patient-experience",
  "/breathe/analytics",
  "/breathe/roi",
  "/breathe/pricing",
  "/breathe/security",
  "/breathe/compliance",
  "/breathe/multi-location",
  "/breathe/case-studies",
  "/breathe/faq",
  "/breathe/switch/brightree",
  "/breathe/switch/bonafide",
  "/breathe/switch/nikohealth",
  "/breathe/switch/sleepglad",
  "/breathe/signup",
];

/**
 * True only for the canonical platform apex (`cmbreathe.com`, with or without
 * a `www.` prefix or a port). Tenant custom domains (`pennpaps.com`), tenant
 * subdomains (`acme.cmbreathe.com`), the Railway preview host, and localhost
 * all return false so they keep serving the static tenant files.
 */
export function isPlatformApexHost(host: string | null | undefined): boolean {
  const bare = (host ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  return bare === PLATFORM_APEX_HOST;
}

/** XML-escape the five characters that are unsafe in element text. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build the Breathe `sitemap.xml` body for the given canonical origin. */
export function buildBreatheSitemapXml(origin = PLATFORM_APEX_ORIGIN): string {
  const urls = BREATHE_SITEMAP_PATHS.map(
    (p) => `  <url><loc>${escapeXml(`${origin}${p}`)}</loc></url>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Build the platform-apex `robots.txt`. Allows the marketing crawl, blocks
 * the gated app surfaces, and (the SEO point of this whole module) advertises
 * the sitemap so crawlers discover it without a Search Console submission.
 */
export function buildPlatformRobotsTxt(origin = PLATFORM_APEX_ORIGIN): string {
  return [
    "# CareMetric Breathe — platform apex robots.txt",
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /platform",
    "Disallow: /account",
    "Disallow: /sign-in",
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Host class 2 + 3: preview hosts and tenant storefronts.
// ────────────────────────────────────────────────────────────────────

/**
 * True for the platform's own Railway deploy/preview hostnames. A tenant can
 * never claim one — `normalizeCustomDomain` rejects `*.up.railway.app`
 * outright (tenant-domain.ts) — so any such host is the platform serving
 * duplicate content on a non-canonical name.
 */
export function isPlatformPreviewHost(
  host: string | null | undefined,
): boolean {
  const bare = (host ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  return bare === "up.railway.app" || bare.endsWith(".up.railway.app");
}

/**
 * `robots.txt` for a platform-owned host that must not be indexed.
 *
 * Counter-intuitively this ALLOWS crawling. `Disallow: /` would be the
 * obvious choice and is the wrong one: a crawler that is forbidden to fetch
 * the page can never see that the page says noindex, so a preview URL that
 * was already discovered stays in the index as a bare URL-only result.
 * Google is explicit that a page carrying noindex has to remain crawlable
 * for the directive to be honoured.
 *
 * So: let them in, and make sure what they find says noindex. The SPA's
 * `useNoIndexExceptApex` hook sets the meta tag, and `securityHeaders`
 * serves `X-Robots-Tag: noindex` on these hosts so the directive does not
 * depend on the crawler executing JavaScript. No sitemap is advertised —
 * being crawlable is not the same as being promoted.
 */
export function buildNoindexRobotsTxt(): string {
  return [
    "# Non-canonical deploy host — crawlable on purpose, but not indexed.",
    "# Crawling stays open so the noindex directive (meta tag + the",
    "# X-Robots-Tag response header) can actually be read; blocking the",
    "# fetch would strand an already-discovered URL in the index.",
    `# The canonical platform site is ${PLATFORM_APEX_ORIGIN}.`,
    "User-agent: *",
    "Allow: /",
    "",
  ].join("\n");
}

/**
 * A `scheme://host` origin for the request, or null when the host is missing
 * or not shaped like a hostname.
 *
 * The host is attacker-influenced in principle (it is read from `Host` /
 * `X-Forwarded-Host`), so it is validated here rather than interpolated
 * blindly into XML. `requestHost()` has already gated `X-Forwarded-Host` on
 * the trusted-proxy chain and stripped any port. Returning null makes the
 * caller fall through to the static file instead of emitting a document
 * built from a junk host.
 *
 * A forged host can at worst make THAT response advertise itself, which is
 * the same thing the crawler already believes by having fetched it there —
 * no other host's content is affected.
 */
export function resolvePublicOrigin(
  host: string | null | undefined,
  protocol: string,
): string | null {
  const bare = (host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!bare) return null;
  // Hostname shape only: letters/digits/dots/hyphens, at least one dot or
  // the bare `localhost`. Anything with a slash, space, quote, or angle
  // bracket (i.e. anything that could break out of an XML text node or a
  // robots directive) is rejected.
  const looksLikeHost =
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(bare) &&
    (bare.includes(".") || bare === "localhost");
  if (!looksLikeHost) return null;

  // Public hosts are always https. These origins become canonical URLs in a
  // sitemap, and every production hostname is HTTPS-only (securityHeaders'
  // HSTS, and preflight:prod rejects non-HTTPS public URLs) — so deriving the
  // scheme from `req.protocol` would only ever be a liability: a trust-proxy
  // misconfiguration that left `X-Forwarded-Proto` unread would publish a
  // whole sitemap of `http://` URLs to search engines. Loopback dev hosts are
  // the one case where http is real, and there `protocol` decides.
  const isLoopback =
    bare === "localhost" || bare === "127.0.0.1" || bare.endsWith(".localhost");
  const scheme = isLoopback && protocol !== "https" ? "http" : "https";
  return `${scheme}://${bare}`;
}

/**
 * Rewrite every `<loc>` in a sitemap document so its origin is `origin`,
 * preserving each URL's path/query and the rest of the document (comments,
 * `changefreq`, `priority`) byte for byte.
 *
 * A `<loc>` that isn't an absolute URL is left alone — better to ship the
 * author's literal text than to silently drop a route from the sitemap.
 */
export function rewriteSitemapOrigin(xml: string, origin: string): string {
  return xml.replace(/<loc>([^<]*)<\/loc>/g, (whole, raw: string) => {
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      return whole;
    }
    return `<loc>${escapeXml(`${origin}${parsed.pathname}${parsed.search}`)}</loc>`;
  });
}

/**
 * Point a `robots.txt`'s `Sitemap:` directive at `origin`. Every other line
 * (the `Disallow` list, which is host-independent) is preserved. A file with
 * no `Sitemap:` line gains one, so the directive can't go missing.
 */
export function rewriteRobotsSitemapUrl(txt: string, origin: string): string {
  const sitemapLine = `Sitemap: ${origin}/sitemap.xml`;
  let replaced = false;
  const out = txt.replace(/^[ \t]*Sitemap:.*$/gim, () => {
    replaced = true;
    return sitemapLine;
  });
  if (replaced) return out;
  return `${out.replace(/\s*$/, "")}\n\n${sitemapLine}\n`;
}
