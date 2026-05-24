// Tests for pages/admin/patients.tsx
//
// PR change: replaced window.confirm() in the bulk status-change
// handler with the useConfirmDialog hook. The "close" action is
// irreversible (patients permanently removed from outreach) and
// marked destructive; other bulk actions (pause/resume) are neutral.
//
// The vitest environment is "node" (no DOM). We read the source as a
// string and assert the structural and behavioural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "patients.tsx"), "utf8");

// ---------------------------------------------------------------------------
// useConfirmDialog import
// ---------------------------------------------------------------------------

describe("patients — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });
});

// ---------------------------------------------------------------------------
// Hook initialisation in PatientsPage
// ---------------------------------------------------------------------------

describe("patients PatientsPage — hook initialisation", () => {
  it("destructures [confirm, ConfirmDialogEl] from useConfirmDialog()", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

// ---------------------------------------------------------------------------
// Bulk status-change confirm — close path (destructive)
// ---------------------------------------------------------------------------

describe("patients — bulk close confirm (destructive)", () => {
  it("awaits confirm() in the bulk action handler (async guard)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,600}return;/);
  });

  it("uses isClosing flag to branch between close and other titles", () => {
    expect(SRC).toContain("const isClosing = targetStatus === \"closed\";");
  });

  it("close title includes the patient count (singular)", () => {
    expect(SRC).toContain(
      '`Close ${ids.length} patient${ids.length === 1 ? "" : "s"}?`',
    );
  });

  it("close description warns about permanent outreach removal", () => {
    expect(SRC).toContain(
      '"Closed patients are removed from outreach permanently."',
    );
  });

  it("marks the close action as destructive:true", () => {
    expect(SRC).toContain("destructive: isClosing");
  });

  it("confirmLabel uses the verb (Pause / Resume / Close)", () => {
    expect(SRC).toContain("confirmLabel: verb");
  });
});

// ---------------------------------------------------------------------------
// Bulk status-change confirm — non-close path (neutral)
// ---------------------------------------------------------------------------

describe("patients — bulk non-close confirm (neutral)", () => {
  it("non-close title includes verb and count without permanent-warning description", () => {
    expect(SRC).toContain(
      '`${verb} ${ids.length} patient${ids.length === 1 ? "" : "s"}?`',
    );
  });

  it("non-close description is undefined (no extra warning needed)", () => {
    expect(SRC).toContain("description: isClosing");
    expect(SRC).toContain(": undefined");
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialogEl rendered in JSX
// ---------------------------------------------------------------------------

describe("patients PatientsPage — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside the page return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

// ---------------------------------------------------------------------------
// No more window.confirm in the bulk handler
// ---------------------------------------------------------------------------

describe("patients — window.confirm removed", () => {
  it("does not use window.confirm anywhere in the file", () => {
    expect(SRC).not.toContain("window.confirm");
  });
});

// ---------------------------------------------------------------------------
// Regression: core patients page behaviour
// ---------------------------------------------------------------------------

describe("patients — regression: core behaviour retained", () => {
  it("exports PatientsPage", () => {
    expect(SRC).toContain("export function PatientsPage");
  });

  it("still uses BulkActionBar for bulk actions", () => {
    expect(SRC).toContain("BulkActionBar");
  });

  it("still uses useFilteredList or similar for patient filtering", () => {
    expect(SRC).toContain("useFilteredList");
  });
});