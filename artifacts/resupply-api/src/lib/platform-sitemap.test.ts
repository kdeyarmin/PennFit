// Host-aware platform sitemap + robots.
//
// Covers the apex host gate, the XML/robots builders, the gate+fallthrough
// wiring (apex serves the Breathe sitemap; every other host falls through to
// whatever static handler sits behind it), and a drift guard that keeps
// BREATHE_SITEMAP_PATHS in lockstep with the /breathe routes in the SPA's
// App.tsx.

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
  buildPlatformRobotsTxt,
  isPlatformApexHost,
} from "./platform-sitemap.js";

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

describe("sitemap/robots host gating (wiring)", () => {
  function buildApp(): Express {
    const app = express();
    app.get("/sitemap.xml", (req, res, next) => {
      if (!isPlatformApexHost(req.hostname)) return next();
      res.type("application/xml").send(buildBreatheSitemapXml());
    });
    app.get("/robots.txt", (req, res, next) => {
      if (!isPlatformApexHost(req.hostname)) return next();
      res.type("text/plain").send(buildPlatformRobotsTxt());
    });
    // Stand-in for the static tenant files served behind these handlers.
    app.get("/sitemap.xml", (_req, res) => res.send("STATIC_TENANT_SITEMAP"));
    app.get("/robots.txt", (_req, res) => res.send("STATIC_TENANT_ROBOTS"));
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

  it("falls through to the static file on a tenant host", async () => {
    const res = await request(buildApp())
      .get("/sitemap.xml")
      .set("Host", "pennpaps.com");
    expect(res.status).toBe(200);
    expect(res.text).toBe("STATIC_TENANT_SITEMAP");
  });

  it("serves the apex robots on the apex and falls through elsewhere", async () => {
    const apex = await request(buildApp())
      .get("/robots.txt")
      .set("Host", "cmbreathe.com");
    expect(apex.text).toContain("Sitemap: ");
    const tenant = await request(buildApp())
      .get("/robots.txt")
      .set("Host", "pennpaps.com");
    expect(tenant.text).toBe("STATIC_TENANT_ROBOTS");
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
