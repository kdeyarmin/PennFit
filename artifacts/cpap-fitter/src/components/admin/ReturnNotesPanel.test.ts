// Tests for components/admin/ReturnNotesPanel.tsx
//
// PR change (a11y): the note-draft textarea was given
// aria-label="Return note" so screen-reader users can identify the
// internal return note field.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "ReturnNotesPanel.tsx"), "utf8");

// ---------------------------------------------------------------------------
// a11y: aria-label on the note textarea
// ---------------------------------------------------------------------------

describe("ReturnNotesPanel — a11y: note textarea aria-label", () => {
  it("note textarea has aria-label='Return note'", () => {
    expect(SRC).toContain('aria-label="Return note"');
  });

  it("aria-label appears alongside the return-specific placeholder", () => {
    const ariaIdx = SRC.indexOf('aria-label="Return note"');
    const placeholderIdx = SRC.indexOf(
      "Add an internal note about this return.",
    );
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(Math.abs(ariaIdx - placeholderIdx)).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("ReturnNotesPanel — structural invariants", () => {
  it("exports ReturnNotesPanel", () => {
    expect(SRC).toContain("export function ReturnNotesPanel");
  });

  it("note is visible only to admins (per placeholder text)", () => {
    expect(SRC).toContain("Visible only to admins");
  });

  it("disables the textarea while a mutation is pending", () => {
    expect(SRC).toContain("disabled={mutation.isPending}");
  });
});
