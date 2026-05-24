// Tests for pages/admin/rules.tsx
//
// PR change: replaced window.confirm() in the RuleFormModal onDelete
// handler with the useConfirmDialog hook. Deleting a rule cannot be
// undone, so the dialog is marked destructive.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "rules.tsx"), "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("rules — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation in RuleFormModal
// ---------------------------------------------------------------------------

describe("rules RuleFormModal — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// onDelete — confirm dialog options
// ---------------------------------------------------------------------------

describe("rules RuleFormModal — onDelete confirm options", () => {
  it("awaits confirm() before deleting (async guard pattern)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Delete rule?"', () => {
    expect(SRC).toContain('title: "Delete rule?"');
  });

  it("description includes the rule name and states it cannot be undone", () => {
    expect(SRC).toContain(
      '`Delete rule "${initial.name}"? This cannot be undone.`',
    );
  });

  it('uses confirmLabel "Delete"', () => {
    expect(SRC).toContain('confirmLabel: "Delete"');
  });

  it("marks the delete action as destructive:true", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("still guards onDelete with `if (!initial) return;`", () => {
    expect(SRC).toContain("if (!initial) return;");
  });

  it("no longer uses window.confirm for the delete action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}Delete rule/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("rules RuleFormModal — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the modal return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// Regression: core rules page behaviour
// ---------------------------------------------------------------------------

describe("rules — regression: core behaviour retained", () => {
  it("contains RuleFormModal component", () => {
    expect(SRC).toContain("function RuleFormModal");
  });

  it("still uses useAdminRole for role-based access", () => {
    expect(SRC).toContain("useAdminRole");
  });

  it("still manages form state with useState<FormState>", () => {
    expect(SRC).toContain("useState<FormState>");
  });
});