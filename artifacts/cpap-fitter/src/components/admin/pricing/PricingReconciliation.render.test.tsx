// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionMutationCache } from "@workspace/resupply-auth-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/admin/pricing-api";
import type { Quote, Reconciliation } from "@/lib/admin/pricing-api";
import { PricingQuotesPanel } from "./PricingReviewsPanel";
import { AdminPricingPage } from "@/pages/admin/admin-pricing";

vi.mock("./PricingItemReview", () => ({
  PricingEvaluationResult: () => null,
  PricingItemReview: () => <p>Item calculator</p>,
}));
vi.mock("@workspace/api-client-react/admin", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react/admin")>()),
  useGetAdminMe: () => ({
    isPending: false,
    data: { userId: "csr-1", permissions: ["pricing.evaluate"] },
  }),
}));
vi.mock("@/lib/admin/pricing-api", async (original) => ({
  ...(await original<typeof import("@/lib/admin/pricing-api")>()),
  getPricingQuotes: vi.fn(),
  getPricingSummary: vi.fn(),
  getPricingActuals: vi.fn(),
  closePricingActuals: vi.fn(),
  getPricingState: vi.fn(),
  getPricingAlerts: vi.fn(),
}));
const quote = (id = "quote-1"): Quote =>
  ({
    id,
    revision: 2,
    status: "bound",
    approvedAt: null,
    validUntil: "2099-12-31T23:59:59.999Z",
    lines: [
      {
        id: "line-1",
        sku: "MASK",
        description: id === "quote-1" ? "Mask review" : "Other review",
        quantity: 1,
        unitAmountCents: 10000,
      },
    ],
    scenario: { revenue: { mode: "insurance" } },
    evaluation: { state: "meets_target" },
  }) as unknown as Quote;
const reconciliation = (offset = 0, revision = 3): Reconciliation => ({
  quote: quote(),
  revision,
  costsComplete: true,
  revenueComplete: true,
  settled: true,
  events: [
    {
      id: `event-${offset}`,
      source: "collection",
      sourceRef: `Receipt ${offset + 1}`,
      economicEventId: `collection-${offset + 1}`,
      kind: "revenue",
      amountCents: 10000,
      createdAt: "2026-01-01T00:00:00Z",
      occurredAt: "2026-01-01T00:00:00Z",
    },
  ],
  eventPage: { offset, limit: 100, total: 1001, hasMore: offset < 1000 },
  forecast: {
    status: "blocked",
    evaluation: null,
    reason: "stale_dependencies",
    evaluatedAt: "2026-01-01T00:00:00Z",
  },
  actualRevenueCents: 10010000,
  actualCostCents: 6000000,
  actualContributionCents: 4010000,
  actualMarginBps: 4005,
  quotedRevenueCents: 10000,
  quotedCostCents: 5000,
  costVarianceCents: 5995000,
  revenueVarianceCents: 10000000,
});
function mount(ui: React.ReactNode) {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
    client,
  };
}
async function openActuals() {
  const view = mount(<PricingQuotesPanel canManage canApprove={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /Mask review/ }));
  await screen.findByLabelText(
    "All supplier and fulfillment costs are recorded",
  );
  return view;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPricingQuotes).mockResolvedValue({
    quotes: [quote(), quote("quote-2")],
    hasMore: false,
  });
  vi.mocked(api.getPricingSummary).mockResolvedValue({ groups: [] });
  vi.mocked(api.getPricingActuals).mockImplementation(async (_id, offset = 0) =>
    reconciliation(offset),
  );
  vi.mocked(api.closePricingActuals).mockResolvedValue(reconciliation(0, 4));
  vi.mocked(api.getPricingState).mockResolvedValue({
    revision: 1,
    policy: null,
    enabled: false,
    enforceQuotes: false,
    activePriceListId: null,
  });
});
afterEach(cleanup);

