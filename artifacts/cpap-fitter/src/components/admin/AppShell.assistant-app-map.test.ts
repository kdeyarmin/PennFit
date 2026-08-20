// Drift guard: the PennPilot knowledge base must know every page in the nav.
//
// The admin assistant's whole first job is "where is the page that does X"
// (see adminAssistantKnowledge.ts). It answers from APP_MAP_SECTION — a
// hand-written prose map of the sidebar — and nothing tied that prose to
// NAV_GROUPS, which is the sidebar. So the failure mode is silent and
// one-directional: a page ships, gets a nav entry, and the assistant
// confidently tells operators it doesn't exist. That had already happened
// to 29 pages, among them the entire clinical-fitter suite (Fit review,
// Mask catalog, Formulary, Safety screening), Front Desk, the referral
// reviewer, insurance discovery, ADR, and audit readiness.
//
// This test fails when a nav href has no mention in the knowledge base, so
// adding a page to the sidebar forces a line in the map in the same change.
// It checks one direction only — the map is allowed to describe things that
// aren't nav entries (the top-header Video visit button, the platform
// console, redirects like /admin/email-inbox).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NAV_GROUPS } from "./AppShell";
import { flattenTargets } from "./nav-traversal";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// allow-source-read: the knowledge base is a module-level template literal
// in a SIBLING PACKAGE (resupply-api) that this SPA package must not import
// at runtime — it is a server-side LLM prompt, not served over any
// endpoint. Reading the literal is the only way to compare the two, exactly
// as AppShell.mask-fitter-scope.test.ts reads the server's route allowlist.
const KNOWLEDGE_SRC = readFileSync(
  path.resolve(
    __dirname,
    "../../../../resupply-api/src/lib/admin-assistant/adminAssistantKnowledge.ts",
  ),
  "utf8",
);

function appMapSection(): string {
  const marker = "const APP_MAP_SECTION = `";
  const start = KNOWLEDGE_SRC.indexOf(marker);
  if (start < 0) throw new Error("APP_MAP_SECTION literal not found");
  const bodyStart = start + marker.length;
  const end = KNOWLEDGE_SRC.indexOf("`;", bodyStart);
  if (end < 0) throw new Error("APP_MAP_SECTION is unterminated");
  return KNOWLEDGE_SRC.slice(bodyStart, end);
}

/** Every href the sidebar can navigate to, deduplicated. */
function navHrefs(): string[] {
  return [...new Set(flattenTargets(NAV_GROUPS).map((t) => t.href))];
}

describe("PennPilot app map vs the admin sidebar", () => {
  const APP_MAP = appMapSection();

  it("parses a substantial map and a full nav (sanity)", () => {
    expect(APP_MAP.length).toBeGreaterThan(2000);
    expect(navHrefs().length).toBeGreaterThan(100);
  });

  it("mentions every page reachable from the sidebar", () => {
    // A shorter href is a prefix of longer ones ("/admin/analytics" sits
    // inside "/admin/analytics/margin"), so a mention only counts when the
    // path ENDS there. Scan every occurrence, not just the first — the
    // first is usually the deeper route.
    const mentioned = (href: string): boolean => {
      for (
        let i = APP_MAP.indexOf(href);
        i >= 0;
        i = APP_MAP.indexOf(href, i + 1)
      ) {
        const next = APP_MAP[i + href.length] ?? "";
        if (!/[a-z0-9\-/]/i.test(next)) return true;
      }
      return false;
    };
    const missing = navHrefs().filter((href) => !mentioned(href));
    expect(
      missing,
      `sidebar page(s) missing from adminAssistantKnowledge APP_MAP_SECTION: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
