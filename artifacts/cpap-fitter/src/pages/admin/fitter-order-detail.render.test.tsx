// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminOrderDetail as OrderData } from "@/lib/admin/storefront-admin-api";

vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wouter")>()),
  useParams: () => ({ id: "order-one" }),
}));
vi.mock("@/hooks/admin/use-document-title", () => ({
  useDocumentTitle: vi.fn(),
}));
import { AdminOrderDetail } from "./fitter-order-detail";

afterEach(cleanup);

it("labels the legacy email timestamp as a send without claiming delivery", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const order: OrderData = {
    id: "order-one",
    orderReference: "ORD-ABC123",
    patientFirstName: "Example",
    patientLastName: "Patient",
    patientEmail: "example@example.test",
    maskId: "example-mask",
    maskName: "Example Mask",
    maskManufacturer: "Example Manufacturer",
    shippingCity: "Example City",
    shippingState: "PA",
    shippingZip: "12345",
    emailStatus: "sent",
    emailDeliveredAt: "2026-09-11T10:00:00Z",
    createdAt: "2026-09-11T09:00:00Z",
    payload: {},
  };
  client.setQueryData(["admin-order", order.id], { order });
  render(
    <QueryClientProvider client={client}>
      <AdminOrderDetail />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Email sent")).toBeTruthy();
  expect(screen.getByText(/^Email sent .+/)).toBeTruthy();
  expect(screen.queryByText(/Email delivered/)).toBeNull();
  client.clear();
});
