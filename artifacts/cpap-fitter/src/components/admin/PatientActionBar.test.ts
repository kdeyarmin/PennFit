// Tests for components/admin/PatientActionBar.tsx
//
// PR change: replaced window.confirm() in the patient-close status
// change with the useConfirmDialog hook. The close action is
// irreversible (patients removed from outreach permanently) so the
// dialog is marked destructive.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "PatientActionBar.tsx"), "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("PatientActionBar — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation
// ---------------------------------------------------------------------------

describe("PatientActionBar — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// Close-patient confirm dialog options
// ---------------------------------------------------------------------------

describe("PatientActionBar — close-patient confirm options", () => {
  it("awaits confirm() only when next status is 'closed'", () => {
    // The guard fires only for next === "closed".
    expect(SRC).toContain('if (next === "closed") {');
  });

  it("uses await confirm() (async guard pattern)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Close patient?"', () => {
    expect(SRC).toContain('title: "Close patient?"');
  });

  it("description warns that closed patients are removed from outreach permanently", () => {
    expect(SRC).toContain(
      "Closed patients are removed from outreach permanently. Proceed?",
    );
  });

  it('uses confirmLabel "Close patient"', () => {
    expect(SRC).toContain('confirmLabel: "Close patient"');
  });

  it("marks the action as destructive:true (permanent)", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("no longer uses window.confirm for the close action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}Close this patient/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("PatientActionBar — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the Card return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// Regression: core PatientActionBar behaviour
// ---------------------------------------------------------------------------

describe("PatientActionBar — regression: core behaviour retained", () => {
  it("still exports PatientActionBar", () => {
    expect(SRC).toContain("export function PatientActionBar");
  });

  it("still accepts patient and onAfterAction props", () => {
    expect(SRC).toContain("patient: PatientDetail");
    expect(SRC).toContain("onAfterAction: () => void");
  });

  it("still uses useSendSmsReminder, useSendEmailReminder, usePlaceVoiceCall", () => {
    expect(SRC).toContain("useSendSmsReminder");
    expect(SRC).toContain("useSendEmailReminder");
    expect(SRC).toContain("usePlaceVoiceCall");
  });
});
