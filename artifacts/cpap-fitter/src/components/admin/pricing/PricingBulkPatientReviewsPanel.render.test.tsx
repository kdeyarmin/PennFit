// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
const { drafts, send } = vi.hoisted(() => ({ drafts: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/admin/therapy-resupply-api", () => ({
  listResupplyDrafts: drafts,
}));
vi.mock("@/lib/admin-json-fetch", () => ({ adminJsonFetch: send }));
vi.mock("@/lib/admin/pricing-api", () => ({
  pricingKey: ["admin", "pricing"],
}));
import { PricingBulkPatientReviewsPanel } from "./PricingBulkPatientReviewsPanel";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("resupply patient pricing selection", () => {
  it("sends only the explicit draft selection and clears results when the selection changes", async () => {
    drafts.mockResolvedValue({
      drafts: [1, 2].map((n) => ({
        id: `draft-${n}`,
        patientId: `patient-${n}`,
        patientName: `Fixture ${n}`,
        category: "mask",
        suggestedProductId: "MASK",
        suggestedQuantity: n,
        nextEligibleDate: "2026-09-14",
      })),
    });
    send.mockResolvedValue({
      evaluatedAt: "2026-09-14T12:00:00Z",
      reviews: [
        {
          draftId: "draft-2",
          patientId: "patient-2",
          sku: "MASK",
          quantity: 2,
          state: "stale",
          message: "Fixture pricing expired",
        },
      ],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PricingBulkPatientReviewsPanel />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select Fixture 2 MASK" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate selected drafts" }),
    );
    expect(await screen.findByText("Fixture pricing expired")).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([
      "/admin/pricing/resupply-review",
      { method: "POST", body: JSON.stringify({ draftIds: ["draft-2"] }) },
    ]);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Fixture 1 MASK" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Fixture pricing expired")).toBeNull(),
    );
  });
});
