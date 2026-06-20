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
    getManualDocument: vi.fn(),
    createManualDocument: vi.fn(),
    updateManualDocument: vi.fn(),
    sendManualDocumentEmail: vi.fn(),
    createManualDocumentPacket: vi.fn(),
    getManualDocumentPacket: vi.fn(),
  },
}));

vi.mock("@/lib/admin/manual-documents-api", () => ({
  getManualDocumentCatalog: api.getManualDocumentCatalog,
  listManualDocuments: api.listManualDocuments,
  getStandardDocumentCatalog: api.getStandardDocumentCatalog,
  getManualDocument: api.getManualDocument,
  createManualDocument: api.createManualDocument,
  updateManualDocument: api.updateManualDocument,
  deleteManualDocument: vi.fn(),
  attachManualDocument: vi.fn(),
  manualDocumentPdfUrl: (id: string) => `/pdf/${id}`,
  manualDocumentPacketPdfUrl: (id: string) => `/packet-pdf/${id}`,
  searchPatientsForAttach: vi.fn(),
  sendManualDocumentEmail: api.sendManualDocumentEmail,
  sendManualDocumentFax: vi.fn(),
  listManualDocumentPackets: vi.fn().mockResolvedValue({ packets: [] }),
  getManualDocumentPacket: api.getManualDocumentPacket,
  createManualDocumentPacket: api.createManualDocumentPacket,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminDocumentsPage — standard payer documents", () => {
  it("distinguishes manual PDF packets from patient e-sign packets", async () => {
    api.listManualDocuments.mockResolvedValue({ documents: [] });
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [],
      packets: [],
    });

    renderPage();

    expect(
      await screen.findByText(/manual PDF for email, fax, download/),
    ).toBeTruthy();
    const eSignLink = screen.getByRole("link", { name: "Send for e-sign" });
    expect(eSignLink.getAttribute("href")).toBe("/admin/patient-packets");
    expect(
      screen.getByText(/This is not an electronic-signature packet/),
    ).toBeTruthy();
  });

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
      packets: [],
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

  it("creates every member draft, in order, then the packet on Create packet", async () => {
    api.listManualDocuments.mockResolvedValue({ documents: [] });
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [
        {
          key: "aob_financial",
          label: "Assignment of Benefits",
          documentType: "cmn",
          description: "AOB.",
          title: "Assignment of Benefits",
          fields: {},
          body: "AOB terms…",
        },
        {
          key: "abn_medicare",
          label: "ABN",
          documentType: "cmn",
          description: "ABN.",
          title: "Advance Beneficiary Notice",
          fields: {},
          body: "ABN terms…",
        },
      ],
      packets: [
        {
          key: "new_patient_setup",
          label: "New-patient setup packet",
          description: "Intake paperwork bundle.",
          title: "New Patient Setup Packet",
          includeCoverSheet: true,
          templateKeys: ["aob_financial", "abn_medicare"],
        },
      ],
    });
    api.createManualDocument
      .mockResolvedValueOnce({ id: "doc-aob" })
      .mockResolvedValueOnce({ id: "doc-abn" });
    api.createManualDocumentPacket.mockResolvedValue({ id: "packet-1" });

    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Create packet" }),
    );
    await waitFor(() =>
      expect(api.createManualDocumentPacket).toHaveBeenCalledWith({
        title: "New Patient Setup Packet",
        documentIds: ["doc-aob", "doc-abn"],
        includeCoverSheet: true,
      }),
    );
    expect(api.createManualDocument).toHaveBeenNthCalledWith(1, {
      documentType: "cmn",
      title: "Assignment of Benefits",
      fields: {},
      body: "AOB terms…",
    });
    expect(api.createManualDocument).toHaveBeenNthCalledWith(2, {
      documentType: "cmn",
      title: "Advance Beneficiary Notice",
      fields: {},
      body: "ABN terms…",
    });
  });
});

