// Tests for components/admin/DocumentsTab.tsx
//
// PR change (a11y): the review-note textarea inside the document review
// flow was given aria-label="Review note" so screen-reader users can
// identify the optional note field without relying solely on the
// placeholder text.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "DocumentsTab.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-label on the review note textarea
// ---------------------------------------------------------------------------

describe("DocumentsTab — a11y: review note textarea aria-label", () => {
  it("review note textarea has aria-label='Review note'", () => {
    expect(SRC).toContain('aria-label="Review note"');
  });

  it("aria-label appears near the maxLength={500} note textarea", () => {
    const ariaIdx = SRC.indexOf('aria-label="Review note"');
    const maxlenIdx = SRC.indexOf("maxLength={500}");
    expect(ariaIdx).toBeGreaterThan(-1);
    expect(maxlenIdx).toBeGreaterThan(-1);
    expect(Math.abs(ariaIdx - maxlenIdx)).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("DocumentsTab — structural invariants", () => {
  it("exports DocumentsTab", () => {
    expect(SRC).toContain("export function DocumentsTab");
  });

  it("receives patientId as a prop", () => {
    expect(SRC).toContain("patientId");
  });

  it("review note is limited to 500 characters", () => {
    expect(SRC).toContain("maxLength={500}");
  });
});