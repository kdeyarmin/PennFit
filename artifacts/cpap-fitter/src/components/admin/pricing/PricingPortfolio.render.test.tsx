// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { ApiError } from "@workspace/api-client-react/admin";
import {
  SessionMutationCache,
  clearSessionCache,
} from "@workspace/resupply-auth-react";
import { PricingPortfolioPanel } from "./PricingPortfolioPanel";
import { PricingBatchesPanel } from "./PricingReviewsPanel";
import * as api from "@/lib/admin/pricing-api";
import type {
  PriceBatch,
  PricingPortfolioEntry,
  PricingPortfolioItem,
  PricingState,
  ResolvedScenario,
} from "@/lib/admin/pricing-api";

vi.mock("@/lib/admin/pricing-api", async (original) => ({
  ...(await original<typeof import("@/lib/admin/pricing-api")>()),
  getPricingPortfolio: vi.fn(),
  refreshPricingPortfolioScenario: vi.fn(),
  getPricingBatches: vi.fn(),
  previewPricingBatch: vi.fn(),
  recommendPricingScenario: vi.fn(),
  activatePricingBatch: vi.fn(),
}));

const resolved = (sku = "MASK-1"): ResolvedScenario =>
  ({
    scenario: {
      validUntil: "2099-01-01T00:00:00.000Z",
      delivery: { country: "US", postalCode: "19103", service: "Ground" },
      revenue: { mode: "self_pay", shippingChargedCents: 0 },
      lines: [
        {
          id: `line-${sku}`,
          sku,
          description: sku === "MASK-1" ? "Mask" : "Filter",
          quantity: 1,
          unitAmountCents: 10000,
          offerId: `offer-${sku}`,
          offerVersion: 1,
          fulfillmentMethod: "dropship",
        },
      ],
    },
    input: {},
    policyId: "policy-1",
    policyVersion: 1,
    dependencies: [],
    evaluation: {
      state: "meets_target",
      revenueMode: "self_pay",
      selectedBasis: "contribution",
      netRevenueCents: 10000,
      deliveredCostCents: 4000,
      contributionCents: 6000,
      selectedBasisMarginBps: 6000,
      goodsCostCents: 3500,
      additionalFulfillmentCostCents: 500,
      processingFeeCents: 0,
      expectedRefundCents: 0,
      riskCostCents: 0,
      overheadCents: 0,
      issues: [],
    },
  }) as unknown as ResolvedScenario;
const entry = (entryIndex = 0): PricingPortfolioEntry => ({
  batchId: "published-1",
  entryIndex,
  entry: resolved(entryIndex ? "FILTER-1" : "MASK-1"),
});
const item = (
  sku = "MASK-1",
  activeEntries: PricingPortfolioEntry[] = [entry()],
): PricingPortfolioItem => ({
  sku,
  name: sku === "MASK-1" ? "Mask" : "Filter",
  category: "Masks",
  offers: [],
  hasMoreOffers: false,
  activeEntries,
});
const state = {
  revision: 3,
  enabled: true,
  enforceQuotes: true,
  activePriceListId: "published-1",
  policy: null,
} satisfies PricingState;
const batch = (withComparison = true): PriceBatch => ({
  id: "preview-1",
  name: "September prices",
  createdAt: "2026-09-14T12:00:00.000Z",
  active: false,
  scheduledAt: null,
  scheduleStatus: null,
  scheduleError: null,
  entries: [
    {
      ...resolved(),
      ...(withComparison
        ? {
            comparison: {
              status: "comparable" as const,
              reason: null,
              evaluatedAt: "2026-09-14T12:00:00.000Z",
              previousPriceListId: "published-1",
              previousEntryIndexes: [0],
              previousUnitAmounts: [
                { sku: "MASK-1", quantity: 1, unitAmountCents: 8000 },
              ],
              previousInput: resolved().input,
              previousEvaluation: {
                ...resolved().evaluation,
                netRevenueCents: 8000,
                contributionCents: 4000,
                selectedBasisMarginBps: 5000,
              },
            },
          }
        : {}),
    },
  ],
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPricingPortfolio).mockResolvedValue({
    items: [item()],
    hasMore: false,
  });
  vi.mocked(api.refreshPricingPortfolioScenario).mockImplementation(
    async (scenario) => ({ ...resolved(), scenario }),
  );
  vi.mocked(api.getPricingBatches).mockResolvedValue({ batches: [] });
  vi.mocked(api.previewPricingBatch).mockResolvedValue(batch());
  vi.mocked(api.activatePricingBatch).mockResolvedValue(state);
});
afterEach(cleanup);

