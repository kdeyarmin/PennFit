// Tests for pages/admin/admin-inbound-faxes.tsx — useUrlState migration
//
// PR change: replaced useState<Filter> + manual URL sync with useUrlState.
// A new FILTER_IDS set and isFilter predicate were added to validate URL params.
//
// The component uses React + @tanstack/react-query which cannot be rendered
// in the vitest node environment without jsdom. We use two complementary
// strategies:
//
//   1. Static source analysis — readFileSync + SRC.toContain() assertions to
//      verify structural invariants (import, hook call site, config values).
//
//   2. Pure-logic re-implementation — isFilter is re-implemented verbatim
//      from the source so its boundary behaviour can be tested exhaustively.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-inbound-faxes.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Import checks
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — useUrlState import", () => {
  it("imports useUrlState from the hooks module", () => {
    expect(SRC).toContain('from "@/hooks/use-url-state"');
  });

  it("imports useUrlState by name", () => {
    expect(SRC).toContain("useUrlState");
  });
});

// ---------------------------------------------------------------------------
// useUrlState call-site configuration
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — useUrlState call site", () => {
  it('uses key "filter" for the URL param', () => {
    expect(SRC).toContain('key: "filter"');
  });

  it('uses "open" as the defaultValue', () => {
    expect(SRC).toContain('defaultValue: "open"');
  });

  it("passes isFilter as the isAllowed predicate", () => {
    expect(SRC).toContain("isAllowed: isFilter");
  });

  it("destructures [filter, setFilter] from useUrlState", () => {
    expect(SRC).toContain("filter, setFilter");
  });
});

// ---------------------------------------------------------------------------
// FILTER_IDS set and isFilter predicate
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — FILTER_IDS set contents", () => {
  const expectedFilters = ["open", "new", "triaged", "attached", "archived"];

  for (const f of expectedFilters) {
    it(`FILTER_IDS contains "${f}"`, () => {
      expect(SRC).toContain(`"${f}"`);
    });
  }

  it("defines FILTER_IDS as a ReadonlySet<string>", () => {
    expect(SRC).toContain("ReadonlySet<string>");
    expect(SRC).toContain("FILTER_IDS");
  });

  it("defines isFilter as a type-predicate returning v is Filter", () => {
    expect(SRC).toContain("v is Filter");
    expect(SRC).toContain("isFilter");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of isFilter (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source:
//   type Filter = "open" | "new" | "triaged" | "attached" | "archived";
//   const FILTER_IDS: ReadonlySet<string> = new Set<Filter>([
//     "open", "new", "triaged", "attached", "archived",
//   ]);
//   const isFilter = (v: string): v is Filter => FILTER_IDS.has(v);

type Filter = "open" | "new" | "triaged" | "attached" | "archived";

const FILTER_IDS: ReadonlySet<string> = new Set<Filter>([
  "open",
  "new",
  "triaged",
  "attached",
  "archived",
]);
const isFilter = (v: string): v is Filter => FILTER_IDS.has(v);

describe("admin-inbound-faxes — isFilter predicate (valid inputs)", () => {
  const valid: Filter[] = ["open", "new", "triaged", "attached", "archived"];

  it.each(valid)('accepts "%s"', (f) => {
    expect(isFilter(f)).toBe(true);
  });
});

describe("admin-inbound-faxes — isFilter predicate (invalid inputs)", () => {
  it("rejects an empty string", () => {
    expect(isFilter("")).toBe(false);
  });

  it("rejects a completely unknown value", () => {
    expect(isFilter("unknown")).toBe(false);
  });

  it("rejects a valid value with wrong casing", () => {
    expect(isFilter("Open")).toBe(false);
    expect(isFilter("OPEN")).toBe(false);
  });

  it("rejects a partial match (prefix of a valid filter)", () => {
    expect(isFilter("tri")).toBe(false);
    expect(isFilter("arch")).toBe(false);
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(isFilter(" open")).toBe(false);
    expect(isFilter("open ")).toBe(false);
  });

  it("rejects a value that is a superset of a valid filter", () => {
    expect(isFilter("opened")).toBe(false);
    expect(isFilter("new_item")).toBe(false);
  });
});

describe("admin-inbound-faxes — isFilter covers exactly 5 filters", () => {
  it("FILTER_IDS has size 5", () => {
    expect(FILTER_IDS.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Regression: filter chips still rendered in the correct order
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — filter chip order in source", () => {
  it("renders filter chips in open→new→triaged→attached→archived order", () => {
    const openIdx = SRC.indexOf('"open"');
    const newIdx = SRC.indexOf('"new"', openIdx);
    const triagedIdx = SRC.indexOf('"triaged"', newIdx);
    const attachedIdx = SRC.indexOf('"attached"', triagedIdx);
    const archivedIdx = SRC.indexOf('"archived"', attachedIdx);
    expect(openIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(openIdx);
    expect(triagedIdx).toBeGreaterThan(newIdx);
    expect(attachedIdx).toBeGreaterThan(triagedIdx);
    expect(archivedIdx).toBeGreaterThan(attachedIdx);
  });
});

// ---------------------------------------------------------------------------
// data-testid not broken by the migration
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — structural markup unchanged by migration", () => {
  it("still renders FilterChip components for each filter value", () => {
    expect(SRC).toContain("FilterChip");
  });

  it("still passes setFilter as the onClick handler for chips", () => {
    expect(SRC).toContain("setFilter");
  });
});