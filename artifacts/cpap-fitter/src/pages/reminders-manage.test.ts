// Tests for pages/reminders-manage.tsx
//
// PR changes:
//   * Token is now read ONCE from window.location.search via useState initialiser
//     (replaces: const token = useMemo(() => new URLSearchParams(search).get("token") ?? "", [search]))
//   * useEffect strips the token from the URL on mount so the single-use secret
//     doesn't persist in browser history or shareable URLs.
//
// The component uses React + hooks which cannot be rendered in the node
// vitest environment without jsdom. We read the source file as a string and
// assert on the structural and security invariants that matter.
//
// The buildState helper is a pure function local to the module and is also
// verified via source-level structural checks.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "reminders-manage.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Token capture: useState initialiser (not useMemo + useSearch)
// ---------------------------------------------------------------------------
describe("reminders-manage — token captured via useState initialiser", () => {
  it("reads the token inside a useState initialiser function", () => {
    // The token is no longer driven by the reactive `useSearch` hook.
    // It is captured once at mount via useState(() => ...).
    expect(SRC).toContain("useState(() => {");
  });

  it("reads window.location.search inside the initialiser", () => {
    expect(SRC).toContain("window.location.search");
  });

  it("falls back to empty string when the token param is absent", () => {
    expect(SRC).toContain(`?? ""`);
  });

  it("does NOT re-read window.location in subsequent renders (token is constant)", () => {
    // The old code used `const [search] = useSearch()` which re-ran on navigation.
    // The new code captures once; subsequent renders never touch window.location.
    expect(SRC).not.toContain("useSearch");
  });

  it("is SSR-safe: returns empty string when window is undefined", () => {
    expect(SRC).toContain(`typeof window === "undefined"`);
  });
});

// ---------------------------------------------------------------------------
// Token stripping: useEffect removes it from the address bar on mount
// ---------------------------------------------------------------------------
describe("reminders-manage — token stripped from URL on mount via useEffect", () => {
  it("includes a useEffect with empty dependency array for the strip", () => {
    // Pattern: useEffect(() => { ... }, []);
    expect(SRC).toMatch(/useEffect\s*\(\s*\(\s*\)\s*=>/);
    expect(SRC).toContain("}, []);");
  });

  it("guards against SSR inside the strip effect", () => {
    // The effect checks typeof window === 'undefined' before accessing history.
    expect(SRC).toContain(`typeof window === "undefined"`);
  });

  it("checks that 'token' is in the search params before deleting", () => {
    expect(SRC).toContain(`params.has("token")`);
  });

  it("deletes the 'token' param before rewriting the URL", () => {
    expect(SRC).toContain(`params.delete("token")`);
  });

  it("calls history.replaceState so there is no page reload", () => {
    expect(SRC).toContain("window.history.replaceState");
  });

  it("rebuilds the path from pathname + surviving query params + hash", () => {
    expect(SRC).toContain("window.location.pathname");
    expect(SRC).toContain("window.location.hash");
    expect(SRC).toContain("params.toString()");
  });

  it("omits '?' when no query params survive the strip", () => {
    expect(SRC).toMatch(/qs \? `\?\$\{qs\}` : ""/);
  });

  it("swallows History API exceptions via try/catch", () => {
    expect(SRC).toContain("try {");
    expect(SRC).toContain("// History API not available: no-op.");
  });
});

// ---------------------------------------------------------------------------
// Imports: useSearch and useMemo removed from the import list
// ---------------------------------------------------------------------------
describe("reminders-manage — import cleanup", () => {
  it("no longer imports useSearch from wouter", () => {
    expect(SRC).not.toContain("useSearch");
  });

  it("no longer imports useMemo for the token", () => {
    // useMemo was only used for the token; it should be gone entirely.
    expect(SRC).not.toContain("useMemo");
  });
});

// ---------------------------------------------------------------------------
// buildState — structural checks (pure helper, not exported)
// ---------------------------------------------------------------------------
describe("reminders-manage — buildState helper structure", () => {
  it("defines buildState as a local function", () => {
    expect(SRC).toContain("function buildState(");
  });

  it("iterates over REMINDER_ITEMS to build per-SKU state", () => {
    expect(SRC).toContain("REMINDER_ITEMS");
    expect(SRC).toContain("for (const def of REMINDER_ITEMS)");
  });

  it("creates an enabled entry for server-provided items", () => {
    expect(SRC).toContain("enabled: true");
  });

  it("creates a disabled entry with defaults for items not on the server", () => {
    expect(SRC).toContain("enabled: false");
    expect(SRC).toContain("def.defaultIntervalDays");
  });

  it("uses todayIso() for the lastReplacedAt default of missing items", () => {
    expect(SRC).toContain("todayIso()");
  });
});

// ---------------------------------------------------------------------------
// Regression: core page behaviour still present
// ---------------------------------------------------------------------------
describe("reminders-manage — regression: core manage behaviour intact", () => {
  it("shows a 'Manage link missing' card when no token is present", () => {
    expect(SRC).toContain("Manage link missing");
  });

  it("surfaces a validation error when the user tries to save with no items selected", () => {
    expect(SRC).toContain("Pick at least one supply");
  });

  it("calls update.mutate with the token and enabled items on Save", () => {
    // The params are token-only for unauthed manage links and `{}` for
    // signed-in customers — the ternary spelling shouldn't matter to
    // this assertion.
    expect(SRC).toContain("update.mutate(");
    expect(SRC).toMatch(/params:\s*hasToken\s*\?\s*\{\s*token\s*\}/);
    // The actual payload that drives the save — a regression that
    // drops or renames `items: enabled` would silently pass the
    // params-shape check above without this.
    expect(SRC).toMatch(/data:\s*\{\s*items:\s*enabled\s*\}/);
  });

  it("calls unsub.mutate with the token (when present) on Unsubscribe", () => {
    expect(SRC).toContain("unsub.mutate(");
    expect(SRC).toMatch(/unsub\.mutate\([^)]*params:\s*hasToken\s*\?\s*\{\s*token\s*\}/s);
  });

  it("renders the unsubscribed confirmation card after successful unsubscribe", () => {
    expect(SRC).toContain("You've been unsubscribed");
  });
});

