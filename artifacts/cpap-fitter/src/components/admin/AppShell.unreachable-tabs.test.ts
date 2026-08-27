// A nav entry must not advertise a screen the viewer's role cannot load.
//
// Five tabs carried no `requiredPermission` while their backing routes gate
// on one the role may not hold, so a respiratory therapist saw Therapy
// Fleet, clicked it, and the fetch 403'd — and a biller hit the same on
// Recalls. The nav is the promise; the route is the truth.
//
// These are BEHAVIOURAL: they drive the real `visibleTabs` / `sectionVisible`
// filters with a role's real permission set and assert what that person ends
// up seeing. Asserting the gates instead (by reading the source and matching
// `requiredPermission:` strings) would pass even if the filter stopped
// consulting them.

import { describe, expect, it } from "vitest";

import { NAV_GROUPS } from "./AppShell";
import { sectionVisible, visibleTabs, type NavSection } from "./nav-traversal";

// Permission sets exactly as `EFFECTIVE_ROLE_PERMISSIONS` defines them in
// lib/resupply-auth/src/rbac.ts. Restated here rather than imported: the SPA
// depends on @workspace/resupply-auth-react, not the server-side auth
// package, and these are the test's INPUT — the nav filtering is what is
// under test. Keep them in step if the catalog changes.
const CLINICIAN: ReadonlySet<string> = new Set([
  "patients.read",
  "clinical.read",
  "clinical.note.write",
  "clinical.intervention.write",
  "formulary.manage",
  "fit_session.override",
  // Granted so the RT can run the therapy monitoring the User Manual
  // calls their job. `therapy.read`, NOT `reports.read`: the latter also
  // gates ~50 billing/revenue/payer route files an RT has no business in.
  "therapy.read",
  "returns.read",
  "cases.read",
]);

const CUSTOMER_SERVICE_REP: ReadonlySet<string> = new Set([
  "patients.read",
  "patients.update",
  "returns.read",
  "returns.manage",
  "orders.create",
  "compliance.read",
  "reports.read",
  "therapy.read",
  "inventory.read",
  "conversations.manage",
  "fit_session.override",
  "cases.read",
  "cases.manage",
  "provider_portal.manage",
]);

const BILLER: ReadonlySet<string> = new Set([
  "patients.read",
  "patients.update",
  "reports.read",
  "therapy.read",
  "cost.read",
  "inventory.read",
  "billing.manage",
  "conversations.manage",
]);

/** The sidebar entry whose tab bar contains `href`. */
function sectionContaining(href: string): NavSection {
  for (const group of NAV_GROUPS) {
    for (const section of group.items) {
      if (section.tabs?.some((tab) => tab.href === href)) return section;
    }
  }
  throw new Error(`no nav section contains a tab for ${href}`);
}

function visibleHrefs(
  href: string,
  permissions: ReadonlySet<string>,
): string[] {
  return visibleTabs(sectionContaining(href), permissions).map((t) => t.href);
}

/** href → the route permission that decides whether the page can load. */
const THERAPY_DASHBOARDS = [
  "/admin/therapy-fleet", // therapy-fleet.ts        → therapy.read
  "/admin/therapy-compliance", // therapy-compliance.ts   → therapy.read
  "/admin/therapy-resupply", // therapy-resupply.ts     → therapy.read
] as const;
const THERAPY_REPORT = "/admin/therapy-usage-report"; // → therapy.read
const RECALLS = "/admin/equipment-recalls"; // equipment-recalls.ts → returns.read

// The clinician set was widened with reports.read / returns.read /
// cases.read so an RT can run the therapy monitoring the User Manual
// calls their job. The gates were NOT removed to achieve that — they
// stayed exactly as they were and simply pass now, which is the whole
// point of gating on the route's permission rather than on the role.
describe("a clinician sees the therapy screens their role can now load", () => {
  it("shows the population therapy dashboards", () => {
    for (const href of THERAPY_DASHBOARDS) {
      expect(visibleHrefs(href, CLINICIAN)).toContain(href);
    }
  });

  it("shows the printable Therapy Report", () => {
    expect(visibleHrefs(THERAPY_REPORT, CLINICIAN)).toContain(THERAPY_REPORT);
  });

  it("shows Recalls", () => {
    expect(visibleHrefs(RECALLS, CLINICIAN)).toContain(RECALLS);
  });

  it("still hides what the role genuinely cannot load", () => {
    // Asset recovery READS on cases.read (now held), but a role without
    // it must still not be offered the tab — the gate is what decides,
    // not the role, so prove it with a set that lacks the permission.
    const withoutCases = new Set(
      [...CLINICIAN].filter((p) => p !== "cases.read"),
    );
    expect(visibleHrefs("/admin/asset-recovery", withoutCases)).not.toContain(
      "/admin/asset-recovery",
    );
  });
});

describe("a biller keeps what they can load and loses what they can't", () => {
  it("hides Recalls (no returns.read)", () => {
    expect(visibleHrefs(RECALLS, BILLER)).not.toContain(RECALLS);
  });

  it("still sees the therapy dashboards and report (has reports.read)", () => {
    for (const href of [...THERAPY_DASHBOARDS, THERAPY_REPORT]) {
      expect(visibleHrefs(href, BILLER)).toContain(href);
    }
  });
});

describe("nothing is hidden from a role that can load it", () => {
  it("leaves every one of the five visible to a customer service rep", () => {
    for (const href of [...THERAPY_DASHBOARDS, THERAPY_REPORT, RECALLS]) {
      expect(visibleHrefs(href, CUSTOMER_SERVICE_REP)).toContain(href);
    }
  });
});

describe("gating these tabs does not strand a role in an empty group", () => {
  // `sectionVisible` hides a sidebar entry once every tab inside it is
  // filtered out, so over-gating would cost the clinician the entry point
  // rather than just the pages.
  it("keeps Therapy monitoring open to a clinician, with its reachable tabs", () => {
    const section = sectionContaining("/admin/therapy-fleet");
    expect(sectionVisible(section, CLINICIAN)).toBe(true);
    const hrefs = visibleTabs(section, CLINICIAN).map((t) => t.href);
    // RT Overview's route is plain requireAdmin; RT outcomes gates on
    // clinical.read, which a clinician holds.
    expect(hrefs).toContain("/admin/rt-overview");
    expect(hrefs).toContain("/admin/rt-outcomes");
  });

  it("keeps Providers & recalls open to a clinician and a biller", () => {
    const section = sectionContaining(RECALLS);
    for (const perms of [CLINICIAN, BILLER]) {
      expect(sectionVisible(section, perms)).toBe(true);
      // Providers needs only patients.read, which every staff role holds.
      expect(visibleTabs(section, perms).map((t) => t.href)).toContain(
        "/admin/providers",
      );
    }
  });
});
