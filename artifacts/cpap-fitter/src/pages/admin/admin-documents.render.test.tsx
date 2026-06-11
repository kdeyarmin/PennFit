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
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { api } = vi.hoisted(() => ({
  api: {
    getManualDocumentCatalog: vi.fn(),
    listManualDocuments: vi.fn(),
    getStandardDocumentCatalog: vi.fn(),
    createManualDocument: vi.fn(),
  },
}));

vi.mock("@/lib/admin/manual-documents-api", () => ({
  getManualDocumentCatalog: api.getManualDocumentCatalog,
  listManualDocuments: api.listManualDocuments,
  getStandardDocumentCatalog: api.getStandardDocumentCatalog,
  getManualDocument: vi.fn(),
  createManualDocument: api.createManualDocument,
  updateManualDocument: vi.fn(),
  deleteManualDocument: vi.fn(),
  attachManualDocument: vi.fn(),
  manualDocumentPdfUrl: (id: string) => `/pdf/${id}`,
  manualDocumentPacketPdfUrl: (id: string) => `/packet-pdf/${id}`,
  searchPatientsForAttach: vi.fn(),
  sendManualDocumentEmail: vi.fn(),
  sendManualDocumentFax: vi.fn(),
  listManualDocumentPackets: vi.fn().mockResolvedValue({ packets: [] }),
  getManualDocumentPacket: vi.fn(),
  createManualDocumentPacket: vi.fn(),
  updateManualDocumentPacket: vi.fn(),
  deleteManualDocumentPacket: vi.fn(),
  sendManualDocumentPacketEmail: vi.fn(),
  sendManualDocumentPacketFax: vi.fn(),
  getManualDocumentPrefill: vi.fn(),
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

describe("AdminDocumentsPage — standard payer documents", () => {
  it("always lists the standard library and creates a draft on Use", async () => {
    api.listManualDocuments.mockResolvedValue({ documents: [] });
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [
        {
          key: "swo_pap",
          label: "Standard Written Order (SWO) — PAP device & supplies",
          documentType: "cmn",
          description: "Medicare-compliant written order.",
          title: "Standard Written Order — PAP Device & Supplies",
          fields: { items_ordered: "E0601 — CPAP device — qty 1" },
          body: "Required elements…",
        },
      ],
    });
    api.createManualDocument.mockResolvedValue({ id: "doc-1" });

    renderPage();

    // The library renders for everyone, even with zero documents.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use",
      }),
    );
    await waitFor(() =>
      expect(api.createManualDocument).toHaveBeenCalledWith({
        documentType: "cmn",
        title: "Standard Written Order — PAP Device & Supplies",
        fields: { items_ordered: "E0601 — CPAP device — qty 1" },
        body: "Required elements…",
      }),
    );
  });
});

describe("AdminDocumentsPage — catalog failure surfacing", () => {
  it("shows an error + Try again instead of an empty dropdown, and recovers", async () => {
    api.listManualDocuments.mockResolvedValue({ documents: [] });
    api.getStandardDocumentCatalog.mockResolvedValue({ templates: [] });
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
    api.getStandardDocumentCatalog.mockResolvedValue({ templates: [] });
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
