// @vitest-environment jsdom
//
// Render regression test for AdminProviderEsignPage (/admin/provider-portal,
// the "E-signature portal" nav entry).
//
// Investigating an "E-signature portal — Something went wrong" report: this
// test renders both tabs with payloads shaped like the real
// /admin/provider-portal/{signature-requests,accounts} responses (including
// every status and the nullable fields) and asserts the page never bubbles a
// render error to the top-level ErrorBoundary.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let MOCK_REQUESTS: unknown = { requests: [] };
let MOCK_ACCOUNTS: unknown = { accounts: [] };

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    // The page issues two list queries keyed ["admin", "signature-requests",
    // status] and ["admin", "provider-accounts"] (plus the provider-picker
    // search inside modals). Dispatch on the key's second element.
    useQuery: (options: { queryKey: unknown[] }) => {
      const key = options.queryKey[1];
      const data =
        key === "signature-requests"
          ? MOCK_REQUESTS
          : key === "provider-accounts"
            ? MOCK_ACCOUNTS
            : { providers: [] };
      return {
        data,
        isPending: false,
        isError: false,
        error: null,
        refetch: () => {},
      };
    },
  };
});

import { AdminProviderEsignPage } from "./admin-provider-esign";

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AdminProviderEsignPage />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

const REQUESTS_FIXTURE = {
  requests: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      providerId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      providerName: "Dr. Maria Alvarez",
      providerNpi: "1234567890",
      subjectType: "prescription",
      subjectId: null,
      title: "CPAP resupply order — mask + tubing",
      patientName: "Pat Example",
      status: "pending",
      createdAt: "2026-06-01T12:00:00.000Z",
      signedAt: null,
      expiresAt: "2026-07-01T12:00:00.000Z",
      readyToPrintAt: null,
      returnedSignedAt: null,
      attachedToChartAt: null,
      releasedAt: null,
      releaseKind: null,
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      providerId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      providerName: "Dr. Maria Alvarez",
      providerNpi: "1234567890",
      subjectType: "cmn",
      subjectId: "ord_123",
      title: "CMN — E0601 CPAP device",
      patientName: null,
      status: "signed",
      createdAt: "2026-05-20T09:30:00.000Z",
      signedAt: "2026-05-21T10:00:00.000Z",
      expiresAt: null,
      readyToPrintAt: "2026-05-21T11:00:00.000Z",
      returnedSignedAt: "2026-05-22T11:00:00.000Z",
      attachedToChartAt: "2026-05-23T11:00:00.000Z",
      releasedAt: "2026-05-24T11:00:00.000Z",
      releaseKind: "claim",
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      providerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      providerName: null,
      providerNpi: null,
      subjectType: "document",
      subjectId: null,
      title: "Chart note addendum",
      patientName: null,
      status: "declined",
      createdAt: "2026-05-18T09:30:00.000Z",
      signedAt: null,
      expiresAt: null,
      readyToPrintAt: null,
      returnedSignedAt: null,
      attachedToChartAt: null,
      releasedAt: null,
      releaseKind: null,
    },
    {
      id: "44444444-4444-4444-4444-444444444444",
      providerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      providerName: "Dr. Sam Lee",
      providerNpi: "0987654321",
      subjectType: "dwo",
      subjectId: null,
      title: "DWO — heated tubing",
      patientName: "Casey Sample",
      status: "void",
      createdAt: "2026-05-15T09:30:00.000Z",
      signedAt: null,
      expiresAt: null,
      readyToPrintAt: null,
      returnedSignedAt: null,
      attachedToChartAt: null,
      releasedAt: null,
      releaseKind: null,
    },
    {
      // "expired" is in the API's status union but not the status filter —
      // it must still render (falls through to the muted badge).
      id: "55555555-5555-5555-5555-555555555555",
      providerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      providerName: "Dr. Sam Lee",
      providerNpi: "0987654321",
      subjectType: "swo",
      subjectId: null,
      title: "SWO — replacement cushions",
      patientName: null,
      status: "expired",
      createdAt: "2026-04-01T09:30:00.000Z",
      signedAt: null,
      expiresAt: "2026-05-01T09:30:00.000Z",
      readyToPrintAt: null,
      returnedSignedAt: null,
      attachedToChartAt: null,
      releasedAt: null,
      releaseKind: null,
    },
  ],
};

const ACCOUNTS_FIXTURE = {
  accounts: [
    {
      id: "66666666-6666-6666-6666-666666666666",
      providerId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      email: "malvarez@example.com",
      status: "active",
      mfaEnrolled: true,
      lastLoginAt: "2026-06-08T15:45:00.000Z",
      invitedByEmail: "admin@pennpaps.com",
      createdAt: "2026-05-01T12:00:00.000Z",
      providerName: "Dr. Maria Alvarez",
      providerNpi: "1234567890",
      practiceName: "Alvarez Sleep Medicine",
    },
    {
      // Invited-but-never-signed-in: nullable fields exercised.
      id: "77777777-7777-7777-7777-777777777777",
      providerId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      email: "slee@example.com",
      status: "invited",
      mfaEnrolled: false,
      lastLoginAt: null,
      invitedByEmail: null,
      createdAt: "2026-06-01T12:00:00.000Z",
      providerName: null,
      providerNpi: null,
      practiceName: null,
    },
    {
      id: "88888888-8888-8888-8888-888888888888",
      providerId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      email: "disabled@example.com",
      status: "disabled",
      mfaEnrolled: true,
      lastLoginAt: "2026-03-08T15:45:00.000Z",
      invitedByEmail: "admin@pennpaps.com",
      createdAt: "2026-02-01T12:00:00.000Z",
      providerName: "Dr. Disabled Example",
      providerNpi: "1112223334",
      practiceName: null,
    },
  ],
};

describe("AdminProviderEsignPage — render regression", () => {
  it("renders the Documents tab with every status + lifecycle state without crashing", () => {
    MOCK_REQUESTS = REQUESTS_FIXTURE;
    renderPage();

    expect(
      screen.getByText("CPAP resupply order — mask + tubing"),
    ).toBeTruthy();
    expect(screen.getByText("CMN — E0601 CPAP device")).toBeTruthy();
    // Fully-released lifecycle line renders its release kind.
    expect(screen.getByText("✓ Released (claim)")).toBeTruthy();
    // The out-of-filter "expired" status still renders a badge.
    expect(screen.getByText("expired")).toBeTruthy();
  });

  it("renders the Documents tab empty state", () => {
    MOCK_REQUESTS = { requests: [] };
    renderPage();

    expect(
      screen.getByText("No signature requests match this filter."),
    ).toBeTruthy();
  });

  it("renders the Provider accounts tab, including null provider fields", () => {
    MOCK_REQUESTS = REQUESTS_FIXTURE;
    MOCK_ACCOUNTS = ACCOUNTS_FIXTURE;
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Provider accounts" }));

    expect(screen.getByText("Dr. Maria Alvarez")).toBeTruthy();
    expect(screen.getByText(/slee@example\.com/)).toBeTruthy();
    // Disabled account exposes the Enable action; active ones expose Disable.
    expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Disable" }).length).toBe(2);
  });

  it("renders the Provider accounts empty state", () => {
    MOCK_REQUESTS = { requests: [] };
    MOCK_ACCOUNTS = { accounts: [] };
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Provider accounts" }));

    expect(
      screen.getByText("No providers have portal access yet."),
    ).toBeTruthy();
  });
});
