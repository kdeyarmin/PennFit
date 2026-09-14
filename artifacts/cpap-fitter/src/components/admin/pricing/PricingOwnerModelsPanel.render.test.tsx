// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SessionMutationCache,
  clearSessionCache,
} from "@workspace/resupply-auth-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/admin/pricing-api";
import type {
  PricingOwnerModelsResponse,
  Quote,
  Scenario,
} from "@/lib/admin/pricing-api";
import {
  PricingOwnerModelsPanel,
  type OwnerModelSource,
} from "./PricingOwnerModelsPanel";

vi.mock("@/lib/admin/pricing-api", async (original) => ({
  ...(await original<typeof import("@/lib/admin/pricing-api")>()),
  getPricingQuotes: vi.fn(),
  getPricingQuote: vi.fn(),
  getPricingOwnerModels: vi.fn(),
  refreshPricingPortfolioScenario: vi.fn(),
}));
const scenario: Scenario = {
  validUntil: "2099-01-01T00:00:00.000Z",
  lines: [
    {
      id: "mask",
      sku: "MASK",
      description: "Review mask",
      quantity: 1,
      unitAmountCents: 10000,
      offerId: "offer",
      offerVersion: 1,
      fulfillmentMethod: "dropship",
    },
  ],
  revenue: {
    mode: "self_pay",
    shippingChargeCents: 0,
    discount: { fixedCents: 0 },
  },
};
const source: OwnerModelSource = {
  scenario,
  label: "Current item review",
  revision: 1,
};
const empty = { status: "needs_inputs", issues: [] } as const;
function response(): PricingOwnerModelsResponse {
  const evaluation = {
    state: "approval_needed",
    contributionCents: 5000,
    contributionMarginBps: 5000,
    issues: [
      {
        code: "line_floor",
        path: "lines.mask",
        message: "Mask line requires a pricing review.",
      },
    ],
  };
  return {
    resolved: { scenario, evaluation },
    models: {
      modelVersion: "1",
      evaluatedAt: "2026-09-14T12:00:00Z",
      currency: "USD",
      overheadTreatment: "explicit_fixed_costs_replace_allocated_overhead",
      baseline: evaluation,
      strategies: {
        status: "calculated",
        issues: [],
        items: [
          {
            status: "calculated",
            issues: [],
            strategy: "reference_price",
            lineId: "mask",
            unitPriceCents: 9500,
            evaluation,
            recommendationStatus: null,
            equivalentTargetMarginBps: null,
          },
        ],
      },
      monthly: {
        status: "calculated",
        issues: evaluation.issues,
        contributionPerOrderCents: 5000,
        breakEvenOrders: 20,
        targetProfitOrders: null,
        projectedRevenueCents: 50000,
        projectedContributionCents: 40000,
        projectedProfitCents: 32145,
      },
      sensitivity: {
        status: "estimated",
        issues: [],
        items: [
          {
            id: "stress",
            label: "Stress result",
            status: "estimated",
            issues: [],
            evaluation,
            contributionDeltaCents: -500,
          },
        ],
      },
      priceVolume: {
        status: "calculated",
        issues: [],
        items: [
          {
            id: "price",
            label: "Price result",
            status: "calculated",
            issues: [],
            evaluation,
            contributionDeltaCents: 500,
            orders: 6,
            projectedRevenueCents: 6300,
            projectedContributionCents: 3000,
            projectedProfitCents: 3000,
          },
        ],
      },
      acquisition: {
        ...empty,
        horizonMonths: null,
        totalOrders: null,
        contributionPerCustomerCents: null,
        netPerCustomerCents: null,
        totalAcquisitionCostCents: null,
        projectedProfitCents: null,
        acquisitionPaybackOrders: null,
        paybackWithinHorizon: null,
      },
      workingCapital: {
        ...empty,
        fundingGapDays: null,
        periodCashOutlayCents: null,
        estimatedFundingCents: null,
      },
    },
  } as unknown as PricingOwnerModelsResponse;
}
function quote(): Quote {
  return {
    ...response().resolved,
    id: "saved-quote",
    revision: 2,
    lines: scenario.lines,
    validUntil: scenario.validUntil,
  } as unknown as Quote;
}
function mount(
  incomingSource: OwnerModelSource | null = source,
  canManage = true,
) {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = (next: OwnerModelSource | null, active = true) => (
    <QueryClientProvider client={client}>
      <PricingOwnerModelsPanel
        active={active}
        canManage={canManage}
        incomingSource={next}
        onItemReview={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(ui(incomingSource));
  return {
    client,
    rerender: (next: OwnerModelSource | null, active = true) =>
      view.rerender(ui(next, active)),
  };
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function button(name: string) {
  return screen.getByRole("button", { name });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPricingQuotes).mockResolvedValue({
    quotes: [quote()],
    hasMore: false,
  });
  vi.mocked(api.getPricingQuote).mockResolvedValue(quote());
  vi.mocked(api.getPricingOwnerModels).mockResolvedValue(response());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("owner planning models", () => {
  it("keeps blanks unknown, sends only the selected model, accepts explicit zero and renders server results and source issues", async () => {
    mount();
    expect(
      (screen.getByLabelText("Monthly fixed costs ($)") as HTMLInputElement)
        .value,
    ).toBe("");
    fill("Monthly fixed costs ($)", "1000000.25");
    fill("Assumed monthly orders", "0");
    fireEvent.click(button("Calculate monthly break-even & profit"));
    await screen.findByText("$321.45");
    expect(api.getPricingOwnerModels).toHaveBeenCalledWith(scenario, {
      monthly: { fixedCostCents: 100000025, orders: 0 },
    });
    expect(
      screen.getByText("Mask line requires a pricing review."),
    ).toBeTruthy();
    expect(screen.getByText("Approval needed")).toBeTruthy();
  });
  it("sends signed stress percentages without inventing omitted collection changes", async () => {
    mount();
    fill("Goods cost change (%)", "-5.25");
    fill("Freight cost change (%)", "0");
    fireEvent.click(button("Calculate cost & collection stress"));
    await screen.findByText("Stress result · Uses estimated inputs");
    expect(api.getPricingOwnerModels).toHaveBeenCalledWith(scenario, {
      sensitivity: {
        cases: [
          {
            id: expect.any(String),
            label: "Case 1",
            goodsChangeBps: -525,
            freightChangeBps: 0,
          },
        ],
      },
    });
  });
  it("requires an explicit bundle item for price changes and sends only entered pricing strategies", async () => {
    const bundle = {
      ...scenario,
      lines: [
        ...scenario.lines,
        {
          ...scenario.lines[0],
          id: "cushion",
          sku: "CUSHION",
          description: "Cushion",
        },
      ],
    };
    mount({ ...source, scenario: bundle });
    fill("Target contribution margin (%)", "40");
    fill("Reference unit price ($)", "95");
    fireEvent.click(button("Calculate pricing strategies"));
    await screen.findByText(
      "Choose the item whose unit price you want to compare.",
    );
    expect(api.getPricingOwnerModels).not.toHaveBeenCalled();
    fill("Item to reprice in strategy and volume models", "cushion");
    fireEvent.click(button("Calculate pricing strategies"));
    await screen.findByText("Reference price · Calculated");
    expect(api.getPricingOwnerModels).toHaveBeenCalledWith(bundle, {
      selectedLineId: "cushion",
      strategies: { targetMarginBps: 4000, referenceUnitPriceCents: 9500 },
    });
  });
  it("keeps a price-volume case incomplete until price and volume are explicitly supplied", async () => {
    mount();
    fill("Monthly fixed costs for price comparison ($)", "0");
    fireEvent.click(button("Calculate price versus volume"));
    await screen.findByText(
      "Price case 1: enter both a unit price and a whole-number order volume.",
    );
    expect(api.getPricingOwnerModels).not.toHaveBeenCalled();
    fill("Scenario unit price ($)", "10.50");
    fill("Assumed monthly orders at this price", "6");
    fireEvent.click(button("Calculate price versus volume"));
    await screen.findByText("Price result · Calculated");
    expect(api.getPricingOwnerModels).toHaveBeenCalledWith(scenario, {
      selectedLineId: "mask",
      priceVolume: {
        fixedCostCents: 0,
        cases: [
          {
            id: expect.any(String),
            label: "Case 1",
            unitPriceCents: 1050,
            orders: 6,
          },
        ],
      },
    });
  });
  it.each([
    {
      name: "repeat orders & acquisition",
      fields: [
        ["Planning period (months)", "12"],
        ["Assumed customers", "25"],
        ["Orders per customer over the full period", "4"],
        ["Acquisition cost per customer ($)", "10.25"],
        ["Retention cost per order ($)", "0"],
        ["Fixed costs for the full planning period ($)", "1000"],
      ],
      expected: {
        acquisition: {
          horizonMonths: 12,
          customers: 25,
          ordersPerCustomer: 4,
          acquisitionCostPerCustomerCents: 1025,
          retentionCostPerOrderCents: 0,
          fixedCostCents: 100000,
        },
      },
    },
    {
      name: "working capital",
      fields: [
        ["Planning period (days)", "30"],
        ["Assumed orders during this period", "100"],
        ["Cash paid out per order ($)", "25.10"],
        ["Days held in inventory", "0"],
        ["Days until customer / insurer collection", "45"],
        ["Days until vendor payment", "30"],
      ],
      expected: {
        workingCapital: {
          periodDays: 30,
          orders: 100,
          cashOutlayPerOrderCents: 2510,
          inventoryDays: 0,
          daysToCollect: 45,
          daysToPayVendor: 30,
        },
      },
    },
  ])(
    "independently calculates $name without supplying unrelated assumptions",
    async ({ name, fields, expected }) => {
      mount();
      fields.forEach(([label, value]) => fill(label, value));
      fireEvent.click(button(`Calculate ${name}`));
      await waitFor(() =>
        expect(api.getPricingOwnerModels).toHaveBeenCalledWith(
          scenario,
          expected,
        ),
      );
      await screen.findByText("More information needed");
    },
  );
  it("ignores an in-flight result after assumptions change and preserves the draft across workspace visibility", async () => {
    const pending = deferred<PricingOwnerModelsResponse>();
    vi.mocked(api.getPricingOwnerModels).mockReturnValue(pending.promise);
    const view = mount();
    fill("Monthly fixed costs ($)", "100");
    fireEvent.click(button("Calculate monthly break-even & profit"));
    await waitFor(() => expect(api.getPricingOwnerModels).toHaveBeenCalled());
    fill("Monthly fixed costs ($)", "200");
    view.rerender(source, false);
    view.rerender(source, true);
    await act(async () => pending.resolve(response()));
    expect(screen.queryByText("$321.45")).toBeNull();
    expect(
      (button("Download scenario report") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Monthly fixed costs ($)") as HTMLInputElement)
        .value,
    ).toBe("200");
  });
  it("discards responses after a new source is selected, even when its line amounts are identical", async () => {
    const pending = deferred<PricingOwnerModelsResponse>();
    vi.mocked(api.getPricingOwnerModels).mockReturnValue(pending.promise);
    const view = mount();
    fill("Monthly fixed costs ($)", "100");
    fireEvent.click(button("Calculate monthly break-even & profit"));
    await waitFor(() => expect(api.getPricingOwnerModels).toHaveBeenCalled());
    view.rerender({ ...source, revision: 2, label: "New review" });
    await screen.findByText("New review");
    await act(async () => pending.resolve(response()));
    expect(screen.queryByText("$321.45")).toBeNull();
    expect(
      (button("Download scenario report") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("does not restore a result after the account session cache is cleared", async () => {
    const pending = deferred<PricingOwnerModelsResponse>();
    vi.mocked(api.getPricingOwnerModels).mockReturnValue(pending.promise);
    const view = mount();
    fill("Monthly fixed costs ($)", "100");
    fireEvent.click(button("Calculate monthly break-even & profit"));
    await waitFor(() => expect(api.getPricingOwnerModels).toHaveBeenCalled());
    await act(async () => {
      await clearSessionCache(view.client);
      pending.resolve(response());
    });
    expect(screen.queryByText("$321.45")).toBeNull();
    expect(
      (button("Download scenario report") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("supports paged saved sources and offers fresh-review guidance for an expired patient quote", async () => {
    vi.mocked(api.getPricingQuotes).mockImplementation(async (offset = 0) => ({
      quotes: offset ? [quote()] : [],
      hasMore: !offset,
    }));
    vi.mocked(api.getPricingQuote).mockResolvedValue({
      ...quote(),
      scenario: {
        ...scenario,
        patientId: "patient",
        validUntil: "2020-01-01T00:00:00Z",
      },
    });
    mount(null);
    await screen.findByText(
      "No saved reviews on this page. Evaluate an item to begin.",
    );
    fireEvent.click(button("Next saved scenarios"));
    await screen.findByRole("option", { name: /Review mask/ });
    fill("Saved review for owner models", "saved-quote");
    await screen.findByText(/This review has expired/);
    expect(api.getPricingQuotes).toHaveBeenLastCalledWith(50);
    expect(api.getPricingQuote).toHaveBeenCalledWith("saved-quote");
    expect(
      screen.queryByRole("button", { name: "Refresh catalog assumptions" }),
    ).toBeNull();
    expect(api.refreshPricingPortfolioScenario).not.toHaveBeenCalled();
  });
  it("ignores a saved-review response after the account session changes", async () => {
    const pending = deferred<Quote>();
    vi.mocked(api.getPricingQuote).mockReturnValue(pending.promise);
    const view = mount(null);
    await screen.findByRole("option", { name: /Review mask/ });
    fill("Saved review for owner models", "saved-quote");
    await waitFor(() => expect(api.getPricingQuote).toHaveBeenCalled());
    await act(async () => {
      await clearSessionCache(view.client);
      pending.resolve(quote());
    });
    expect(screen.queryByText(/Saved review saved-qu/)).toBeNull();
    expect(
      screen.getByText(/Select a source scenario before calculating/),
    ).toBeTruthy();
  });
  it("recovers from a calculation error and prevents exports after editing its assumptions", async () => {
    vi.mocked(api.getPricingOwnerModels)
      .mockRejectedValueOnce(
        new Error("Pricing source temporarily unavailable"),
      )
      .mockResolvedValue(response());
    mount();
    fill("Monthly fixed costs ($)", "100");
    fireEvent.click(button("Calculate monthly break-even & profit"));
    const error = await screen.findByRole("alert");
    fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
    await screen.findByText("$321.45");
    expect(
      (button("Download scenario report") as HTMLButtonElement).disabled,
    ).toBe(false);
    fill("Monthly fixed costs ($)", "101");
    expect(screen.queryByText("$321.45")).toBeNull();
    expect(
      (button("Download scenario report") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("exports readable result snapshots and neutralizes spreadsheet formulas in user labels", async () => {
    let captured: NodeBlob | undefined;
    const createObjectURL = vi.fn((blob: NodeBlob) => {
      captured = blob;
      return "blob:owner-models";
    });
    const ExistingURL = URL;
    vi.stubGlobal(
      "URL",
      class extends ExistingURL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = vi.fn();
      },
    );
    vi.stubGlobal("Blob", NodeBlob);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mount();
    const stress = within(screen.getByRole("group", { name: "Stress case 1" }));
    fireEvent.change(stress.getByLabelText("Case 1 name"), {
      target: { value: "  =SUM(1,2)" },
    });
    fill("Goods cost change (%)", "10");
    fireEvent.click(button("Calculate cost & collection stress"));
    await screen.findByText("Stress result · Uses estimated inputs");
    fireEvent.click(button("Download scenario report"));
    const csv = await captured!.text();
    expect(csv).toContain("'  =SUM(1,2)");
    expect(csv).toContain('"Goods cost change (%)","10"');
    expect(csv).toContain("Contribution change");
    expect(csv).toContain("Planning assumptions only");
    expect(csv).not.toContain("patientId");
  });
  it("does not fetch or render model controls without manager access", () => {
    mount(null, false);
    expect(screen.getByRole("alert").textContent).toContain(
      "pricing manager access",
    );
    expect(api.getPricingQuotes).not.toHaveBeenCalled();
    expect(api.getPricingOwnerModels).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Monthly fixed costs ($)")).toBeNull();
  });
});
