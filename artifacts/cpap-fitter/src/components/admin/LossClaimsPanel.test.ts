// Tests for components/admin/LossClaimsPanel.tsx
//
// PR change (a11y): the optional-note input was given
// aria-label="Optional note" so screen-reader users can identify the
// loss-claim note field even though its placeholder also reads "Optional note".
// The explicit aria-label ensures compatibility with screen readers that
// do not derive accessible names from placeholder attributes.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "LossClaimsPanel.tsx"), "utf8");

// ---------------------------------------------------------------------------
// a11y: aria-label on the note input
// ---------------------------------------------------------------------------

describe("LossClaimsPanel — a11y: note input aria-label", () => {
  it("note input has aria-label='Optional note'", () => {
    expect(SRC).toContain('aria-label="Optional note"');
  });

  it("aria-label and placeholder are both 'Optional note' on the same element", () => {
    const ariaIdx = SRC.indexOf('aria-label="Optional note"');
    const placeholderIdx = SRC.indexOf('placeholder="Optional note"');
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeGreaterThan(-1);
    // Both must be within the same input element block.
    expect(Math.abs(ariaIdx - placeholderIdx)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("LossClaimsPanel — structural invariants", () => {
  it("exports LossClaimsPanel", () => {
    expect(SRC).toContain("export function LossClaimsPanel");
  });

  it("receives orderId as a prop", () => {
    expect(SRC).toContain("orderId");
  });
});