function docSummary(id: string, title: string, createdAt: string) {
  return {
    id,
    document_type: "cmn",
    title,
    status: "draft",
    patient_id: null,
    chart_document_id: null,
    recipient_name: null,
    recipient_email: null,
    recipient_fax_e164: null,
    last_emailed_at: null,
    last_faxed_at: null,
    attached_at: null,
    created_by_email: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("AdminDocumentsPage — packets from selected documents", () => {
  it("creates the packet in table order, regardless of tick order", async () => {
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [],
      packets: [],
    });
    api.listManualDocuments.mockResolvedValue({
      documents: [
        docSummary("doc-new", "Newest CMN", "2026-06-02T00:00:00Z"),
        docSummary("doc-old", "Older CMN", "2026-06-01T00:00:00Z"),
      ],
    });
    api.createManualDocumentPacket.mockResolvedValue({ id: "pkt-1" });
    api.getManualDocumentPacket.mockResolvedValue({
      packet: {
        id: "pkt-1",
        title: "Document packet",
        recipient_name: null,
        recipient_address: null,
        recipient_email: null,
        recipient_fax_e164: null,
        document_ids: ["doc-new", "doc-old"],
        include_cover_sheet: true,
        status: "draft",
        last_emailed_at: null,
        last_faxed_at: null,
        created_by_email: null,
        created_at: "2026-06-02T00:00:00Z",
        updated_at: "2026-06-02T00:00:00Z",
      },
      documents: [],
      missingDocumentIds: [],
    });

    renderPage();

    // Tick in REVERSE table order: older first, newest second.
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select Older CMN" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newest CMN" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create packet from selected" }),
    );

    await waitFor(() =>
      expect(api.createManualDocumentPacket).toHaveBeenCalledWith(
        expect.objectContaining({ documentIds: ["doc-new", "doc-old"] }),
      ),
    );
  });
});

describe("AdminDocumentsPage — document editor send actions", () => {
  it("mirrors the recipient email and saves the form before emailing", async () => {
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [],
      packets: [],
    });
    api.listManualDocuments.mockResolvedValue({
      documents: [docSummary("doc-1", "My CMN", "2026-06-01T00:00:00Z")],
    });
    api.getManualDocument.mockResolvedValue({
      document: {
        ...docSummary("doc-1", "My CMN", "2026-06-01T00:00:00Z"),
        recipient_address: null,
        fields: {},
        body: null,
      },
    });
    api.updateManualDocument.mockResolvedValue({ ok: true });
    api.sendManualDocumentEmail.mockResolvedValue({ ok: true });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    // Typing in the Recipient block must flow through to "Email to".
    const recipientEmail = await screen.findByLabelText("Email", {
      exact: true,
    });
    fireEvent.change(recipientEmail, {
      target: { value: "dr.smith@example.com" },
    });
    const sendEmail = screen.getByLabelText("Email to");
    expect((sendEmail as HTMLInputElement).value).toBe("dr.smith@example.com");

    fireEvent.click(screen.getByRole("button", { name: "Email document" }));

    // The form is persisted BEFORE the send, so the emailed PDF matches
    // what's typed.
    await waitFor(() =>
      expect(api.sendManualDocumentEmail).toHaveBeenCalledWith("doc-1", {
        email: "dr.smith@example.com",
      }),
    );
    expect(api.updateManualDocument).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({ recipientEmail: "dr.smith@example.com" }),
    );
    const saveOrder = api.updateManualDocument.mock.invocationCallOrder[0]!;
    const sendOrder = api.sendManualDocumentEmail.mock.invocationCallOrder[0]!;
    expect(saveOrder).toBeLessThan(sendOrder);
  });

  it("blocks an email send with no destination instead of round-tripping", async () => {
    api.getManualDocumentCatalog.mockResolvedValue(CATALOG);
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [],
      packets: [],
    });
    api.listManualDocuments.mockResolvedValue({
      documents: [docSummary("doc-1", "My CMN", "2026-06-01T00:00:00Z")],
    });
    api.getManualDocument.mockResolvedValue({
      document: {
        ...docSummary("doc-1", "My CMN", "2026-06-01T00:00:00Z"),
        recipient_address: null,
        fields: {},
        body: null,
      },
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Email document" }),
    );

    expect(
      await screen.findByText("Enter an email address first."),
    ).toBeTruthy();
    expect(api.sendManualDocumentEmail).not.toHaveBeenCalled();
    expect(api.updateManualDocument).not.toHaveBeenCalled();
  });
});

describe("AdminDocumentsPage — catalog failure surfacing", () => {
  it("shows an error + Try again instead of an empty dropdown, and recovers", async () => {
    api.listManualDocuments.mockResolvedValue({ documents: [] });
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [],
      packets: [],
    });
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
    api.getStandardDocumentCatalog.mockResolvedValue({
      templates: [],
      packets: [],
    });
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
