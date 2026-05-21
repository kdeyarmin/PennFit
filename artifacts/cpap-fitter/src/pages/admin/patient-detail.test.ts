// Tests for admin/patient-detail.tsx — prescriptions-tab extraction PR
//
// PR change: the inline PrescriptionsTab component (plus its helpers
// GenerateSwoButton, PrescriptionAttachmentCell, formatBytes,
// MAX_ATTACHMENT_BYTES, and ATTACHMENT_ACCEPT) was extracted into
// src/components/admin/PrescriptionsTab.tsx. The patient-detail page
// now delegates to the imported component.
//
// This PR also removed the direct import of useUpdatePrescriptionStatus
// and the prescription-attachment helpers from patient-detail.tsx, since
// those are now encapsulated inside PrescriptionsTab.tsx.
//
// The component renders via React hooks and cannot be rendered in the
// node Vitest environment without jsdom. We read the source file as a
// string and assert on the structural invariants introduced by the PR.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "patient-detail.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Import added by PR: PrescriptionsTab from dedicated module
// ---------------------------------------------------------------------------
describe("patient-detail — PrescriptionsTab import (PR change)", () => {
  it("imports PrescriptionsTab from the dedicated component file", () => {
    expect(SRC).toContain(
      'import { PrescriptionsTab } from "@/components/admin/PrescriptionsTab"',
    );
  });

  it("references PrescriptionsTab in the component body (renders it)", () => {
    // It's not enough to import; the component must actually be used.
    const importIdx = SRC.indexOf(
      'import { PrescriptionsTab } from "@/components/admin/PrescriptionsTab"',
    );
    const useIdx = SRC.indexOf("PrescriptionsTab", importIdx + 1);
    // There should be at least one more occurrence after the import line.
    expect(useIdx).toBeGreaterThan(importIdx);
  });
});

// ---------------------------------------------------------------------------
// Imports removed by PR: prescription-attachment helpers
// ---------------------------------------------------------------------------
describe("patient-detail — prescription-attachment helpers removed (PR change)", () => {
  it("does NOT import uploadPrescriptionAttachment in patient-detail.tsx", () => {
    // This helper was moved into PrescriptionsTab.tsx.
    // A direct import here would create a duplicate dependency.
    expect(SRC).not.toContain("uploadPrescriptionAttachment");
  });

  it("does NOT import removePrescriptionAttachment in patient-detail.tsx", () => {
    expect(SRC).not.toContain("removePrescriptionAttachment");
  });

  it("does NOT import prescriptionAttachmentDownloadUrl in patient-detail.tsx", () => {
    expect(SRC).not.toContain("prescriptionAttachmentDownloadUrl");
  });

  it("does NOT import from the prescription-attachment lib path", () => {
    expect(SRC).not.toContain(
      '"@/lib/admin/prescription-attachment"',
    );
    expect(SRC).not.toContain(
      "'@/lib/admin/prescription-attachment'",
    );
  });
});

// ---------------------------------------------------------------------------
// Import removed by PR: useUpdatePrescriptionStatus
// ---------------------------------------------------------------------------
describe("patient-detail — useUpdatePrescriptionStatus removed (PR change)", () => {
  it("does NOT import useUpdatePrescriptionStatus in patient-detail.tsx", () => {
    // useUpdatePrescriptionStatus is now consumed inside PrescriptionsTab.tsx.
    // Having it imported here as well would be an unnecessary duplication.
    expect(SRC).not.toContain("useUpdatePrescriptionStatus");
  });
});

// ---------------------------------------------------------------------------
// Local definitions removed by PR: inline PrescriptionsTab helpers
// ---------------------------------------------------------------------------
describe("patient-detail — inline PrescriptionsTab helpers removed (PR change)", () => {
  it("does NOT define a local formatBytes function", () => {
    // formatBytes is now private to PrescriptionsTab.tsx.
    expect(SRC).not.toContain("function formatBytes(");
  });

  it("does NOT define MAX_ATTACHMENT_BYTES constant", () => {
    expect(SRC).not.toContain("MAX_ATTACHMENT_BYTES");
  });

  it("does NOT define ATTACHMENT_ACCEPT constant", () => {
    expect(SRC).not.toContain("ATTACHMENT_ACCEPT");
  });

  it("does NOT define an inline GenerateSwoButton function", () => {
    expect(SRC).not.toContain("function GenerateSwoButton(");
  });

  it("does NOT define an inline PrescriptionAttachmentCell function", () => {
    expect(SRC).not.toContain("function PrescriptionAttachmentCell(");
  });

  it("does NOT define an inline PrescriptionsTab function (only the import is present)", () => {
    // The import brings in PrescriptionsTab; there must not be a *local*
    // function definition of the same name.
    expect(SRC).not.toContain("function PrescriptionsTab(");
  });
});

// ---------------------------------------------------------------------------
// Regression: pre-existing page structure not broken by extraction
// ---------------------------------------------------------------------------
describe("patient-detail — regression: page structure intact after extraction", () => {
  it("still imports PatientPrescription type from the api-client-react package", () => {
    expect(SRC).toContain("type PatientPrescription");
  });

  it("still defines the Prescription type alias in the file", () => {
    // The type alias was kept in patient-detail.tsx even after extraction;
    // it is used by other parts of the page (e.g. TypeScript inference).
    expect(SRC).toContain("type Prescription = PatientPrescription");
  });

  it("still imports openPdfInNewTab for use by other tabs in the page", () => {
    // SWO generation inside PrescriptionsTab.tsx uses its own import;
    // patient-detail.tsx has separate PDF usages.
    expect(SRC).toContain("openPdfInNewTab");
  });

  it("still imports formatDate from the shared format lib", () => {
    expect(SRC).toContain("formatDate");
  });

  it("still imports useGetPatient to load the patient record", () => {
    expect(SRC).toContain("useGetPatient");
  });

  it("still imports ApiError for its own error-handling paths", () => {
    expect(SRC).toContain("ApiError");
  });

  it("still imports PatientBillingTab, PatientResupplyTab, and PortalTab", () => {
    expect(SRC).toContain("PatientBillingTab");
    expect(SRC).toContain("PatientResupplyTab");
    expect(SRC).toContain("PortalTab");
  });
});

// ---------------------------------------------------------------------------
// Regression: no duplicate import of same identifier from different paths
// ---------------------------------------------------------------------------
describe("patient-detail — regression: no duplicate identifier imports", () => {
  it("imports PrescriptionsTab exactly once", () => {
    const occurrences = (
      SRC.match(/import\s*\{[^}]*PrescriptionsTab[^}]*\}/g) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });

  it("does not import PatientPrescription from multiple sources", () => {
    // Ensure type only comes from api-client-react/admin.
    expect(SRC).toContain(
      '"@workspace/api-client-react/admin"',
    );
    const occurrences = (SRC.match(/type PatientPrescription/g) ?? []).length;
    // Only one declaration or import; a re-export from a second path would
    // indicate a stale copy.
    expect(occurrences).toBe(1);
  });
});
