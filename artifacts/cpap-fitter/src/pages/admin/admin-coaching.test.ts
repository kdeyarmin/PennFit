// Tests for pages/admin/admin-coaching.tsx
//
// PR change (a11y): two inputs in NewPlanCard were given aria-label
// attributes:
//   - Patient ID (UUID) text input → aria-label="Patient ID (UUID)"
//   - Target % numeric input      → aria-label="Target %"

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-coaching.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: aria-labels in NewPlanCard
// ---------------------------------------------------------------------------

describe("admin-coaching NewPlanCard — a11y: form controls have aria-labels", () => {
  it("patient ID input has aria-label='Patient ID (UUID)'", () => {
    expect(SRC).toContain('aria-label="Patient ID (UUID)"');
  });

  it("target % input has aria-label='Target %'", () => {
    expect(SRC).toContain('aria-label="Target %"');
  });
});

// ---------------------------------------------------------------------------
// NewPlanCard — structural invariants
// ---------------------------------------------------------------------------

describe("admin-coaching NewPlanCard — structural invariants", () => {
  it("patient ID input has inputMode=numeric for the target field", () => {
    expect(SRC).toContain('inputMode="numeric"');
  });

  it("patient ID input placeholder shows a UUID example", () => {
    expect(SRC).toContain("00000000-0000-0000-0000-000000000000");
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