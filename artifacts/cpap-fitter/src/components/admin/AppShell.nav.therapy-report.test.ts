// Static guards for the Therapy Report nav item added to AppShell.tsx.
//
// NAV_GROUPS is not exported from AppShell.tsx, so we read the source
// directly and assert the expected href, label, matchPrefix, hint, and
// icon are present. Mirrors the approach in AppShell.nav.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(
  path.join(__dirname, "AppShell.tsx"),
  "utf8",
);

// ── New nav item: Therapy Report (Insights group) ─────────────────────────────

describe("AppShell NAV_GROUPS — therapy-usage-report entry", () => {
  it("registers the /admin/therapy-usage-report href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/therapy-usage-report"');
  });

  it("uses 'Therapy Report' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Therapy Report"');
  });

  it("uses /admin/therapy-usage-report as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain(
      'matchPrefix: "/admin/therapy-usage-report"',
    );
  });

  it("includes a descriptive hint mentioning provider, patient, and manufacturer", () => {
    // The hint should describe the three grouping axes.
    expect(APPSHELL_SRC).toContain("provider");
    expect(APPSHELL_SRC).toContain("patient");
    expect(APPSHELL_SRC).toContain("manufacturer");
  });

  it("imports ScrollText from lucide-react (icon used by the Therapy Report item)", () => {
    expect(APPSHELL_SRC).toContain("ScrollText");
  });

  it("hint mentions 'print-quality' or 'therapy adherence'", () => {
    // The hint must describe the report's purpose so ops teams know what to click.
    const hasAdherence =
      APPSHELL_SRC.includes("therapy adherence") ||
      APPSHELL_SRC.includes("print-quality");
    expect(hasAdherence).toBe(true);
  });
});

// ── Regression: surrounding Insights group items undisturbed ──────────────────

describe("AppShell NAV_GROUPS — Insights group neighbours still present", () => {
  it("still registers /admin/analytics", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/analytics"');
  });

  it("still registers /admin/nps", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/nps"');
  });

  it("therapy-usage-report item appears between analytics and nps in source", () => {
    const analyticsPos = APPSHELL_SRC.indexOf('href: "/admin/analytics"');
    const therapyPos = APPSHELL_SRC.indexOf(
      'href: "/admin/therapy-usage-report"',
    );
    const npsPos = APPSHELL_SRC.indexOf('href: "/admin/nps"');
    expect(analyticsPos).toBeGreaterThan(-1);
    expect(therapyPos).toBeGreaterThan(analyticsPos);
    expect(npsPos).toBeGreaterThan(therapyPos);
  });
});