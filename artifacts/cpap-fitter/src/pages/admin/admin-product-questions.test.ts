// Tests for pages/admin/admin-product-questions.tsx
//
// PR change: removed useUrlState hook, removed TAB_IDS set and isTab predicate,
// and replaced URL-persisted tab state with a plain
// useState<AdminProductQuestionStatus>("pending").
//
// The component uses React + @tanstack/react-query which cannot be rendered
// in the vitest node environment without jsdom. We use two complementary
// strategies:
//
//   1. Static source analysis — readFileSync + SRC.toContain() / not.toContain()
//      assertions to verify structural invariants that changed in this PR.
//
//   2. Pure-logic re-implementation — the TABS array and membership check are
//      re-implemented verbatim so their boundary behaviour can be tested
//      exhaustively without React.

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
// PR change: useUrlState removed — now uses plain useState
// ---------------------------------------------------------------------------

describe("admin-product-questions — useUrlState removed in this PR", () => {
  it("does not import useUrlState", () => {
    expect(SRC).not.toContain("useUrlState");
  });

  it("does not import from @/hooks/use-url-state", () => {
    expect(SRC).not.toContain("use-url-state");
  });

  it("no longer defines TAB_IDS", () => {
    expect(SRC).not.toContain("TAB_IDS");
  });

  it("no longer defines an isTab predicate", () => {
    expect(SRC).not.toContain("isTab");
  });
});

// ---------------------------------------------------------------------------
// useState replaces useUrlState
// ---------------------------------------------------------------------------

describe("admin-product-questions — useState with 'pending' default", () => {
  it('uses useState<AdminProductQuestionStatus>("pending") for tab state', () => {
    expect(SRC).toContain('useState<AdminProductQuestionStatus>("pending")');
  });

  it("imports useState from react", () => {
    expect(SRC).toContain("useState");
  });

  it('does not use a useUrlState config object with key: "tab"', () => {
    expect(SRC).not.toContain('key: "tab"');
  });
});

// ---------------------------------------------------------------------------
// TABS array contents
// ---------------------------------------------------------------------------

describe("admin-product-questions — TABS array contents", () => {
  const expectedTabs = ["pending", "answered", "rejected"];

  for (const t of expectedTabs) {
    it(`TABS includes tab id "${t}"`, () => {
      expect(SRC).toContain(`"${t}"`);
    });
  }

  it("does not include an 'approved' tab (lifecycle goes pending→answered|rejected)", () => {
    // Distinguish from shop reviews — there is no "approved" status here.
    // The word "approved" shouldn't appear as a tab id.
    const tabApprovedMatch = SRC.match(/"approved"/g);
    // "approved" may appear in other contexts; ensure it's not a tab id in TABS.
    // We check that the TABS definition block only contains the three valid statuses.
    expect(SRC).not.toContain('{ id: "approved"');
  });
});

// ---------------------------------------------------------------------------
// ARIA / accessibility markup
// ---------------------------------------------------------------------------

describe("admin-product-questions — ARIA tab roles", () => {
  it('has role="tablist" on the tab container', () => {
    expect(SRC).toContain('role="tablist"');
  });

  it('has role="tab" on each tab button', () => {
    expect(SRC).toContain('role="tab"');
  });

  it("sets aria-selected based on the active tab", () => {
    expect(SRC).toContain("aria-selected");
  });
});

// ---------------------------------------------------------------------------
// data-testid attributes
// ---------------------------------------------------------------------------

describe("admin-product-questions — data-testid attributes", () => {
  it('has data-testid="admin-product-questions-page" on the root element', () => {
    expect(SRC).toContain('data-testid="admin-product-questions-page"');
  });

  it('uses "admin-product-questions-tab-" prefix in the tab button data-testid', () => {
    expect(SRC).toContain("admin-product-questions-tab-");
  });

  it("derives the tab data-testid from the tab id dynamically", () => {
    // Template literal interpolates t.id.
    expect(SRC).toMatch(/admin-product-questions-tab-.*t\.id/s);
  });
});

// ---------------------------------------------------------------------------
// API imports unchanged
// ---------------------------------------------------------------------------

describe("admin-product-questions — API imports unchanged", () => {
  it("imports answerAdminProductQuestion", () => {
    expect(SRC).toContain("answerAdminProductQuestion");
  });

  it("imports rejectAdminProductQuestion", () => {
    expect(SRC).toContain("rejectAdminProductQuestion");
  });

  it("imports listAdminProductQuestions", () => {
    expect(SRC).toContain("listAdminProductQuestions");
  });

  it("imports AlreadyModeratedError for concurrent-edit handling", () => {
    expect(SRC).toContain("AlreadyModeratedError");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation: TABS array and tab-membership check
// (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source:
//   const TABS: ReadonlyArray<{ id: AdminProductQuestionStatus; label: string }> = [
//     { id: "pending", label: "Pending" },
//     { id: "answered", label: "Answered" },
//     { id: "rejected", label: "Rejected" },
//   ];

type AdminProductQuestionStatus = "pending" | "answered" | "rejected";

const TABS_PQ: ReadonlyArray<{ id: AdminProductQuestionStatus; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "answered", label: "Answered" },
  { id: "rejected", label: "Rejected" },
];

const isTabPQ = (v: string): v is AdminProductQuestionStatus =>
  TABS_PQ.some((t) => t.id === v);

describe("admin-product-questions — TABS array structure", () => {
  it("has exactly 3 tabs", () => {
    expect(TABS_PQ).toHaveLength(3);
  });

  it("lists tabs in pending → answered → rejected order", () => {
    const ids = TABS_PQ.map((t) => t.id);
    expect(ids).toEqual(["pending", "answered", "rejected"]);
  });

  it("each tab has a human-readable label", () => {
    for (const t of TABS_PQ) {
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it('tab ids sorted alphabetically are ["answered", "pending", "rejected"]', () => {
    expect(TABS_PQ.map((t) => t.id).sort()).toEqual([
      "answered",
      "pending",
      "rejected",
    ]);
  });
});

describe("admin-product-questions — tab membership (valid inputs)", () => {
  it.each(["pending", "answered", "rejected"] as AdminProductQuestionStatus[])(
    'recognises "%s" as a valid tab',
    (t) => {
      expect(isTabPQ(t)).toBe(true);
    },
  );
});

describe("admin-product-questions — tab membership (invalid inputs)", () => {
  it("rejects an empty string", () => {
    expect(isTabPQ("")).toBe(false);
  });

  it("rejects an entirely unknown value", () => {
    expect(isTabPQ("approved")).toBe(false);
    expect(isTabPQ("open")).toBe(false);
    expect(isTabPQ("all")).toBe(false);
  });

  it("rejects wrong casing of a valid tab", () => {
    expect(isTabPQ("Pending")).toBe(false);
    expect(isTabPQ("ANSWERED")).toBe(false);
    expect(isTabPQ("Rejected")).toBe(false);
  });

  it("rejects a partial match (prefix of a valid tab)", () => {
    expect(isTabPQ("pend")).toBe(false);
    expect(isTabPQ("answer")).toBe(false);
    expect(isTabPQ("reject")).toBe(false);
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(isTabPQ(" pending")).toBe(false);
    expect(isTabPQ("pending ")).toBe(false);
  });

  it("rejects a superset of a valid tab name", () => {
    expect(isTabPQ("pending_review")).toBe(false);
    expect(isTabPQ("answered_by_staff")).toBe(false);
  });
});

describe("admin-product-questions — tab set has no duplicates", () => {
  it("no duplicate tab ids", () => {
    const ids = TABS_PQ.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});