describe("reconciliation controls and history", () => {
  it("recovers from a failed history page without losing the completeness draft", async () => {
    vi.mocked(api.getPricingActuals).mockImplementation(
      async (_id, offset = 0) => {
        if (offset) throw new Error("History page unavailable");
        return reconciliation();
      },
    );
    await openActuals();
    fireEvent.click(
      screen.getByLabelText("All supplier and fulfillment costs are recorded"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next actual events" }));
    await screen.findByText("History page unavailable");
    fireEvent.click(
      screen.getByRole("button", { name: "Return to first actual events" }),
    );
    expect(
      (
        (await screen.findByLabelText(
          "All supplier and fulfillment costs are recorded",
        )) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });
  it("initializes settled completeness from loaded evidence and preserves it when saving a new reason", async () => {
    await openActuals();
    expect(
      (
        screen.getByLabelText(
          "All supplier and fulfillment costs are recorded",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          "All collections, refunds and credits are recorded",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Completeness evidence / reason"), {
      target: { value: "Reviewed final invoice and receipt" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save reconciliation status" }),
    );
    await waitFor(() =>
      expect(api.closePricingActuals).toHaveBeenCalledWith("quote-1", {
        expectedRevision: 3,
        costsComplete: true,
        revenueComplete: true,
        reason: "Reviewed final invoice and receipt",
      }),
    );
  });
  it("preserves draft completeness across pages while totals still cover all events, and resets history for another quote", async () => {
    await openActuals();
    fireEvent.click(
      screen.getByLabelText("All supplier and fulfillment costs are recorded"),
    );
    fireEvent.change(screen.getByLabelText("Completeness evidence / reason"), {
      target: { value: "Checking a remaining supplier credit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next actual events" }));
    await screen.findByText(/Receipt 101/);
    expect(api.getPricingActuals).toHaveBeenLastCalledWith("quote-1", 100);
    expect(
      (
        screen.getByLabelText(
          "All supplier and fulfillment costs are recorded",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByLabelText(
          "Completeness evidence / reason",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Checking a remaining supplier credit");
    expect(screen.getByText("$100,100.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Other review/ }));
    await waitFor(() =>
      expect(api.getPricingActuals).toHaveBeenLastCalledWith("quote-2", 0),
    );
    expect(
      (
        (await screen.findByLabelText(
          "All supplier and fulfillment costs are recorded",
        )) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
  it("preserves an edited choice on refetch and requires review of a new reconciliation revision", async () => {
    const { client } = await openActuals();
    fireEvent.click(
      screen.getByLabelText("All supplier and fulfillment costs are recorded"),
    );
    fireEvent.change(screen.getByLabelText("Completeness evidence / reason"), {
      target: { value: "Checking original completeness evidence" },
    });
    vi.mocked(api.getPricingActuals).mockResolvedValue(reconciliation(0, 4));
    await act(async () => {
      await client.invalidateQueries({
        queryKey: [...api.pricingKey, "actuals", "quote-1"],
      });
    });
    await screen.findByRole("button", { name: "Reload completeness status" });
    expect(
      (
        screen.getByLabelText(
          "All supplier and fulfillment costs are recorded",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Save reconciliation status",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Reload completeness status" }),
    );
    expect(
      (
        screen.getByLabelText(
          "All supplier and fulfillment costs are recorded",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Save reconciliation status" }),
    );
    await waitFor(() =>
      expect(api.closePricingActuals).toHaveBeenCalledWith(
        "quote-1",
        expect.objectContaining({
          expectedRevision: 4,
          costsComplete: true,
          revenueComplete: true,
        }),
      ),
    );
  });
});

describe("CSR pricing permission boundaries", () => {
  it("does not fetch or render manager portfolio totals for evaluate-only staff", async () => {
    mount(<PricingQuotesPanel canManage={false} canApprove={false} />);
    await screen.findByRole("button", { name: /Mask review/ });
    expect(api.getPricingSummary).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Portfolio profitability" }),
    ).toBeNull();
  });
  it("omits manager follow-up navigation for evaluate-only staff", async () => {
    mount(<AdminPricingPage />);
    await screen.findByRole("button", { name: "Reviews & actuals" });
    expect(screen.queryByRole("button", { name: "Follow-up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Owner models" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reviews & actuals" }));
    await screen.findByRole("button", { name: /Mask review/ });
    expect(api.getPricingSummary).not.toHaveBeenCalled();
    expect(api.getPricingAlerts).not.toHaveBeenCalled();
  });
});
