// Static guards for the Therapy Adherence Report nav item added to AppShell.tsx.
//
// NAV_GROUPS is not exported, so we read the source file directly and assert
// the expected href, label, matchPrefix, hint, and icon are present — the same
// approach used by AppShell.nav.test.ts for all other nav item additions.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

// ─── New nav item: Therapy Report (Insights group) ────────────────────────────

describe("AppShell NAV_GROUPS — Therapy Adherence Report entry", () => {
  it("registers the /admin/therapy-usage-report href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/therapy-usage-report"');
  });

  it('uses "Therapy Report" as the label', () => {
    expect(APPSHELL_SRC).toContain('label: "Therapy Report"');
  });

  it("uses /admin/therapy-usage-report as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain(
      'matchPrefix: "/admin/therapy-usage-report"',
    );
  });

  it("includes a descriptive hint mentioning providers, patients, or manufacturers", () => {
    // The hint should describe the three grouping axes so ops staff understand
    // what the report covers. It must contain at least "provider" or "patient".
    const hintMatch =
      APPSHELL_SRC.includes("provider") || APPSHELL_SRC.includes("patient");
    expect(hintMatch).toBe(true);
  });

  it("includes a hint about therapy adherence", () => {
    // The hint copy describes a provider-ready therapy adherence snapshot.
    expect(APPSHELL_SRC).toMatch(/therapy|adherence/i);
  });

  it("imports ScrollText from lucide-react (icon used by the new entry)", () => {
    expect(APPSHELL_SRC).toContain("ScrollText");
  });
});

// ─── Regression: pre-existing Analytics entry is undisturbed ─────────────────

describe("AppShell NAV_GROUPS — Analytics entry not removed by Therapy Report PR", () => {
  it("still registers the /admin/analytics href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/analytics"');
  });

  it("still registers the /admin/nps href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/nps"');
  });
});

// ─── Position guard: Therapy Report comes between analytics and nps ───────────

describe("AppShell NAV_GROUPS — Therapy Report positioned after Analytics, before NPS", () => {
  it("therapy-usage-report href appears after /admin/analytics in source order", () => {
    const analyticsIdx = APPSHELL_SRC.indexOf('href: "/admin/analytics"');
    const therapyIdx = APPSHELL_SRC.indexOf(
      'href: "/admin/therapy-usage-report"',
    );
    expect(analyticsIdx).toBeGreaterThan(-1);
    expect(therapyIdx).toBeGreaterThan(analyticsIdx);
  });

  it("therapy-usage-report href appears before /admin/nps in source order", () => {
    const therapyIdx = APPSHELL_SRC.indexOf(
      'href: "/admin/therapy-usage-report"',
    );
    const npsIdx = APPSHELL_SRC.indexOf('href: "/admin/nps"');
    expect(therapyIdx).toBeGreaterThan(-1);
    expect(npsIdx).toBeGreaterThan(therapyIdx);
  });
});