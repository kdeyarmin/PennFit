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
import {
  SessionMutationCache,
  clearSessionCache,
} from "@workspace/resupply-auth-react";
import { ApiError } from "@workspace/api-client-react/admin";
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
  savePricingActual: vi.fn(),
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
  vi.mocked(api.savePricingActual)
    .mockReset()
    .mockResolvedValue(reconciliation(0, 4));
  vi.mocked(api.getPricingState).mockResolvedValue({
    revision: 1,
    policy: null,
    enabled: false,
    enforceQuotes: false,
    activePriceListId: null,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fillActual(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function enterActual() {
  fillActual("Actual amount ($)", "24.50");
  fillActual("Source document reference", "Invoice-123");
  fillActual("Unique economic event reference", "cost-123");
  fillActual("Actual event notes", "Supplier invoice checked");
  fillActual("Allocate to item", "line-1");
}

describe("actual event submission", () => {
  it("retries the complete committed payload unchanged after a lost response", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    vi.mocked(api.savePricingActual).mockRejectedValueOnce(
      new Error("Reply lost after save"),
    );
    await openActuals();
    enterActual();
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await screen.findByText("Reply lost after save");
    const body = vi.mocked(api.savePricingActual).mock.calls[0][1];
    vi.setSystemTime(new Date("2026-09-15T12:10:00Z"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.savePricingActual).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.savePricingActual).mock.calls[1]).toEqual([
      "quote-1",
      body,
    ]);
    expect(vi.mocked(api.savePricingActual).mock.calls[1][1]).toBe(body);
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "Unique economic event reference",
          ) as HTMLInputElement
        ).value,
      ).toBe(""),
    );
    expect(
      (
        screen.getByLabelText(
          "Economic occurrence date and time (UTC)",
        ) as HTMLInputElement
      ).value,
    ).toBe("2026-09-15T12:10");
    enterActual();
    fillActual("Source document reference", "Invoice-124");
    fillActual("Unique economic event reference", "cost-124");
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await waitFor(() => expect(api.savePricingActual).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.savePricingActual).mock.calls[2][1]).toMatchObject({
      economicEventId: "cost-124",
      sourceRef: "Invoice-124",
      occurredAt: "2026-09-15T12:10:00.000Z",
    });
  });
  it("records a historical economic date as UTC instead of the entry time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    await openActuals();
    enterActual();
    fillActual("Economic occurrence date and time (UTC)", "2026-08-15T09:45");
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await waitFor(() =>
      expect(api.savePricingActual).toHaveBeenCalledWith(
        "quote-1",
        expect.objectContaining({ occurredAt: "2026-08-15T09:45:00.000Z" }),
      ),
    );
  });
  it.each(["", "2026-02-30T09:45", "2026-09-16T09:45"])(
    "refuses missing, impossible or future occurrence time %j",
    async (date) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
      await openActuals();
      enterActual();
      fillActual("Economic occurrence date and time (UTC)", date);
      fireEvent.click(
        screen.getByRole("button", { name: "Record actual event" }),
      );
      expect(
        screen.getByText(/Enter a valid economic occurrence date/),
      ).toBeTruthy();
      expect(api.savePricingActual).not.toHaveBeenCalled();
    },
  );
  it("uses deliberate edits without replacing references after an uncertain save and shows conflict recovery", async () => {
    vi.mocked(api.savePricingActual)
      .mockRejectedValueOnce(new Error("Reply lost after save"))
      .mockRejectedValueOnce(
        new ApiError(
          new Response(null, { status: 409 }),
          { error: "duplicate_economic_event" },
          { method: "POST", url: "/pricing/quotes/quote-1/actuals" },
        ),
      );
    await openActuals();
    enterActual();
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await screen.findByText("Reply lost after save");
    const original = structuredClone(
      vi.mocked(api.savePricingActual).mock.calls[0][1],
    );
    fillActual("Actual event source", "adjustment");
    fillActual("Economic effect", "cost_credit");
    fillActual("Actual amount ($)", "35.00");
    fillActual("Allocate to item", "");
    fillActual("Actual event notes", "Correction evidence");
    fillActual("Economic occurrence date and time (UTC)", "2026-07-01T10:30");
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await screen.findByText(
      /This event reference already has different recorded details/,
    );
    expect(vi.mocked(api.savePricingActual).mock.calls[0][1]).toEqual(original);
    expect(vi.mocked(api.savePricingActual).mock.calls[1][1]).toEqual({
      source: "adjustment",
      sourceRef: "Invoice-123",
      economicEventId: "cost-123",
      kind: "cost_credit",
      amountCents: 3500,
      notes: "Correction evidence",
      occurredAt: "2026-07-01T10:30:00.000Z",
    });
    const reads = vi.mocked(api.getPricingActuals).mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh actual event history" }),
    );
    await waitFor(() =>
      expect(api.getPricingActuals).toHaveBeenCalledTimes(reads + 1),
    );
    expect(api.savePricingActual).toHaveBeenCalledTimes(2);
    expect(
      (
        screen.getByLabelText(
          "Unique economic event reference",
        ) as HTMLInputElement
      ).value,
    ).toBe("cost-123");
  });
  it("does not erase a newer draft when an earlier save finishes", async () => {
    let resolve!: (value: Reconciliation) => void;
    vi.mocked(api.savePricingActual).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await openActuals();
    enterActual();
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await waitFor(() => expect(api.savePricingActual).toHaveBeenCalledTimes(1));
    fillActual("Actual amount ($)", "99.00");
    fillActual("Source document reference", "Invoice-next");
    fillActual("Unique economic event reference", "cost-next");
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    expect(api.savePricingActual).toHaveBeenCalledTimes(1);
    await act(async () => resolve(reconciliation(0, 4)));
    expect(
      (screen.getByLabelText("Actual amount ($)") as HTMLInputElement).value,
    ).toBe("99.00");
    expect(
      (
        screen.getByLabelText(
          "Unique economic event reference",
        ) as HTMLInputElement
      ).value,
    ).toBe("cost-next");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Record actual event",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await waitFor(() => expect(api.savePricingActual).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.savePricingActual).mock.calls[1][1]).toMatchObject({
      amountCents: 9900,
      sourceRef: "Invoice-next",
      economicEventId: "cost-next",
    });
  });
  it("does not retry an old actual-event body after the session changes", async () => {
    vi.mocked(api.savePricingActual).mockRejectedValueOnce(
      new Error("Reply lost after save"),
    );
    const { client } = await openActuals();
    enterActual();
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await screen.findByText("Reply lost after save");
    const retry = screen.getByRole("button", { name: "Retry" });
    await act(async () => {
      await clearSessionCache(client);
      fireEvent.click(retry);
    });
    expect(api.savePricingActual).toHaveBeenCalledTimes(1);
  });
  it("does not refresh private data from a late actual-event reply after a session change", async () => {
    let resolve!: (value: Reconciliation) => void;
    vi.mocked(api.savePricingActual).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { client } = await openActuals();
    enterActual();
    fireEvent.click(
      screen.getByRole("button", { name: "Record actual event" }),
    );
    await waitFor(() => expect(api.savePricingActual).toHaveBeenCalledTimes(1));
    await act(async () => {
      await clearSessionCache(client);
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => resolve(reconciliation(0, 4)));
    expect(invalidate).not.toHaveBeenCalled();
    expect(
      client.getQueryData([...api.pricingKey, "actuals", "quote-1", 0]),
    ).toBeUndefined();
  });
});

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
