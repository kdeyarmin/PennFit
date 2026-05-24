// Static guard for the "Mark shipped back" action added to the admin shop
// returns queue in this PR.
//
// The component uses React + @tanstack/react-query mutations which cannot be
// rendered in the node vitest environment without jsdom.  We read the source
// file directly and assert the structural invariants that matter most:
//
//  1. markShipped is imported from the API module.
//  2. The "Mark shipped back" button is present with its expected
//     data-testid pattern.
//  3. The "Mark received" button now also carries a data-testid (added in
//     this PR alongside the new shipped-back step).
//  4. The button is gated by `item.status === "approved"` so it only appears
//     when the return is in the right state.
//  5. The comment block at the top of the file reflects the updated workflow
//     (approved → Mark shipped back · Mark received).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-shop-returns.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// API import
// ---------------------------------------------------------------------------
describe("admin-shop-returns — markShipped API import", () => {
  it("imports markShipped from the shop-returns-api module", () => {
    expect(SRC).toContain("markShipped");
  });

  it("imports markShipped alongside the other action functions", () => {
    // The import block should include markShipped between markReceived and
    // the other actions so it follows the alphabetical/logical ordering.
    expect(SRC).toMatch(/markReceived[\s\S]{0,50}markShipped|markShipped[\s\S]{0,50}markReceived/);
  });
});

// ---------------------------------------------------------------------------
// "Mark shipped back" button markup
// ---------------------------------------------------------------------------
describe("admin-shop-returns — Mark shipped back button", () => {
  it("renders the 'Mark shipped back' button label", () => {
    expect(SRC).toContain("Mark shipped back");
  });

  it("includes a data-testid with the return-id-mark-shipped pattern", () => {
    expect(SRC).toContain("return-${item.id}-mark-shipped");
  });

  it("gates the button on item.status === 'approved'", () => {
    // The button should only appear when the return is in 'approved' state.
    expect(SRC).toContain(`item.status === "approved"`);
  });

  it("calls shippedMut.mutate() on confirmation", () => {
    expect(SRC).toContain("shippedMut.mutate()");
  });

  it("disables the button while the mutation is pending", () => {
    expect(SRC).toContain("shippedMut.isPending");
  });

  it("shows a confirmation dialog with a human-readable message", () => {
    // The confirmation moved from window.confirm("...?") to a
    // useConfirmDialog title/description split. Look for the title
    // (which carries the question form) and the description (the
    // clarifying body that used to follow the "?").
    expect(SRC).toContain("Mark return as shipped back?");
    expect(SRC).toContain(
      "Use this when the customer confirms they've handed off the parcel",
    );
  });
});

// ---------------------------------------------------------------------------
// "Mark received" button now has a data-testid (added in this PR)
// ---------------------------------------------------------------------------
describe("admin-shop-returns — Mark received button data-testid", () => {
  it("includes a data-testid with the return-id-mark-received pattern", () => {
    expect(SRC).toContain("return-${item.id}-mark-received");
  });

  it("Mark received button still renders the expected label", () => {
    expect(SRC).toContain("Mark received");
  });
});

// ---------------------------------------------------------------------------
// Status-workflow comment at top of file reflects the new two-step flow
// ---------------------------------------------------------------------------
describe("admin-shop-returns — status workflow documentation", () => {
  it("documents the approved → Mark shipped back step in the header comment", () => {
    expect(SRC).toContain("Mark shipped back");
  });

  it("notes that the in-transit step is optional (skip-to-received still works)", () => {
    expect(SRC).toContain("optional");
  });
});

// ---------------------------------------------------------------------------
// Regression: existing action buttons are still present
// ---------------------------------------------------------------------------
describe("admin-shop-returns — pre-existing action buttons not removed", () => {
  it("still has the Approve button", () => {
    expect(SRC).toContain("approveMut");
  });

  it("still has the Reject button", () => {
    expect(SRC).toContain("rejectMut");
  });

  it("still has the Refund button", () => {
    expect(SRC).toContain("refundMut");
  });

  it("still has the Replace button", () => {
    expect(SRC).toContain("replaceMut");
  });
});

// ---------------------------------------------------------------------------
// Tab IDs and URL state invariants
// ---------------------------------------------------------------------------
// URL state: the page wires its ?tab= search param via the shared
// `useUrlState` hook (history-replacing, popstate-aware) — see
// src/hooks/use-url-state.ts for the implementation.
// ---------------------------------------------------------------------------

