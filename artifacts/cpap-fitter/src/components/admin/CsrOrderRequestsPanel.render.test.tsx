// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CsrOrderRequestSummary } from "@workspace/api-client-react/admin";

const { listRequests, resend, cancel } = vi.hoisted(() => ({
  listRequests: vi.fn(),
  resend: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@workspace/api-client-react/admin", async (importActual) => {
  const actual =
    await importActual<typeof import("@workspace/api-client-react/admin")>();
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...actual,
    useCsrOrderRequests: (
      params: Parameters<typeof actual.useCsrOrderRequests>[0],
      options: Parameters<typeof actual.useCsrOrderRequests>[1],
    ) =>
      useQuery({
        queryKey: ["/resupply-api/admin/csr-order-requests", params],
        queryFn: () => listRequests(params),
        ...options?.query,
      }),
    useResendCsrOrderRequest: () => ({ mutate: resend, isPending: false }),
    useCancelCsrOrderRequest: () => ({ mutate: cancel, isPending: false }),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { CsrOrderRequestsPanel } from "./CsrOrderRequestsPanel";

const request: CsrOrderRequestSummary = {
  id: "request-1",
  orderReference: "CSR-001",
  status: "sent",
  customerName: "Example Patient",
  customerEmail: "example@example.test",
  customerPhone: null,
  items: [{ description: "Mask", quantity: 1, unitAmountCents: 1000 }],
  amountTotalCents: 1000,
  currency: "usd",
  noteToCustomer: null,
  documents: [],
  expiresAt: null,
  sentAt: "2026-09-01T12:00:00Z",
  firstViewedAt: null,
  signedAt: null,
  signerName: null,
  canceledAt: null,
  createdByEmail: null,
  createdAt: "2026-09-01T12:00:00Z",
  hasLinkedDraft: true,
  hasQueuedFulfillment: false,
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <CsrOrderRequestsPanel />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("signature order history", () => {
  it("can reach an order older than the first 25 and return to recent orders", async () => {
    listRequests.mockImplementation(async ({ page = 1 }) => ({
      requests: [
        {
          ...request,
          id: `request-${page}`,
          orderReference: page === 1 ? "RECENT-ORDER" : "OLDER-ORDER",
        },
      ],
      total: 26,
      page,
      pageSize: 25,
    }));
    mount();
    await screen.findByText("RECENT-ORDER");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("OLDER-ORDER");
    expect(listRequests).toHaveBeenLastCalledWith({ page: 2, pageSize: 25 });
    expect(screen.queryByText("RECENT-ORDER")).toBeNull();
    expect(screen.getByText("Showing 26–26 of 26")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    await screen.findByText("RECENT-ORDER");
  });

  it("offers resend and cancel only for unsigned active links", async () => {
    listRequests.mockResolvedValue({
      requests: [
        request,
        {
          ...request,
          id: "signed",
          orderReference: "SIGNED-ORDER",
          status: "signed",
          signedAt: "2026-09-02T12:00:00Z",
          hasQueuedFulfillment: true,
        },
        {
          ...request,
          id: "followup",
          orderReference: "FOLLOWUP-ORDER",
          status: "signed",
          signedAt: "2026-09-02T12:00:00Z",
        },
      ],
      total: 3,
      page: 1,
      pageSize: 25,
    });
    mount();
    await screen.findByText("SIGNED-ORDER");
    for (const reference of ["SIGNED-ORDER", "FOLLOWUP-ORDER"]) {
      const row = screen.getByText(reference).closest("tr")!;
      expect(within(row).queryByRole("button", { name: "Resend" })).toBeNull();
      expect(within(row).queryByRole("button", { name: "Cancel" })).toBeNull();
    }
    const openRow = screen.getByText("CSR-001").closest("tr")!;
    expect(
      within(openRow).getByRole("button", { name: "Resend" }),
    ).toBeTruthy();
    expect(
      within(openRow).getByRole("button", { name: "Cancel" }),
    ).toBeTruthy();
    expect(resend).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("shows a load failure without claiming no signature orders exist", async () => {
    listRequests.mockRejectedValue(new Error("Service unavailable"));
    mount();
    await waitFor(() =>
      expect(screen.getByText(/Could not load signature orders/)).toBeTruthy(),
    );
    expect(screen.queryByText(/No signature orders yet/)).toBeNull();
  });

  it.each(["Retry", "Previous page"])(
    "recovers from a failed next page using %s",
    async (recovery) => {
      let rejectPage!: (error: Error) => void;
      const pendingPage = new Promise((_, reject) => {
        rejectPage = reject;
      });
      let secondPageAttempts = 0;
      listRequests.mockImplementation(({ page = 1 }) => {
        if (page === 2 && secondPageAttempts++ === 0) return pendingPage;
        return Promise.resolve({
          requests: [
            {
              ...request,
              orderReference: page === 1 ? "RECENT-ORDER" : "OLDER-ORDER",
            },
          ],
          total: 26,
          page,
          pageSize: 25,
        });
      });
      mount();
      await screen.findByText("RECENT-ORDER");
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await waitFor(() =>
        expect(listRequests).toHaveBeenCalledWith({ page: 2, pageSize: 25 }),
      );
      // The production placeholder option keeps the old row visible, but
      // it cannot be acted on while a different page is loading.
      expect(screen.getByText("RECENT-ORDER")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Resend" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);

      await act(async () => rejectPage(new Error("Temporary failure")));
      await screen.findByText(
        /Could not load signature orders: Temporary failure/,
      );
      // React Query drops placeholder data when the destination page
      // errors, so none of the previous page's actions remain visible.
      expect(screen.queryByText("RECENT-ORDER")).toBeNull();
      expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(screen.queryByText(/No signature orders yet/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: recovery }));
      await screen.findByText(
        recovery === "Retry" ? "OLDER-ORDER" : "RECENT-ORDER",
      );
      expect(screen.queryByText(/Could not load signature orders/)).toBeNull();
      expect(resend).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("disables cached row actions after a background refresh fails until retry succeeds", async () => {
    const page = { requests: [request], total: 1, page: 1, pageSize: 25 };
    listRequests
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error("Refresh failed"));
    const { client } = mount();
    await screen.findByText("CSR-001");
    await act(() =>
      client.invalidateQueries({
        queryKey: ["/resupply-api/admin/csr-order-requests"],
      }),
    );
    await screen.findByText(/Could not load signature orders: Refresh failed/);
    expect(screen.getByText("CSR-001")).toBeTruthy();
    for (const name of ["Resend", "Cancel"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(resend).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();

    listRequests.mockResolvedValueOnce(page);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText(/Could not load signature orders/)).toBeNull(),
    );
    expect(
      (screen.getByRole("button", { name: "Resend" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
