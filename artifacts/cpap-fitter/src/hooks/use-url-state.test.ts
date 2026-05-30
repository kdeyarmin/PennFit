// Tests for hooks/use-url-state.ts
//
// useUrlState is a React hook that persists a string-enum state value in a
// URL search parameter. Because the vitest environment is "node" (no jsdom),
// we cannot render the hook directly. We use two complementary strategies:
//
//   1. Static source analysis — readFileSync on the hook source and assert
//      structural invariants: correct exports, use of replaceState (not
//      pushState), popstate listener wiring, and the SSR guard.
//
//   2. Pure-logic re-implementation — the hook's two non-trivial pure
//      computations (reading from URLSearchParams, building the next URL)
//      are re-implemented verbatim here as standalone functions so they can
//      be tested exhaustively without React or a DOM environment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "use-url-state.ts"), "utf8");

// ---------------------------------------------------------------------------
// Structural / static checks
// ---------------------------------------------------------------------------

describe("use-url-state — exports", () => {
  it("exports the useUrlState function", () => {
    expect(SRC).toContain("export function useUrlState");
  });

  it("exports the UseUrlStateOptions interface", () => {
    expect(SRC).toContain("export interface UseUrlStateOptions");
  });
});

describe("use-url-state — uses replaceState, not pushState", () => {
  it("calls history.replaceState to avoid polluting back-history", () => {
    expect(SRC).toContain("replaceState");
  });

  it("documents the preference for replaceState over pushState in the file header", () => {
    // The comment explains the design decision. We verify the word 'replaceState'
    // appears in the implementation (non-comment code) as well as documentation.
    const implementationLine = SRC.split("\n").find(
      (line) =>
        !line.trimStart().startsWith("//") && line.includes("replaceState"),
    );
    expect(implementationLine).toBeDefined();
  });
});

describe("use-url-state — popstate listener", () => {
  it("adds a popstate event listener to support browser back/forward", () => {
    expect(SRC).toContain('addEventListener("popstate"');
  });

  it("removes the popstate listener on cleanup (useEffect return)", () => {
    expect(SRC).toContain('removeEventListener("popstate"');
  });
});

