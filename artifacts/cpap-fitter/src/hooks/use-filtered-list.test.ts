// Tests for hooks/use-filtered-list.ts
//
// The hook itself is thin React wiring (useState + useCallback). The
// interesting invariants live in the wiring, not in extractable pure
// logic, so this file leans on the source-analysis pattern used by
// use-url-state.test.ts and asserts the React composition is correct.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "use-filtered-list.ts"), "utf8");

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

describe("use-filtered-list — exports", () => {
  it("exports useFilteredList", () => {
    expect(SRC).toContain("export function useFilteredList");
  });
  it("exports the result + options interfaces", () => {
    expect(SRC).toContain("export interface UseFilteredListResult");
    expect(SRC).toContain("export interface UseFilteredListOptions");
  });
});

// ---------------------------------------------------------------------------
// Reset-offset-on-filter-change invariant — the whole reason this
// hook exists. Catches regressions if a future refactor forgets to
// reset offset in any of the three filter-mutating setters.
// ---------------------------------------------------------------------------

describe("use-filtered-list — offset resets on every filter change", () => {
  // Each setter body must end with `setOffset(0)`. We grab the chunk
  // of source between `setFilter` / `setFilters` / `clearFilters` and
  // the next `const` declaration, then assert setOffset(0) is in it.
  function bodyOf(name: string): string {
    const start = SRC.indexOf(`const ${name} = useCallback`);
    expect(start, `setter ${name} not found`).toBeGreaterThan(-1);
    // Walk forward to the matching `,\n  [`-ish closer; just take a
    // generous window. The body is small.
    return SRC.slice(start, start + 400);
  }
  it("setFilter resets offset to 0", () => {
    expect(bodyOf("setFilter")).toContain("setOffset(0)");
  });
  it("setFilters resets offset to 0", () => {
    expect(bodyOf("setFilters")).toContain("setOffset(0)");
  });
  it("clearFilters resets offset to 0", () => {
    expect(bodyOf("clearFilters")).toContain("setOffset(0)");
  });
});

// ---------------------------------------------------------------------------
// Defaults capture — clearFilters must restore the FIRST render's
// defaults, not whatever object the caller passes on a later render.
// ---------------------------------------------------------------------------

describe("use-filtered-list — defaults captured once via useRef", () => {
  it("clearFilters reads from a ref initialised at mount", () => {
    // useRef(initialFilters) — captures the first-render value;
    // clearFilters then restores from initialFiltersRef.current.
    expect(SRC).toContain("useRef(initialFilters)");
    expect(SRC).toMatch(/setFiltersState\(initialFiltersRef\.current\)/);
  });
});

// ---------------------------------------------------------------------------
// setOffset is exposed directly — pagination needs to set arbitrary
// offsets without re-triggering the filter-reset path.
// ---------------------------------------------------------------------------

describe("use-filtered-list — setOffset is returned untouched", () => {
  it("the returned setOffset is the raw useState setter", () => {
    // Not wrapped in useCallback or any reset logic — pagination
    // owns the offset and doesn't reset filters.
    expect(SRC).toMatch(/setOffset,\s*\n\s*pageSize/);
  });
});
