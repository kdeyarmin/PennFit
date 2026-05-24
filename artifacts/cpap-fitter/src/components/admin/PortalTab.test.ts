// Tests for components/admin/PortalTab.tsx
//
// PR change: replaced window.confirm() in handleRevoke with the
// useConfirmDialog hook. Revoking portal access immediately signs
// the patient out, so the action is marked destructive.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "PortalTab.tsx"), "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("PortalTab — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation
// ---------------------------------------------------------------------------

describe("PortalTab — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// handleRevoke — confirm dialog options
// ---------------------------------------------------------------------------

describe("PortalTab — handleRevoke confirm options", () => {
  it("awaits confirm() before revoking (async guard pattern)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,400}return;/);
  });

  it('uses title "Revoke portal access?"', () => {
    expect(SRC).toContain('title: "Revoke portal access?"');
  });

  it("description explains the patient will be signed out immediately", () => {
    expect(SRC).toContain(
      "They will be signed out immediately and cannot log in until re-invited.",
    );
  });

  it('uses confirmLabel "Revoke"', () => {
    expect(SRC).toContain('confirmLabel: "Revoke"');
  });

  it("marks the action as destructive:true", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("no longer uses window.confirm for the revoke action", () => {
    expect(SRC).not.toMatch(/window\.confirm[\s\S]{0,100}Revoke this patient/);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("PortalTab — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the component return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// Regression: core PortalTab behaviour
// ---------------------------------------------------------------------------

describe("PortalTab — regression: core behaviour retained", () => {
  it("still exports PortalTab", () => {
    expect(SRC).toContain("export function PortalTab");
  });

  it("still accepts patient and onChanged props", () => {
    expect(SRC).toContain("patient: PatientDetail");
    expect(SRC).toContain("onChanged: () => void");
  });

  it("still calls revokePortalInvite", () => {
    expect(SRC).toContain("revokePortalInvite");
  });

  it("still calls resendPortalInvite", () => {
    expect(SRC).toContain("resendPortalInvite");
  });
});