// Tests for pages/admin/admin-fitter-leads.tsx
//
// PR change (a11y): the CSR notes textarea in LeadDetailsPanel was given
// aria-label="CSR notes" so screen-reader users can identify the scratchpad.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-fitter-leads.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-label on the CSR notes textarea
// ---------------------------------------------------------------------------

describe("admin-fitter-leads LeadDetailsPanel — a11y: CSR notes aria-label", () => {
  it("CSR notes textarea has aria-label='CSR notes'", () => {
    expect(SRC).toContain('aria-label="CSR notes"');
  });

  it("aria-label appears on the element that also has a data-testid starting with lead-notes-textarea", () => {
    const ariaIdx = SRC.indexOf('aria-label="CSR notes"');
    // The data-testid is a template literal — find it by a fixed prefix
    const testidIdx = SRC.indexOf("lead-notes-textarea-");
    // Both must be in the same textarea block — within 200 chars of each other.
    expect(Math.abs(ariaIdx - testidIdx)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// LeadDetailsPanel — structural invariants
// ---------------------------------------------------------------------------

describe("admin-fitter-leads LeadDetailsPanel — structural invariants", () => {
  it("CSR notes textarea has a maxLength of 2000", () => {
    expect(SRC).toContain("maxLength={2000}");
  });

  it("CSR notes textarea has rows={6}", () => {
    expect(SRC).toContain("rows={6}");
  });

  it("CSR notes placeholder communicates its purpose", () => {
    expect(SRC).toContain("Operator scratchpad");
  });
});

// ---------------------------------------------------------------------------
// Regression: page exports and core behaviour retained
// ---------------------------------------------------------------------------

describe("admin-fitter-leads — regression", () => {
  it("still exports AdminFitterLeadsPage", () => {
    expect(SRC).toContain("export function AdminFitterLeadsPage");
  });

  it("still defines LeadDetailsPanel", () => {
    expect(SRC).toContain("function LeadDetailsPanel(");
  });
});
