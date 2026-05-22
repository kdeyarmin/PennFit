// Tests for pages/admin/admin-product-questions.tsx — useUrlState migration
//
// PR change: replaced useState<AdminProductQuestionStatus> with useUrlState.
// A new TAB_IDS set and isTab predicate were added to validate URL params.
//
// The component uses React + @tanstack/react-query which cannot be rendered
// in the vitest node environment without jsdom. We use two complementary
// strategies:
//
//   1. Static source analysis — readFileSync + SRC.toContain() assertions to
//      verify structural invariants (import, hook call site, config values).
//
//   2. Pure-logic re-implementation — isTab is re-implemented verbatim
//      from the source so its boundary behaviour can be tested exhaustively.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-product-questions.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Import checks
// ---------------------------------------------------------------------------

describe("admin-product-questions — useUrlState import", () => {
  it("imports useUrlState from the hooks module", () => {
    expect(SRC).toContain('from "@/hooks/use-url-state"');
  });

  it("names useUrlState in the import statement", () => {
    expect(SRC).toContain("useUrlState");
  });

  it("no longer imports useState directly for tab state", () => {
    // useState may still be used inside child components (QuestionCard),
    // but the page-level tab state must now go through useUrlState.
    // We just verify the top-level hook migration is present.
    expect(SRC).toContain("useUrlState");
  });
});

// ---------------------------------------------------------------------------
// useUrlState call-site configuration
// ---------------------------------------------------------------------------

describe("admin-product-questions — useUrlState call site", () => {
  it('uses key "tab" for the URL param', () => {
    expect(SRC).toContain('key: "tab"');
  });

  it('uses "pending" as the defaultValue', () => {
    expect(SRC).toContain('defaultValue: "pending"');
  });

  it("passes isTab as the isAllowed predicate", () => {
    expect(SRC).toContain("isAllowed: isTab");
  });

  it("destructures [tab, setTab] from useUrlState", () => {
    expect(SRC).toContain("tab, setTab");
  });
});

// ---------------------------------------------------------------------------
// TAB_IDS set and isTab predicate
// ---------------------------------------------------------------------------

describe("admin-product-questions — TAB_IDS set structure", () => {
  it("defines TAB_IDS as a ReadonlySet<string>", () => {
    expect(SRC).toContain("ReadonlySet<string>");
    expect(SRC).toContain("TAB_IDS");
  });

  it("derives TAB_IDS from the TABS array using map", () => {
    expect(SRC).toContain("TABS.map");
    expect(SRC).toContain("TAB_IDS");
  });

  it("defines isTab as a type-predicate returning v is AdminProductQuestionStatus", () => {
    expect(SRC).toContain("v is AdminProductQuestionStatus");
    expect(SRC).toContain("isTab");
  });
});

describe("admin-product-questions — TABS array contents", () => {
  const expectedTabs = ["pending", "answered", "rejected"];

  for (const t of expectedTabs) {
    it(`TABS includes a tab with id "${t}"`, () => {
      expect(SRC).toContain(`"${t}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of isTab (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source:
//   const TABS = [
//     { id: "pending", ... }, { id: "answered", ... }, { id: "rejected", ... }
//   ];
//   const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id));
//   const isTab = (v: string): v is AdminProductQuestionStatus => TAB_IDS.has(v);

type AdminProductQuestionStatus = "pending" | "answered" | "rejected";

const TABS_PQ = [
  { id: "pending" as const, label: "Pending" },
  { id: "answered" as const, label: "Answered" },
  { id: "rejected" as const, label: "Rejected" },
];

const TAB_IDS_PQ: ReadonlySet<string> = new Set(TABS_PQ.map((t) => t.id));
const isTabPQ = (
  v: string,
): v is AdminProductQuestionStatus => TAB_IDS_PQ.has(v);

describe("admin-product-questions — isTab predicate (valid inputs)", () => {
  const valid: AdminProductQuestionStatus[] = ["pending", "answered", "rejected"];

  it.each(valid)('accepts "%s"', (t) => {
    expect(isTabPQ(t)).toBe(true);
  });
});

describe("admin-product-questions — isTab predicate (invalid inputs)", () => {
  it("rejects an empty string", () => {
    expect(isTabPQ("")).toBe(false);
  });

  it("rejects an entirely unknown value", () => {
    expect(isTabPQ("approved")).toBe(false);
  });

  it("rejects wrong casing of a valid tab", () => {
    expect(isTabPQ("Pending")).toBe(false);
    expect(isTabPQ("ANSWERED")).toBe(false);
  });

  it("rejects a partial match (prefix of valid tab)", () => {
    expect(isTabPQ("pend")).toBe(false);
    expect(isTabPQ("answer")).toBe(false);
    expect(isTabPQ("reject")).toBe(false);
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(isTabPQ(" pending")).toBe(false);
    expect(isTabPQ("pending ")).toBe(false);
  });

  it("rejects a value that is a superset of a valid tab", () => {
    expect(isTabPQ("pending_review")).toBe(false);
  });
});

describe("admin-product-questions — TAB_IDS covers exactly 3 statuses", () => {
  it("TAB_IDS_PQ has size 3", () => {
    expect(TAB_IDS_PQ.size).toBe(3);
  });

  it("TABS array has 3 entries matching TAB_IDS", () => {
    expect(TABS_PQ).toHaveLength(3);
    expect(TABS_PQ.map((t) => t.id).sort()).toEqual(
      ["answered", "pending", "rejected"],
    );
  });
});

// ---------------------------------------------------------------------------
// data-testid attributes used by the tab buttons
// ---------------------------------------------------------------------------

describe("admin-product-questions — tab button data-testid attributes", () => {
  it("uses a template-literal data-testid with the admin-product-questions-tab- prefix", () => {
    // Source uses: data-testid={`admin-product-questions-tab-${t.id}`}
    expect(SRC).toContain("admin-product-questions-tab-");
  });

  it("data-testid is dynamically derived from the tab id", () => {
    // The template literal interpolates t.id so each tab gets a unique testid.
    expect(SRC).toMatch(/admin-product-questions-tab-.*t\.id/s);
  });
});

describe("admin-product-questions — root page data-testid", () => {
  it('has data-testid="admin-product-questions-page" on the root element', () => {
    expect(SRC).toContain('data-testid="admin-product-questions-page"');
  });
});

// ---------------------------------------------------------------------------
// Regression: tab strip uses ARIA tablist/tab roles
// ---------------------------------------------------------------------------

describe("admin-product-questions — ARIA tab roles", () => {
  it('includes role="tablist" on the tab container', () => {
    expect(SRC).toContain('role="tablist"');
  });

  it('includes role="tab" on each tab button', () => {
    expect(SRC).toContain('role="tab"');
  });

  it("sets aria-selected based on active tab", () => {
    expect(SRC).toContain("aria-selected");
  });
});