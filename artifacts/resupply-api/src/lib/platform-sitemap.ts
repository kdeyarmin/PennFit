// Host-aware platform sitemap + robots for the Breathe marketing site.
//
// The Breathe marketing pages live on the platform apex (cmbreathe.com) — a
// different host from any tenant storefront. The static public/sitemap.xml is
// the TENANT (pennpaps.com) sitemap and must never list cross-domain URLs, so
// the /breathe pages get their own apex-served sitemap here. These handlers
// are mounted AHEAD of express.static in app.ts; on any non-apex host they
// fall through (next()) so the tenant's static sitemap.xml / robots.txt are
// served unchanged.
//
// Indexability: only the canonical apex is served — this mirrors the frontend
// `isPlatformApexHost()` noindex gate (cpap-fitter/src/lib/platform-host.ts).
// The Railway `*.up.railway.app` preview host is deliberately NOT served: its
// pages are noindex (staging / duplicate content), so it gets no sitemap.

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
  "/breathe/roi",
  "/breathe/pricing",
  "/breathe/security",
  "/breathe/case-studies",
  "/breathe/faq",
  "/breathe/switch/brightree",
  "/breathe/switch/bonafide",
  "/breathe/switch/nikohealth",
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
