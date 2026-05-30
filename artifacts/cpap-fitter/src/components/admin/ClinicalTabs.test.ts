// Tests for components/admin/ClinicalTabs.tsx
//
// PR change (a11y): three modal selects and the LabeledInput component
// were given aria-label attributes.
//   - AddSleepStudyModal: study-type select → aria-label="Study type"
//   - AddInsuranceCoverageModal: rank select → aria-label="Rank"
//   - AddPriorAuthorizationModal: status select → aria-label="Status"
//   - LabeledInput component: input → aria-label={label}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "ClinicalTabs.tsx"), "utf8");

// ---------------------------------------------------------------------------
// a11y: AddSleepStudyModal
// ---------------------------------------------------------------------------

describe("ClinicalTabs AddSleepStudyModal — a11y: study-type select aria-label", () => {
  it("study-type select has aria-label='Study type'", () => {
    expect(SRC).toContain('aria-label="Study type"');
  });
});

// ---------------------------------------------------------------------------
// a11y: AddInsuranceCoverageModal
// ---------------------------------------------------------------------------

describe("ClinicalTabs AddInsuranceCoverageModal — a11y: rank select aria-label", () => {
  it("rank select has aria-label='Rank'", () => {
    expect(SRC).toContain('aria-label="Rank"');
  });
});

// ---------------------------------------------------------------------------
// a11y: AddPriorAuthorizationModal
// ---------------------------------------------------------------------------

describe("ClinicalTabs AddPriorAuthorizationModal — a11y: status select aria-label", () => {
  it("status select has aria-label='Status'", () => {
    expect(SRC).toContain('aria-label="Status"');
  });
});

// ---------------------------------------------------------------------------
// a11y: LabeledInput helper — aria-label forwarded from label prop
// ---------------------------------------------------------------------------

describe("ClinicalTabs LabeledInput — a11y: aria-label={label}", () => {
  it("LabeledInput forwards the label prop as aria-label on the native input", () => {
    // The pattern must appear inside the LabeledInput function body.
    const fnStart = SRC.indexOf("function LabeledInput(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = SRC.indexOf("\nfunction ", fnStart + 1);
    const fnBody = SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fnBody).toContain("aria-label={label}");
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("ClinicalTabs — structural invariants", () => {
  it("defines AddSleepStudyModal", () => {
    expect(SRC).toContain("function AddSleepStudyModal(");
  });

  it("defines AddInsuranceCoverageModal", () => {
    expect(SRC).toContain("function AddInsuranceCoverageModal(");
  });

  it("defines AddPriorAuthorizationModal", () => {
    expect(SRC).toContain("function AddPriorAuthorizationModal(");
  });

  it("defines LabeledInput", () => {
    expect(SRC).toContain("function LabeledInput(");
  });
});
