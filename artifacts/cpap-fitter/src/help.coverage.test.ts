// Static guard for Help Center coverage.
//
// The /help index (`pages/help.tsx`) is a hand-maintained list of
// topics, and each topic's article is a hand-registered route in
// `App.tsx`. Nothing ties them together, so the failure modes are
// silent: an article ships without an index card (patients can never
// find it), or an index card points at a route that was never
// registered (404 from the help hub). This test parses both files and
// fails when the two sets of /help/* paths drift apart — making the
// index an honest registry of every published article.
//
// When adding a help article you must therefore do all three steps:
//   1. create pages/help-<slug>.tsx,
//   2. register <Route path="/help/<slug>"> in App.tsx,
//   3. add a topic card for it in pages/help.tsx.
//
// allow-source-read: structural registry invariant (router ↔ help index
// cross-check) with no behavioral equivalent — rendering the whole app
// to enumerate registered routes would couple this guard to every
// page's runtime dependencies. Same pattern as admin.scope.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = readFileSync(path.join(__dirname, "App.tsx"), "utf8");
const HELP_TSX = readFileSync(
  path.join(__dirname, "pages", "help.tsx"),
  "utf8",
);

function extract(pattern: RegExp, src: string): Set<string> {
  const out = new Set<string>();
  for (const match of src.matchAll(pattern)) {
    out.add(match[1]!);
  }
  return out;
}

// Routes registered in the router: path="/help/<slug>".
const routedArticles = extract(/path="(\/help\/[^"]+)"/g, APP_TSX);

// Topics listed (or cross-promoted) on the help hub: href: "/help/<slug>".
const indexedArticles = extract(/href: "(\/help\/[^"]+)"/g, HELP_TSX);

describe("help center coverage", () => {
  it("registers at least the original ten articles (sanity)", () => {
    expect(routedArticles.size).toBeGreaterThanOrEqual(10);
  });

  it("every routed /help/* article has a card on the help index", () => {
    const missingFromIndex = [...routedArticles].filter(
      (route) => !indexedArticles.has(route),
    );
    expect(
      missingFromIndex,
      `These /help routes exist in App.tsx but have no topic card in ` +
        `pages/help.tsx — patients can't discover them from the hub: ` +
        missingFromIndex.join(", "),
    ).toEqual([]);
  });

  it("every help-index card points at a registered route", () => {
    const missingRoutes = [...indexedArticles].filter(
      (href) => !routedArticles.has(href),
    );
    expect(
      missingRoutes,
      `These hrefs appear on the help index in pages/help.tsx but have ` +
        `no <Route> in App.tsx — they would 404: ` +
        missingRoutes.join(", "),
    ).toEqual([]);
  });
});
