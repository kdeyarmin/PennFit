// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { PricingItemReview } from "./PricingItemReview";
import { PricingOrderReview } from "./PricingOrderReview";
import { PricingBatchesPanel } from "./PricingReviewsPanel";
import * as api from "@/lib/admin/pricing-api";
import type {
  Quote,
  ResolvedScenario,
  PricingState,
} from "@/lib/admin/pricing-api";
const patientId = "10000000-0000-4000-8000-000000000001";
const offerId = "20000000-0000-4000-8000-000000000001";
const policyId = "30000000-0000-4000-8000-000000000001";
const quoteId = "40000000-0000-4000-8000-000000000001";
const shippingId = "50000000-0000-4000-8000-000000000001";
vi.mock("@/lib/admin/catalog-api", () => ({
  fetchCatalog: vi.fn().mockResolvedValue({
    products: [{ sku: "MASK-1", name: "Test mask", active: true }],
    total: 1,
  }),
}));
vi.mock("@/lib/admin/manual-documents-api", () => ({
  searchPatientsForAttach: vi.fn().mockResolvedValue([]),
}));
vi.mock("@workspace/api-client-react/admin", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@workspace/api-client-react/admin")
  >()),
  useGetAdminMe: () => ({
    data: { userId: "csr-user", permissions: ["pricing.evaluate"] },
    isPending: false,
  }),
}));
vi.mock("@/lib/admin/pricing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/pricing-api")>()),
  getPricingState: vi.fn(),
  getPricingOffers: vi.fn(),
  getPricingRevenueProfiles: vi.fn(),
  getActivePricingPrices: vi.fn(),
  evaluatePricingScenario: vi.fn(),
  savePricingQuote: vi.fn(),
  getPricingQuotes: vi.fn(),
  getPricingQuote: vi.fn(),
  getPricingShippingRates: vi.fn(),
  getPricingBatches: vi.fn(),
  getPricingPortfolio: vi.fn(),
  previewPricingBatch: vi.fn(),
  activatePricingBatch: vi.fn(),
}));
const state: PricingState = {
  revision: 3,
  enabled: true,
  enforceQuotes: true,
  activePriceListId: null,
  policy: {
    id: policyId,
    version: 1,
    name: "Reviewed policy",
    effectiveFrom: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-12-31T23:59:59.999Z",
    createdAt: "2020-01-01T00:00:00.000Z",
    createdBy: "manager",
    rules: {
      targetMarginBps: 4000,
      floorMarginBps: 2000,
      basis: "contribution",
    },
  },
};
function resolved(): ResolvedScenario {
  return {
    scenario: {
      patientId,
      validUntil: "2099-01-01T23:59:59.999Z",
      lines: [
        {
          id: "60000000-0000-4000-8000-000000000001",
          sku: "MASK-1",
          description: "Test mask",
          quantity: 1,
          unitAmountCents: 10000,
          offerId,
          offerVersion: 1,
          fulfillmentMethod: "dropship",
        },
      ],
      revenue: {
        mode: "insurance",
        expectedCollectibleCents: 13337,
        status: "verified",
      },
    },
    policyId,
    policyVersion: 1,
    dependencies: [
      { offerId, version: 1, expiresAt: "2099-12-31T23:59:59.999Z" },
    ],
    input: { evaluatedAt: "2026-09-14T12:00:00.000Z" },
    evaluation: {
      state: "meets_target",
      revenueMode: "insurance",
      selectedBasis: "contribution",
      netRevenueCents: 13337,
      deliveredCostCents: 5000,
      contributionCents: 8337,
      selectedBasisMarginBps: 6250,
      goodsCostCents: 4000,
      additionalFulfillmentCostCents: 1000,
      processingFeeCents: 0,
      expectedRefundCents: 0,
      riskCostCents: 0,
      overheadCents: 0,
      maximumDeliveredCostCents: 8002,
      issues: [],
    },
  } as unknown as ResolvedScenario;
}
function quote(): Quote {
  return {
    ...resolved(),
    id: quoteId,
    revision: 2,
    status: "approved",
    patientId,
    lines: resolved().scenario.lines.map((line) => ({
      ...line,
      unitCostCents: 4000,
    })),
    validUntil: "2099-01-01T23:59:59.999Z",
    approvedBy: "manager",
    approvedAt: "2026-09-14T12:00:00.000Z",
    boundOrderId: null,
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
  };
}
function mount(ui: React.ReactNode) {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
  return { ...view, client };
}
async function fillReview() {
  await screen.findByRole("option", { name: /Supplier One/ });
  fireEvent.change(screen.getByLabelText("Item 1 supplier offer"), {
    target: { value: offerId },
  });
  fireEvent.change(screen.getByLabelText("Review valid through (UTC)"), {
    target: { value: "2099-01-01" },
  });
  fireEvent.change(screen.getByLabelText("Expected total collections ($)"), {
    target: { value: "120.00" },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getPricingState).mockResolvedValue(state);
  vi.mocked(api.getPricingOffers).mockResolvedValue({
    offers: [
      {
        id: offerId,
        version: 1,
        sku: "MASK-1",
        supplierName: "Supplier One",
        supplierSku: "S-1",
        currency: "USD",
        unitCostCents: 4000,
        unitsPerPack: 1,
        minQuantity: 1,
        maxQuantity: null,
        status: "verified",
        effectiveFrom: "2020-01-01T00:00:00.000Z",
        expiresAt: "2099-12-31T23:59:59.999Z",
        source: "Invoice 1",
        components: [],
        createdAt: "2020-01-01T00:00:00.000Z",
        createdBy: "manager",
      },
    ],
  });
  vi.mocked(api.getPricingRevenueProfiles).mockResolvedValue({
    profiles: [],
    hasMore: false,
  });
  vi.mocked(api.getActivePricingPrices).mockResolvedValue({ batch: null });
  vi.mocked(api.evaluatePricingScenario).mockImplementation(async () =>
    resolved(),
  );
  vi.mocked(api.savePricingQuote).mockImplementation(async () => quote());
  vi.mocked(api.getPricingQuotes).mockResolvedValue({
    quotes: [],
    hasMore: false,
  });
  vi.mocked(api.getPricingQuote).mockImplementation(async () => quote());
  vi.mocked(api.getPricingBatches).mockResolvedValue({ batches: [] });
  vi.mocked(api.getPricingPortfolio).mockResolvedValue({
    items: [],
    hasMore: false,
  });
});
afterEach(cleanup);
const initialLines = [
  {
    sku: "MASK-1",
    description: "Test mask",
    quantity: 1,
    unitAmountCents: 10000,
  },
];
describe("pricing review safety and usability", () => {
  it("opens owner models with the current evaluated scenario and removes the action after editing", async () => {
    const openOwnerModels = vi.fn();
    mount(
      <PricingItemReview
        initialLines={initialLines}
        onUseInOwnerModels={openOwnerModels}
      />,
    );
    await fillReview();
    expect(
      screen.queryByRole("button", { name: "Use in owner models" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use in owner models" }),
    );
    expect(openOwnerModels).toHaveBeenCalledWith(resolved().scenario);
    fireEvent.change(screen.getByLabelText("Item 1 quantity"), {
      target: { value: "2" },
    });
    expect(
      screen.queryByRole("button", { name: "Use in owner models" }),
    ).toBeNull();
  });
  it("evaluates internal volume simulations up to 10,000 units and rejects larger quantities", async () => {
    mount(<PricingItemReview initialLines={initialLines} />);
    await fillReview();
    fireEvent.change(screen.getByLabelText("Item 1 quantity"), {
      target: { value: "10001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("1 to 10,000"),
    );
    expect(api.evaluatePricingScenario).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Item 1 quantity"), {
      target: { value: "10000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    await waitFor(() =>
      expect(api.evaluatePricingScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: [expect.objectContaining({ quantity: 10_000 })],
        }),
      ),
    );
    expect(
      screen.getByText(/Scenarios above 99 units per item cannot be attached/),
    ).toBeTruthy();
  });
  it("retains the 99-unit limit when reviewing a patient order", async () => {
    const attach = vi.fn();
    mount(
      <PricingItemReview
        patientId={patientId}
        initialLines={initialLines}
        onAttach={attach}
      />,
    );
    await fillReview();
    fireEvent.change(screen.getByLabelText("Item 1 quantity"), {
      target: { value: "100" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("1 to 99"),
    );
    expect(api.evaluatePricingScenario).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });
  it("saves a verified within-target review without requesting manager approval", async () => {
    vi.mocked(api.savePricingQuote).mockImplementation(
      async ({ requestApproval }) => ({
        ...quote(),
        status: requestApproval ? "pending_approval" : "approved",
      }),
    );
    mount(
      <PricingItemReview
        patientId={patientId}
        initialLines={initialLines}
        onAttach={vi.fn()}
      />,
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save review", exact: true }),
    );
    await waitFor(() =>
      expect(api.savePricingQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          requestApproval: false,
          scenario: resolved().scenario,
        }),
      ),
    );
    expect(
      (
        (await screen.findByRole("button", {
          name: "Use approved review in order",
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      screen.queryByText("Sent to a pricing manager for review."),
    ).toBeNull();
  });
  it("explicitly requests manager approval for a permissible below-target review", async () => {
    vi.mocked(api.evaluatePricingScenario).mockResolvedValue({
      ...resolved(),
      evaluation: { ...resolved().evaluation, state: "approval_needed" },
    });
    vi.mocked(api.savePricingQuote).mockImplementation(
      async ({ requestApproval }) => ({
        ...quote(),
        status: requestApproval ? "pending_approval" : "draft",
      }),
    );
    mount(
      <PricingItemReview
        patientId={patientId}
        initialLines={initialLines}
        onAttach={vi.fn()}
      />,
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Request manager approval",
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(api.savePricingQuote).toHaveBeenCalledWith(
        expect.objectContaining({ requestApproval: true }),
      ),
    );
    await screen.findByText("Sent to a pricing manager for review.");
    expect(
      (
        screen.getByRole("button", {
          name: "Use approved review in order",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("resets an open calculator when the order items change", async () => {
    const props = {
      patientId,
      quote: null,
      onAttach: vi.fn(),
      onRequirementChange: vi.fn(),
    };
    const { rerender, client } = mount(
      <PricingOrderReview {...props} initialLines={initialLines} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Evaluate items" }),
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    await screen.findByText("$133.37");
    rerender(
      <QueryClientProvider client={client}>
        <PricingOrderReview
          {...props}
          initialLines={[
            { ...initialLines[0], quantity: 3, unitAmountCents: 2500 },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(
      (screen.getByLabelText("Item 1 quantity") as HTMLInputElement).value,
    ).toBe("3");
    expect(
      (
        screen.getByLabelText(
          "Item 1 billed / scenario unit amount ($)",
        ) as HTMLInputElement
      ).value,
    ).toBe("25.00");
    expect(screen.queryByText("$133.37")).toBeNull();
  });
  it("blocks unreviewed submission if the policy refresh fails with cached optional rules", async () => {
    vi.mocked(api.getPricingState).mockRejectedValue(
      new Error("Policy unavailable"),
    );
    const required = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData([...api.pricingKey, "state"], {
      ...state,
      enforceQuotes: false,
    });
    render(
      <QueryClientProvider client={client}>
        <PricingOrderReview
          patientId={patientId}
          initialLines={initialLines}
          quote={null}
          onAttach={vi.fn()}
          onRequirementChange={required}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Policy unavailable");
    await waitFor(() => expect(required).toHaveBeenLastCalledWith(null));
    expect(screen.queryByText(/Review optional/)).toBeNull();
  });
  it("rechecks saved reviews and refuses one bound to a canceled order after the list loaded", async () => {
    vi.mocked(api.getPricingQuotes).mockResolvedValue({
      quotes: [quote()],
      hasMore: false,
    });
    vi.mocked(api.getPricingQuote).mockResolvedValue({
      ...quote(),
      status: "bound",
      boundOrderId: "canceled-order",
    });
    const attach = vi.fn();
    mount(
      <PricingOrderReview
        patientId={patientId}
        initialLines={initialLines}
        quote={null}
        onAttach={attach}
        onRequirementChange={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose approved review" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use this review" }),
    );
    await waitFor(() =>
      expect(api.getPricingQuote).toHaveBeenCalledWith(quoteId),
    );
    expect(attach).not.toHaveBeenCalled();
    await screen.findByText(/no longer available for a new order/);
  });
  it("discards an in-flight saved review selection after the fixed patient changes", async () => {
    vi.mocked(api.getPricingQuotes).mockResolvedValue({
      quotes: [quote()],
      hasMore: false,
    });
    let finish!: (value: Quote) => void;
    vi.mocked(api.getPricingQuote).mockReturnValue(
      new Promise<Quote>((resolve) => {
        finish = resolve;
      }),
    );
    const props = {
      initialLines,
      quote: null,
      onAttach: vi.fn(),
      onRequirementChange: vi.fn(),
    };
    const { rerender, client } = mount(
      <PricingOrderReview {...props} patientId={patientId} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose approved review" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use this review" }),
    );
    await waitFor(() => expect(api.getPricingQuote).toHaveBeenCalled());
    rerender(
      <QueryClientProvider client={client}>
        <PricingOrderReview {...props} patientId="different-patient" />
      </QueryClientProvider>,
    );
    await act(async () => {
      finish(quote());
    });
    expect(props.onAttach).not.toHaveBeenCalled();
  });
  it("requires collection verification again after changing its amount", async () => {
    mount(
      <PricingItemReview
        patientId={patientId}
        initialLines={initialLines}
        canVerify
      />,
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I verified the expected collection amount/,
      }),
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /I verified the expected collection amount/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Expected total collections ($)"), {
      target: { value: "80.00" },
    });
    expect(
      (
        screen.getByRole("checkbox", {
          name: /I verified the expected collection amount/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });
  it("clears prior collection assumptions when switching the patient search", async () => {
    mount(<PricingItemReview initialLines={initialLines} canVerify />);
    await fillReview();
    fireEvent.change(
      screen.getByLabelText("Collection evidence / payer reference"),
      { target: { value: "Prior patient evidence" } },
    );
    fireEvent.change(screen.getByLabelText("Find patient"), {
      target: { value: "Different patient" },
    });
    expect(
      (
        screen.getByLabelText(
          "Expected total collections ($)",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      (
        screen.getByLabelText(
          "Collection evidence / payer reference",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("keeps a blank amount unknown and refuses partial decimal entry", async () => {
    mount(
      <PricingItemReview
        patientId={patientId}
        initialLines={[{ ...initialLines[0], unitAmountCents: null }]}
      />,
    );
    await fillReview();
    expect(
      (
        screen.getByLabelText(
          "Item 1 billed / scenario unit amount ($)",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    fireEvent.change(
      screen.getByLabelText("Item 1 billed / scenario unit amount ($)"),
      { target: { value: "100.123" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("dollar amount"),
    );
    expect(api.evaluatePricingScenario).not.toHaveBeenCalled();
  });
  it("uses server totals and never permits CSR to self-verify collection evidence", async () => {
    mount(
      <PricingItemReview patientId={patientId} initialLines={initialLines} />,
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    await screen.findByText("$133.37");
    expect(screen.queryByRole("checkbox", { name: /I verified/ })).toBeNull();
    expect(api.evaluatePricingScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        revenue: expect.objectContaining({
          mode: "insurance",
          expectedCollectibleCents: 12000,
          status: "estimated",
        }),
      }),
    );
  });
  it("discards a late calculation after quantity changes", async () => {
    let complete!: (value: ResolvedScenario) => void;
    vi.mocked(api.evaluatePricingScenario).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    mount(
      <PricingItemReview patientId={patientId} initialLines={initialLines} />,
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    await waitFor(() => expect(api.evaluatePricingScenario).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Item 1 quantity"), {
      target: { value: "2" },
    });
    await act(async () => complete(resolved()));
    expect(screen.queryByText("$133.37")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save review" })).toBeNull();
  });
  it("clears saved review actions as soon as financial input changes", async () => {
    mount(
      <PricingItemReview
        patientId={patientId}
        initialLines={initialLines}
        onAttach={vi.fn()}
      />,
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save review" }));
    await screen.findByRole("button", { name: "Use approved review in order" });
    fireEvent.change(screen.getByLabelText("Expected total collections ($)"), {
      target: { value: "90.00" },
    });
    expect(
      screen.queryByRole("button", { name: "Use approved review in order" }),
    ).toBeNull();
  });
  it("caps a stock review at the selected live shipping expiry", async () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    vi.mocked(api.getPricingShippingRates).mockResolvedValue({
      origin: "configured_warehouse",
      rates: [
        {
          carrierCode: "UPS",
          serviceCode: "ground",
          serviceDescription: "Ground",
          totalCents: 999,
          zone: null,
          shippingQuoteId: shippingId,
          expiresAt,
        },
      ],
    });
    mount(
      <PricingItemReview patientId={patientId} initialLines={initialLines} />,
    );
    await fillReview();
    fireEvent.change(screen.getByLabelText("Supplier delivery service"), {
      target: { value: "Expedited supplier delivery" },
    });
    fireEvent.change(screen.getByLabelText("Item 1 fulfillment"), {
      target: { value: "stock" },
    });
    for (const label of [
      "Weight (oz)",
      "Length (in)",
      "Width (in)",
      "Height (in)",
    ])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "5" },
      });
    fireEvent.click(screen.getByRole("button", { name: "Get shipping rates" }));
    fireEvent.click(await screen.findByRole("radio", { name: /UPS/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    await waitFor(() =>
      expect(api.evaluatePricingScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          shippingQuoteId: shippingId,
          validUntil: expiresAt,
          delivery: expect.objectContaining({ service: "ground" }),
        }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Weight (oz)"), {
      target: { value: "8" },
    });
    expect(screen.queryByRole("radio", { name: /UPS/ })).toBeNull();
  });
  it("suppresses a late saved quote after the session cache is cleared", async () => {
    let complete!: (value: Quote) => void;
    vi.mocked(api.savePricingQuote).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { client } = mount(
      <PricingItemReview
        patientId={patientId}
        initialLines={initialLines}
        onAttach={vi.fn()}
      />,
    );
    await fillReview();
    fireEvent.click(
      screen.getByRole("button", { name: "Evaluate profitability" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save review" }));
    await waitFor(() => expect(api.savePricingQuote).toHaveBeenCalled());
    await act(async () => {
      await clearSessionCache(client);
      complete(quote());
    });
    expect(
      screen.queryByRole("button", { name: "Use approved review in order" }),
    ).toBeNull();
  });
  it("blocks calculation until a company policy is configured", async () => {
    vi.mocked(api.getPricingState).mockResolvedValue({
      ...state,
      policy: null,
      enabled: false,
      enforceQuotes: false,
    });
    mount(<PricingItemReview initialLines={initialLines} />);
    await screen.findByText(/No pricing policy is configured/);
    expect(
      (
        screen.getByRole("button", {
          name: "Evaluate profitability",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("scopes reusable approvals to the selected patient", async () => {
    const wrong = { ...quote(), id: "another", patientId: "different-patient" };
    vi.mocked(api.getPricingQuotes).mockResolvedValue({
      quotes: [wrong, quote()],
      hasMore: false,
    });
    const attach = vi.fn(),
      required = vi.fn();
    mount(
      <PricingOrderReview
        patientId={patientId}
        initialLines={initialLines}
        quote={null}
        onAttach={attach}
        onRequirementChange={required}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose approved review" }),
    );
    const use = await screen.findAllByRole("button", {
      name: "Use this review",
    });
    expect(use).toHaveLength(1);
    expect(api.getPricingQuotes).toHaveBeenCalledWith(0, {
      patientId,
      status: "approved",
    });
    fireEvent.click(use[0]);
    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith(
        expect.objectContaining({ id: quoteId, revision: 2, patientId }),
      ),
    );
  });
  it("shows oversized internal reviews without allowing them to attach to a patient order", async () => {
    const large = quote();
    large.lines = large.lines.map((line) => ({ ...line, quantity: 100 }));
    large.scenario = { ...large.scenario, lines: large.lines };
    vi.mocked(api.getPricingQuotes).mockResolvedValue({
      quotes: [large],
      hasMore: false,
    });
    const attach = vi.fn();
    mount(
      <PricingOrderReview
        patientId={patientId}
        initialLines={initialLines}
        quote={null}
        onAttach={attach}
        onRequirementChange={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose approved review" }),
    );
    await screen.findByText(/Internal simulation only: patient orders support/);
    const use = screen.getByRole("button", {
      name: "Use this review",
    }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(use);
    expect(api.getPricingQuote).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });
  it("activates the frozen batch id rather than changed working selection", async () => {
    const batch = {
      id: "70000000-0000-4000-8000-000000000001",
      name: "Reviewed prices",
      createdAt: new Date().toISOString(),
      entries: [resolved()],
      active: false,
      scheduledAt: null,
      scheduleStatus: null,
      scheduleError: null,
    };
    vi.mocked(api.previewPricingBatch).mockResolvedValue(batch);
    vi.mocked(api.activatePricingBatch).mockResolvedValue({
      ...state,
      activePriceListId: batch.id,
    });
    const scenarios = [resolved().scenario],
      onClear = vi.fn();
    const { rerender, client } = mount(
      <PricingBatchesPanel
        state={state}
        scenarios={scenarios}
        onClear={onClear}
        canPublish
      />,
    );
    fireEvent.change(screen.getByLabelText("Price list name"), {
      target: { value: "Reviewed prices" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create frozen preview" }),
    );
    await screen.findByText("Frozen preview: Reviewed prices");
    rerender(
      <QueryClientProvider client={client}>
        <PricingBatchesPanel
          state={state}
          scenarios={[
            ...scenarios,
            { ...scenarios[0], validUntil: "2098-01-01T00:00:00.000Z" },
          ]}
          onClear={onClear}
          canPublish
        />
      </QueryClientProvider>,
    );
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
      expect(api.activatePricingBatch).toHaveBeenCalledWith(batch.id, 3),
    );
  });
});
