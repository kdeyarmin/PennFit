// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const {
  listShopOrders,
  getShopOrder,
  markShopOrderDelivered,
  setShopOrderTracking,
  refundShopOrder,
} = vi.hoisted(() => ({
  listShopOrders: vi.fn(),
  getShopOrder: vi.fn(),
  markShopOrderDelivered: vi.fn(),
  setShopOrderTracking: vi.fn(),
  refundShopOrder: vi.fn(),
}));

vi.mock("@/lib/admin/shop-orders-api", () => ({
  listShopOrders,
  getShopOrder,
  markShopOrderDelivered,
  setShopOrderTracking,
  refundShopOrder,
}));

import { AdminShopOrdersPage } from "./admin-shop-orders";

const ORDER = {
  id: "ord-12345678",
  status: "shipped",
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  amountTotalCents: 4599,
  currency: "usd",
  createdAt: "2026-06-01T10:00:00Z",
  paidAt: "2026-06-01T10:00:00Z",
  shippedAt: "2026-06-02T10:00:00Z",
  deliveredAt: null,
  trackingCarrier: "UPS",
  trackingNumber: "1Z999",
  fulfillmentMethod: "ship",
  itemCount: 2,
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <AdminShopOrdersPage />
    </QueryClientProvider>,
  );
}

describe("AdminShopOrdersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listShopOrders.mockResolvedValue({
      orders: [ORDER],
      total: 1,
      limit: 25,
      offset: 0,
    });
    getShopOrder.mockResolvedValue({
      ...ORDER,
      stripeSessionId: "cs_test",
      stripePaymentIntentId: "pi_test",
      shippingAddress: null,
      lineItems: [
        { name: "AirFit P10", quantity: 2, amountSubtotalCents: 4599 },
      ],
    });
    markShopOrderDelivered.mockResolvedValue({});
    setShopOrderTracking.mockResolvedValue({});
    refundShopOrder.mockResolvedValue({});
  });
  afterEach(cleanup);

  it("lists paid orders with the customer name", async () => {
    renderPage();
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(listShopOrders).toHaveBeenCalled();
  });

  it("opens an order's detail (line items) and can mark it delivered", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("shop-order-open-ord-12345678"));

    // Detail loads the line items.
    expect(await screen.findByText(/AirFit P10/)).toBeTruthy();
    expect(getShopOrder).toHaveBeenCalledWith("ord-12345678");

    fireEvent.click(screen.getByRole("button", { name: /mark delivered/i }));
    await waitFor(() =>
      expect(markShopOrderDelivered).toHaveBeenCalledWith("ord-12345678"),
    );
  });

  it("refunds with a Stripe-allowed reason chosen from the select", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("shop-order-open-ord-12345678"));
    await screen.findByText(/AirFit P10/); // detail panel loaded

    // The reason is a constrained select (free text was rejected by
    // Stripe's enum schema); pick one and confirm it's forwarded.
    fireEvent.change(screen.getByLabelText("Refund reason"), {
      target: { value: "duplicate" },
    });
    fireEvent.click(screen.getByRole("button", { name: /refund order/i }));
    await waitFor(() =>
      expect(refundShopOrder).toHaveBeenCalledWith("ord-12345678", {
        reason: "duplicate",
      }),
    );
  });

  it("searches orders by the typed query (debounced)", async () => {
    renderPage();
    await screen.findByText("Ada Lovelace");
    fireEvent.change(screen.getByTestId("shop-orders-search"), {
      target: { value: "ord-12" },
    });
    await waitFor(() =>
      expect(listShopOrders).toHaveBeenCalledWith(
        expect.objectContaining({ q: "ord-12" }),
      ),
    );
  });
});
