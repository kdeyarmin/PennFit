// Host-aware sitemap + robots.
//
// Covers the three host classes (platform apex, non-canonical deploy host,
// tenant storefront), the XML/robots builders, the origin rewriters that make
// one checked-in sitemap correct for every tenant domain, the routing wiring,
// and a drift guard that keeps BREATHE_SITEMAP_PATHS in lockstep with the
// /breathe routes in the SPA's App.tsx.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

import {
  BREATHE_SITEMAP_PATHS,
  PLATFORM_APEX_ORIGIN,
  buildBreatheSitemapXml,
  buildNoindexRobotsTxt,
  buildPlatformRobotsTxt,
  isPlatformApexHost,
  isPlatformPreviewHost,
  resolvePublicOrigin,
  rewriteRobotsSitemapUrl,
  rewriteSitemapOrigin,
} from "./platform-sitemap.js";

// The real checked-in files the tenant branch re-serves. Reading them (rather
// than a fixture) is the point: these are the artifacts that shipped with one
// tenant's domain baked in, so the regression below asserts against the thing
// that was actually wrong.
// allow-source-read: static served artifacts, not TypeScript source — this
// asserts the bytes real crawlers receive.
const SPA_PUBLIC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../cpap-fitter/public",
);
const STATIC_SITEMAP = readFileSync(
  path.join(SPA_PUBLIC, "sitemap.xml"),
  "utf8",
);
const STATIC_ROBOTS = readFileSync(path.join(SPA_PUBLIC, "robots.txt"), "utf8");

describe("isPlatformApexHost", () => {
  it("matches the canonical apex with or without www / port / trailing dot", () => {
    for (const h of [
      "cmbreathe.com",
      "www.cmbreathe.com",
      "CMBREATHE.COM",
      "cmbreathe.com:3000",
      "cmbreathe.com.",
    ]) {
      expect(isPlatformApexHost(h), h).toBe(true);
    }
  });

  it("rejects tenant hosts, the railway preview host, and junk", () => {
    for (const h of [
      "pennpaps.com",
      "acme.cmbreathe.com",
      "pennfit.up.railway.app",
      "localhost",
      "",
      null,
      undefined,
    ]) {
      expect(isPlatformApexHost(h), String(h)).toBe(false);
    }
  });
});

