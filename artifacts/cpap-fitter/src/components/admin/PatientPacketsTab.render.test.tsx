// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { api } = vi.hoisted(() => ({
  api: {
    templates: [] as Array<{
      key: string;
      title: string;
      summary: string;
      requiresSignature: boolean;
      defaultIncluded: boolean;
      required: boolean;
      standalone: boolean;
    }>,
    packets: [] as Array<{
      id: string;
      patient_id: string | null;
      title: string;
      status: "draft" | "sent" | "viewed" | "completed" | "voided" | "expired";
      recipient_name: string;
      recipient_email: string | null;
      sent_at: string | null;
      completed_at: string | null;
      expires_at: string | null;
      created_at: string;
    }>,
    sendPatientPacket: vi.fn(),
    resendPatientPacket: vi.fn(),
    voidPatientPacket: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react/admin", () => ({
  usePatientPackets: () => ({
    data: { packets: api.packets },
    isPending: false,
    isError: false,
    error: null,
  }),
  usePatientPacketTemplates: () => ({
    data: { templates: api.templates, mergeTokens: [] },
    isPending: false,
    isError: false,
    error: null,
  }),
  useSendPatientPacket: () => ({
    mutateAsync: api.sendPatientPacket,
    isPending: false,
  }),
  useResendPatientPacket: () => ({
    mutateAsync: api.resendPatientPacket,
    isPending: false,
  }),
  useVoidPatientPacket: () => ({
    mutateAsync: api.voidPatientPacket,
    isPending: false,
  }),
  getPatientPacketsQueryKey: (patientId: string) => [
    "/admin/patient-packets",
    patientId,
  ],
  patientPacketPdfUrl: (packetId: string) => `/packet-pdf/${packetId}`,
}));

import { PatientPacketsTab } from "./PatientPacketsTab";

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PatientPacketsTab patientId="patient-1" hasEmail hasPhone />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.templates = [
    {
      key: "onboarding-consent",
      title: "Onboarding Consent",
      summary: "Required onboarding signature.",
      requiresSignature: true,
      defaultIncluded: true,
      required: true,
      standalone: false,
    },
    {
      key: "refill-confirmation",
      title: "Refill Confirmation",
      summary: "Standalone refill signature.",
      requiresSignature: true,
      defaultIncluded: false,
      required: false,
      standalone: true,
    },
  ];
  api.packets = [];
  api.sendPatientPacket.mockReset();
  api.resendPatientPacket.mockReset();
  api.voidPatientPacket.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("PatientPacketsTab", () => {
  it("keeps the quick sender scoped to onboarding templates", async () => {
    renderTab();

    expect(screen.getByText("Quick send onboarding packet")).toBeTruthy();
    const fullSender = screen.getByRole("link", { name: "Full sender" });
    expect(fullSender.getAttribute("href")).toBe("/admin/patient-packets");

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));

    expect(await screen.findByText("Onboarding Consent")).toBeTruthy();
    expect(screen.queryByText("Refill Confirmation")).toBeNull();
    expect(screen.getByText(/Standalone forms such as ABN/)).toBeTruthy();
  });

  it("shows signature receipt language for completed packets", async () => {
    api.packets = [
      {
        id: "packet-1",
        patient_id: "patient-1",
        title: "New Patient Packet",
        status: "completed",
        recipient_name: "Jordan Smith",
        recipient_email: "jordan@example.com",
        sent_at: "2026-06-10T12:00:00Z",
        completed_at: "2026-06-11T12:00:00Z",
        expires_at: null,
        created_at: "2026-06-10T12:00:00Z",
      },
    ];

    renderTab();

    expect(await screen.findByText("Signature received")).toBeTruthy();
    const pdf = screen.getByRole("link", { name: "Signed PDF" });
    expect(pdf.getAttribute("href")).toBe("/packet-pdf/packet-1");
  });
});
