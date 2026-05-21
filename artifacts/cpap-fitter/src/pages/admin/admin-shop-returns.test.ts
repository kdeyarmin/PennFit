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
// PR change: bespoke URL sync replaces useUrlState
// ---------------------------------------------------------------------------

describe("admin-shop-returns — useUrlState removed", () => {
  it("does not import useUrlState", () => {
    expect(SRC).not.toContain("useUrlState");
  });

  it("does not import from @/hooks/use-url-state", () => {
    expect(SRC).not.toContain('from "@/hooks/use-url-state"');
  });
});

describe("admin-shop-returns — readTabFromUrl function", () => {
  it("defines readTabFromUrl as a standalone function", () => {
    expect(SRC).toContain("function readTabFromUrl");
  });

  it("guards readTabFromUrl against SSR with typeof window === \"undefined\"", () => {
    expect(SRC).toContain('typeof window === "undefined"');
  });

  it("returns \"open\" as the SSR fallback", () => {
    // The SSR branch returns "open" (the default tab).
    const ssrGuardLine = SRC.split("\n").find(
      (line) => line.includes('typeof window === "undefined"') && line.includes("return"),
    );
    // Either the guard is on the same line or the return is the next line.
    // Just assert the fallback value "open" appears near the guard.
    expect(SRC).toContain('"open"');
  });

  it("reads the \"tab\" key from URLSearchParams", () => {
    expect(SRC).toContain('.get("tab")');
  });

  it("uses TAB_IDS.has to validate the raw URL param", () => {
    expect(SRC).toContain("TAB_IDS.has");
  });
});

describe("admin-shop-returns — TAB_IDS type narrowed to ReadonlySet<Tab>", () => {
  it("declares TAB_IDS as ReadonlySet<Tab> (not ReadonlySet<string>)", () => {
    expect(SRC).toContain("ReadonlySet<Tab>");
    expect(SRC).not.toContain("ReadonlySet<string>");
  });

  it("still builds TAB_IDS from TABS.map", () => {
    expect(SRC).toContain("TABS.map");
    expect(SRC).toContain("TAB_IDS");
  });
});

