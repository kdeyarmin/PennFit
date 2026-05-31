// Tests for the /admin/therapy-usage-report route added to console.tsx.
//
// We read the source as a string and assert the structural invariants
// needed for the new route to function: the lazy import, the Route
// definition, and the component name. Mirrors the approach used in
// other page source-guard tests in this directory.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

// ── Lazy import wiring ────────────────────────────────────────────────────────

describe("console.tsx — AdminTherapyUsageReportPage lazy import", () => {
  it("declares AdminTherapyUsageReportPage via lazy()", () => {
    expect(SRC).toContain("AdminTherapyUsageReportPage");
    expect(SRC).toContain("lazy(");
  });

  it("imports from the admin-therapy-usage-report module", () => {
    expect(SRC).toContain("admin-therapy-usage-report");
  });

  it("re-exports AdminTherapyUsageReportPage as the default of the lazy chunk", () => {
    // The pattern `default: m.AdminTherapyUsageReportPage` matches the
    // project convention used by every other lazy admin page.
    expect(SRC).toContain("default: m.AdminTherapyUsageReportPage");
  });
});

// ── Route registration ────────────────────────────────────────────────────────

describe("console.tsx — /admin/therapy-usage-report Route", () => {
  it("registers a Route with path /admin/therapy-usage-report", () => {
    expect(SRC).toContain('path="/admin/therapy-usage-report"');
  });

  it("mounts AdminTherapyUsageReportPage as the component for the route", () => {
    expect(SRC).toContain("component={AdminTherapyUsageReportPage}");
  });

  it("therapy-usage-report route appears after the analytics route in source order", () => {
    const analyticsPos = SRC.indexOf('path="/admin/analytics"');
    const therapyPos = SRC.indexOf('path="/admin/therapy-usage-report"');
    expect(analyticsPos).toBeGreaterThan(-1);
    expect(therapyPos).toBeGreaterThan(analyticsPos);
  });
});

// ── Regression: adjacent routes undisturbed ───────────────────────────────────

describe("console.tsx — adjacent routes still present", () => {
  it("still registers the /admin/analytics route", () => {
    expect(SRC).toContain('path="/admin/analytics"');
  });

  it("still registers the /admin/rt-overview route", () => {
    expect(SRC).toContain('path="/admin/rt-overview"');
  });

  it("still exports AdminConsole (main app shell entry)", () => {
    expect(SRC).toContain("function AdminConsole");
  });
});