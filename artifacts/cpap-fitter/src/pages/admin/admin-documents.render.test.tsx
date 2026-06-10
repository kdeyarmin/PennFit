// @vitest-environment jsdom
//
// Render regression test for AdminDocumentsPage (/admin/documents).
//
// Investigating a "no document types in dropdown" report: the type
// catalog is fetched from /admin/manual-documents/catalog, and a single
// failed fetch (rate-limit blip, network hiccup) used to render a
// permanently empty <select> with no error and no way to recover
// (global QueryClient: retry 1, no refetch-on-focus). This asserts the
// failure is surfaced with a working "Try again" path.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { api } = vi.hoisted(() => ({
  api: {
    getManualDocumentCatalog: vi.fn(),
    listManualDocuments: vi.fn(),
  },
}));

vi.mock("@/lib/admin/manual-documents-api", () => ({
  getManualDocumentCatalog: api.getManualDocumentCatalog,
  listManualDocuments: api.listManualDocuments,
  getManualDocument: vi.fn(),
  createManualDocument: vi.fn(),
  updateManualDocument: vi.fn(),
  deleteManualDocument: vi.fn(),
  attachManualDocument: vi.fn(),
  manualDocumentPdfUrl: (id: string) => `/pdf/${id}`,
  searchPatientsForAttach: vi.fn(),
  sendManualDocumentEmail: vi.fn(),
  sendManualDocumentFax: vi.fn(),
}));

import { AdminDocumentsPage } from "./admin-documents";

const CATALOG = {
  types: [
    {
      type: "cmn",
      label: "Certificate of Medical Necessity",
      description: "Free-form CMN.",
      phi: true,
      requiresSignature: true,
      fields: [],
    },
  ],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AdminDocumentsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("AdminDocumentsPage — catalog failure surfacing", () => {
  it("shows an error + Try again instead of an empty dropdown, and recovers", async () => {
    api.listManualDocuments.mockResolvedValue({ documents: [] });
    api.getManualDocumentCatalog.mockRejectedValueOnce(
      new Error("network down"),
    );
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);

    renderPage();

    // Open the compose panel — the catalog query has already failed.
    fireEvent.click(
      await screen.findByRole("button", { name: "New document" }),
    );

    // The failure must be visible, not a silent empty <select>.
    expect(
      await screen.findByText(/Couldn’t load the document types/),
    ).toBeTruthy();

    // Retry refetches and the types populate the dropdown.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("option", {
        name: "Certificate of Medical Necessity",
      }),
    ).toBeTruthy();
  });

  it("renders the type options when the catalog loads", async () => {
    api.listManualDocuments.mockResolvedValue({ documents: [] });
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "New document" }),
    );
    expect(
      await screen.findByRole("option", {
        name: "Certificate of Medical Necessity",
      }),
    ).toBeTruthy();
  });
});