describe("buildBreatheSitemapXml", () => {
  it("emits a well-formed urlset with every path on the apex origin", () => {
    const xml = buildBreatheSitemapXml();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    for (const p of BREATHE_SITEMAP_PATHS) {
      expect(xml).toContain(`<loc>${PLATFORM_APEX_ORIGIN}${p}</loc>`);
    }
    // One <url> per path, no stray ampersands left unescaped.
    expect(xml.match(/<url>/g)).toHaveLength(BREATHE_SITEMAP_PATHS.length);
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe("buildPlatformRobotsTxt", () => {
  it("advertises the sitemap and blocks the gated app surfaces", () => {
    const txt = buildPlatformRobotsTxt();
    expect(txt).toContain(`Sitemap: ${PLATFORM_APEX_ORIGIN}/sitemap.xml`);
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("Disallow: /admin");
    expect(txt).toContain("Disallow: /api/");
  });
});

describe("isPlatformPreviewHost", () => {
  it("matches the platform's Railway deploy hosts", () => {
    for (const h of [
      "pennfit.up.railway.app",
      "up.railway.app",
      "PENNFIT.UP.RAILWAY.APP",
      "pennfit.up.railway.app:8080",
    ]) {
      expect(isPlatformPreviewHost(h), h).toBe(true);
    }
  });

  it("does not match the apex, tenant hosts, or lookalikes", () => {
    for (const h of [
      "cmbreathe.com",
      "pennpaps.com",
      "acme.cmbreathe.com",
      // A tenant cannot register these (normalizeCustomDomain rejects the
      // real suffix), but a lookalike domain must not be mistaken for one.
      "notup.railway.app.evil.com",
      "",
      null,
      undefined,
    ]) {
      expect(isPlatformPreviewHost(h), String(h)).toBe(false);
    }
  });
});

describe("resolvePublicOrigin", () => {
  it("builds an origin from the host and forwarded protocol", () => {
    expect(resolvePublicOrigin("pennpaps.com", "https")).toBe(
      "https://pennpaps.com",
    );
    expect(resolvePublicOrigin("ACME.cmbreathe.com", "https")).toBe(
      "https://acme.cmbreathe.com",
    );
    expect(resolvePublicOrigin("localhost", "http")).toBe("http://localhost");
  });

  it("forces https on a public host even when the proxy reports http", () => {
    // A trust-proxy misconfiguration must not be able to publish a sitemap
    // of http:// canonical URLs; only loopback dev hosts honour http.
    expect(resolvePublicOrigin("pennpaps.com", "http")).toBe(
      "https://pennpaps.com",
    );
    expect(resolvePublicOrigin("pennpaps.com", "")).toBe(
      "https://pennpaps.com",
    );
    expect(resolvePublicOrigin("127.0.0.1", "http")).toBe("http://127.0.0.1");
  });

  it("rejects hosts that could break out of an XML text node", () => {
    for (const h of [
      "",
      "   ",
      "evil.com/<script>",
      'evil.com"><loc>https://attacker.test',
      "evil com",
      "host\nSitemap: https://attacker.test/sitemap.xml",
      "singlelabel",
      null,
      undefined,
    ]) {
      expect(resolvePublicOrigin(h, "https"), String(h)).toBeNull();
    }
  });
});

describe("rewriteSitemapOrigin", () => {
  it("swaps the origin while preserving path, query, and metadata", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<!-- a comment -->",
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      "  <url><loc>https://old.example/</loc><priority>1.0</priority></url>",
      "  <url><loc>https://old.example/learn/dry-mouth</loc><changefreq>monthly</changefreq></url>",
      "  <url><loc>https://old.example/shop?tab=masks</loc></url>",
      "</urlset>",
    ].join("\n");
    const out = rewriteSitemapOrigin(xml, "https://acme.test");
    expect(out).toContain("<loc>https://acme.test/</loc>");
    expect(out).toContain("<loc>https://acme.test/learn/dry-mouth</loc>");
    expect(out).toContain("<loc>https://acme.test/shop?tab=masks</loc>");
    expect(out).not.toContain("old.example");
    // Everything that is not a <loc> survives untouched.
    expect(out).toContain("<!-- a comment -->");
    expect(out).toContain("<priority>1.0</priority>");
    expect(out).toContain("<changefreq>monthly</changefreq>");
  });

  it("leaves a non-absolute <loc> alone rather than dropping the route", () => {
    const xml = "<url><loc>/relative/path</loc></url>";
    expect(rewriteSitemapOrigin(xml, "https://acme.test")).toBe(xml);
  });

  it("round-trips an escaped query without double-escaping it", () => {
    // The <loc> in the source document is ALREADY XML-escaped, so a two-param
    // query reads `?x=1&amp;y=2`. `new URL()` keeps that literal, and naively
    // re-escaping produced `&amp;amp;` — silently changing the URL's query
    // from `x=1&y=2` to `x=1&amp;y=2`. The earlier version of this test only
    // asserted "contains &amp; and no bare &", which the broken output also
    // satisfied. Assert the exact string.
    const xml = "<url><loc>https://old.example/a?x=1&amp;y=2</loc></url>";
    const out = rewriteSitemapOrigin(xml, "https://acme.test");
    expect(out).toBe("<url><loc>https://acme.test/a?x=1&amp;y=2</loc></url>");
    expect(out).not.toContain("&amp;amp;");
    expect(out).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("is idempotent — rewriting an already-rewritten document is a no-op", () => {
    const xml = "<url><loc>https://old.example/a?x=1&amp;y=2</loc></url>";
    const once = rewriteSitemapOrigin(xml, "https://acme.test");
    expect(rewriteSitemapOrigin(once, "https://acme.test")).toBe(once);
  });
});

describe("rewriteRobotsSitemapUrl", () => {
  it("repoints an existing Sitemap directive and keeps the Disallow list", () => {
    const txt = [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "",
      "Sitemap: https://old.example/sitemap.xml",
      "",
    ].join("\n");
    const out = rewriteRobotsSitemapUrl(txt, "https://acme.test");
    expect(out).toContain("Sitemap: https://acme.test/sitemap.xml");
    expect(out).not.toContain("old.example");
    expect(out).toContain("Disallow: /admin");
    expect(out).toContain("Allow: /");
  });

  it("adds a Sitemap directive when the file has none", () => {
    const out = rewriteRobotsSitemapUrl(
      "User-agent: *\nDisallow: /admin\n",
      "https://acme.test",
    );
    expect(out).toContain("Sitemap: https://acme.test/sitemap.xml");
    expect(out).toContain("Disallow: /admin");
  });
});

describe("buildNoindexRobotsTxt", () => {
  // This deliberately ALLOWS crawling. `Disallow: /` reads like the stronger
  // choice and is the weaker one: a crawler forbidden to fetch the page never
  // sees that the page says noindex, so an already-discovered preview URL
  // stays in the index as a URL-only result. Google requires a noindex page
  // to remain crawlable. The directive itself is carried by the SPA meta tag
  // and by the `X-Robots-Tag: noindex` response header (securityHeaders).
  it("allows crawling so the noindex directive can actually be read", () => {
    const txt = buildNoindexRobotsTxt();
    expect(txt).toContain("Allow: /");
    expect(txt).not.toMatch(/^\s*Disallow: \/\s*$/m);
  });

  it("advertises no sitemap and points at the canonical apex", () => {
    const txt = buildNoindexRobotsTxt();
    expect(txt).not.toContain("Sitemap:");
    expect(txt).toContain(PLATFORM_APEX_ORIGIN);
  });
});

describe("sitemap/robots host routing (wiring)", () => {
  // Mirrors the dispatch in app.ts. Kept as a local mock because importing
  // the real app needs the full boot env; the branches under test are the
  // pure helpers above, so this only asserts they are wired in the right
  // order.
  function buildApp(): Express {
    const app = express();
    app.get("/sitemap.xml", (req, res, next) => {
      const host = req.hostname;
      if (isPlatformApexHost(host)) {
        res.type("application/xml").send(buildBreatheSitemapXml());
        return;
      }
      if (isPlatformPreviewHost(host)) {
        res.status(404).end();
        return;
      }
      const origin = resolvePublicOrigin(host, req.protocol);
      if (origin === null) return next();
      res
        .type("application/xml")
        .send(rewriteSitemapOrigin(STATIC_SITEMAP, origin));
    });
    app.get("/robots.txt", (req, res, next) => {
      const host = req.hostname;
      if (isPlatformApexHost(host)) {
        res.type("text/plain").send(buildPlatformRobotsTxt());
        return;
      }
      if (isPlatformPreviewHost(host)) {
        res.type("text/plain").send(buildNoindexRobotsTxt());
        return;
      }
      const origin = resolvePublicOrigin(host, req.protocol);
      if (origin === null) return next();
      res
        .type("text/plain")
        .send(rewriteRobotsSitemapUrl(STATIC_ROBOTS, origin));
    });
    app.use((_req, res) => res.status(404).send("FELL_THROUGH"));
    return app;
  }

  it("serves the Breathe sitemap on the apex host", async () => {
    const res = await request(buildApp())
      .get("/sitemap.xml")
      .set("Host", "cmbreathe.com");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.text).toContain("/breathe/pricing</loc>");
  });

  it("serves no sitemap and a Disallow-all robots on the deploy host", async () => {
    const app = buildApp();
    const sitemap = await request(app)
      .get("/sitemap.xml")
      .set("Host", "pennfit.up.railway.app");
    expect(sitemap.status).toBe(404);

    const robots = await request(app)
      .get("/robots.txt")
      .set("Host", "pennfit.up.railway.app");
    expect(robots.status).toBe(200);
    // Crawlable on purpose (see buildNoindexRobotsTxt), and still no sitemap
    // and no other tenant's domain.
    expect(robots.text).toContain("Allow: /");
    expect(robots.text).not.toContain("Sitemap:");
    expect(robots.text).not.toContain("pennpaps.com");
  });

  it("serves the apex robots on the apex", async () => {
    const res = await request(buildApp())
      .get("/robots.txt")
      .set("Host", "cmbreathe.com");
    expect(res.text).toContain(`Sitemap: ${PLATFORM_APEX_ORIGIN}/sitemap.xml`);
  });
});

describe("regression: a tenant domain never publishes another tenant's URLs", () => {
  // The bug this guards: /sitemap.xml and /robots.txt were static files with
  // pennpaps.com baked in, served unchanged to every host. Tenant #2 would
  // have published tenant #1's 70+ URLs and advertised a cross-domain
  // sitemap, which search engines discard outright.
  function serve(host: string): { sitemap: string; robots: string } {
    const origin = resolvePublicOrigin(host, "https");
    if (origin === null) throw new Error(`unusable host: ${host}`);
    return {
      sitemap: rewriteSitemapOrigin(STATIC_SITEMAP, origin),
      robots: rewriteRobotsSitemapUrl(STATIC_ROBOTS, origin),
    };
  }

  it("gives a second tenant its own origin and no trace of the first", () => {
    const { sitemap, robots } = serve("acme-dme.com");
    expect(sitemap).not.toContain("pennpaps.com");
    expect(robots).not.toContain("pennpaps.com");
    expect(sitemap).toContain("<loc>https://acme-dme.com/</loc>");
    expect(robots).toContain("Sitemap: https://acme-dme.com/sitemap.xml");
  });

  it("works the same for a platform subdomain tenant", () => {
    const { sitemap, robots } = serve("acme.cmbreathe.com");
    expect(sitemap).not.toContain("pennpaps.com");
    expect(sitemap).toContain(
      "<loc>https://acme.cmbreathe.com/insurance</loc>",
    );
    expect(robots).toContain("Sitemap: https://acme.cmbreathe.com/sitemap.xml");
  });

  it("every <loc> is on the requesting origin, for any tenant", () => {
    for (const host of ["pennpaps.com", "acme-dme.com", "acme.cmbreathe.com"]) {
      const { sitemap } = serve(host);
      const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
        (m) => m[1]!,
      );
      expect(locs.length).toBeGreaterThan(50);
      const offOrigin = locs.filter(
        (l) => new URL(l).host !== host.toLowerCase(),
      );
      expect(offOrigin, `${host} leaked: ${offOrigin.join(", ")}`).toEqual([]);
    }
  });

  it("leaves the launch tenant's own URL set unchanged", () => {
    // pennpaps.com must keep serving exactly what it serves today — the
    // rewrite is an identity transform for the tenant the file was written
    // for, so this fix cannot regress the launching tenant's SEO.
    const { sitemap } = serve("pennpaps.com");
    const before = [...STATIC_SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (m) => m[1]!,
    );
    const after = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (m) => m[1]!,
    );
    expect(after).toEqual(before);
  });
});

describe("drift guard: BREATHE_SITEMAP_PATHS vs App.tsx /breathe routes", () => {
  // allow-source-read: structural check between the sitemap path list and the
  // wouter <Route path="/breathe…"> literals in the sibling SPA package, the
  // same pattern as cpap-fitter/src/sitemap.drift.test.ts. The route table
  // isn't exported at runtime, so reading the literals is the only check.
  it("lists exactly the static /breathe routes the SPA serves", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appTsxPath = path.resolve(here, "../../../cpap-fitter/src/App.tsx");
    const appTsx = readFileSync(appTsxPath, "utf8");
    const routePaths = new Set<string>();
    for (const m of appTsx.matchAll(/path="(\/breathe[^"]*)"/g)) {
      const p = m[1]!;
      if (p.includes(":") || p.includes("*")) continue;
      routePaths.add(p);
    }
    const listed = new Set(BREATHE_SITEMAP_PATHS);
    const missingFromSitemap = [...routePaths].filter((p) => !listed.has(p));
    const staleInSitemap = [...listed].filter((p) => !routePaths.has(p));
    expect(
      missingFromSitemap,
      `/breathe routes missing from BREATHE_SITEMAP_PATHS: ${missingFromSitemap.join(", ")}`,
    ).toEqual([]);
    expect(
      staleInSitemap,
      `BREATHE_SITEMAP_PATHS entries with no matching App.tsx route: ${staleInSitemap.join(", ")}`,
    ).toEqual([]);
  });
});
