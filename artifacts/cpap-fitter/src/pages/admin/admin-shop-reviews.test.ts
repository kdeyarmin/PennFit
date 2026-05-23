// Tests for pages/admin/admin-shop-reviews.tsx — useUrlState migration
//
// PR change: replaced useState<Tab> with useUrlState. A new TAB_IDS set and
// isTab predicate were added to validate URL params.
//
// The component uses React + @tanstack/react-query which cannot be rendered
// in the vitest node environment without jsdom. We use two complementary
// strategies:
//
//   1. Static source analysis — readFileSync + SRC.toContain() assertions to
//      verify structural invariants (import, hook call site, config values,
//      data-testid attributes).
//
//   2. Pure-logic re-implementation — isTab is re-implemented verbatim
//      from the source so its boundary behaviour can be tested exhaustively.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-shop-reviews.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Import checks
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — useUrlState import", () => {
  it("imports useUrlState from the hooks module", () => {
    expect(SRC).toContain('from "@/hooks/use-url-state"');
  });

  it("names useUrlState in the import statement", () => {
    expect(SRC).toContain("useUrlState");
  });
});

// ---------------------------------------------------------------------------
// useUrlState call-site configuration
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — useUrlState call site", () => {
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

describe("admin-shop-reviews — TAB_IDS set structure", () => {
  it("defines TAB_IDS as a ReadonlySet<string>", () => {
    expect(SRC).toContain("ReadonlySet<string>");
    expect(SRC).toContain("TAB_IDS");
  });

  it("derives TAB_IDS from the TABS array using map", () => {
    expect(SRC).toContain("TABS.map");
    expect(SRC).toContain("TAB_IDS");
  });

  it("defines isTab as a type-predicate returning v is Tab", () => {
    expect(SRC).toContain("v is Tab");
    expect(SRC).toContain("isTab");
  });
});

describe("admin-shop-reviews — TABS array contents", () => {
  const expectedTabs = ["pending", "approved", "rejected", "all"];

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
//   type Tab = ReviewStatus | "all";
//   const TABS = [
//     { id: "pending", ... }, { id: "approved", ... },
//     { id: "rejected", ... }, { id: "all", ... },
//   ];
//   const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id));
//   const isTab = (v: string): v is Tab => TAB_IDS.has(v);

type ReviewTab = "pending" | "approved" | "rejected" | "all";

const TABS_REVIEWS: ReadonlyArray<{ id: ReviewTab; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

const TAB_IDS_REVIEWS: ReadonlySet<string> = new Set(
  TABS_REVIEWS.map((t) => t.id),
);
const isTabReviews = (v: string): v is ReviewTab => TAB_IDS_REVIEWS.has(v);

describe("admin-shop-reviews — isTab predicate (valid inputs)", () => {
  const valid: ReviewTab[] = ["pending", "approved", "rejected", "all"];

  it.each(valid)('accepts "%s"', (t) => {
    expect(isTabReviews(t)).toBe(true);
  });
});

describe("admin-shop-reviews — isTab predicate (invalid inputs)", () => {
  it("rejects an empty string", () => {
    expect(isTabReviews("")).toBe(false);
  });

  it("rejects an entirely unknown value", () => {
    expect(isTabReviews("open")).toBe(false);
    expect(isTabReviews("moderated")).toBe(false);
  });

  it("rejects wrong casing of a valid tab", () => {
    expect(isTabReviews("Pending")).toBe(false);
    expect(isTabReviews("APPROVED")).toBe(false);
    expect(isTabReviews("All")).toBe(false);
  });

  it("rejects a partial match (prefix of a valid tab)", () => {
    expect(isTabReviews("pend")).toBe(false);
    expect(isTabReviews("appro")).toBe(false);
    expect(isTabReviews("al")).toBe(false);
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(isTabReviews(" pending")).toBe(false);
    expect(isTabReviews("pending ")).toBe(false);
  });

  it("rejects a value that is a superset of a valid tab", () => {
    expect(isTabReviews("pending_review")).toBe(false);
    expect(isTabReviews("all_reviews")).toBe(false);
  });
});

describe("admin-shop-reviews — TAB_IDS covers exactly 4 tabs", () => {
  it("has size 4", () => {
    expect(TAB_IDS_REVIEWS.size).toBe(4);
  });

  it("TABS array has 4 entries", () => {
    expect(TABS_REVIEWS).toHaveLength(4);
  });

  it("includes the synthetic 'all' aggregate tab", () => {
    expect(isTabReviews("all")).toBe(true);
  });

  it("all three ReviewStatus values are included", () => {
    const statuses: ReviewTab[] = ["pending", "approved", "rejected"];
    for (const s of statuses) {
      expect(isTabReviews(s)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// data-testid attributes used by the tab buttons
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — tab button data-testid attributes", () => {
  it("uses a template-literal data-testid with the shop-reviews-tab- prefix", () => {
    // Source uses: data-testid={`shop-reviews-tab-${t.id}`}
    expect(SRC).toContain("shop-reviews-tab-");
  });

  it("data-testid is dynamically derived from the tab id", () => {
    // The template literal interpolates t.id so each tab gets a unique testid.
    expect(SRC).toMatch(/shop-reviews-tab-.*t\.id/s);
  });
});

describe("admin-shop-reviews — root page data-testid", () => {
  it('has data-testid="admin-shop-reviews-page" on the root element', () => {
    expect(SRC).toContain('data-testid="admin-shop-reviews-page"');
  });
});

// ---------------------------------------------------------------------------
// Regression: tab strip uses ARIA tablist/tab roles
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — ARIA tab roles", () => {
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

// ---------------------------------------------------------------------------
// Security: review body rendered as plain text (not innerHTML)
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — XSS defense", () => {
  it("does not use dangerouslySetInnerHTML for review body", () => {
    expect(SRC).not.toContain("dangerouslySetInnerHTML");
  });
});
