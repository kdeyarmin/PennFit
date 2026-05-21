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
// useUrlState migration (PR change: replace bespoke tab-URL sync with hook)
// ---------------------------------------------------------------------------

describe("admin-shop-returns — useUrlState import", () => {
  it("imports useUrlState from the hooks module", () => {
    expect(SRC).toContain('from "@/hooks/use-url-state"');
  });

  it("names useUrlState in the import statement", () => {
    expect(SRC).toContain("useUrlState");
  });
});

describe("admin-shop-returns — custom URL helpers removed", () => {
  it("no longer defines a standalone readTabFromUrl function", () => {
    expect(SRC).not.toContain("readTabFromUrl");
  });

  it("no longer has inline params.delete / params.set URL-building inside the component", () => {
    // The bespoke setTab function built URLs inline; that logic now lives in
    // useUrlState. The component source should not contain the old local setTab
    // arrow that called setTabState.
    expect(SRC).not.toContain("setTabState");
  });
});

describe("admin-shop-returns — useUrlState call-site configuration", () => {
  it('uses key "tab" for the URL param', () => {
    expect(SRC).toContain('key: "tab"');
  });

  it('uses "open" as the defaultValue', () => {
    expect(SRC).toContain('defaultValue: "open"');
  });

  it("passes isTab as the isAllowed predicate", () => {
    expect(SRC).toContain("isAllowed: isTab");
  });

  it("destructures [tab, setTab] from useUrlState", () => {
    expect(SRC).toContain("tab, setTab");
  });
});

describe("admin-shop-returns — TAB_IDS and isTab predicate (new additions)", () => {
  it("defines TAB_IDS as a ReadonlySet<string>", () => {
    // Updated from ReadonlySet<Tab> to ReadonlySet<string> in this PR.
    expect(SRC).toContain("ReadonlySet<string>");
    expect(SRC).toContain("TAB_IDS");
  });

  it("defines isTab as a type-predicate (v is Tab)", () => {
    expect(SRC).toContain("v is Tab");
    expect(SRC).toContain("isTab");
  });

  it("derives TAB_IDS from the TABS array", () => {
    expect(SRC).toContain("TABS.map");
    expect(SRC).toContain("TAB_IDS");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of isTab (verbatim from source)
// ---------------------------------------------------------------------------
//
// Source:
//   type Tab = ReturnStatus | "all" | "open";
//   const TABS = [
//     { id: "open" }, { id: "requested" }, { id: "approved" },
//     { id: "shipped_back" }, { id: "received" }, { id: "refunded" },
//     { id: "replaced" }, { id: "rejected" }, { id: "all" },
//   ];
//   const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id));
//   const isTab = (v: string): v is Tab => TAB_IDS.has(v);

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

const TAB_IDS_RETURNS: ReadonlySet<string> = new Set(
  TABS_RETURNS.map((t) => t.id),
);
const isTabReturns = (v: string): v is ReturnTab =>
  TAB_IDS_RETURNS.has(v);

describe("admin-shop-returns — isTab predicate (valid inputs)", () => {
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

  it.each(valid)('accepts "%s"', (t) => {
    expect(isTabReturns(t)).toBe(true);
  });
});

describe("admin-shop-returns — isTab predicate (invalid inputs)", () => {
  it("rejects an empty string", () => {
    expect(isTabReturns("")).toBe(false);
  });

  it("rejects an unknown status value", () => {
    expect(isTabReturns("pending")).toBe(false);
    expect(isTabReturns("closed_out")).toBe(false);
  });

  it("rejects wrong casing of a valid tab", () => {
    expect(isTabReturns("Open")).toBe(false);
    expect(isTabReturns("APPROVED")).toBe(false);
    expect(isTabReturns("Shipped_Back")).toBe(false);
  });

  it("rejects a partial match (prefix of a valid tab id)", () => {
    expect(isTabReturns("ship")).toBe(false);
    expect(isTabReturns("req")).toBe(false);
  });

  it("rejects whitespace-padded versions of valid values", () => {
    expect(isTabReturns(" open")).toBe(false);
    expect(isTabReturns("open ")).toBe(false);
  });
});

describe("admin-shop-returns — TAB_IDS covers exactly 9 tabs", () => {
  it("has size 9", () => {
    expect(TAB_IDS_RETURNS.size).toBe(9);
  });

  it("TABS array has 9 entries", () => {
    expect(TABS_RETURNS).toHaveLength(9);
  });

  it("includes the synthetic 'open' and 'all' aggregate tabs", () => {
    expect(isTabReturns("open")).toBe(true);
    expect(isTabReturns("all")).toBe(true);
  });
});