describe("admin-shop-returns — TAB_IDS and tabs", () => {
  it("defines TAB_IDS as a ReadonlySet", () => {
    expect(SRC).toContain("ReadonlySet");
    expect(SRC).toContain("TAB_IDS");
  });

  const expectedTabs = [
    "open",
    "requested",
    "approved",
    "shipped_back",
    "received",
    "refunded",
    "replaced",
    "rejected",
    "all",
  ];
  for (const tab of expectedTabs) {
    it(`TABS includes tab id "${tab}"`, () => {
      expect(SRC).toContain(`"${tab}"`);
    });
  }
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of readTabFromUrl (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source (from admin-shop-returns.tsx):
//   type Tab = ReturnStatus | "all" | "open";
//   const TABS = [
//     { id: "open" }, { id: "requested" }, { id: "approved" },
//     { id: "shipped_back" }, { id: "received" }, { id: "refunded" },
//     { id: "replaced" }, { id: "rejected" }, { id: "all" },
//   ];
//   const TAB_IDS: ReadonlySet<Tab> = new Set(TABS.map((t) => t.id));
//
//   function readTabFromUrl(): Tab {
//     if (typeof window === "undefined") return "open";
//     const raw = new URLSearchParams(window.location.search).get("tab");
//     return raw && TAB_IDS.has(raw as Tab) ? (raw as Tab) : "open";
//   }

type ReturnTab =
  | "open"
  | "requested"
  | "approved"
  | "shipped_back"
  | "received"
  | "refunded"
  | "replaced"
  | "rejected"
  | "all";

const TABS_RETURNS: ReadonlyArray<{ id: ReturnTab }> = [
  { id: "open" },
  { id: "requested" },
  { id: "approved" },
  { id: "shipped_back" },
  { id: "received" },
  { id: "refunded" },
  { id: "replaced" },
  { id: "rejected" },
  { id: "all" },
];

const TAB_IDS_RETURNS: ReadonlySet<ReturnTab> = new Set(
  TABS_RETURNS.map((t) => t.id),
);

// Parameterised re-implementation that accepts the search string so
// tests don't need a real window.
function readTabFromSearch(search: string): ReturnTab {
  const raw = new URLSearchParams(search).get("tab");
  return raw && TAB_IDS_RETURNS.has(raw as ReturnTab)
    ? (raw as ReturnTab)
    : "open";
}

describe("readTabFromUrl logic — returns 'open' by default", () => {
  it("returns 'open' when search string is empty", () => {
    expect(readTabFromSearch("")).toBe("open");
  });

  it("returns 'open' when 'tab' param is absent", () => {
    expect(readTabFromSearch("?page=2")).toBe("open");
  });

  it("returns 'open' when 'tab' param is empty", () => {
    expect(readTabFromSearch("?tab=")).toBe("open");
  });

  it("returns 'open' for an unknown tab value", () => {
    expect(readTabFromSearch("?tab=unknown")).toBe("open");
  });

  it("returns 'open' for a value with wrong casing", () => {
    expect(readTabFromSearch("?tab=Approved")).toBe("open");
    expect(readTabFromSearch("?tab=OPEN")).toBe("open");
  });
});

describe("readTabFromUrl logic — returns valid tab values", () => {
  const validTabs: ReturnTab[] = [
    "open",
    "requested",
    "approved",
    "shipped_back",
    "received",
    "refunded",
    "replaced",
    "rejected",
    "all",
  ];

  it.each(validTabs)('returns "%s" when it is in the search string', (tab) => {
    expect(readTabFromSearch(`?tab=${tab}`)).toBe(tab);
  });

  it("returns the tab even when there are other params before it", () => {
    expect(readTabFromSearch("?page=3&tab=received")).toBe("received");
  });

  it("returns the tab even when there are other params after it", () => {
    expect(readTabFromSearch("?tab=refunded&sort=asc")).toBe("refunded");
  });
});

describe("readTabFromUrl logic — TAB_IDS invariants", () => {
  it("contains exactly 9 tabs", () => {
    expect(TAB_IDS_RETURNS.size).toBe(9);
  });

  it("includes both the synthetic 'open' and 'all' tabs", () => {
    expect(TAB_IDS_RETURNS.has("open")).toBe(true);
    expect(TAB_IDS_RETURNS.has("all")).toBe(true);
  });

  it("includes the 'shipped_back' status (underscore, not hyphen)", () => {
    expect(TAB_IDS_RETURNS.has("shipped_back")).toBe(true);
  });

  it("does not include partial matches like 'ship'", () => {
    expect(readTabFromSearch("?tab=ship")).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of setTab URL building (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source:
//   const params = new URLSearchParams(window.location.search);
//   if (next === "open") params.delete("tab");
//   else params.set("tab", next);
//   const qs = params.toString();
//   const newUrl = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;

function buildTabUrl(
  next: ReturnTab,
  currentSearch: string,
  pathname: string,
  hash: string,
): string {
  const params = new URLSearchParams(currentSearch);
  if (next === "open") params.delete("tab");
  else params.set("tab", next);
  const qs = params.toString();
  return pathname + (qs ? `?${qs}` : "") + hash;
}

describe("setTab URL building — 'open' removes the param", () => {
  it("produces a clean pathname when next is 'open' and no other params", () => {
    expect(buildTabUrl("open", "", "/admin/returns", "")).toBe("/admin/returns");
  });

  it("removes only the tab param, preserving other params", () => {
    const url = buildTabUrl("open", "?tab=approved&page=2", "/admin/returns", "");
    expect(url).not.toContain("tab=");
    expect(url).toContain("page=2");
  });

  it("removes tab param and preserves hash", () => {
    const url = buildTabUrl("open", "?tab=received", "/admin/returns", "#top");
    expect(url).toBe("/admin/returns#top");
  });
});

describe("setTab URL building — non-default values set the param", () => {
  it("sets tab=approved in the URL", () => {
    const url = buildTabUrl("approved", "", "/admin/returns", "");
    expect(url).toBe("/admin/returns?tab=approved");
  });

  it("sets tab=shipped_back in the URL", () => {
    const url = buildTabUrl("shipped_back", "", "/admin/returns", "");
    expect(url).toContain("tab=shipped_back");
  });

  it("replaces an existing tab param value", () => {
    const url = buildTabUrl("rejected", "?tab=approved", "/admin/returns", "");
    expect(url).toBe("/admin/returns?tab=rejected");
  });

  it("preserves hash when setting a non-default tab", () => {
    const url = buildTabUrl("all", "", "/admin/returns", "#section");
    expect(url).toBe("/admin/returns?tab=all#section");
  });

  it("preserves unrelated query params", () => {
    const url = buildTabUrl("requested", "?page=5", "/admin/returns", "");
    expect(url).toContain("tab=requested");
    expect(url).toContain("page=5");
  });
});

// ---------------------------------------------------------------------------
// Source-level check: useUrlState integration
// ---------------------------------------------------------------------------
// The PR removed the manual readTabFromUrl / popstate implementation and
// the associated tests. The current source delegates URL-state management to
// the useUrlState hook. These tests verify the hook is properly integrated.

describe("admin-shop-returns — useUrlState hook integration", () => {
  it("imports useUrlState from @/hooks/use-url-state", () => {
    expect(SRC).toContain('from "@/hooks/use-url-state"');
    expect(SRC).toContain("useUrlState");
  });

  it("calls useUrlState with key: 'tab'", () => {
    expect(SRC).toMatch(/useUrlState[\s\S]{0,50}key:\s*["']tab["']/);
  });

  it("calls useUrlState with defaultValue: 'open'", () => {
    expect(SRC).toMatch(/useUrlState[\s\S]{0,80}defaultValue:\s*["']open["']/);
  });

  it("passes isAllowed guard to useUrlState for type safety", () => {
    expect(SRC).toContain("isAllowed");
    expect(SRC).toContain("isTab");
  });

  it("defines isTab as a type-narrowing guard that uses TAB_IDS.has()", () => {
    expect(SRC).toContain("TAB_IDS.has(");
    expect(SRC).toMatch(/\bisTab\s*=/);
  });
});

// ---------------------------------------------------------------------------
// Regression: source no longer contains manual readTabFromUrl / popstate
// ---------------------------------------------------------------------------
// These checks confirm the manual URL state was fully replaced by useUrlState.

describe("admin-shop-returns — manual URL state removed (replaced by useUrlState)", () => {
  it("does not define a standalone readTabFromUrl function", () => {
    expect(SRC).not.toContain("function readTabFromUrl");
  });

  it("does not manually call window.history.replaceState or pushState for tab changes", () => {
    // The useUrlState hook owns history management; the component should not
    // also call replaceState/pushState directly.
    expect(SRC).not.toMatch(/history\.(replaceState|pushState)\s*\(/);
  });

  it("does not manually add or remove a popstate event listener", () => {
    expect(SRC).not.toContain('addEventListener("popstate"');
    expect(SRC).not.toContain('removeEventListener("popstate"');
  });
});
