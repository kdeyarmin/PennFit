// Tests for pages/admin/admin-backorders.tsx
//
// PR change: replaced window.confirm() in the SubstitutesPanel
// onDelete handler with the useConfirmDialog hook. Deleting a
// substitute rule is irreversible, so the dialog is marked
// destructive.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-backorders.tsx"), "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("admin-backorders — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation in SubstitutesPanel
// ---------------------------------------------------------------------------

describe("admin-backorders SubstitutesPanel — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// onDelete — confirm dialog options
// ---------------------------------------------------------------------------

describe("admin-backorders SubstitutesPanel — onDelete confirm options", () => {
  it("onDelete handler is async", () => {
    expect(SRC).toContain("onDelete={async () => {");
  });

  it("awaits confirm() before deleting (early-return on cancel)", () => {
    // Guard: if (!(await confirm(...))) return;
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Delete substitute?"', () => {
    expect(SRC).toContain('title: "Delete substitute?"');
  });

  it("description includes the primarySku and alternativeSku", () => {
    expect(SRC).toContain(
      "`Delete substitute ${s.primarySku} → ${s.alternativeSku}?`",
    );
  });

  it('uses confirmLabel "Delete"', () => {
    expect(SRC).toContain('confirmLabel: "Delete"');
  });

  it("marks the action as destructive:true", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("still calls remove.mutate(s.id) on confirmation", () => {
    expect(SRC).toContain("remove.mutate(s.id);");
  });

  it("no longer uses window.confirm for the delete action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}Delete substitute/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("admin-backorders SubstitutesPanel — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the Card return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// Regression: core backorders behaviour
// ---------------------------------------------------------------------------

describe("admin-backorders — regression: core behaviour retained", () => {
  it("still renders BackorderRow components", () => {
    expect(SRC).toContain("BackorderRow");
  });

  it("still imports clearBackorder and createSubstitute", () => {
    expect(SRC).toContain("clearBackorder");
    expect(SRC).toContain("createSubstitute");
  });
});

// ---------------------------------------------------------------------------
// a11y: aria-label additions (PR change)
// ---------------------------------------------------------------------------

describe("admin-backorders — a11y: form controls have aria-labels", () => {
  it("BackordersPanel SKU input has aria-label='SKU'", () => {
    expect(SRC).toContain('aria-label="SKU"');
  });

  it("BackordersPanel Notes input has aria-label='Notes'", () => {
    expect(SRC).toContain('aria-label="Notes"');
  });

  it("SubstitutesPanel Primary SKU input has aria-label='Primary SKU'", () => {
    expect(SRC).toContain('aria-label="Primary SKU"');
  });

  it("SubstitutesPanel Alternative SKU input has aria-label='Alternative SKU'", () => {
    expect(SRC).toContain('aria-label="Alternative SKU"');
  });

  it("SubstitutesPanel Priority input has aria-label='Priority'", () => {
    expect(SRC).toContain('aria-label="Priority"');
  });
});
