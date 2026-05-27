// Tests for components/admin/EquipmentTab.tsx
//
// PR change (a11y): two form controls in AddEquipmentModal and the
// LabeledInput helper were given aria-label attributes.
//   - AddEquipmentModal: device-class select → aria-label="Device class"
//   - LabeledInput component: input → aria-label={label}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "EquipmentTab.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// a11y: AddEquipmentModal
// ---------------------------------------------------------------------------

describe("EquipmentTab AddEquipmentModal — a11y: device-class select aria-label", () => {
  it("device-class select has aria-label='Device class'", () => {
    expect(SRC).toContain('aria-label="Device class"');
  });
});

// ---------------------------------------------------------------------------
// a11y: LabeledInput helper
// ---------------------------------------------------------------------------

describe("EquipmentTab LabeledInput — a11y: aria-label forwarded from label prop", () => {
  it("LabeledInput forwards the label prop as aria-label on the native input", () => {
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

describe("EquipmentTab — structural invariants", () => {
  it("exports EquipmentTab", () => {
    expect(SRC).toContain("export function EquipmentTab");
  });

  it("defines AddEquipmentModal", () => {
    expect(SRC).toContain("function AddEquipmentModal(");
  });

  it("defines LabeledInput", () => {
    expect(SRC).toContain("function LabeledInput(");
  });

  it("device class select is still driven by DEVICE_CLASS_LABELS", () => {
    expect(SRC).toContain("DEVICE_CLASS_LABELS");
  });
});