// Structural guards for the staff Help Center (/admin/resources).
//
// The content is hand-written prose, so the failure modes are silent
// rather than loud: a how-to that points at a page nobody registered, a
// `related` slug that was renamed, a duplicate anchor id that makes a
// deep link ambiguous. None of those throw at runtime — the reader just
// lands somewhere wrong.
//
// The important assertion is the last one: every /admin/... path the
// content mentions must be a real console page. The console's NAV_GROUPS
// (components/admin/AppShell.tsx) is the authority for what exists, so
// this parses it and cross-checks. Adding a help article that references
// a page that was never built now fails CI instead of shipping.
//
// allow-source-read: registry invariant across two hand-maintained
// sources (help content ↔ console nav) with no behavioral equivalent —
// rendering the whole console to enumerate its nav would couple this
// guard to every page's runtime dependencies. Same pattern as
// help.coverage.test.ts and admin.scope.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FAQ_ENTRIES,
  GUIDE_SECTIONS,
  HELP_CATEGORIES,
  HOW_TO_GUIDES,
  getHowTo,
  referencedConsolePaths,
  searchHelp,
  searchIndexSize,
} from "./index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "..");

const APP_SHELL = readFileSync(
  path.join(SRC_ROOT, "components", "admin", "AppShell.tsx"),
  "utf8",
);
const CONSOLE_TSX = readFileSync(
  path.join(SRC_ROOT, "pages", "admin", "console.tsx"),
  "utf8",
);

/** Every `/admin/...` destination the sidebar can navigate to. */
const NAV_PATHS = new Set<string>(
  [...APP_SHELL.matchAll(/href:\s*["'](\/admin[^"']*)["']/g)].map((m) => m[1]!),
);

/**
 * Console pages that are real but are not sidebar entries — reachable
 * from a chart, the top header, or a redirect. Keep this list short and
 * justified; it is the escape hatch the cross-check depends on.
 */
const NON_NAV_PATHS = new Set<string>([
  "/admin/resources/faq",
  "/admin/resources/user-guide",
  // A real registered route (console.tsx) reached from the Config
  // card-grid rather than the sidebar.
  "/admin/billing/config/modifier-rules",
]);

