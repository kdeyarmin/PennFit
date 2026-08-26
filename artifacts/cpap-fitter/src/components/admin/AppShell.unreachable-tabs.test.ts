// Nav entries must not advertise a screen the viewer's role cannot load.
//
// Five tabs carried no `requiredPermission` while their backing routes gate
// on one the role may not hold, so a respiratory therapist (and, for the
// returns-gated ones, a biller) saw the tab, clicked it, and got a 403 from
// the fetch. The nav is the promise; the route is the truth. These guards
// pin each nav gate to the permission its route actually requires.
//
// NAV_GROUPS is not exported, so we read the source directly — the same
// approach AppShell.nav.test.ts and AppShell.therapy-report-nav.test.ts use.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPSHELL_SRC = readFileSync(path.join(__dirname, "AppShell.tsx"), "utf8");

/**
 * The nav entry's own object literal, from its `href:` line to the closing
 * brace, so an assertion can't accidentally match a neighbouring tab's gate.
 */
function navEntry(href: string): string {
  const start = APPSHELL_SRC.indexOf(`href: "${href}"`);
  expect(start, `nav entry ${href} not found`).toBeGreaterThan(-1);
  const end = APPSHELL_SRC.indexOf("},", start);
  return APPSHELL_SRC.slice(start, end);
}

// href → the permission the backing route requires. Each pairing was read
// off the route file; keep them in step if a route's gate ever changes.
const GATED: ReadonlyArray<readonly [string, string, string]> = [
  // routes/admin/therapy-fleet.ts — the fleet + cohort summaries
  ["/admin/therapy-fleet", "reports.read", "therapy-fleet.ts"],
  // routes/admin/therapy-compliance.ts — the CMS 90-day tracker
  ["/admin/therapy-compliance", "reports.read", "therapy-compliance.ts"],
  // routes/admin/therapy-resupply.ts — device-reported supplies due
  ["/admin/therapy-resupply", "reports.read", "therapy-resupply.ts"],
  // routes/admin/therapy-usage-report.ts — the printable adherence report
  ["/admin/therapy-usage-report", "reports.read", "therapy-usage-report.ts"],
  // routes/admin/equipment-recalls.ts — recall registry + serial scan
  ["/admin/equipment-recalls", "returns.read", "equipment-recalls.ts"],
];

describe("AppShell NAV_GROUPS — tabs gate on the permission their route requires", () => {
  for (const [href, permission, route] of GATED) {
    it(`${href} requires ${permission} (matching ${route})`, () => {
      expect(navEntry(href)).toContain(`requiredPermission: "${permission}"`);
    });
  }
});

describe("the clinician (RT) role keeps a therapy landing page", () => {
  // Gating every tab in a group would make `sectionVisible` hide the group
  // outright, leaving an RT with no therapy entry point at all. RT Overview
  // gates on nothing (its route is plain requireAdmin) and RT outcomes on
  // clinical.read, which the clinician holds — so the group survives.
  it("leaves RT Overview ungated so it stays visible to every staff role", () => {
    expect(navEntry("/admin/rt-overview")).not.toContain("requiredPermission");
  });

  it("keeps RT outcomes on clinical.read, which the clinician holds", () => {
    expect(navEntry("/admin/rt-outcomes")).toContain(
      'requiredPermission: "clinical.read"',
    );
  });

  // Same reasoning for the Providers & recalls group: Providers gates on
  // nothing and its route only needs patients.read, which every staff role
  // holds, so gating Recalls can't empty the group.
  it("leaves Providers ungated so gating Recalls can't empty its group", () => {
    expect(navEntry("/admin/providers")).not.toContain("requiredPermission");
  });
});
