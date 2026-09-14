// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SessionMutationCache,
  clearSessionCache,
} from "@workspace/resupply-auth-react";
import { PricingDeliveryReview } from "./PricingDeliveryReview";
import * as api from "@/lib/admin/pricing-api";
import type { CsrOrderRequestSummary } from "@workspace/api-client-react/admin";
vi.mock("@/lib/admin/pricing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/pricing-api")>()),
  previewDeliveryPricing: vi.fn(),
  approveDeliveryPricing: vi.fn(),
}));
const order = {
  id: "order-id",
  orderReference: "CSR-TEST",
  customerName: "Synthetic Patient",
  amountTotalCents: 20000,
  items: [
    {
      sku: "MASK-1",
      lineId: "line-id",
      description: "Accepted mask",
      quantity: 2,
      unitAmountCents: 10000,
      fulfillmentMethod: "dropship",
    },
  ],
} as CsrOrderRequestSummary;
const preview = {
  reviewId: "review-id",
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  approvalClass: "firm",
  evaluation: {
    state: "meets_target",
    deliveredCostCents: 6500,
    contributionCents: 5500,
    issues: [],
  },
  originalEvaluation: { deliveredCostCents: 5000 },
  items: order.items,
  patientId: "patient-id",
  addressSnapshot: {
    address1: "10 Example St",
    city: "Philadelphia",
    state: "PA",
    postalCode: "19103",
  },
} as api.DeliveryPricingPreview;
function mount() {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PricingDeliveryReview
        order={order}
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return client;
}
async function evaluate() {
  fireEvent.change(screen.getByLabelText("Delivery review service"), {
    target: { value: "Ground" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Preview delivery profitability" }),
  );
  await screen.findByText("Current delivery review");
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.previewDeliveryPricing).mockResolvedValue(preview);
  vi.mocked(api.approveDeliveryPricing).mockResolvedValue({
    fulfillmentIds: ["fulfillment-id"],
    skipped: null,
    replayed: false,
  });
});
afterEach(cleanup);
describe("accepted order delivery review", () => {
  it("requires explicit confirmation and evidence to renew unchanged original costs", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I verified that the original non-delivery fees and reserves are unchanged/,
        hidden: true,
      }),
    );
    fireEvent.change(screen.getByLabelText("Delivery review service"), {
      target: { value: "Ground" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview delivery profitability" }),
    );
    expect(api.previewDeliveryPricing).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Provide evidence and a future expiry/),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("Unchanged fee and reserve evidence"),
      { target: { value: "Verified current agreement" } },
    );
    fireEvent.change(
      screen.getByLabelText("Fee and reserve evidence valid through (UTC)"),
      { target: { value: "2099-01-01" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview delivery profitability" }),
    );
    await screen.findByText("Current delivery review");
    expect(api.previewDeliveryPricing).toHaveBeenLastCalledWith("order-id", {
      delivery: { country: "US", service: "Ground" },
      costVerification: {
        source: "Verified current agreement",
        expiresAt: "2099-01-01T23:59:59.999Z",
      },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I verified that the original non-delivery fees and reserves are unchanged/,
        hidden: true,
      }),
    );
    expect(screen.queryByText("Current delivery review")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview delivery profitability" }),
    );
    await waitFor(() =>
      expect(api.previewDeliveryPricing).toHaveBeenLastCalledWith("order-id", {
        delivery: { country: "US", service: "Ground" },
      }),
    );
  });
  it("keeps accepted amounts read-only and approves only the evaluated delivery revision", async () => {
    mount();
    await evaluate();
    expect(screen.queryByLabelText(/unit amount/)).toBeNull();
    expect(api.previewDeliveryPricing).toHaveBeenCalledWith("order-id", {
      delivery: { country: "US", service: "Ground" },
    });
    fireEvent.change(screen.getByLabelText("Delivery approval reason"), {
      target: { value: "Verified supplier quote for updated address" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Approve delivery and retry fulfillment",
      }),
    );
    await waitFor(() =>
      expect(api.approveDeliveryPricing).toHaveBeenCalledWith(
        "order-id",
        "review-id",
        {
          revision: 1,
          reason: "Verified supplier quote for updated address",
          allowException: false,
        },
      ),
    );
  });
  it("clears an evaluated delivery when a freight assumption changes", async () => {
    mount();
    await evaluate();
    fireEvent.change(screen.getByLabelText("Updated freight amount ($)"), {
      target: { value: "19.00" },
    });
    expect(
      screen.queryByRole("button", {
        name: "Approve delivery and retry fulfillment",
      }),
    ).toBeNull();
    expect(api.approveDeliveryPricing).not.toHaveBeenCalled();
  });
  it("requires explicit acknowledgement for a permitted exception", async () => {
    vi.mocked(api.previewDeliveryPricing).mockResolvedValue({
      ...preview,
      approvalClass: "exception",
    });
    mount();
    await evaluate();
    fireEvent.change(screen.getByLabelText("Delivery approval reason"), {
      target: { value: "Reviewed temporary margin exception" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Approve delivery and retry fulfillment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I approve this permitted margin exception/,
      }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Approve delivery and retry fulfillment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("never releases a blocked delivery review", async () => {
    vi.mocked(api.previewDeliveryPricing).mockResolvedValue({
      ...preview,
      approvalClass: "blocked",
    });
    mount();
    await evaluate();
    fireEvent.change(screen.getByLabelText("Delivery approval reason"), {
      target: { value: "Review evidence cannot override a hard floor" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Approve delivery and retry fulfillment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(api.approveDeliveryPricing).not.toHaveBeenCalled();
  });
  it("drops a late preview after a session change", async () => {
    let complete!: (v: api.DeliveryPricingPreview) => void;
    vi.mocked(api.previewDeliveryPricing).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const client = mount();
    fireEvent.change(screen.getByLabelText("Delivery review service"), {
      target: { value: "Ground" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview delivery profitability" }),
    );
    await waitFor(() => expect(api.previewDeliveryPricing).toHaveBeenCalled());
    await act(async () => {
      await clearSessionCache(client);
      complete(preview);
    });
    expect(screen.queryByText("Current delivery review")).toBeNull();
  });
});
