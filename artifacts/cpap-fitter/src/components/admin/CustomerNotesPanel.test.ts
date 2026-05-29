// Tests for components/admin/CustomerNotesPanel.tsx
//
// PR change (a11y): the note-draft textarea was given
// aria-label="Customer note" so screen-reader users can identify the
// field without a visible label (the placeholder text alone is not
// sufficient for screen readers).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "CustomerNotesPanel.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-label on the note textarea
// ---------------------------------------------------------------------------

describe("CustomerNotesPanel — a11y: note textarea aria-label", () => {
  it("note textarea has aria-label='Customer note'", () => {
    expect(SRC).toContain('aria-label="Customer note"');
  });

  it("aria-label appears alongside the placeholder (same element)", () => {
    const ariaIdx = SRC.indexOf('aria-label="Customer note"');
    const placeholderIdx = SRC.indexOf(
      "Add a note for the team. Visible only to admins.",
    );
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeGreaterThan(-1);
    // Both must be within the same textarea block.
    expect(Math.abs(ariaIdx - placeholderIdx)).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("CustomerNotesPanel — structural invariants", () => {
  it("exports CustomerNotesPanel", () => {
    expect(SRC).toContain("export function CustomerNotesPanel");
  });

  it("limits notes to MAX_BODY + 200 characters via maxLength", () => {
    expect(SRC).toContain("MAX_BODY + 200");
  });

  it("disables the textarea while a mutation is pending", () => {
    expect(SRC).toContain("mutation.isPending");
    expect(SRC).toContain("disabled={mutation.isPending}");
  });
});
