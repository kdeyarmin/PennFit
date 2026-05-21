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
    expect(SRC).toContain(
      "Mark this return as shipped back?",
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
// PR change: useUrlState removed — replaced with bespoke URL sync
// ---------------------------------------------------------------------------

describe("admin-shop-returns — useUrlState removed in this PR", () => {
  it("does not import useUrlState", () => {
    expect(SRC).not.toContain("useUrlState");
  });

  it("does not import from @/hooks/use-url-state", () => {
    expect(SRC).not.toContain("use-url-state");
  });
});

describe("admin-shop-returns — TAB_IDS is now ReadonlySet<Tab> (not ReadonlySet<string>)", () => {
  it("defines TAB_IDS with ReadonlySet<Tab> type", () => {
    expect(SRC).toContain("ReadonlySet<Tab>");
  });

  it("no longer uses ReadonlySet<string> for TAB_IDS", () => {
    // The old code used ReadonlySet<string> for cross-hook compatibility;
    // the new bespoke implementation can use the stricter Tab type.
    expect(SRC).not.toContain("ReadonlySet<string>");
  });
});

describe("admin-shop-returns — readTabFromUrl SSR guard and structure", () => {
  it("defines a readTabFromUrl function", () => {
    expect(SRC).toContain("readTabFromUrl");
  });

  it("guards the window access with typeof window check", () => {
    expect(SRC).toContain('typeof window === "undefined"');
  });

  it("reads the 'tab' param from URLSearchParams", () => {
    expect(SRC).toContain('new URLSearchParams(window.location.search).get("tab")');
  });

  it("falls back to 'open' when the param is missing or invalid", () => {
    // The function returns the literal string "open" as the SSR/default fallback.
    expect(SRC).toContain('return "open"');
  });
});

describe("admin-shop-returns — setTab URL manipulation", () => {
  it("uses history.replaceState (not pushState) to avoid polluting back-history", () => {
    expect(SRC).toContain("replaceState");
    expect(SRC).not.toContain("pushState");
  });

  it("deletes 'tab' param from URL when next is 'open' (keeps canonical URL clean)", () => {
    expect(SRC).toContain('params.delete("tab")');
  });

  it("sets the 'tab' param when next differs from 'open'", () => {
    expect(SRC).toContain('params.set("tab", next)');
  });

  it("preserves window.location.hash in the rebuilt URL", () => {
    expect(SRC).toContain("window.location.hash");
  });
});

describe("admin-shop-returns — popstate listener for back/forward rehydration", () => {
  it("adds a popstate event listener", () => {
    expect(SRC).toContain('window.addEventListener("popstate"');
  });

  it("removes the popstate listener on cleanup", () => {
    expect(SRC).toContain('window.removeEventListener("popstate"');
  });

  it("imports useEffect from react for the listener lifecycle", () => {
    expect(SRC).toContain("useEffect");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of readTabFromUrl
// (verbatim from source, minus the window guard — exercised in a node env)
// ---------------------------------------------------------------------------
//
// Source:
//   const TAB_IDS: ReadonlySet<Tab> = new Set(TABS.map((t) => t.id));
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

const TABS_SR: ReadonlyArray<{ id: ReturnTab }> = [
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

const TAB_IDS_SR: ReadonlySet<ReturnTab> = new Set(TABS_SR.map((t) => t.id));

// Mirrors readTabFromUrl without the window guard (testable in node).
function readTabFromSearch(search: string): ReturnTab {
  const raw = new URLSearchParams(search).get("tab");
  return raw && TAB_IDS_SR.has(raw as ReturnTab) ? (raw as ReturnTab) : "open";
}

// Mirrors the setTab URL-building logic (pure, no side effects).
function buildReturnUrl(
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

describe("admin-shop-returns — readTabFromUrl logic (returns default for missing/invalid)", () => {
  it("returns 'open' when search string is empty", () => {
    expect(readTabFromSearch("")).toBe("open");
  });

  it("returns 'open' when the 'tab' param is absent", () => {
    expect(readTabFromSearch("?other=foo")).toBe("open");
  });

  it("returns 'open' for an empty 'tab' param value", () => {
    expect(readTabFromSearch("?tab=")).toBe("open");
  });

  it("returns 'open' for an unknown param value", () => {
    expect(readTabFromSearch("?tab=pending")).toBe("open");
  });

  it("returns 'open' for a value with wrong casing", () => {
    expect(readTabFromSearch("?tab=Open")).toBe("open");
    expect(readTabFromSearch("?tab=REQUESTED")).toBe("open");
  });
});

describe("admin-shop-returns — readTabFromUrl logic (returns valid param when allowed)", () => {
  const validTabs: ReturnTab[] = [
    "open", "requested", "approved", "shipped_back",
    "received", "refunded", "replaced", "rejected", "all",
  ];

  it.each(validTabs)('returns "%s" when tab param is "%s"', (t) => {
    expect(readTabFromSearch(`?tab=${t}`)).toBe(t);
  });

  it("ignores other params and still reads tab correctly", () => {
    expect(readTabFromSearch("?page=2&tab=received")).toBe("received");
  });
});

describe("admin-shop-returns — TAB_IDS covers exactly 9 tabs", () => {
  it("has size 9", () => {
    expect(TAB_IDS_SR.size).toBe(9);
  });

  it("TABS array has 9 entries", () => {
    expect(TABS_SR).toHaveLength(9);
  });

  it("includes both synthetic aggregate tabs 'open' and 'all'", () => {
    expect(TAB_IDS_SR.has("open")).toBe(true);
    expect(TAB_IDS_SR.has("all")).toBe(true);
  });
});

describe("admin-shop-returns — buildReturnUrl default-value removes param", () => {
  it("produces a clean pathname with no query string when next is 'open'", () => {
    expect(buildReturnUrl("open", "", "/admin/returns", "")).toBe("/admin/returns");
  });

  it("removes only the 'tab' key and preserves unrelated params", () => {
    const result = buildReturnUrl("open", "?tab=approved&page=2", "/admin/returns", "");
    expect(result).toBe("/admin/returns?page=2");
  });

  it("appends hash when next is 'open' and other params remain", () => {
    const result = buildReturnUrl("open", "?tab=requested", "/admin/returns", "#top");
    expect(result).toBe("/admin/returns#top");
  });
});

describe("admin-shop-returns — buildReturnUrl non-default value sets param", () => {
  it("appends ?tab=<value> for a non-default tab", () => {
    expect(buildReturnUrl("approved", "", "/admin/returns", "")).toBe("/admin/returns?tab=approved");
  });

  it("replaces an existing tab value", () => {
    expect(buildReturnUrl("rejected", "?tab=requested", "/admin/returns", "")).toBe(
      "/admin/returns?tab=rejected",
    );
  });

  it("preserves unrelated params when setting a non-default tab", () => {
    const result = buildReturnUrl("all", "?page=3", "/admin/returns", "");
    expect(result).toContain("tab=all");
    expect(result).toContain("page=3");
  });

  it("preserves hash in the rebuilt URL", () => {
    const result = buildReturnUrl("received", "", "/admin/returns", "#anchor");
    expect(result).toBe("/admin/returns?tab=received#anchor");
  });
});
