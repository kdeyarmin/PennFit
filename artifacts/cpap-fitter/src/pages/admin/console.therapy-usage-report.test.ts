// Static guards for the /admin/therapy-usage-report lazy route registration
// in console.tsx.
//
// Mirrors the patterns in console.lazy.test.ts and console.route.test.ts:
// read the console.tsx source directly and assert the lazy import + Route
// mounting are present and correctly wired.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

// ─── Lazy loading ─────────────────────────────────────────────────────────────

describe("console.tsx — AdminTherapyUsageReportPage lazy loading", () => {
  it("declares AdminTherapyUsageReportPage as a lazy() component", () => {
    expect(SRC).toMatch(
      /const\s+AdminTherapyUsageReportPage\s*=\s*lazy\s*\(/,
    );
  });

  it("imports the page from @/pages/admin/admin-therapy-usage-report", () => {
    expect(SRC).toContain(
      'import("@/pages/admin/admin-therapy-usage-report")',
    );
  });

  it("maps the named export to default via .then({ default: m.AdminTherapyUsageReportPage })", () => {
    // The .then() factory must re-export the named export as `default` so
    // lazy() can resolve it — bare dynamic imports would get name-mangled by
    // Vite at build time.
    expect(SRC).toContain("default: m.AdminTherapyUsageReportPage");
  });

  it("does NOT use a static import for AdminTherapyUsageReportPage", () => {
    expect(SRC).not.toMatch(
      /import\s*\{[^}]*\bAdminTherapyUsageReportPage\b[^}]*\}/,
    );
  });
});

// ─── Route registration ───────────────────────────────────────────────────────

describe("console.tsx — /admin/therapy-usage-report route", () => {
  it("registers a Route at path /admin/therapy-usage-report", () => {
    expect(SRC).toContain('path="/admin/therapy-usage-report"');
  });

  it("mounts AdminTherapyUsageReportPage as the route component", () => {
    // The Route element must reference the lazy component by name.
    const routeIdx = SRC.indexOf('path="/admin/therapy-usage-report"');
    expect(routeIdx).toBeGreaterThan(-1);
    // The component= prop should be on or near the same Route element.
    const routeSnippet = SRC.slice(routeIdx, routeIdx + 200);
    expect(routeSnippet).toContain("AdminTherapyUsageReportPage");
  });
});

// ─── Placement: after analytics, before rt-overview ──────────────────────────

describe("console.tsx — Therapy Usage Report route placement", () => {
  it("therapy-usage-report route appears after the analytics route", () => {
    const analyticsIdx = SRC.indexOf('path="/admin/analytics"');
    const therapyIdx = SRC.indexOf('path="/admin/therapy-usage-report"');
    expect(analyticsIdx).toBeGreaterThan(-1);
    expect(therapyIdx).toBeGreaterThan(analyticsIdx);
  });

  it("therapy-usage-report route appears before the rt-overview route", () => {
    const therapyIdx = SRC.indexOf('path="/admin/therapy-usage-report"');
    const rtIdx = SRC.indexOf('path="/admin/rt-overview"');
    expect(therapyIdx).toBeGreaterThan(-1);
    expect(rtIdx).toBeGreaterThan(therapyIdx);
  });
});