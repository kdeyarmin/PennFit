// contact.ts — storefront company-identity fetch. Prefers the
// cache-busting /api/storefront-company-info alias and falls back to
// /api/company-info so a rolling deploy (new SPA + older API) does not
// leave the footer stuck on CareMetric compile-time defaults.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(__dirname, "contact.ts"), "utf8");

describe("contact.ts company-info fetch", () => {
  it("prefers /api/storefront-company-info", () => {
    expect(SRC).toContain('"/api/storefront-company-info"');
  });

  it("falls back to /api/company-info when the alias is unavailable", () => {
    expect(SRC).toContain('"/api/company-info"');
    expect(SRC).toMatch(/storefront-company-info[\s\S]*company-info/);
  });

  it("ships CareMetric platform defaults, never the seed tenant brand", () => {
    expect(SRC).toContain('name: "CareMetric Breathe"');
    expect(SRC).toContain('legalName: "CareMetric Breathe"');
    // Compile-time defaults must not hardcode the seed tenant's name as
    // the live display value (comments may still mention it for contrast).
    expect(SRC).not.toMatch(/name:\s*"Penn/);
    expect(SRC).not.toMatch(/legalName:\s*"Penn/);
  });
});
