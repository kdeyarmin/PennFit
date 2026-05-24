// Tests for pages/shop-product-detail.tsx
//
// PR changes in MyReviewPanel:
//   1. Replaced window.confirm() with the useConfirmDialog hook for
//      the "Delete your review?" prompt (destructive, cannot be undone).
//   2. Replaced window.alert() with a toast notification on delete
//      failure (variant: "destructive").
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "shop-product-detail.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

describe("shop-product-detail — imports", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });

  it("imports toast from @/hooks/use-toast", () => {
    expect(SRC).toContain('from "@/hooks/use-toast"');
    expect(SRC).toContain("toast");
  });
});

// ---------------------------------------------------------------------------
// MyReviewPanel — hook initialisation
// ---------------------------------------------------------------------------

describe("shop-product-detail MyReviewPanel — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// handleDelete — confirm dialog options
// ---------------------------------------------------------------------------

describe("shop-product-detail MyReviewPanel — handleDelete confirm options", () => {
  it("awaits confirm() before deleting (async guard pattern)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Delete your review?"', () => {
    expect(SRC).toContain('title: "Delete your review?"');
  });

  it('description says "This can\'t be undone."', () => {
    expect(SRC).toContain('"This can\'t be undone."');
  });

  it('uses confirmLabel "Delete"', () => {
    expect(SRC).toContain('confirmLabel: "Delete"');
  });

  it("marks the delete action as destructive:true", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("no longer uses window.confirm for the delete action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}Delete your review/);
  });
});

// ---------------------------------------------------------------------------
// handleDelete — error toast instead of window.alert
// ---------------------------------------------------------------------------

describe("shop-product-detail MyReviewPanel — delete error toast", () => {
  it("calls toast() on delete failure", () => {
    expect(SRC).toContain("toast({");
  });

  it('uses variant: "destructive" for the error toast', () => {
    expect(SRC).toContain('variant: "destructive"');
  });

  it('uses title "Couldn\'t delete your review"', () => {
    expect(SRC).toContain('"Couldn\'t delete your review"');
  });

  it('includes description "Please try again."', () => {
    expect(SRC).toContain('"Please try again."');
  });

  it("no longer uses window.alert on delete failure", () => {
    expect(SRC).not.toMatch(
      /window\.alert[\s\S]{0,100}Couldn't delete your review/,
    );
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("shop-product-detail MyReviewPanel — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside MyReviewPanel return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// Regression: core MyReviewPanel behaviour
// ---------------------------------------------------------------------------

describe("shop-product-detail MyReviewPanel — regression", () => {
  it("still calls deleteMyReview on confirmed delete", () => {
    expect(SRC).toContain("deleteMyReview");
  });

  it("still calls onChange(null) after successful delete", () => {
    expect(SRC).toContain("onChange(null)");
  });

  it("still has a deleting state guard", () => {
    expect(SRC).toContain("setDeleting(true)");
    expect(SRC).toContain("setDeleting(false)");
  });

  it("has the pdp-my-review-delete testid on the delete button", () => {
    expect(SRC).toContain('data-testid="pdp-my-review-delete"');
  });
});