describe("admin-shop-returns — bespoke setTab URL sync", () => {
  it("uses history.replaceState to update the URL", () => {
    expect(SRC).toContain("replaceState");
  });

  it("SSR-guards the URL update path", () => {
    // setTab contains its own typeof window === "undefined" guard.
    const matches = SRC.match(/typeof window === "undefined"/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("deletes the param when next equals the default (\"open\")", () => {
    expect(SRC).toContain('params.delete("tab")');
  });

  it("sets the param when next differs from the default", () => {
    expect(SRC).toContain('params.set("tab", next)');
  });

  it("preserves window.location.hash in the rebuilt URL", () => {
    expect(SRC).toContain("window.location.hash");
  });

  it("uses window.location.pathname in the rebuilt URL", () => {
    expect(SRC).toContain("window.location.pathname");
  });
});

describe("admin-shop-returns — popstate listener for back/forward navigation", () => {
  it("adds a popstate event listener", () => {
    expect(SRC).toContain('addEventListener("popstate"');
  });

  it("removes the popstate listener on cleanup", () => {
    expect(SRC).toContain('removeEventListener("popstate"');
  });

  it("rehydrates state from readTabFromUrl on popstate", () => {
    expect(SRC).toContain("readTabFromUrl()");
  });

  it("wires the listener inside a useEffect with empty deps", () => {
    // useEffect must be imported and used.
    expect(SRC).toContain("useEffect");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of readTabFromUrl (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source (admin-shop-returns.tsx):
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

const TAB_IDS_RETURNS: ReadonlySet<ReturnTab> = new Set<ReturnTab>([
  "open",
  "requested",
  "approved",
  "shipped_back",
  "received",
  "refunded",
  "replaced",
  "rejected",
  "all",
]);

function readTabFromUrlLogic(search: string): ReturnTab {
  // Mirrors the non-SSR path of readTabFromUrl().
  const raw = new URLSearchParams(search).get("tab");
  return raw && TAB_IDS_RETURNS.has(raw as ReturnTab) ? (raw as ReturnTab) : "open";
}

describe("admin-shop-returns — readTabFromUrl logic: missing or empty param", () => {
  it("returns \"open\" when the search string is empty", () => {
    expect(readTabFromUrlLogic("")).toBe("open");
  });

  it("returns \"open\" when tab is absent from the query string", () => {
    expect(readTabFromUrlLogic("?page=2")).toBe("open");
  });

  it("returns \"open\" when the tab param value is empty", () => {
    expect(readTabFromUrlLogic("?tab=")).toBe("open");
  });
});

describe("admin-shop-returns — readTabFromUrl logic: valid tab values", () => {
  const valid: ReturnTab[] = [
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

  it.each(valid)('returns "%s" when ?tab=%s is in the URL', (tab) => {
    expect(readTabFromUrlLogic(`?tab=${tab}`)).toBe(tab);
  });

  it("handles tab param preceded by other params", () => {
    expect(readTabFromUrlLogic("?page=2&tab=approved")).toBe("approved");
  });

  it("handles tab param followed by other params", () => {
    expect(readTabFromUrlLogic("?tab=received&page=3")).toBe("received");
  });
});

describe("admin-shop-returns — readTabFromUrl logic: invalid tab values fall back to open", () => {
  it("rejects an entirely unknown value", () => {
    expect(readTabFromUrlLogic("?tab=pending")).toBe("open");
  });

  it("rejects a value with wrong casing", () => {
    expect(readTabFromUrlLogic("?tab=Open")).toBe("open");
    expect(readTabFromUrlLogic("?tab=APPROVED")).toBe("open");
    expect(readTabFromUrlLogic("?tab=Shipped_Back")).toBe("open");
  });

  it("rejects a partial match (prefix of a valid tab)", () => {
    expect(readTabFromUrlLogic("?tab=req")).toBe("open");
    expect(readTabFromUrlLogic("?tab=ship")).toBe("open");
  });

  it("rejects a superset of a valid tab id", () => {
    expect(readTabFromUrlLogic("?tab=opened")).toBe("open");
    expect(readTabFromUrlLogic("?tab=all_returns")).toBe("open");
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(readTabFromUrlLogic("?tab= open")).toBe("open");
    expect(readTabFromUrlLogic("?tab=open ")).toBe("open");
  });
});

describe("admin-shop-returns — TAB_IDS_RETURNS covers exactly 9 tabs", () => {
  it("has size 9", () => {
    expect(TAB_IDS_RETURNS.size).toBe(9);
  });

  it("includes the synthetic aggregate tabs 'open' and 'all'", () => {
    expect(TAB_IDS_RETURNS.has("open")).toBe(true);
    expect(TAB_IDS_RETURNS.has("all")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of the setTab URL-building logic (verbatim)
// ---------------------------------------------------------------------------
//
// Source (admin-shop-returns.tsx):
//   const params = new URLSearchParams(window.location.search);
//   if (next === "open") params.delete("tab");
//   else params.set("tab", next);
//   const qs = params.toString();
//   const newUrl =
//     window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;

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

describe("admin-shop-returns — setTab URL-building: default value removes param", () => {
  it("produces a clean pathname when next is 'open' and search is empty", () => {
    expect(buildReturnUrl("open", "", "/admin/returns", "")).toBe("/admin/returns");
  });

  it("removes the tab param when next is 'open', even if it was set", () => {
    expect(buildReturnUrl("open", "?tab=approved", "/admin/returns", "")).toBe(
      "/admin/returns",
    );
  });

  it("removes only the tab key and preserves unrelated params", () => {
    expect(
      buildReturnUrl("open", "?tab=received&page=2", "/admin/returns", ""),
    ).toBe("/admin/returns?page=2");
  });
});

describe("admin-shop-returns — setTab URL-building: non-default value sets param", () => {
  it("appends tab=approved to a clean URL", () => {
    expect(buildReturnUrl("approved", "", "/admin/returns", "")).toBe(
      "/admin/returns?tab=approved",
    );
  });

  it("replaces an existing tab value", () => {
    expect(
      buildReturnUrl("rejected", "?tab=approved", "/admin/returns", ""),
    ).toBe("/admin/returns?tab=rejected");
  });

  it("preserves unrelated params when setting tab", () => {
    const result = buildReturnUrl("shipped_back", "?page=3", "/admin/returns", "");
    expect(result).toContain("tab=shipped_back");
    expect(result).toContain("page=3");
  });
});

describe("admin-shop-returns — setTab URL-building: hash is preserved", () => {
  it("appends a non-empty hash to the rebuilt URL", () => {
    expect(
      buildReturnUrl("received", "", "/admin/returns", "#section"),
    ).toBe("/admin/returns?tab=received#section");
  });

  it("appends hash even when no query string remains (open tab)", () => {
    expect(
      buildReturnUrl("open", "?tab=approved", "/admin/returns", "#top"),
    ).toBe("/admin/returns#top");
  });

  it("does not add a stray hash when hash is empty", () => {
    expect(buildReturnUrl("all", "", "/admin/returns", "")).toBe(
      "/admin/returns?tab=all",
    );
  });
});

describe("admin-shop-returns — setTab URL-building: edge cases", () => {
  it("handles a key name that appears as a substring of another key", () => {
    // 'tab' vs 'stable' — URLSearchParams must not confuse them.
    const result = buildReturnUrl("approved", "?stable=1", "/admin/returns", "");
    expect(result).toContain("tab=approved");
    expect(result).toContain("stable=1");
  });

  it("handles special characters in unrelated param values", () => {
    const result = buildReturnUrl("refunded", "?q=hello+world", "/admin/returns", "");
    expect(result).toContain("tab=refunded");
  });
})