describe("use-url-state — SSR guard", () => {
  it('guards both read and set paths with typeof window === "undefined"', () => {
    // The phrase appears at least twice: once in read(), once in setValue().
    const matches = SRC.match(/typeof window === "undefined"/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("use-url-state — default-value URL cleanup", () => {
  it("deletes the param from the URL when next equals the default", () => {
    // Source should delete the key rather than set it to the default string.
    expect(SRC).toContain("params.delete(key)");
  });

  it("sets the param when next differs from the default", () => {
    expect(SRC).toContain("params.set(key, next)");
  });
});

describe("use-url-state — URL construction includes hash", () => {
  it("appends window.location.hash to the rebuilt URL", () => {
    expect(SRC).toContain("window.location.hash");
  });
});

describe("use-url-state — react imports", () => {
  it("imports useState from react", () => {
    expect(SRC).toContain("useState");
  });

  it("imports useEffect from react", () => {
    expect(SRC).toContain("useEffect");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementations (verbatim from the hook source)
// ---------------------------------------------------------------------------
//
// read() in the hook:
//
//   const raw = new URLSearchParams(window.location.search).get(key);
//   return raw && isAllowed(raw) ? raw : defaultValue;
//
// We extract this as a standalone function parameterised on the search string
// so tests don't need window at all.

function read<T extends string>(
  search: string,
  key: string,
  defaultValue: T,
  isAllowed: (v: string) => v is T,
): T {
  const raw = new URLSearchParams(search).get(key);
  return raw && isAllowed(raw) ? raw : defaultValue;
}

// buildUrl() in the hook's setValue:
//
//   const params = new URLSearchParams(window.location.search);
//   if (next === defaultValue) params.delete(key);
//   else params.set(key, next);
//   const qs = params.toString();
//   const newUrl =
//     window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;

function buildUrl(
  key: string,
  defaultValue: string,
  next: string,
  currentSearch: string,
  pathname: string,
  hash: string,
): string {
  const params = new URLSearchParams(currentSearch);
  if (next === defaultValue) params.delete(key);
  else params.set(key, next);
  const qs = params.toString();
  return pathname + (qs ? `?${qs}` : "") + hash;
}

type Tab = "open" | "approved" | "rejected" | "all";
const ALLOWED = new Set<Tab>(["open", "approved", "rejected", "all"]);
const isTab = (v: string): v is Tab => ALLOWED.has(v as Tab);

// ---------------------------------------------------------------------------
// read() — initial value from URLSearchParams
// ---------------------------------------------------------------------------

describe("useUrlState read logic — returns defaultValue on missing param", () => {
  it("returns the default when the search string is empty", () => {
    expect(read("", "tab", "open" as Tab, isTab)).toBe("open");
  });

  it("returns the default when the key is absent from the search string", () => {
    expect(read("?other=foo", "tab", "open" as Tab, isTab)).toBe("open");
  });

  it("returns the default when the key is present but its value is empty", () => {
    expect(read("?tab=", "tab", "open" as Tab, isTab)).toBe("open");
  });
});

describe("useUrlState read logic — returns param when allowed", () => {
  it("returns a valid non-default value found in the search string", () => {
    expect(read("?tab=approved", "tab", "open" as Tab, isTab)).toBe("approved");
  });

  it("returns the default value itself when it is explicitly present in the URL", () => {
    // ?tab=open is the default — hook returns it (the URL is non-canonical
    // but the value is still valid per isAllowed).
    expect(read("?tab=open", "tab", "open" as Tab, isTab)).toBe("open");
  });

  it("handles a param that is not the first in the query string", () => {
    expect(read("?foo=bar&tab=rejected", "tab", "open" as Tab, isTab)).toBe(
      "rejected",
    );
  });

  it("handles a param that is followed by additional params", () => {
    expect(read("?tab=all&foo=bar", "tab", "open" as Tab, isTab)).toBe("all");
  });
});

describe("useUrlState read logic — coerces disallowed values to default", () => {
  it("returns the default for a completely unknown value", () => {
    expect(read("?tab=unknown", "tab", "open" as Tab, isTab)).toBe("open");
  });

  it("returns the default for a value with different casing", () => {
    // isAllowed is case-sensitive by design.
    expect(read("?tab=APPROVED", "tab", "open" as Tab, isTab)).toBe("open");
  });

  it("returns the default for a partial match (prefix of a valid value)", () => {
    expect(read("?tab=appro", "tab", "open" as Tab, isTab)).toBe("open");
  });

  it("returns the default for a SQL-injection-style value", () => {
    expect(read("?tab=open%27+OR+1%3D1", "tab", "open" as Tab, isTab)).toBe(
      "open",
    );
  });
});

// ---------------------------------------------------------------------------
// buildUrl() — URL construction in setValue
// ---------------------------------------------------------------------------

describe("useUrlState buildUrl logic — default value removes the param", () => {
  it("produces a clean pathname with no query string when next is the default", () => {
    expect(buildUrl("tab", "open", "open", "", "/admin/reviews", "")).toBe(
      "/admin/reviews",
    );
  });

  it("removes only the managed key and preserves unrelated params", () => {
    const result = buildUrl(
      "tab",
      "open",
      "open",
      "?tab=approved&page=2",
      "/admin/reviews",
      "",
    );
    expect(result).toBe("/admin/reviews?page=2");
  });

  it("removes param even when it appears mid-string", () => {
    const result = buildUrl(
      "tab",
      "open",
      "open",
      "?foo=1&tab=rejected&bar=2",
      "/admin",
      "",
    );
    expect(result).not.toContain("tab=");
    expect(result).toContain("foo=1");
    expect(result).toContain("bar=2");
  });
});

describe("useUrlState buildUrl logic — non-default value sets the param", () => {
  it("appends the key=value query string for a non-default value", () => {
    expect(buildUrl("tab", "open", "approved", "", "/admin/reviews", "")).toBe(
      "/admin/reviews?tab=approved",
    );
  });

  it("replaces an existing value for the same key", () => {
    const result = buildUrl(
      "tab",
      "open",
      "rejected",
      "?tab=approved",
      "/admin/reviews",
      "",
    );
    expect(result).toBe("/admin/reviews?tab=rejected");
  });

  it("preserves unrelated params when adding a new key", () => {
    const result = buildUrl("tab", "open", "all", "?page=3", "/admin", "");
    expect(result).toContain("tab=all");
    expect(result).toContain("page=3");
  });
});

describe("useUrlState buildUrl logic — hash is preserved", () => {
  it("appends a non-empty hash to the rebuilt URL", () => {
    const result = buildUrl(
      "tab",
      "open",
      "approved",
      "",
      "/admin/reviews",
      "#section",
    );
    expect(result).toBe("/admin/reviews?tab=approved#section");
  });

  it("appends hash even when no query params remain", () => {
    const result = buildUrl(
      "tab",
      "open",
      "open",
      "?tab=approved",
      "/admin",
      "#top",
    );
    expect(result).toBe("/admin#top");
  });

  it("does not add a stray hash when hash is empty", () => {
    const result = buildUrl("tab", "open", "open", "", "/admin", "");
    expect(result).toBe("/admin");
  });
});

describe("useUrlState buildUrl logic — edge cases", () => {
  it("handles a key whose name appears as a substring of another key", () => {
    // 'tab' vs 'stable' — URLSearchParams must not confuse them.
    const result = buildUrl(
      "tab",
      "open",
      "approved",
      "?stable=1",
      "/admin",
      "",
    );
    expect(result).toContain("tab=approved");
    expect(result).toContain("stable=1");
  });

  it("handles special characters in unrelated param values", () => {
    const result = buildUrl(
      "tab",
      "open",
      "approved",
      "?q=hello+world",
      "/admin",
      "",
    );
    expect(result).toContain("tab=approved");
  });
});