describe("pricing portfolio selection", () => {
  it("does not select another supplier's published scenario just because the item has a matching offer", async () => {
    const supplierB = {
      ...entry(),
      suppliers: [
        { sku: "MASK-1", offerId: "offer-B", supplierName: "Supplier B" },
      ],
    };
    const supplierA = {
      ...entry(1),
      suppliers: [
        { sku: "FILTER-1", offerId: "offer-A", supplierName: "Supplier A" },
      ],
    };
    vi.mocked(api.getPricingPortfolio).mockResolvedValue({
      items: [
        item("MASK-1", [supplierB]),
        { ...item("FILTER-1", [supplierA]), hasMoreOffers: true },
      ],
      hasMore: false,
    });
    mount(<PricingPortfolioPanel onAdd={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Supplier"), {
      target: { value: "Supplier A" },
    });
    await screen.findByRole("checkbox", { name: "Select FILTER-1 scenario 2" });
    expect(
      screen.queryByRole("checkbox", { name: "Select MASK-1 scenario 1" }),
    ).toBeNull();
    await screen.findByText("Supplier for this item: Supplier A");
    fireEvent.click(
      screen.getByRole("button", { name: "Select all filtered scenarios" }),
    );
    await screen.findByText(/1 distinct published scenarios selected/);
    expect(
      (
        screen.getByRole("button", {
          name: "Add selected scenarios to working selection (1)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("selects a bundle once while preserving all bundle items and current supplier refresh", async () => {
    const bundle = entry();
    bundle.entry.scenario.lines.push(...resolved("FILTER-1").scenario.lines);
    vi.mocked(api.getPricingPortfolio).mockResolvedValue({
      items: [item("MASK-1", [bundle]), item("FILTER-1", [bundle])],
      hasMore: false,
    });
    const add = vi.fn();
    mount(<PricingPortfolioPanel onAdd={add} />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select MASK-1 scenario 1" }),
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Select FILTER-1 scenario 1",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add selected scenarios to working selection (1)",
      }),
    );
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith([bundle.entry.scenario]),
    );
    expect(api.refreshPricingPortfolioScenario).toHaveBeenCalledTimes(1);
    expect(
      add.mock.calls[0][0][0].lines.map((line: { sku: string }) => line.sku),
    ).toEqual(["MASK-1", "FILTER-1"]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Select available scenarios on this page",
      }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Add selected scenarios to working selection (0)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Select FILTER-1 scenario 1",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });
  it("searches all filtered pages, deduplicates contexts and discloses items needing first review", async () => {
    vi.mocked(api.getPricingPortfolio).mockImplementation(async (filters) =>
      filters?.limit === 100
        ? filters.offset === 0
          ? { items: [item(), item("NEW-1", [])], hasMore: true }
          : { items: [item(), item("FILTER-1", [entry(1)])], hasMore: false }
        : { items: [item()], hasMore: false },
    );
    mount(<PricingPortfolioPanel onAdd={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Find item or SKU"), {
      target: { value: "mask" },
    });
    fireEvent.change(screen.getByLabelText("Category (exact)"), {
      target: { value: "Masks" },
    });
    fireEvent.change(screen.getByLabelText("Supplier"), {
      target: { value: "Supplier One" },
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Select all filtered scenarios",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select all filtered scenarios" }),
    );
    await screen.findByText(
      /2 distinct published scenarios selected.*1 item\(s\)/,
    );
    expect(api.getPricingPortfolio).toHaveBeenCalledWith({
      q: "mask",
      category: "Masks",
      supplier: "Supplier One",
      limit: 100,
      offset: 100,
    });
    fireEvent.change(screen.getByLabelText("Supplier"), {
      target: { value: "Another" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Add selected scenarios to working selection (0)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("discards a late filtered selection after filters change", async () => {
    let finish!: (value: api.PricingPortfolio) => void;
    vi.mocked(api.getPricingPortfolio).mockImplementation((filters) =>
      filters?.limit === 100
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ items: [item()], hasMore: false }),
    );
    mount(<PricingPortfolioPanel onAdd={vi.fn()} />);
    await screen.findByRole("checkbox");
    fireEvent.click(
      screen.getByRole("button", { name: "Select all filtered scenarios" }),
    );
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("Find item or SKU"), {
      target: { value: "different" },
    });
    await act(async () => finish({ items: [item()], hasMore: false }));
    expect(
      (
        screen.getByRole("button", {
          name: "Add selected scenarios to working selection (0)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("keeps failures visible and never silently adds only successful refreshes", async () => {
    vi.mocked(api.getPricingPortfolio).mockResolvedValue({
      items: [item(), item("FILTER-1", [entry(1)])],
      hasMore: false,
    });
    vi.mocked(api.refreshPricingPortfolioScenario).mockImplementation(
      async (scenario) => {
        if (scenario.lines[0].sku === "FILTER-1")
          throw new Error("Supplier evidence expired");
        return { ...resolved(), scenario };
      },
    );
    const add = vi.fn();
    mount(<PricingPortfolioPanel onAdd={add} />);
    await screen.findByRole("checkbox", { name: "Select MASK-1 scenario 1" });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Select available scenarios on this page",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add selected scenarios to working selection (2)",
      }),
    );
    await screen.findByText(
      /No scenarios were added.*Supplier evidence expired/,
    );
    expect(add).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Select MASK-1 scenario 1",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
  it("does not add a late refreshed scenario after a session change", async () => {
    let finish!: (value: ResolvedScenario) => void;
    vi.mocked(api.refreshPricingPortfolioScenario).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const add = vi.fn(),
      { client } = mount(<PricingPortfolioPanel onAdd={add} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add selected scenarios to working selection (1)",
      }),
    );
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => {
      await clearSessionCache(client);
      finish(resolved());
    });
    expect(add).not.toHaveBeenCalled();
  });
  it("opens an unpriced item for explicit assumptions instead of inventing a bulk scenario", async () => {
    vi.mocked(api.getPricingPortfolio).mockResolvedValue({
      items: [item("MASK-1", [])],
      hasMore: false,
    });
    const review = vi.fn();
    mount(<PricingPortfolioPanel onAdd={vi.fn()} onReviewItem={review} />);
    await screen.findByText(/First scenario needed/);
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review MASK-1" }));
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ sku: "MASK-1", name: "Mask" }),
    );
  });
});

describe("frozen bulk price economics", () => {
  it("shows fresh-preview guidance for a scheduled activation blocked by changed retained prices", async () => {
    vi.mocked(api.getPricingBatches).mockResolvedValue({
      batches: [
        {
          ...batch(),
          scheduledAt: "2026-09-14T12:00:00.000Z",
          scheduleStatus: "blocked",
          scheduleError: "price_list_contexts_changed",
        },
      ],
    });
    mount(
      <PricingBatchesPanel
        scenarios={[]}
        onClear={vi.fn()}
        state={state}
        canPublish
      />,
    );
    await screen.findByText(
      /blocked.*Published item groups or retained prices changed.*Create a fresh preview/,
    );
  });
  it("explains how to recover when activation conflicts with newer retained prices", async () => {
    vi.mocked(api.activatePricingBatch).mockRejectedValue(
      new ApiError(
        new Response(null, { status: 409 }),
        { error: "price_list_contexts_changed" },
        { method: "POST", url: "/admin/pricing/batches/preview-1/activate" },
      ),
    );
    const onClear = vi.fn();
    mount(
      <PricingBatchesPanel
        scenarios={[resolved().scenario]}
        onClear={onClear}
        state={state}
        canPublish
      />,
    );
    fireEvent.change(screen.getByLabelText("Price list name"), {
      target: { value: "September prices" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create frozen preview" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Activate reviewed price list",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Activate price list",
        exact: true,
      }),
    );
    await screen.findByText(
      /Published item groups or retained prices changed.*Create a fresh preview/,
    );
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByText("Frozen preview: September prices")).toBeTruthy();
    expect(screen.queryByText(/Internal price list activated/)).toBeNull();
  });
  it("identifies every retained context needing evidence instead of losing structured errors", async () => {
    vi.mocked(api.previewPricingBatch).mockRejectedValue(
      new ApiError(
        new Response(null, { status: 422 }),
        {
          error: "retained_context_requires_review",
          issues: [
            { path: "self_pay:MASK-1:1", message: "stale_dependencies" },
            {
              path: "insurance:FILTER-1:2",
              message: "cost_information_needed",
            },
          ],
        },
        { method: "POST", url: "/admin/pricing/batches/preview" },
      ),
    );
    mount(
      <PricingBatchesPanel
        scenarios={[resolved().scenario]}
        onClear={vi.fn()}
        state={state}
        canPublish
      />,
    );
    fireEvent.change(screen.getByLabelText("Price list name"), {
      target: { value: "September prices" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create frozen preview" }),
    );
    await screen.findByText("Self-pay · MASK-1:1");
    await screen.findByText("Insurance · FILTER-1:2");
    expect(screen.getByRole("alert").textContent).toContain(
      "stale dependencies",
    );
    expect(
      screen.queryByRole("button", { name: "Activate reviewed price list" }),
    ).toBeNull();
  });
  it("recommends the explicit self-pay selection in bulk and preserves insurance collections", async () => {
    const insurance = {
      ...resolved("INSURANCE"),
      scenario: {
        ...resolved("INSURANCE").scenario,
        revenue: {
          mode: "insurance" as const,
          expectedCollectibleCents: 12000,
          status: "verified" as const,
        },
      },
    };
    vi.mocked(api.recommendPricingScenario).mockImplementation(
      async (scenario, lineId) => ({
        ...resolved(),
        scenario,
        recommendation: {
          status: "recommended",
          lineId: lineId!,
          recommendedUnitPriceCents: 12500,
          recommendedInput: resolved().input,
          evaluation: resolved().evaluation,
        },
      }),
    );
    mount(
      <PricingBatchesPanel
        scenarios={[
          resolved().scenario,
          resolved("FILTER-1").scenario,
          insurance.scenario,
        ]}
        onClear={vi.fn()}
        state={state}
        canPublish
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Include scenario 2 in frozen preview",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Recommend target prices for selected self-pay scenarios",
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "Scenario 1 MASK-1 new unit amount ($)",
          ) as HTMLInputElement
        ).value,
      ).toBe("125.00"),
    );
    expect(api.recommendPricingScenario).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByLabelText(
          "Scenario 3 INSURANCE new unit amount ($)",
        ) as HTMLInputElement
      ).value,
    ).toBe("100.00");
    fireEvent.change(screen.getByLabelText("Price list name"), {
      target: { value: "September prices" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create frozen preview" }),
    );
    await waitFor(() =>
      expect(api.previewPricingBatch).toHaveBeenCalledWith({
        name: "September prices",
        scenarios: [
          expect.objectContaining({
            lines: [expect.objectContaining({ unitAmountCents: 12500 })],
          }),
          insurance.scenario,
        ],
      }),
    );
  });
  it("displays retained active contexts in the full snapshot without offering to remove them", async () => {
    const frozen = batch();
    frozen.entries[0].changeKind = "selected";
    frozen.entries.push({ ...resolved("FILTER-1"), changeKind: "retained" });
    frozen.selectedEntryCount = 1;
    frozen.retainedEntryCount = 1;
    vi.mocked(api.previewPricingBatch).mockResolvedValue(frozen);
    mount(
      <PricingBatchesPanel
        scenarios={[resolved().scenario]}
        onClear={vi.fn()}
        state={state}
        canPublish
      />,
    );
    fireEvent.change(screen.getByLabelText("Price list name"), {
      target: { value: "September prices" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create frozen preview" }),
    );
    await screen.findByText(
      /1 selected updates and 1 retained published contexts; 2 scenarios/,
    );
    await screen.findByText(
      /Retained published context · original amounts preserved/,
    );
    expect(
      screen.getAllByRole("checkbox", {
        name: "Include this eligible change in a new subset preview",
      }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Include this eligible change in a new subset preview",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview selected eligible changes (1 of 1)",
      }),
    );
    await waitFor(() =>
      expect(api.previewPricingBatch).toHaveBeenLastCalledWith({
        name: "September prices — selected 1",
        scenarios: [resolved().scenario],
      }),
    );
  });
  it("locks related amount edits until the requested recommendation has returned", async () => {
    let finish!: (
      value: Awaited<ReturnType<typeof api.recommendPricingScenario>>,
    ) => void;
    vi.mocked(api.recommendPricingScenario).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount(
      <PricingBatchesPanel
        scenarios={[resolved().scenario]}
        onClear={vi.fn()}
        state={state}
        canPublish
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Recommend target price for scenario 1",
      }),
    );
    const amount = screen.getByLabelText(
      "Scenario 1 MASK-1 new unit amount ($)",
    ) as HTMLInputElement;
    await waitFor(() => expect(amount.disabled).toBe(true));
    expect(
      (
        screen.getByRole("button", {
          name: "Clear selection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () =>
      finish({
        ...resolved(),
        recommendation: {
          status: "recommended",
          lineId: "line-MASK-1",
          recommendedUnitPriceCents: 12000,
          recommendedInput: resolved().input,
          evaluation: resolved().evaluation,
        },
      }),
    );
    await waitFor(() => expect(amount.disabled).toBe(false));
    expect(amount.value).toBe("120.00");
    fireEvent.change(amount, { target: { value: "125.00" } });
    expect(amount.value).toBe("125.00");
  });
  it("freezes edited amounts and displays server-comparable previous and new margins", async () => {
    const { rerender, client } = mount(
      <PricingBatchesPanel
        scenarios={[resolved().scenario]}
        onClear={vi.fn()}
        state={state}
        canPublish
        canManage
      />,
    );
    fireEvent.change(screen.getByLabelText("Price list name"), {
      target: { value: "September prices" },
    });
    fireEvent.change(
      screen.getByLabelText("Scenario 1 MASK-1 new unit amount ($)"),
      { target: { value: "105.25" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create frozen preview" }),
    );
    await screen.findByText("Frozen preview: September prices");
    expect(api.previewPricingBatch).toHaveBeenCalledWith({
      name: "September prices",
      scenarios: [
        expect.objectContaining({
          lines: [expect.objectContaining({ unitAmountCents: 10525 })],
        }),
      ],
    });
    const previous = screen.getByText(
      "Previous-price projected margin",
    ).parentElement!;
    expect(within(previous).getByText("50.00%")).toBeTruthy();
    const next = screen.getByText("New-price projected margin").parentElement!;
    expect(within(next).getByText("60.00%")).toBeTruthy();
    rerender(
      <QueryClientProvider client={client}>
        <PricingBatchesPanel
          scenarios={[resolved().scenario]}
          onClear={vi.fn()}
          state={{ ...state, revision: 4, activePriceListId: "newer-list" }}
          canPublish
          canManage
        />
      </QueryClientProvider>,
    );
    await screen.findByText(
      /The active price list has changed since this comparison was frozen/,
    );
    expect(within(previous).getByText("50.00%")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find item or SKU"), {
      target: { value: "filter" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Activate reviewed price list" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Activate price list",
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(api.activatePricingBatch).toHaveBeenCalledWith("preview-1", 4),
    );
  });
  it("discloses unavailable previous margins for older saved batches", async () => {
    vi.mocked(api.previewPricingBatch).mockResolvedValue(batch(false));
    mount(
      <PricingBatchesPanel
        scenarios={[resolved().scenario]}
        onClear={vi.fn()}
        state={state}
        canPublish={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Price list name"), {
      target: { value: "September prices" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create frozen preview" }),
    );
    await screen.findByText(
      /No comparable published-price calculation was recorded/,
    );
    expect(
      within(
        screen.getByText("Previous-price projected margin").parentElement!,
      ).getByText("Not available"),
    ).toBeTruthy();
  });
});
