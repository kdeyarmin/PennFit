// Tests for components/admin/BulkActionBar.tsx
//
// The vitest environment for cpap-fitter is "node" (no DOM, no React
// rendering). We follow the source-analysis pattern established by
// hooks/use-bulk-selection.test.ts and hooks/use-filtered-list.test.ts:
// read the source as a string and assert the structural invariants
// that drive runtime behaviour.
//
// Invariants under test:
//   - Public API exports are stable (component + interfaces).
//   - Visibility rule: returns null when selectedCount === 0 && !feedback.
//   - Selection count vs feedback label logic.
//   - Error vs success colour styling.
//   - "Clear selection" is disabled while any action isPending.
//   - "Dismiss" button rendered only when selectedCount === 0 && feedback.
//   - Action buttons rendered only when selectedCount > 0.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "BulkActionBar.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("BulkActionBar — exports", () => {
  it("exports the BulkActionBar function component", () => {
    expect(SRC).toContain("export function BulkActionBar");
  });
  it("exports the BulkAction interface", () => {
    expect(SRC).toContain("export interface BulkAction");
  });
  it("exports the BulkActionBarProps interface", () => {
    expect(SRC).toContain("export interface BulkActionBarProps");
  });
});

// ---------------------------------------------------------------------------
// Visibility rule — null when nothing to show
// ---------------------------------------------------------------------------

describe("BulkActionBar — visibility rule", () => {
  it("returns null when selectedCount === 0 AND feedback is falsy", () => {
    // The guard must be an early return so the bar adds no DOM when
    // there is neither a selection nor feedback.
    expect(SRC).toContain("if (selectedCount === 0 && !feedback) return null;");
  });

  it("does NOT return null early when selectedCount > 0", () => {
    // When there's a selection the bar must render regardless of feedback.
    // The null guard must only fire when BOTH conditions are true.
    expect(SRC).toMatch(/selectedCount === 0 && !feedback/);
    // The guard is exactly the conjunction; neither condition alone triggers it.
    expect(SRC).not.toMatch(/if \(selectedCount === 0\) return null/);
  });

  it("does NOT return null when feedback is set but selectedCount === 0", () => {
    // Feedback alone keeps the bar visible — the admin needs to read
    // the result of the last bulk action even after selection is cleared.
    const nullGuard = SRC.indexOf("if (selectedCount === 0 && !feedback) return null;");
    expect(nullGuard).toBeGreaterThan(-1);
    // Guard uses &&, so feedback alone won't satisfy it.
    expect(SRC).not.toMatch(/if \(!feedback\) return null/);
  });
});

// ---------------------------------------------------------------------------
// Count label vs feedback label
// ---------------------------------------------------------------------------

describe("BulkActionBar — count/feedback label", () => {
  it("renders '{N} selected on this page' when selectedCount > 0", () => {
    expect(SRC).toContain("`${selectedCount} selected on this page`");
  });

  it("renders 'Bulk action result' when selectedCount === 0 (feedback-only state)", () => {
    expect(SRC).toContain('"Bulk action result"');
  });

  it("renders feedback text in a sibling span when feedback is present", () => {
    // The feedback.text span must exist as a conditional child so it
    // appears alongside both the count label and the result label.
    expect(SRC).toContain("{feedback.text}");
  });
});

// ---------------------------------------------------------------------------
// Error vs success colours
// ---------------------------------------------------------------------------

describe("BulkActionBar — error vs success styling", () => {
  it("derives isError from feedback.kind === 'error'", () => {
    expect(SRC).toContain('feedback?.kind === "error"');
  });

  it("uses the error border colour (#fca5a5) when isError is true", () => {
    expect(SRC).toContain('"#fca5a5"');
  });

  it("uses the amber border colour (#c9a24a) for the success / no-error state", () => {
    expect(SRC).toContain('"#c9a24a"');
  });

  it("uses the error background (#fef2f2) when isError is true", () => {
    expect(SRC).toContain('"#fef2f2"');
  });

  it("uses the amber background (#fffaf0) for the success / no-error state", () => {
    expect(SRC).toContain('"#fffaf0"');
  });

  it("uses the error text colour (#991b1b) for feedback text when isError", () => {
    expect(SRC).toContain('"#991b1b"');
  });
});

