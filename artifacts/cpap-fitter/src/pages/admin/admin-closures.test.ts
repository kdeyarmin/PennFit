// Tests for pages/admin/admin-closures.tsx
//
// PR change: replaced window.confirm() in the ClosureListCard
// onEndNow handler with the useConfirmDialog hook. Ending a closure
// immediately stops auto-replies, but it is not considered
// irreversible, so the dialog is neutral (no destructive styling).
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-closures.tsx"), "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("admin-closures — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation in ClosureListCard
// ---------------------------------------------------------------------------

describe("admin-closures ClosureListCard — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// onEndNow — confirm dialog options
// ---------------------------------------------------------------------------

describe("admin-closures ClosureListCard — onEndNow confirm options", () => {
  it("onEndNow handler is async", () => {
    expect(SRC).toContain("onEndNow={async () => {");
  });

  it("awaits confirm() before ending (early-return on cancel)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "End closure now?"', () => {
    expect(SRC).toContain('title: "End closure now?"');
  });

  it("description includes the closure label and states auto-reply stops immediately", () => {
    expect(SRC).toContain(
      '`End "${c.label}" right now? Auto-reply stops immediately.`',
    );
  });

  it('uses confirmLabel "End now"', () => {
    expect(SRC).toContain('confirmLabel: "End now"');
  });

  it("does NOT use destructive:true (ending a closure is reversible by re-creation)", () => {
    // The confirm call for end-now should not use destructive styling.
    const endNowBlock =
      SRC.match(/onEndNow=\{async \(\) => \{[\s\S]{0,400}return;/)?.[0] ?? "";
    expect(endNowBlock).not.toContain("destructive: true");
  });

  it("still calls endNow.mutate(c.id) on confirmation", () => {
    expect(SRC).toContain("endNow.mutate(c.id);");
  });

  it("no longer uses window.confirm for the end-now action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}End/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("admin-closures ClosureListCard — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the Card return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// Regression: core closures behaviour
// ---------------------------------------------------------------------------

describe("admin-closures — regression: core behaviour retained", () => {
  it("still exports the closures page", () => {
    expect(SRC).toContain("function NewClosureCard");
    expect(SRC).toContain("function ClosureListCard");
  });

  it("still imports createClosure and endClosureNow", () => {
    expect(SRC).toContain("createClosure");
    expect(SRC).toContain("endClosureNow");
  });
});

// ---------------------------------------------------------------------------
// a11y: aria-label additions (PR change)
// ---------------------------------------------------------------------------

describe("admin-closures — a11y: form controls have aria-labels", () => {
  it("NewClosureCard Label input has aria-label='Label'", () => {
    expect(SRC).toContain('aria-label="Label"');
  });

  it("NewClosureCard Starts-at datetime input has aria-label='Starts at'", () => {
    expect(SRC).toContain('aria-label="Starts at"');
  });

  it("NewClosureCard Ends-at datetime input has aria-label='Ends at'", () => {
    expect(SRC).toContain('aria-label="Ends at"');
  });

  it("NewClosureCard Auto-reply message textarea has aria-label='Auto-reply message'", () => {
    expect(SRC).toContain('aria-label="Auto-reply message"');
  });
});