describe("help content — identifiers", () => {
  it("how-to slugs are unique", () => {
    const slugs = HOW_TO_GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("user-guide section ids are unique", () => {
    const ids = GUIDE_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("FAQ ids are unique", () => {
    const ids = FAQ_ENTRIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("slugs and anchor ids are URL-safe", () => {
    const bad = [
      ...HOW_TO_GUIDES.map((g) => g.slug),
      ...GUIDE_SECTIONS.map((s) => s.id),
      ...FAQ_ENTRIES.map((f) => f.id),
    ].filter((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
    expect(bad, `Not lowercase-kebab: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("help content — cross-references resolve", () => {
  it("every how-to `related` slug points at a real how-to", () => {
    const broken: string[] = [];
    for (const g of HOW_TO_GUIDES) {
      for (const slug of g.related ?? []) {
        if (!getHowTo(slug)) broken.push(`${g.slug} → ${slug}`);
      }
    }
    expect(broken, `Dangling related links: ${broken.join(", ")}`).toEqual([]);
  });

  it("every FAQ `seeAlso` slug points at a real how-to", () => {
    const broken = FAQ_ENTRIES.filter(
      (f) => f.seeAlso && !getHowTo(f.seeAlso),
    ).map((f) => `${f.id} → ${f.seeAlso}`);
    expect(broken, `Dangling seeAlso links: ${broken.join(", ")}`).toEqual([]);
  });

  it("every category in use is a declared category", () => {
    const declared = new Set(HELP_CATEGORIES.map((c) => c.id));
    const used = new Set<string>([
      ...HOW_TO_GUIDES.map((g) => g.category),
      ...GUIDE_SECTIONS.map((s) => s.category),
      ...FAQ_ENTRIES.map((f) => f.category),
    ]);
    const unknown = [...used].filter((c) => !declared.has(c as never));
    expect(unknown, `Undeclared categories: ${unknown.join(", ")}`).toEqual([]);
  });

  it("every declared category has at least one how-to", () => {
    const empty = HELP_CATEGORIES.filter(
      (c) => !HOW_TO_GUIDES.some((g) => g.category === c.id),
    ).map((c) => c.id);
    expect(empty, `Categories with no how-to: ${empty.join(", ")}`).toEqual([]);
  });
});

describe("help content — editorial shape", () => {
  it("every how-to has steps and a primary page", () => {
    for (const g of HOW_TO_GUIDES) {
      expect(g.steps.length, `${g.slug} has no steps`).toBeGreaterThan(0);
      expect(g.summary.length, `${g.slug} has no summary`).toBeGreaterThan(0);
      expect(g.primaryPath.startsWith("/admin"), g.slug).toBe(true);
    }
  });

  it("some how-tos are featured on the hub, but not all of them", () => {
    const featured = HOW_TO_GUIDES.filter((g) => g.featured);
    expect(featured.length).toBeGreaterThan(0);
    expect(featured.length).toBeLessThan(HOW_TO_GUIDES.length);
  });

  it("every user-guide section has content", () => {
    for (const s of GUIDE_SECTIONS) {
      expect(s.blocks.length, `${s.id} has no blocks`).toBeGreaterThan(0);
    }
  });

  it("every FAQ entry has an answer", () => {
    for (const f of FAQ_ENTRIES) {
      expect(f.answer.length, `${f.id} has no answer`).toBeGreaterThan(0);
    }
  });
});

describe("help search", () => {
  it("indexes all three content types", () => {
    expect(searchIndexSize()).toBe(
      HOW_TO_GUIDES.length + GUIDE_SECTIONS.length + FAQ_ENTRIES.length,
    );
  });

  it("returns nothing for an empty query", () => {
    expect(searchHelp("   ")).toEqual([]);
  });

  it("finds a how-to by a word in its title", () => {
    const hits = searchHelp("denials");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.id === "work-the-denials-worklist")).toBe(true);
  });

  it("finds an answer by a keyword that is not in the prose", () => {
    // "unsubscribe" appears only in the STOP entry's keywords.
    const hits = searchHelp("unsubscribe");
    expect(hits.some((h) => h.id === "patient-said-stop")).toBe(true);
  });

  it("narrows rather than widens as terms are added", () => {
    const one = searchHelp("insurance", 50).length;
    const two = searchHelp("insurance verify", 50).length;
    expect(two).toBeLessThanOrEqual(one);
    expect(two).toBeGreaterThan(0);
  });

  it("respects the result limit", () => {
    expect(searchHelp("a", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("help content — every referenced console page exists", () => {
  it("cross-checks every /admin/... path against the console nav", () => {
    const unknown = referencedConsolePaths().filter(
      (p) => !NAV_PATHS.has(p) && !NON_NAV_PATHS.has(p),
    );
    expect(
      unknown,
      `The Help Center points at these /admin paths, but they are neither ` +
        `a NAV_GROUPS entry in AppShell.tsx nor in the NON_NAV_PATHS ` +
        `allowlist — a reader would land on a page that does not exist: ` +
        unknown.join(", "),
    ).toEqual([]);
  });

  it("sanity: the nav parse found a realistic number of pages", () => {
    // Guards the guard — if the AppShell regex ever stops matching, the
    // cross-check above would pass vacuously.
    expect(NAV_PATHS.size).toBeGreaterThan(80);
  });
});

describe("help center routes are registered", () => {
  for (const [routePath, component] of [
    ["/admin/resources", "AdminResourcesPage"],
    ["/admin/resources/how-to/:slug", "AdminResourceHowToPage"],
    ["/admin/resources/user-guide", "AdminResourceUserGuidePage"],
    ["/admin/resources/faq", "AdminResourceFaqPage"],
  ] as const) {
    it(`registers ${routePath}`, () => {
      expect(CONSOLE_TSX).toContain(`path="${routePath}"`);
      expect(CONSOLE_TSX).toContain(`component={${component}}`);
    });
  }

  it("registers the specific /admin/resources/* pages before the hub", () => {
    // wouter's <Switch> takes the first match, so the bare hub route must
    // come last or it would swallow the sub-pages.
    const hub = CONSOLE_TSX.indexOf('path="/admin/resources"');
    for (const sub of [
      'path="/admin/resources/how-to/:slug"',
      'path="/admin/resources/user-guide"',
      'path="/admin/resources/faq"',
    ]) {
      expect(CONSOLE_TSX.indexOf(sub), sub).toBeLessThan(hub);
    }
  });

  it("keeps the Help & Resources nav entry pointing at the hub", () => {
    expect(APP_SHELL).toContain('href: "/admin/resources"');
    // matchPrefix keeps the sidebar entry highlighted on the sub-pages.
    expect(APP_SHELL).toContain('matchPrefix: "/admin/resources"');
  });
});
