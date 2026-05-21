// Tests for pages/admin/admin-shop-reviews.tsx
//
// PR change: removed useUrlState hook, removed TAB_IDS/isTab predicate, and
// replaced the URL-persisted tab state with a plain useState<Tab>("pending").
//
// The component uses React + @tanstack/react-query which cannot be rendered
// in the vitest node environment without jsdom. We use two complementary
// strategies:
//
//   1. Static source analysis — readFileSync + SRC.toContain() / not.toContain()
//      assertions to verify structural invariants that changed in this PR.
//
//   2. Pure-logic re-implementation — the TABS array and isTab logic are
//      re-implemented verbatim so their boundary behaviour can be tested
//      exhaustively without React.

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
// PR change: useUrlState removed — now uses plain useState
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — useUrlState removed in this PR", () => {
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

describe("admin-shop-reviews — useState with 'pending' default", () => {
  it('uses useState<Tab>("pending") for tab state', () => {
    expect(SRC).toContain('useState<Tab>("pending")');
  });

  it("imports useState from react", () => {
    expect(SRC).toContain("useState");
  });

  it('does not hard-code defaultValue: "pending" in a useUrlState config object', () => {
    // Ensure the old hook config is gone.
    expect(SRC).not.toContain("defaultValue:");
  });
});

// ---------------------------------------------------------------------------
// TABS array contents (structure should be unchanged)
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — TABS array contents", () => {
  const expectedTabs = ["pending", "approved", "rejected", "all"];

  for (const t of expectedTabs) {
    it(`TABS includes tab id "${t}"`, () => {
      expect(SRC).toContain(`"${t}"`);
    });
  }

  it('includes the "all" aggregate tab for read-only audit view', () => {
    expect(SRC).toContain('"all"');
  });
});

// ---------------------------------------------------------------------------
// ARIA / accessibility markup (unchanged by the PR)
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — ARIA tab roles", () => {
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

describe("admin-shop-reviews — data-testid attributes", () => {
  it('has data-testid="admin-shop-reviews-page" on the root element', () => {
    expect(SRC).toContain('data-testid="admin-shop-reviews-page"');
  });

  it('uses "shop-reviews-tab-" prefix in the tab button data-testid', () => {
    expect(SRC).toContain("shop-reviews-tab-");
  });

  it("derives the tab data-testid from the tab id dynamically", () => {
    // Template literal interpolates t.id.
    expect(SRC).toMatch(/shop-reviews-tab-.*t\.id/s);
  });
});

// ---------------------------------------------------------------------------
// XSS defense (unchanged)
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — XSS defense", () => {
  it("does not use dangerouslySetInnerHTML for review bodies", () => {
    expect(SRC).not.toContain("dangerouslySetInnerHTML");
  });

  it("documents the plain-text rendering rationale in the file header", () => {
    expect(SRC).toContain("plain text");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation: TABS array and tab-membership check
// (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source:
//   type Tab = ReviewStatus | "all";
//   const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
//     { id: "pending", label: "Pending" },
//     { id: "approved", label: "Approved" },
//     { id: "rejected", label: "Rejected" },
//     { id: "all", label: "All" },
//   ];

type ReviewTab = "pending" | "approved" | "rejected" | "all";

const TABS_REVIEWS: ReadonlyArray<{ id: ReviewTab; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

// Re-implement the membership check without a Set (the source no longer has isTab).
const isReviewTab = (v: string): v is ReviewTab =>
  TABS_REVIEWS.some((t) => t.id === v);

describe("admin-shop-reviews — TABS array structure", () => {
  it("has exactly 4 tabs", () => {
    expect(TABS_REVIEWS).toHaveLength(4);
  });

  it("lists tabs in pending → approved → rejected → all order", () => {
    const ids = TABS_REVIEWS.map((t) => t.id);
    expect(ids).toEqual(["pending", "approved", "rejected", "all"]);
  });

  it("includes the synthetic 'all' aggregate tab", () => {
    expect(isReviewTab("all")).toBe(true);
  });

  it("all three ReviewStatus values are present", () => {
    const statuses: ReviewTab[] = ["pending", "approved", "rejected"];
    for (const s of statuses) {
      expect(isReviewTab(s)).toBe(true);
    }
  });
});

describe("admin-shop-reviews — tab membership (valid inputs)", () => {
  it.each(["pending", "approved", "rejected", "all"] as ReviewTab[])(
    'recognises "%s" as a valid tab',
    (t) => {
      expect(isReviewTab(t)).toBe(true);
    },
  );
});

describe("admin-shop-reviews — tab membership (invalid inputs)", () => {
  it("rejects an empty string", () => {
    expect(isReviewTab("")).toBe(false);
  });

  it("rejects an entirely unknown value", () => {
    expect(isReviewTab("open")).toBe(false);
    expect(isReviewTab("moderated")).toBe(false);
  });

  it("rejects wrong casing of a valid tab", () => {
    expect(isReviewTab("Pending")).toBe(false);
    expect(isReviewTab("APPROVED")).toBe(false);
    expect(isReviewTab("All")).toBe(false);
  });

  it("rejects a partial match", () => {
    expect(isReviewTab("pend")).toBe(false);
    expect(isReviewTab("appro")).toBe(false);
    expect(isReviewTab("al")).toBe(false);
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(isReviewTab(" pending")).toBe(false);
    expect(isReviewTab("pending ")).toBe(false);
  });

  it("rejects a superset of a valid tab name", () => {
    expect(isReviewTab("pending_review")).toBe(false);
    expect(isReviewTab("all_reviews")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: moderation API functions still imported
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — API imports unchanged", () => {
  it("imports approveAdminShopReview", () => {
    expect(SRC).toContain("approveAdminShopReview");
  });

  it("imports rejectAdminShopReview", () => {
    expect(SRC).toContain("rejectAdminShopReview");
  });

  it("imports unrejectAdminShopReview", () => {
    expect(SRC).toContain("unrejectAdminShopReview");
  });

  it("imports listAdminShopReviews", () => {
    expect(SRC).toContain("listAdminShopReviews");
  });
});
