// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Quote } from "@/lib/admin/pricing-api";
const { create, review } = vi.hoisted(() => ({
  create: vi.fn(),
  review: {
    id: "approved-review",
    revision: 7,
    patientId: "patient-reviewed",
    validUntil: "2099-01-01T00:00:00.000Z",
    lines: [
      {
        id: "exact-line",
        sku: "MASK-1",
        description: "Reviewed mask",
        quantity: 2,
        unitAmountCents: 12550,
        fulfillmentMethod: "dropship",
      },
    ],
  },
}));
vi.mock("@workspace/api-client-react/admin", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@workspace/api-client-react/admin")
  >()),
  useCsrOrderRequests: () => ({
    data: { requests: [], total: 0 },
    isLoading: false,
    isFetching: false,
  }),
  useResendCsrOrderRequest: () => ({ mutate: vi.fn() }),
  useCancelCsrOrderRequest: () => ({ mutate: vi.fn() }),
  useCreateCsrOrderRequest: () => ({ mutate: create, isPending: false }),
  usePatientPacketTemplates: () => ({
    data: { templates: [] },
    isLoading: false,
  }),
}));
vi.mock("./pricing/PricingOrderReview", async () => {
  const { useEffect } = await import("react");
  return {
    PricingOrderReview: ({
      quote,
      onAttach,
      onRequirementChange,
    }: {
      quote: Quote | null;
      onAttach: (quote: Quote) => void;
      onRequirementChange: (required: boolean) => void;
    }) => {
      useEffect(() => onRequirementChange(true), [onRequirementChange]);
      return (
        <div>
          <button
            type="button"
            onClick={() => onAttach(review as unknown as Quote)}
          >
            Attach approved insurance review
          </button>
          {quote && <span>Attached revision {quote.revision}</span>}
        </div>
      );
    },
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
import { CsrOrderRequestsPanel } from "./CsrOrderRequestsPanel";
async function open() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CsrOrderRequestsPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create order" }));
  fireEvent.change(screen.getByLabelText("Customer name"), {
    target: { value: "Synthetic Patient" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "synthetic@example.test" },
  });
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
describe("CSR approved pricing attachment", () => {
  it("sends exact patient, quote revision, line identity and fulfillment method", async () => {
    await open();
    fireEvent.click(
      screen.getByRole("button", { name: "Attach approved insurance review" }),
    );
    expect(
      (screen.getByLabelText("Item 1 description") as HTMLInputElement).value,
    ).toBe("Reviewed mask");
    expect(
      (
        screen.getByLabelText(
          "Item 1 unit price in dollars",
        ) as HTMLInputElement
      ).value,
    ).toBe("125.50");
    fireEvent.click(screen.getByRole("button", { name: "Create & send" }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: "patient-reviewed",
        quoteId: "approved-review",
        quoteRevision: 7,
        items: [
          {
            lineId: "exact-line",
            sku: "MASK-1",
            description: "Reviewed mask",
            quantity: 2,
            unitAmountCents: 12550,
            fulfillmentMethod: "dropship",
          },
        ],
      }),
      expect.any(Object),
    );
  });
  it("refuses enforced order creation after editing an attached quantity", async () => {
    await open();
    fireEvent.click(
      screen.getByRole("button", { name: "Attach approved insurance review" }),
    );
    fireEvent.change(screen.getByLabelText("Item 1 quantity"), {
      target: { value: "3" },
    });
    expect(screen.queryByText("Attached revision 7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create & send" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("approved insurance review"),
    );
    expect(create).not.toHaveBeenCalled();
  });
  it("requires review before any unreviewed line can be sent", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Item 1 description"), {
      target: { value: "Unreviewed mask" },
    });
    fireEvent.change(screen.getByLabelText("Item 1 unit price in dollars"), {
      target: { value: "20.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create & send" }));
    expect(create).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("approved insurance review"),
    );
  });
});
