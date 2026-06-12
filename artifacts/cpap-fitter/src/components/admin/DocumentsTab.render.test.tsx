// @vitest-environment jsdom
//
// Behavior tests for the patient-detail Documents tab review actions.
//
// Two regressions under test: a failed "Confirm reviewed" used to be
// swallowed silently (spinner stopped, note field stayed open, no
// message), and "Mark all reviewed" cleared every "New" badge even for
// documents whose API call failed. Both must now surface an error and
// keep the badge on the documents that actually failed.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { api } = vi.hoisted(() => ({
  api: {
    listPatientDocuments: vi.fn(),
    markPatientDocumentReviewed: vi.fn(),
    deletePatientDocument: vi.fn(),
    uploadPatientChartDocument: vi.fn(),
  },
}));

vi.mock("@/lib/admin/patient-documents-api", () => ({
  listPatientDocuments: api.listPatientDocuments,
  markPatientDocumentReviewed: api.markPatientDocumentReviewed,
  deletePatientDocument: api.deletePatientDocument,
  uploadPatientChartDocument: api.uploadPatientChartDocument,
  patientDocumentDownloadUrl: (pid: string, did: string) => `/dl/${pid}/${did}`,
  DOCUMENT_TYPE_LABELS: { referral: "Referral" },
  CHART_UPLOAD_DOCUMENT_TYPES: [{ value: "referral", label: "Referral info" }],
  SIGNED_RETURN_DOCUMENT_TYPES: new Set<string>(),
  ALLOWED_UPLOAD_CONTENT_TYPES: new Set(["application/pdf"]),
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
}));

vi.mock("@/hooks/use-confirm-dialog", () => ({
  useConfirmDialog: () => [vi.fn().mockResolvedValue(true), null],
}));

import { DocumentsTab } from "./DocumentsTab";

function doc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    documentType: "referral",
    filename: `${id}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 1234,
    createdAt: "2026-06-01T00:00:00Z",
    reviewedAt: null,
    reviewedByAdminId: null,
    reviewNote: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DocumentsTab — review failure surfacing", () => {
  it("shows an error when Confirm reviewed fails, instead of silence", async () => {
    api.listPatientDocuments.mockResolvedValue([doc("d1")]);
    api.markPatientDocumentReviewed.mockRejectedValue(
      new Error("Failed to mark reviewed (500)"),
    );

    render(<DocumentsTab patientId="p1" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Mark reviewed" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm reviewed" }));

    expect(
      await screen.findByText("Failed to mark reviewed (500)"),
    ).toBeTruthy();
    // The badge must stay — the document is still unreviewed.
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("keeps the badge on documents that failed in Mark all reviewed", async () => {
    api.listPatientDocuments.mockResolvedValue([doc("d1"), doc("d2")]);
    api.markPatientDocumentReviewed.mockImplementation(
      (_pid: string, docId: string) =>
        docId === "d2"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({ alreadyReviewed: false }),
    );

    render(<DocumentsTab patientId="p1" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Mark all 2 reviewed" }),
    );

    expect(
      await screen.findByText(
        "1 document couldn't be marked reviewed — try again.",
      ),
    ).toBeTruthy();
    // d1 succeeded (badge gone), d2 failed (badge stays).
    expect(screen.getAllByText("New")).toHaveLength(1);
  });
});
