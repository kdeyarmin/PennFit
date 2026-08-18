// App modules: the SPA catalog must match what the migrations seed, and
// switching every module off must never cost an operator the way back.
//
// Both halves guard silent failures. A module declared here but not
// seeded simply doesn't render in the Control Center card, so a switch
// advertised in code is missing from the product. And a module that
// swallowed Control Center or the plan page would let a tenant hide the
// very screen that turns it back on — recoverable only by an operator
// with database access.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

import { APP_MODULES } from "./app-modules";
import { NAV_GROUPS } from "@/components/admin/AppShell";
import {
  filterNavGroupsByFeature,
  featureHidingLocation,
  sectionLandingHref,
  sectionVisible,
} from "@/components/admin/nav-traversal";

const here = dirname(fileURLToPath(import.meta.url));
// artifacts/cpap-fitter/src/lib/admin -> repo root
const REPO_ROOT = join(here, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "lib", "resupply-db", "migrations");

/**
 * `module.*` keys seeded by any migration's feature_flags INSERT.
 *
 * Reads the migration SQL as DATA, the same way the API's
 * feature-flags.catalog.test.ts does — the migrations are the source of
 * truth for what exists in the database and there is no importable
 * representation of them. The API side of the chain (FEATURE_FLAG_KEYS ↔
 * seeded keys, in both directions) is already covered by that test, so
 * matching APP_MODULES against the same seed set pins all three together
 * transitively without a second copy of the check.
 */
function seededModuleKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) =>
    f.endsWith(".sql"),
  )) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (!sql.includes("resupply.feature_flags")) continue;
    for (const m of sql.matchAll(
      /\(\s*'(module\.[a-z0-9_]+)'\s*,\s*(?:true|false)\b/g,
    )) {
      keys.add(m[1]!);
    }
  }
  return keys;
}

const sorted = (s: Iterable<string>) => Array.from(s).sort();

describe("app modules match what the migrations seed", () => {
  const declared = new Set(APP_MODULES.map((m) => m.key));
  const seeded = seededModuleKeys();

  it("found a non-trivial set of seeded module keys (sanity)", () => {
    expect(seeded.size).toBeGreaterThan(5);
  });

  it("every declared module is seeded by a migration", () => {
    expect(sorted([...declared].filter((k) => !seeded.has(k)))).toEqual([]);
  });

  it("every seeded module is declared in APP_MODULES", () => {
    expect(sorted([...seeded].filter((k) => !declared.has(k)))).toEqual([]);
  });

  it("declares no duplicate keys", () => {
    expect(declared.size).toBe(APP_MODULES.length);
  });

  it("gives every module a label, a description, and a console group", () => {
    for (const m of APP_MODULES) {
      expect(m.key, `${m.key} key shape`).toMatch(/^module\.[a-z0-9_]+$/);
      expect(m.label.length, `${m.key} label`).toBeGreaterThan(0);
      expect(m.hides.length, `${m.key} hides`).toBeGreaterThan(0);
      expect(m.group.length, `${m.key} group`).toBeGreaterThan(0);
    }
  });
});

describe("modules never hide the way back", () => {
  // The worst case, run against the real nav: a tenant switches off
  // EVERY module at once.
  const ALL_OFF = new Set(APP_MODULES.map((m) => m.key));
  const survivors = filterNavGroupsByFeature(NAV_GROUPS, ALL_OFF);
  const superAdmin = new Set([
    "admin.tools.manage",
    "system.config.manage",
    "orders.create",
    "patients.update",
    "billing.manage",
    "cases.read",
    "reports.read",
  ]);

  /** Every href still reachable from the sidebar in that worst case. */
  const reachable = new Set<string>();
  for (const group of survivors) {
    for (const section of group.items) {
      if (!sectionVisible(section, superAdmin)) continue;
      if (section.tabs && section.tabs.length > 0) {
        for (const tab of section.tabs) reachable.add(tab.href);
      } else if (section.href) {
        reachable.add(section.href);
      }
    }
  }

  // How an operator runs the business, and — crucially — how they get
  // back to the switch that turns a module on again. A module key
  // covering any of these would let a tenant lock itself out of its own
  // console with one click.
  const PROTECTED = [
    "/admin", // dashboard
    "/admin/patients",
    "/admin/settings",
    "/admin/team",
    "/admin/security",
    "/admin/control-center",
    "/admin/system/configuration",
    "/admin/billing/package", // how a tenant pays us
  ];

  for (const href of PROTECTED) {
    it(`keeps ${href} in the sidebar with every module off`, () => {
      expect(reachable.has(href)).toBe(true);
    });

    it(`never shows a "turned off" notice for ${href}`, () => {
      // Belt and braces: the sidebar could keep an entry while the
      // deep-link guard still blanked the page behind it.
      expect(featureHidingLocation(href, NAV_GROUPS, ALL_OFF)).toBeNull();
    });
  }

  it("lands every surviving section on a page that still exists", () => {
    // A section whose landing tab was filtered away would link into a
    // "turned off" notice from the sidebar itself.
    for (const group of survivors) {
      for (const section of group.items) {
        const href = sectionLandingHref(section, superAdmin);
        expect(href, `${group.label} > ${section.label}`).not.toBe("#");
        expect(
          featureHidingLocation(href, NAV_GROUPS, ALL_OFF),
          `${group.label} > ${section.label} lands on a hidden page`,
        ).toBeNull();
      }
    }
  });

  it("still actually removes things (guards against a no-op filter)", () => {
    // If filterNavGroupsByFeature silently stopped filtering, every test
    // above would pass vacuously.
    expect(survivors.length).toBeLessThan(NAV_GROUPS.length);
    expect(reachable.has("/admin/billing/verify")).toBe(false);
    expect(reachable.has("/admin/front-desk")).toBe(false);
  });

  it("keeps the plan page reachable from outside the Billing module", () => {
    // /admin/billing/package sits in Billing > Tools (hidden with the
    // module) AND in Settings (never hidden). Losing the second copy is
    // what would make "we don't bill insurance" also mean "I can't find
    // where to pay you", so assert the surviving one is the Settings one.
    const owners = survivors
      .flatMap((g) => g.items.map((s) => ({ group: g.label, section: s })))
      .filter((e) =>
        e.section.tabs?.some((t) => t.href === "/admin/billing/package"),
      );
    expect(owners.map((o) => `${o.group} > ${o.section.label}`)).toEqual([
      "System > Settings",
    ]);
  });
});
