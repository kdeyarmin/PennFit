// Tests for pages/admin/admin-coaching.tsx
//
// NewPlanCard's raw "Patient ID (UUID)" text box was replaced by the
// shared <PatientSearchCombobox> (search a patient by name / PacWare id),
// so operators no longer paste a UUID no human knows. The Target % numeric
// input keeps its aria-label.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-coaching.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Patient selection — shared picker, not a raw UUID box
// ---------------------------------------------------------------------------

describe("admin-coaching NewPlanCard — patient selection", () => {
  it("uses the shared PatientSearchCombobox", () => {
    expect(SRC).toContain("PatientSearchCombobox");
    expect(SRC).toContain('aria-label="Patient"');
  });

  it("no longer asks the operator to paste a raw patient UUID", () => {
    expect(SRC).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(SRC).not.toContain("Patient ID (UUID)");
  });
});

// ---------------------------------------------------------------------------
// a11y: the remaining form control keeps its aria-label
// ---------------------------------------------------------------------------

describe("admin-coaching NewPlanCard — a11y: form controls have aria-labels", () => {
  it("target % input has aria-label='Target %'", () => {
    expect(SRC).toContain('aria-label="Target %"');
  });

  it("target % input has inputMode=numeric", () => {
    expect(SRC).toContain('inputMode="numeric"');
  });
});

// ---------------------------------------------------------------------------
// Regression: page exports and core behaviour retained
// ---------------------------------------------------------------------------

describe("admin-coaching — regression", () => {
  it("still exports AdminCoachingPage", () => {
    expect(SRC).toContain("export function AdminCoachingPage");
  });

  it("still defines NewPlanCard", () => {
    expect(SRC).toContain("function NewPlanCard");
  });
});
