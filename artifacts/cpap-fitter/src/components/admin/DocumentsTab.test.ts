// Tests for components/admin/DocumentsTab.tsx
//
// PR change: replaced window.confirm() in handleDelete with the
// useConfirmDialog hook, providing an accessible Radix AlertDialog
// with destructive styling for the permanent delete action.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "DocumentsTab.tsx"), "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("DocumentsTab — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation
// ---------------------------------------------------------------------------

describe("DocumentsTab — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// handleDelete — confirm dialog options
// ---------------------------------------------------------------------------

describe("DocumentsTab — handleDelete confirm options", () => {
  it("awaits confirm() before deleting (async guard pattern)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Delete document?"', () => {
    expect(SRC).toContain('title: "Delete document?"');
  });

  it("includes the document filename in the description", () => {
    // The description template-strings the filename: `Delete "${doc.filename ...}"?`
    expect(SRC).toContain(
      '`Delete "${doc.filename ?? "this document"}"? This cannot be undone.`',
    );
  });

  it('uses confirmLabel "Delete"', () => {
    expect(SRC).toContain('confirmLabel: "Delete"');
  });

  it("marks the action as destructive:true (permanent, cannot be undone)", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("no longer uses window.confirm for the delete action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}Delete/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("DocumentsTab — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the component return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// Regression: core behaviour retained
// ---------------------------------------------------------------------------

describe("DocumentsTab — regression: core document behaviour", () => {
  it("still exports DocumentsTab", () => {
    expect(SRC).toContain("export function DocumentsTab");
  });

  it("still accepts a patientId prop", () => {
    expect(SRC).toContain("patientId: string");
  });

  it("still calls deletePatientDocument", () => {
    expect(SRC).toContain("deletePatientDocument");
  });
});