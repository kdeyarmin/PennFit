// Drift guard: the SPA's app-module catalog, the API's flag allow-list,
// and the seed migration must describe the same set of `module.*` keys.
//
// Each half fails silently on its own, which is why this is a test and
// not a comment:
//   * A key in APP_MODULES but not seeded → the Control Center card
//     silently omits the row (AppModulesCard skips unseeded keys), so a
//     module advertised in code is un-toggleable in the product.
//   * A key seeded but missing from APP_MODULES → it drops out of the
//     card into the generic flag list, loses its plain-English label,
//     and `appModuleLabel` renders the raw key in the "turned off"
//     notice.
//   * A key in either place but missing from FEATURE_FLAG_KEYS → the
//     PATCH route rejects the toggle as `unknown_flag`. Dead switch.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

import { APP_MODULES } from "./app-modules";

const here = dirname(fileURLToPath(import.meta.url));
// artifacts/cpap-fitter/src/lib/admin -> repo root
const REPO_ROOT = join(here, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "lib", "resupply-db", "migrations");
const API_FLAGS = join(
  REPO_ROOT,
  "artifacts",
  "resupply-api",
  "src",
  "lib",
  "feature-flags.ts",
);

/** `module.*` keys seeded by any migration's feature_flags INSERT. */
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

/** `module.*` entries of FEATURE_FLAG_KEYS, read as source text so this
 *  test doesn't have to import across artifact boundaries. */
function apiCatalogModuleKeys(): Set<string> {
  const src = readFileSync(API_FLAGS, "utf8");
  const start = src.indexOf("export const FEATURE_FLAG_KEYS");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("] as const;", start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  return new Set(
    Array.from(block.matchAll(/"(module\.[a-z0-9_]+)"/g), (m) => m[1]!),
  );
}

const sorted = (s: Iterable<string>) => Array.from(s).sort();

describe("app modules stay in lockstep across SPA, API, and migrations", () => {
  const declared = new Set(APP_MODULES.map((m) => m.key));
  const seeded = seededModuleKeys();
  const catalog = apiCatalogModuleKeys();

  it("found a non-trivial set of seeded module keys (sanity)", () => {
    expect(seeded.size).toBeGreaterThan(5);
  });

  it("every declared module is seeded by a migration", () => {
    expect(sorted([...declared].filter((k) => !seeded.has(k)))).toEqual([]);
  });

  it("every seeded module is declared in APP_MODULES", () => {
    expect(sorted([...seeded].filter((k) => !declared.has(k)))).toEqual([]);
  });

  it("every declared module is toggleable via the API allow-list", () => {
    expect(sorted([...declared].filter((k) => !catalog.has(k)))).toEqual([]);
  });

  it("the API allow-list carries no module the SPA doesn't know", () => {
    expect(sorted([...catalog].filter((k) => !declared.has(k)))).toEqual([]);
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
  // The console surfaces an operator needs to run the business — and to
  // find the switch that turns a module back ON — must never themselves
  // be behind a module. A `module.*` key covering Control Center would
  // let a tenant lock itself out of its own settings with one click, with
  // no in-app way to recover.
  const APPSHELL_SRC = readFileSync(
    join(
      REPO_ROOT,
      "artifacts",
      "cpap-fitter",
      "src",
      "components",
      "admin",
      "AppShell.tsx",
    ),
    "utf8",
  );
  // Scope to the full-console nav. The scoped-down MASK_FITTER / LOCKED
  // navs are separate arrays that carry no module tags at all (a paywalled
  // or fitter-only tenant already has a curated nav), so matching against
  // the whole file would count their entries too.
  const NAV_START = APPSHELL_SRC.indexOf("const NAV_GROUPS");
  const NAV_END = APPSHELL_SRC.indexOf("const MASK_FITTER_NAV_GROUPS");
  expect(NAV_START).toBeGreaterThan(-1);
  expect(NAV_END).toBeGreaterThan(NAV_START);
  const APPSHELL = APPSHELL_SRC.slice(NAV_START, NAV_END);

  const PROTECTED_HREFS = [
    "/admin", // dashboard
    "/admin/patients",
    "/admin/settings",
    "/admin/team",
    "/admin/security",
    "/admin/control-center",
    "/admin/system/configuration",
    "/admin/billing/package", // how a tenant pays us
  ];

  for (const href of PROTECTED_HREFS) {
    it(`leaves ${href} reachable with every module off`, () => {
      const idx = APPSHELL.indexOf(`href: "${href}",`);
      expect(idx, `${href} missing from NAV_GROUPS`).toBeGreaterThan(-1);
      // The entry's own object literal — up to the closing brace of the
      // entry — must not carry a requiredFeature.
      const block = APPSHELL.slice(idx, APPSHELL.indexOf("},", idx));
      expect(block).not.toContain("requiredFeature");
    });
  }

  it("keeps Plan & billing outside the Billing module", () => {
    // /admin/billing/package appears twice: inside Billing > Tools (which
    // the module hides) and under Settings (which it must not). The
    // Settings copy is what keeps a cash-pay tenant able to manage their
    // subscription.
    const occurrences =
      APPSHELL.split('href: "/admin/billing/package",').length - 1;
    expect(occurrences).toBe(2);
    expect(APPSHELL).toContain('label: "Plan & billing",');
    expect(APPSHELL).toContain('label: "Package & usage",');
  });
});
