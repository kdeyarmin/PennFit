// Tests for pages/admin/admin-shop-reviews.tsx — post-revert state
//
// PR change: reverted from useUrlState back to plain useState<Tab>("pending").
// The TAB_IDS set and isTab predicate that were added for URL-param validation
// were removed along with the useUrlState import and call site.
//
// Because the component uses React + @tanstack/react-query (not renderable in
// the node vitest environment without jsdom), we use static source analysis:
// readFileSync + SRC.toContain() / SRC.not.toContain() to verify structural
// invariants of the reverted code.

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
// Revert: useUrlState and its supporting code must be gone
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — useUrlState removed", () => {
  it("does not import useUrlState", () => {
    expect(SRC).not.toContain("useUrlState");
  });

  it("does not import from @/hooks/use-url-state", () => {
    expect(SRC).not.toContain('from "@/hooks/use-url-state"');
  });

  it("does not define TAB_IDS", () => {
    expect(SRC).not.toContain("TAB_IDS");
  });

  it("does not define isTab", () => {
    expect(SRC).not.toContain("isTab");
  });

  it("does not use ReadonlySet<string> (which was part of the TAB_IDS declaration)", () => {
    expect(SRC).not.toContain("ReadonlySet<string>");
  });
});

// ---------------------------------------------------------------------------
// Reverted state: plain useState drives the active tab
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — useState<Tab> replaces useUrlState", () => {
  it("uses useState to hold the active tab", () => {
    expect(SRC).toContain("useState");
  });

  it('defaults to "pending" as the initial tab value', () => {
    expect(SRC).toContain('"pending"');
  });

  it('declares [tab, setTab] state pair', () => {
    expect(SRC).toContain("tab, setTab");
  });
});

// ---------------------------------------------------------------------------
// TABS array — all four tabs still present
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — TABS array contents unchanged", () => {
  const expectedTabs = ["pending", "approved", "rejected", "all"];

  for (const t of expectedTabs) {
    it(`TABS includes tab id "${t}"`, () => {
      expect(SRC).toContain(`"${t}"`);
    });
  }

  it("TABS array includes all four tab definitions", () => {
    expect(SRC).toContain("TABS");
    // Verify by counting expected tab ids appearing in the TABS block.
    const tabsBlock = SRC.slice(
      SRC.indexOf("const TABS"),
      SRC.indexOf("export function AdminShopReviewsPage"),
    );
    expect(tabsBlock).toContain('"pending"');
    expect(tabsBlock).toContain('"approved"');
    expect(tabsBlock).toContain('"rejected"');
    expect(tabsBlock).toContain('"all"');
  });
});

// ---------------------------------------------------------------------------
// Structural markup: root page data-testid
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — root page data-testid", () => {
  it('has data-testid="admin-shop-reviews-page" on the root element', () => {
    expect(SRC).toContain('data-testid="admin-shop-reviews-page"');
  });
});

// ---------------------------------------------------------------------------
// Tab button data-testid attributes
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — tab button data-testid attributes", () => {
  it("uses a template-literal data-testid with the shop-reviews-tab- prefix", () => {
    expect(SRC).toContain("shop-reviews-tab-");
  });

  it("data-testid is dynamically derived from the tab id (interpolates t.id)", () => {
    expect(SRC).toMatch(/shop-reviews-tab-.*t\.id/s);
  });
});

// ---------------------------------------------------------------------------
// ARIA tab roles
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

// ---------------------------------------------------------------------------
// No bespoke URL-sync code introduced
// ---------------------------------------------------------------------------

describe("admin-shop-reviews — no bespoke URL sync code", () => {
  it("does not call history.replaceState for tab changes", () => {
    expect(SRC).not.toContain("replaceState");
  });

  it("does not add a popstate listener", () => {
    expect(SRC).not.toContain('addEventListener("popstate"');
  });

  it("does not read from URLSearchParams for tab initialisation", () => {
    expect(SRC).not.toContain("URLSearchParams");
  });
});