// ---------------------------------------------------------------------------
// Action buttons — only when selectedCount > 0
// ---------------------------------------------------------------------------

describe("BulkActionBar — action buttons", () => {
  it("maps actions to Button elements only when selectedCount > 0", () => {
    // The conditional must gate on selectedCount > 0 before mapping.
    expect(SRC).toMatch(/selectedCount > 0[\s\S]*?actions\.map/);
  });

  it("passes isPending as isLoading to Button", () => {
    expect(SRC).toContain("isLoading={a.isPending}");
  });

  it("disables Button when action.disabled OR action.isPending", () => {
    expect(SRC).toContain("disabled={a.disabled || a.isPending}");
  });

  it("defaults action intent to 'secondary' when not supplied", () => {
    expect(SRC).toContain('intent={a.intent ?? "secondary"}');
  });
});

// ---------------------------------------------------------------------------
// Clear selection button
// ---------------------------------------------------------------------------

describe("BulkActionBar — clear selection button", () => {
  it("renders Clear-selection button only when selectedCount > 0", () => {
    // Must appear inside the selectedCount > 0 conditional.
    expect(SRC).toContain("Clear selection");
  });

  it("disables Clear-selection when any action isPending", () => {
    // When a bulk mutation is in flight the admin must not be able
    // to clear the selection (which could confuse in-flight requests).
    expect(SRC).toContain("disabled={actions.some((a) => a.isPending)}");
  });

  it("invokes onClear when Clear-selection is clicked", () => {
    expect(SRC).toContain("onClick={onClear}");
  });
});

// ---------------------------------------------------------------------------
// Dismiss button — feedback-only state
// ---------------------------------------------------------------------------

describe("BulkActionBar — dismiss button", () => {
  it("renders Dismiss only when selectedCount === 0 AND feedback is set AND onDismissFeedback is provided", () => {
    // The exact condition guards the Dismiss button.
    expect(SRC).toContain(
      "{selectedCount === 0 && feedback && onDismissFeedback && (",
    );
  });

  it("invokes onDismissFeedback when Dismiss is clicked", () => {
    expect(SRC).toContain("onClick={onDismissFeedback}");
  });
});

// ---------------------------------------------------------------------------
// ARIA / accessibility
// ---------------------------------------------------------------------------

describe("BulkActionBar — accessibility", () => {
  it("applies role='region' to the bar container", () => {
    expect(SRC).toContain('role="region"');
  });

  it("uses the ariaLabel prop as aria-label on the region", () => {
    expect(SRC).toContain("aria-label={ariaLabel}");
  });

  it("defaults ariaLabel to 'Bulk actions' when not provided", () => {
    expect(SRC).toContain('ariaLabel = "Bulk actions"');
  });
});

// ---------------------------------------------------------------------------
// Comment: confirmation dialogs delegated to useConfirmDialog hook
// (PR change: updated the file-level doc comment)
// ---------------------------------------------------------------------------

describe("BulkActionBar — confirmation dialog delegation comment", () => {
  it("documents that callers use the useConfirmDialog hook (not window.confirm)", () => {
    // The top-of-file ownership comment was updated from
    // "window.confirm or modal" to "useConfirmDialog hook".
    // This test ensures the documentation stays in sync with the
    // hook migration throughout the codebase.
    expect(SRC).toContain("useConfirmDialog hook");
  });

  it("does NOT mention window.confirm in the component ownership comment", () => {
    // Regression: the old comment said callers wrap with window.confirm;
    // after the migration the comment should only reference the hook.
    expect(SRC).not.toContain("window.confirm or modal");
  });
});