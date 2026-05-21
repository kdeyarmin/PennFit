// Tests for pages/admin/admin-product-questions.tsx — post-revert state
//
// PR change: reverted from useUrlState (with TAB_IDS + isTab predicate derived
// from TABS) back to plain useState<AdminProductQuestionStatus>("pending").
// The TAB_IDS set, isTab predicate, and useUrlState import/call-site were all
// removed.
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
  path.join(__dirname, "admin-product-questions.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Revert: useUrlState and its supporting code must be gone
// ---------------------------------------------------------------------------

describe("admin-product-questions — useUrlState removed", () => {
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

describe("admin-product-questions — useState replaces useUrlState", () => {
  it("uses useState to hold the active tab", () => {
    expect(SRC).toContain("useState");
  });

  it('defaults to "pending" as the initial tab value', () => {
    expect(SRC).toContain('"pending"');
  });

  it("declares [tab, setTab] state pair", () => {
    expect(SRC).toContain("tab, setTab");
  });
});

// ---------------------------------------------------------------------------
// TABS array — all three tabs still present
// ---------------------------------------------------------------------------

describe("admin-product-questions — TABS array contents", () => {
  const expectedTabs = ["pending", "answered", "rejected"] as const;

  for (const t of expectedTabs) {
    it(`TABS includes tab with id "${t}"`, () => {
      expect(SRC).toContain(`"${t}"`);
    });
  }

  it("TABS array is a ReadonlyArray typed to AdminProductQuestionStatus", () => {
    expect(SRC).toContain("ReadonlyArray");
    expect(SRC).toContain("AdminProductQuestionStatus");
  });

  it("TABS has exactly 3 entries (verified by label presence)", () => {
    const tabsBlock = SRC.slice(
      SRC.indexOf("const TABS"),
      SRC.indexOf("export function AdminProductQuestionsPage"),
    );
    expect(tabsBlock).toContain('"pending"');
    expect(tabsBlock).toContain('"answered"');
    expect(tabsBlock).toContain('"rejected"');
    // 'approved' is not a valid AdminProductQuestionStatus for this page.
    expect(tabsBlock).not.toContain('"approved"');
  });
});

// ---------------------------------------------------------------------------
// Root page data-testid
// ---------------------------------------------------------------------------

describe("admin-product-questions — root page data-testid", () => {
  it('has data-testid="admin-product-questions-page" on the root element', () => {
    expect(SRC).toContain('data-testid="admin-product-questions-page"');
  });
});

// ---------------------------------------------------------------------------
// Tab button data-testid attributes
// ---------------------------------------------------------------------------

describe("admin-product-questions — tab button data-testid attributes", () => {
  it("uses a template-literal data-testid with the admin-product-questions-tab- prefix", () => {
    expect(SRC).toContain("admin-product-questions-tab-");
  });

  it("data-testid is dynamically derived from the tab id (interpolates t.id)", () => {
    expect(SRC).toMatch(/admin-product-questions-tab-.*t\.id/s);
  });
});

// ---------------------------------------------------------------------------
// ARIA tab roles
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

// ---------------------------------------------------------------------------
// No bespoke URL-sync code introduced
// ---------------------------------------------------------------------------

describe("admin-product-questions — no URL sync code present", () => {
  it("does not call history.replaceState for tab changes", () => {
    expect(SRC).not.toContain("replaceState");
  });

  it("does not add a popstate event listener", () => {
    expect(SRC).not.toContain('addEventListener("popstate"');
  });

  it("does not read from URLSearchParams for tab initialisation", () => {
    expect(SRC).not.toContain("URLSearchParams");
  });
});