// Static guards for the "Verify insurance" nav item added to AppShell.tsx
// (Billing → Worklists). NAV_GROUPS is not exported, so we read the source
// file directly and assert the expected href, label, matchPrefix, and hint
// are present — the same approach used by AppShell.nav.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

describe("AppShell NAV_GROUPS — verify-insurance entry (Billing worklists)", () => {
  it("registers the /admin/billing/verify href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/billing/verify"');
  });

  it("uses 'Verify insurance' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Verify insurance"');
  });

  it("uses /admin/billing/verify as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain('matchPrefix: "/admin/billing/verify"');
  });

  it("includes a hint describing the on-demand 270/271 runner", () => {
    expect(APPSHELL_SRC).toContain(
      "Run an on-demand insurance verification (270/271) for any patient",
    );
  });

  it("appears before the Eligibility worklist tab in source order", () => {
    const verifyIdx = APPSHELL_SRC.indexOf('href: "/admin/billing/verify"');
    const eligibilityIdx = APPSHELL_SRC.indexOf(
      'href: "/admin/billing/eligibility"',
    );
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(eligibilityIdx).toBeGreaterThan(verifyIdx);
  });
});
