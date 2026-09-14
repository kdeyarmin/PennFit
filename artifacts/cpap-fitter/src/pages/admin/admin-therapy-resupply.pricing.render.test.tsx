// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Quote } from "@/lib/admin/pricing-api";
const fixture = vi.hoisted(() => ({
  approve: vi.fn(),
  required: true,
  quote: {
    id: "review",
    revision: 3,
    status: "approved",
    patientId: "patient",
    boundOrderId: null,
    validUntil: "2099-01-01T00:00:00.000Z",
    lines: [
      {
        id: "line-mask",
        sku: "MASK",
        description: "Mask",
        quantity: 1,
        unitAmountCents: 0,
        fulfillmentMethod: "dropship",
      },
      {
        id: "line-cushion",
        sku: "CUSHION",
        description: "Cushion",
        quantity: 2,
        unitAmountCents: 500,
        fulfillmentMethod: "stock",
      },
    ],
  },
}));
vi.mock("@/lib/admin/therapy-resupply-api", async (original) => ({
  ...(await original<typeof import("@/lib/admin/therapy-resupply-api")>()),
  getResupplySummary: vi.fn().mockResolvedValue({ summary: {} }),
  getResupplyOpportunities: vi.fn().mockResolvedValue({ opportunities: [] }),
  listResupplyDrafts: vi.fn().mockResolvedValue({
    drafts: [
      {
        id: "draft",
        patientId: "patient",
        patientName: "Synthetic Patient",
        category: "mask",
        suggestedProductId: "MASK",
        suggestedQuantity: 1,
        status: "proposed",
        origin: "manual",
      },
    ],
  }),
  approveResupplyDraft: fixture.approve,
}));
vi.mock("@/components/admin/pricing/PricingOrderReview", async () => {
  const { useEffect } = await import("react");
  return {
    PricingOrderReview: ({
      onAttach,
      onRequirementChange,
    }: {
      onAttach: (quote: Quote) => void;
      onRequirementChange: (required: boolean) => void;
    }) => {
      useEffect(
        () => onRequirementChange(fixture.required),
        [onRequirementChange],
      );
      return (
        <button onClick={() => onAttach(fixture.quote as unknown as Quote)}>
          Attach reviewed bundle
        </button>
      );
    },
  };
});
import { AdminTherapyResupplyPage } from "./admin-therapy-resupply";
beforeEach(() => {
  vi.clearAllMocks();
  fixture.required = true;
});
afterEach(cleanup);
async function open() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <AdminTherapyResupplyPage />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve & send" }),
  );
  const dialog = within(
    screen.getByRole("dialog", { name: "Approve resupply draft" }),
  );
  fireEvent.change(dialog.getByLabelText("Email"), {
    target: { value: "synthetic@example.test" },
  });
  return dialog;
}
it("approves all reviewed bundle lines when the first item is included at no charge", async () => {
  const dialog = await open();
  fireEvent.click(
    dialog.getByRole("button", { name: "Attach reviewed bundle" }),
  );
  const button = dialog.getByRole("button", { name: "Approve & send" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() =>
    expect(fixture.approve).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        quoteId: "review",
        quoteRevision: 3,
        items: fixture.quote.lines.map(({ id, ...line }) => ({
          ...line,
          lineId: id,
        })),
      }),
    ),
  );
});
it("invalidates the attached bundle after an item edit", async () => {
  const dialog = await open();
  fireEvent.click(
    dialog.getByRole("button", { name: "Attach reviewed bundle" }),
  );
  fireEvent.change(dialog.getByLabelText("Quantity"), {
    target: { value: "2" },
  });
  expect(
    (
      dialog.getByRole("button", {
        name: "Approve & send",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(fixture.approve).not.toHaveBeenCalled();
});
it("does not submit a fractional unreviewed patient quantity", async () => {
  fixture.required = false;
  const dialog = await open();
  fireEvent.change(
    dialog.getByLabelText("Estimated billed amount (USD per unit)"),
    { target: { value: "10" } },
  );
  fireEvent.change(dialog.getByLabelText("Quantity"), {
    target: { value: "1.5" },
  });
  expect(
    (
      dialog.getByRole("button", {
        name: "Approve & send",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(fixture.approve).not.toHaveBeenCalled();
});
it("shows the actionable pricing rejection so the CSR can recover", async () => {
  fixture.required = false;
  fixture.approve.mockRejectedValue(
    new Error("A cost changed. Refresh the review."),
  );
  const dialog = await open();
  fireEvent.change(
    dialog.getByLabelText("Estimated billed amount (USD per unit)"),
    { target: { value: "10" } },
  );
  fireEvent.click(dialog.getByRole("button", { name: "Approve & send" }));
  expect(await dialog.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("A cost changed. Refresh the review."),
  );
});
