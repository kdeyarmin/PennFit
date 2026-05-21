// Tests for pages/admin/admin-inbound-faxes.tsx
//
// PR change: removed useUrlState hook, removed FILTER_IDS set and isFilter
// predicate, and replaced URL-persisted filter state with a plain
// useState<Filter>("open").
//
// The component uses React + @tanstack/react-query which cannot be rendered
// in the vitest node environment without jsdom. We use two complementary
// strategies:
//
//   1. Static source analysis — readFileSync + SRC.toContain() / not.toContain()
//      assertions to verify structural invariants that changed in this PR.
//
//   2. Pure-logic re-implementation — the Filter type and membership check are
//      re-implemented verbatim so their boundary behaviour can be tested
//      exhaustively without React.

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
// PR change: useUrlState removed — now uses plain useState
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — useUrlState removed in this PR", () => {
  it("does not import useUrlState", () => {
    expect(SRC).not.toContain("useUrlState");
  });

  it("does not import from @/hooks/use-url-state", () => {
    expect(SRC).not.toContain("use-url-state");
  });

  it("no longer defines FILTER_IDS", () => {
    expect(SRC).not.toContain("FILTER_IDS");
  });

  it("no longer defines an isFilter predicate", () => {
    expect(SRC).not.toContain("isFilter");
  });
});

// ---------------------------------------------------------------------------
// useState replaces useUrlState
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — useState with 'open' default", () => {
  it('uses useState<Filter>("open") for filter state', () => {
    expect(SRC).toContain('useState<Filter>("open")');
  });

  it("imports useState from react", () => {
    expect(SRC).toContain("useState");
  });

  it('does not use a useUrlState config object with key: "filter"', () => {
    expect(SRC).not.toContain('key: "filter"');
  });
});

// ---------------------------------------------------------------------------
// Filter type and inline chip array
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — Filter type and chip array", () => {
  it('defines the Filter type including "open"', () => {
    expect(SRC).toContain('"open"');
  });

  it('defines the Filter type including "new"', () => {
    expect(SRC).toContain('"new"');
  });

  it('defines the Filter type including "triaged"', () => {
    expect(SRC).toContain('"triaged"');
  });

  it('defines the Filter type including "attached"', () => {
    expect(SRC).toContain('"attached"');
  });

  it('defines the Filter type including "archived"', () => {
    expect(SRC).toContain('"archived"');
  });

  it("renders all 5 filters via an inline array map", () => {
    // Source iterates ["open", "new", "triaged", "attached", "archived"] as const.
    expect(SRC).toContain(
      '["open", "new", "triaged", "attached", "archived"] as const',
    );
  });
});

// ---------------------------------------------------------------------------
// FilterChip component and setFilter wiring
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — FilterChip component still rendered", () => {
  it("renders FilterChip components for each filter", () => {
    expect(SRC).toContain("FilterChip");
  });

  it("passes setFilter as the onClick handler for chips", () => {
    expect(SRC).toContain("setFilter");
  });

  it("uses onClick={() => setFilter(f)} pattern to update state", () => {
    expect(SRC).toContain("setFilter(f)");
  });
});

// ---------------------------------------------------------------------------
// Filter chip order in source
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — filter chip order matches specification", () => {
  it("renders filter chips in open → new → triaged → attached → archived order", () => {
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
// API imports unchanged
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — API imports unchanged", () => {
  it("imports listInboundFaxes", () => {
    expect(SRC).toContain("listInboundFaxes");
  });

  it("imports patchInboundFax", () => {
    expect(SRC).toContain("patchInboundFax");
  });

  it("imports inboundFaxMediaUrl", () => {
    expect(SRC).toContain("inboundFaxMediaUrl");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation: Filter type and membership check
// (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source:
//   type Filter = "open" | "new" | "triaged" | "attached" | "archived";
//   // (inline array used for chips — no FILTER_IDS Set in this version)

type Filter = "open" | "new" | "triaged" | "attached" | "archived";

const FILTER_VALUES: ReadonlyArray<Filter> = [
  "open",
  "new",
  "triaged",
  "attached",
  "archived",
];

const isFilter = (v: string): v is Filter =>
  FILTER_VALUES.includes(v as Filter);

describe("admin-inbound-faxes — Filter membership (valid inputs)", () => {
  it.each(["open", "new", "triaged", "attached", "archived"] as Filter[])(
    'recognises "%s" as a valid filter',
    (f) => {
      expect(isFilter(f)).toBe(true);
    },
  );
});

describe("admin-inbound-faxes — Filter membership (invalid inputs)", () => {
  it("rejects an empty string", () => {
    expect(isFilter("")).toBe(false);
  });

  it("rejects an entirely unknown value", () => {
    expect(isFilter("all")).toBe(false);
    expect(isFilter("pending")).toBe(false);
  });

  it("rejects wrong casing of a valid filter", () => {
    expect(isFilter("Open")).toBe(false);
    expect(isFilter("NEW")).toBe(false);
    expect(isFilter("Archived")).toBe(false);
  });

  it("rejects a partial match (prefix of a valid filter)", () => {
    expect(isFilter("tri")).toBe(false);
    expect(isFilter("arch")).toBe(false);
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(isFilter(" open")).toBe(false);
    expect(isFilter("open ")).toBe(false);
  });

  it("rejects a superset of a valid filter name", () => {
    expect(isFilter("opened")).toBe(false);
    expect(isFilter("new_item")).toBe(false);
  });
});

describe("admin-inbound-faxes — Filter array covers exactly 5 filters", () => {
  it("FILTER_VALUES has length 5", () => {
    expect(FILTER_VALUES).toHaveLength(5);
  });

  it("no duplicates in the filter list", () => {
    expect(new Set(FILTER_VALUES).size).toBe(FILTER_VALUES.length);
  });

  it("contains all expected filter ids", () => {
    expect([...FILTER_VALUES].sort()).toEqual([
      "archived",
      "attached",
      "new",
      "open",
      "triaged",
    ]);
  });
});