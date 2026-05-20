// Static guard for the three nav items added to AppShell.tsx in this PR:
//   - /admin/appointment-requests  (Inbox group)
//   - /admin/integrations          (Insights group)
//   - /admin/accreditation-binder  (System group)
//
// NAV_GROUPS is not exported from AppShell.tsx, so we read the source file
// directly and assert the expected route hrefs, labels, and hints are
// present.  This mirrors the approach used in admin.scope.test.ts and gives
// a quick, zero-rendering guard that route additions don't silently regress.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(
  path.join(__dirname, "AppShell.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// New nav item: Appointment requests (Inbox group)
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — appointment-requests entry (Inbox group)", () => {
  it("registers the /admin/appointment-requests href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/appointment-requests"');
  });

  it("uses 'Appointment requests' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Appointment requests"');
  });

  it("uses /admin/appointment-requests as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain('matchPrefix: "/admin/appointment-requests"');
  });

  it("includes a descriptive hint for the CSR appointment-requests queue", () => {
    expect(APPSHELL_SRC).toContain(
      "CSR queue for patient-initiated appointment requests",
    );
  });

  it("imports CalendarPlus from lucide-react (icon used by the new item)", () => {
    expect(APPSHELL_SRC).toContain("CalendarPlus");
  });
});

// ---------------------------------------------------------------------------
// New nav item: Integrations (Insights group)
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — integrations entry (Insights group)", () => {
  it("registers the /admin/integrations href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/integrations"');
  });

  it("uses 'Integrations' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Integrations"');
  });

  it("uses /admin/integrations as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain('matchPrefix: "/admin/integrations"');
  });

  it("includes a descriptive hint about therapy-cloud vendor connections", () => {
    expect(APPSHELL_SRC).toContain(
      "Therapy-cloud vendor connections and nightly sync status",
    );
  });

  it("imports Plug from lucide-react (icon used by the new item)", () => {
    expect(APPSHELL_SRC).toContain("Plug");
  });
});

// ---------------------------------------------------------------------------
// New nav item: Accreditation binder (System group)
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — accreditation-binder entry (System group)", () => {
  it("registers the /admin/accreditation-binder href", () => {
    expect(APPSHELL_SRC).toContain('href: "/admin/accreditation-binder"');
  });

  it("uses 'Accreditation binder' as the label", () => {
    expect(APPSHELL_SRC).toContain('label: "Accreditation binder"');
  });

  it("uses /admin/accreditation-binder as the matchPrefix", () => {
    expect(APPSHELL_SRC).toContain(
      'matchPrefix: "/admin/accreditation-binder"',
    );
  });

  it("includes a descriptive hint mentioning DMEPOS evidence rollup", () => {
    expect(APPSHELL_SRC).toContain("Surveyor-facing DMEPOS evidence rollup");
  });

  it("imports ClipboardList from lucide-react (icon used by the new item)", () => {
    expect(APPSHELL_SRC).toContain("ClipboardList");
  });
});

// ---------------------------------------------------------------------------
// New nav group: Billing — five entries mounted alongside Orders & Shop.
//   Headline page: /admin/billing  (Billing Hub)
//   Sub-pages:     /admin/billing/{ai-queue,aging,denials,era}
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — billing group", () => {
  it("registers a 'Billing' nav group label", () => {
    expect(APPSHELL_SRC).toContain('label: "Billing"');
  });

  const billingRoutes: ReadonlyArray<[string, string]> = [
    ["/admin/billing", "Billing Hub"],
    ["/admin/billing/ai-queue", "AI queue"],
    ["/admin/billing/eligibility", "Eligibility"],
    ["/admin/billing/prior-auths", "Prior auths"],
    ["/admin/billing/aging", "A/R aging"],
    ["/admin/billing/denials", "Denials & DSO"],
    ["/admin/billing/era", "ERA files"],
    ["/admin/billing/config", "Config"],
  ];

  for (const [href, label] of billingRoutes) {
    it(`mounts ${label} at ${href}`, () => {
      expect(APPSHELL_SRC).toContain(`href: "${href}"`);
      expect(APPSHELL_SRC).toContain(`label: "${label}"`);
      expect(APPSHELL_SRC).toContain(`matchPrefix: "${href}"`);
    });
  }

  it("imports the lucide icons used by the billing group", () => {
    expect(APPSHELL_SRC).toContain("CircleDollarSign");
    expect(APPSHELL_SRC).toContain("Wallet");
    expect(APPSHELL_SRC).toContain("Bot");
    expect(APPSHELL_SRC).toContain("ListFilter");
    expect(APPSHELL_SRC).toContain("TrendingDown");
    expect(APPSHELL_SRC).toContain("ClipboardCheck");
    expect(APPSHELL_SRC).toContain("ShieldAlert");
    expect(APPSHELL_SRC).toContain("SlidersHorizontal");
  });
});

// ---------------------------------------------------------------------------
// Regression: pre-existing routes are undisturbed
// ---------------------------------------------------------------------------
describe("AppShell NAV_GROUPS — pre-existing routes not removed by this PR", () => {
  const expectedRoutes = [
    "/admin/followups",
    "/admin/macros",
    "/admin/patients",
    "/admin/delivery-failures",
    "/admin/operations",
    "/admin/compliance",
  ];

  for (const route of expectedRoutes) {
    it(`retains ${route}`, () => {
      expect(APPSHELL_SRC).toContain(`href: "${route}"`);
    });
  }
});