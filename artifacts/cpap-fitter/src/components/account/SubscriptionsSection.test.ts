// Tests for components/account/SubscriptionsSection.tsx
//
// PR change: replaced window.confirm() in handlePause with the
// useConfirmDialog hook, which provides an accessible Radix
// AlertDialog instead of the native browser modal.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, "SubscriptionsSection.tsx");
if (!existsSync(srcPath)) {
  throw new Error(`Source file not found: ${srcPath}`);
}
const SRC = readFileSync(srcPath, "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("SubscriptionsSection — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation
// ---------------------------------------------------------------------------

describe("SubscriptionsSection — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// handlePause — confirm dialog options
// ---------------------------------------------------------------------------

describe("SubscriptionsSection — handlePause confirm options", () => {
  it("awaits confirm() before pausing (async guard pattern)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Pause auto-ship?"', () => {
    expect(SRC).toContain('title: "Pause auto-ship?"');
  });

  it("includes the pause description mentioning stopping charges and shipping", () => {
    expect(SRC).toContain(
      "We'll stop charging your card and shipping until you resume.",
    );
  });

  it('uses confirmLabel "Pause"', () => {
    expect(SRC).toContain('confirmLabel: "Pause"');
  });

  it("does NOT set destructive:true (pausing is reversible)", () => {
    // The confirm call for pause should not use destructive styling —
    // pause is a reversible action unlike delete or close.
    const pauseBlock = SRC.match(/handlePause[\s\S]{0,600}?return;/)?.[0] ?? "";
    expect(pauseBlock).not.toContain("destructive: true");
  });

  it("no longer uses window.confirm for the pause action", () => {
    // Regression: ensure the old pattern is gone.
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}Pause auto-ship/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("SubscriptionsSection — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the section return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});
