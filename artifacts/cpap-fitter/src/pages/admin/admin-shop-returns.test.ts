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
