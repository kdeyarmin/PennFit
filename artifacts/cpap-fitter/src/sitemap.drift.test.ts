// Drift guard: every public, indexable content route in src/App.tsx must
// have a matching entry in public/sitemap.xml.
//
// Why: the sitemap is a hand-maintained file. Before this guard it had
// drifted to 13 URLs while the app shipped 30+ `learn-*` pages — the SEO
// content investment was invisible to crawlers (see
// docs/app-review-engineering-health-2026-06-09.md, F1). The route map is
// the source of truth; this test parses the static route paths out of
// App.tsx, subtracts the deliberate exclusions below, and fails with the
// exact missing paths when a new public page lands without a sitemap entry.
//
// The reverse direction is also checked: a sitemap URL whose route was
// deleted (or had a typo) would 200 into the SPA shell and soft-404 in
// search consoles, so every <loc> must map to a real static route.
//
// allow-source-read: this is a structural drift check between two static
// artifacts (the wouter route literals in App.tsx and public/sitemap.xml).
// There is no behavioral equivalent — the route table isn't exported at
// runtime, and rendering every route in jsdom to discover paths would be
// slower and flakier than reading the literals.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = readFileSync(path.join(__dirname, "App.tsx"), "utf8");
const SITEMAP = readFileSync(
  path.join(__dirname, "..", "public", "sitemap.xml"),
  "utf8",
);

const ORIGIN = "https://pennpaps.com";
const ORIGIN_URL = new URL(ORIGIN);

// Routes that exist in App.tsx but must NOT be in the sitemap: anything
// state-gated (the fitter funnel), tokenized (signed-link landings), auth,
// account, transactional, or parameterized. Keep this list explicit — a
// new route that is neither excluded here nor in the sitemap should fail
// the test so the author makes a conscious indexability decision.
const EXCLUDED_PREFIXES = [
  "/admin",
  "/provider",
  "/resupply", // legacy redirect namespace
  "/account",
  "/shop/", // cart / checkout-* / orders / wishlist / p/:id — /shop itself IS indexed
  "/sign-in",
  "/sign-up",
];

const EXCLUDED_EXACT = new Set([
  // Fitter funnel — requires consent/session state; entering mid-flow
  // redirects, so indexing these is a soft-404.
  "/capture",
  "/measure",
  "/questionnaire",
  "/results",
  "/order",
  "/order-success",
  // Tokenized / signed-link landings — useless (or an error) without the
  // signed query token.
  "/mask-fit",
  "/fitter-invite",
  "/patient-packet-sign",
  "/reminders/manage",
  "/nps",
  // Auth utility pages.
  "/forgot-password",
  "/reset-password",
  "/verify-email",
]);

function staticRoutePaths(): string[] {
  const paths = new Set<string>();
  for (const match of APP_TSX.matchAll(/path="(\/[^"]*)"/g)) {
    const p = match[1]!;
    // Skip parameterized and wildcard routes — they can't be enumerated
    // statically (e.g. /shop/p/:productId, /admin/*).
    if (p.includes(":") || p.includes("*")) continue;
    paths.add(p);
  }
  return [...paths].sort();
}

function isExcluded(p: string): boolean {
  if (EXCLUDED_EXACT.has(p)) return true;
  return EXCLUDED_PREFIXES.some(
    (prefix) =>
      p === prefix ||
      p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

function sitemapPaths(): string[] {
  const locs = [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  return locs.map((loc) => {
    const parsed = new URL(loc);
    expect(parsed.protocol).toBe(ORIGIN_URL.protocol);
    expect(parsed.hostname).toBe(ORIGIN_URL.hostname);
    expect(parsed.port).toBe(ORIGIN_URL.port);
    const p = parsed.pathname;
    return p === "" ? "/" : p;
  });
}

describe("sitemap.xml stays in lockstep with the public route map", () => {
  it("lists every public, indexable static route from App.tsx", () => {
    const expected = staticRoutePaths().filter((p) => !isExcluded(p));
    const inSitemap = new Set(sitemapPaths());
    const missing = expected.filter((p) => !inSitemap.has(p));
    expect(
      missing,
      `public routes missing from public/sitemap.xml — add a <url> entry ` +
        `for each, or add a deliberate exclusion in sitemap.drift.test.ts: ` +
        missing.join(", "),
    ).toEqual([]);
  });

  it("contains no URL that doesn't map to a real static route", () => {
    const routes = new Set(staticRoutePaths());
    const stale = sitemapPaths().filter((p) => !routes.has(p));
    expect(
      stale,
      `sitemap URLs with no matching route in App.tsx (deleted page or ` +
        `typo — these soft-404): ` +
        stale.join(", "),
    ).toEqual([]);
  });

  it("contains no excluded (state-gated / tokenized / auth) route", () => {
    const leaked = sitemapPaths().filter((p) => isExcluded(p));
    expect(
      leaked,
      `sitemap lists routes that must not be indexed: ` + leaked.join(", "),
    ).toEqual([]);
  });
});
