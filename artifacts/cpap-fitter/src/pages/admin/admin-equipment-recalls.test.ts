// Tests for pages/admin/admin-equipment-recalls.tsx
//
// PR change (a11y): multiple form controls in AddRecallModal and
// LogActionForm were given aria-label attributes.
//
// Controls labelled in this PR:
//   AddRecallModal:
//     - Serial criteria select
//     - Serial list textarea
//     - Description textarea
//     - Field helper: select (aria-label={label}) and input (aria-label={label})
//   LogActionForm:
//     - Action select
//     - Evidence URL input
//     - Notes textarea

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-equipment-recalls.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-labels in AddRecallModal
// ---------------------------------------------------------------------------

describe("admin-equipment-recalls AddRecallModal — a11y: form controls have aria-labels", () => {
  it("serial criteria select has aria-label='Serial criteria'", () => {
    expect(SRC).toContain('aria-label="Serial criteria"');
  });

  it("serial list textarea has aria-label='Serial list'", () => {
    expect(SRC).toContain('aria-label="Serial list"');
  });

  it("description textarea has aria-label='Description'", () => {
    expect(SRC).toContain('aria-label="Description"');
  });
});

// ---------------------------------------------------------------------------
// a11y: aria-labels in LogActionForm
// ---------------------------------------------------------------------------

describe("admin-equipment-recalls LogActionForm — a11y: form controls have aria-labels", () => {
  it("action select has aria-label='Action'", () => {
    expect(SRC).toContain('aria-label="Action"');
  });

  it("evidence URL input has aria-label='Evidence URL'", () => {
    expect(SRC).toContain('aria-label="Evidence URL"');
  });

  it("notes textarea has aria-label='Notes'", () => {
    expect(SRC).toContain('aria-label="Notes"');
  });
});

// ---------------------------------------------------------------------------
// a11y: Field helper propagates aria-label
// ---------------------------------------------------------------------------

describe("admin-equipment-recalls Field helper — a11y: aria-label forwarded from label prop", () => {
  it("Field select uses aria-label={label}", () => {
    // The Field component renders either a <select> or <input> depending
    // on whether options are provided. Both must forward aria-label={label}.
    expect(SRC).toContain("aria-label={label}");
  });
});

// ---------------------------------------------------------------------------
// Regression: page exports and core behaviour retained
// ---------------------------------------------------------------------------

describe("admin-equipment-recalls — regression", () => {
  it("still exports AdminEquipmentRecallsPage", () => {
    expect(SRC).toContain("export function AdminEquipmentRecallsPage");
  });

  it("still defines AddRecallModal", () => {
    expect(SRC).toContain("function AddRecallModal(");
  });

  it("still defines LogActionForm", () => {
    expect(SRC).toContain("function LogActionForm(");
  });

  it("still defines the Field helper", () => {
    expect(SRC).toContain("function Field(");
  });
});
