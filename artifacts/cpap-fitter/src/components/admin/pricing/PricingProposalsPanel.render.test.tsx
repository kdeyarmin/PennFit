// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  review: vi.fn(),
}));
vi.mock("@/lib/admin/pricing-api", () => ({
  pricingKey: ["admin", "pricing"],
  getPricingProposals: mocks.list,
  savePricingProposal: mocks.save,
  reviewPricingProposal: mocks.review,
}));
import { PricingProposalsPanel } from "./PricingProposalsPanel";
import { ProvisionalComparisonSummary } from "./PricingProvisionalComparison";
import type {
  ProvisionalSupplierComparison,
  ProvisionalComparisonResult,
} from "@workspace/api-client-react/admin";
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
function mount() {
  return render(
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
      <PricingProposalsPanel canManage={false} />
    </QueryClientProvider>,
  );
}
function proposal() {
  fill("Item name", "Proposed mask");
  fill("Pack and sellable unit", "Three masks per pack");
  fill("Supplier quote / evidence reference", "Supplier estimates");
}
function compare() {
  fireEvent.click(
    screen.getByRole("button", { name: "Compare provisional supplier costs" }),
  );
  fill("Comparison requested units", "5");
  fill("Comparison delivery area", "17401");
  fill("Comparison delivery service", "Ground");
}
const fees = [
  "Inbound freight",
  "Dropship",
  "Delivery freight",
  "Handling",
  "Packaging",
  "Other charges",
];
function supplier(
  index: number,
  name: string,
  options: {
    packCost?: string;
    unitsPerPack?: string;
    minimumPacks?: string;
    fees?: Record<string, string>;
  } = {},
) {
  const fields = within(
    screen.getByRole("group", { name: `Supplier option ${index}` }),
  );
  const set = (label: string, value: string) =>
    fireEvent.change(fields.getByLabelText(`Supplier ${index} ${label}`), {
      target: { value },
    });
  set("name", name);
  set("evidence reference", `${name} estimate`);
  set("evidence valid through (UTC)", "2099-01-01");
  set("purchase pack cost ($)", options.packCost ?? "10.01");
  set("units per pack", options.unitsPerPack ?? "3");
  if (options.minimumPacks) set("minimum packs", options.minimumPacks);
  for (const fee of fees) set(`${fee} ($)`, options.fees?.[fee] ?? "0");
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ proposals: [], hasMore: false });
  mocks.save.mockResolvedValue({ id: "proposal-1" });
});
afterEach(cleanup);
describe("provisional new-item supplier comparison", () => {
  it("discards a formerly complete result when its saved source cannot be recalculated", () => {
    render(
      <ProvisionalComparisonSummary
        comparison={
          {
            currency: "USD",
            quantity: 0,
            destination: "17401",
            service: "Ground",
            suppliers: [],
          } as ProvisionalSupplierComparison
        }
        result={
          {
            evaluatedAt: new Date().toISOString(),
            quantity: 1,
            suppliers: [
              { id: "a", status: "estimated", deliveredCostCents: 1 },
            ],
          } as ProvisionalComparisonResult
        }
      />,
    );
    expect(
      screen.getByText("The saved cost comparison needs updated information."),
    ).toBeTruthy();
    expect(screen.queryByText(/Delivered purchase outlay/)).toBeNull();
  });
  it("shows comparable whole-pack outlays and saves only provisional evidence without issuing a firm quote", async () => {
    mount();
    proposal();
    compare();
    supplier(1, "Supplier A", {
      fees: { Dropship: "3", "Delivery freight": "4.50", Handling: "1" },
    });
    fill("Supplier 1 Delivery freight basis", "parcel");
    fill("Supplier 1 Delivery freight parcel count", "2");
    fill("Supplier 1 Handling basis", "pack");
    fireEvent.click(
      screen.getByRole("button", { name: "Add supplier option" }),
    );
    supplier(2, "Supplier B", {
      packCost: "3.33",
      unitsPerPack: "1",
      minimumPacks: "6",
    });
    const a = within(
      screen.getByRole("article", { name: "Comparison for Supplier A" }),
    );
    expect(a.getByText("Delivered purchase outlay $34.02")).toBeTruthy();
    expect(
      a.getByText(/Buy 2 packs · 6 purchased units · 1 surplus units/),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("article", { name: "Comparison for Supplier B" }),
      ).getByText("Delivered purchase outlay $19.98"),
    ).toBeTruthy();
    expect(
      screen.getByText(/No firm customer price can be issued/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Submit item proposal" }),
    );
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const saved = mocks.save.mock.calls[0][0];
    expect(saved.comparison).toMatchObject({
      currency: "USD",
      quantity: 5,
      destination: "17401",
      service: "Ground",
    });
    expect(saved.comparison.suppliers[0]).toMatchObject({
      packCostCents: 1001,
      unitsPerPack: 3,
      minimumPacks: 1,
    });
    expect(saved.comparison.suppliers[1]).toMatchObject({
      packCostCents: 333,
      unitsPerPack: 1,
      minimumPacks: 6,
    });
    expect(saved).not.toHaveProperty("comparisonResult");
    expect(saved).not.toHaveProperty("price");
    expect(mocks.review).not.toHaveBeenCalled();
    // This full two-supplier workflow makes over 30 real form changes; allow
    // shared CI workers enough time without increasing other tests' limits.
  }, 15_000);
  it("keeps an unknown charge incomplete and handles pack inclusion without a duplicate charge", () => {
    mount();
    compare();
    supplier(1, "Supplier A");
    fill("Supplier 1 Delivery freight ($)", "");
    expect(screen.getByText("Known subtotal $20.02")).toBeTruthy();
    expect(screen.getByText(/Missing: Delivery freight/)).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText(
        "Supplier 1 Delivery freight is included in pack cost",
      ),
    );
    expect(screen.getByText("Delivered purchase outlay $20.02")).toBeTruthy();
    expect(
      screen.getByText("Delivery freight: Included in pack cost"),
    ).toBeTruthy();
  });
  it("prevents fractional quantities and invalid money from being silently saved as unknown", async () => {
    mount();
    proposal();
    compare();
    supplier(1, "Supplier A");
    fill("Supplier 1 units per pack", "1.5");
    fireEvent.click(
      screen.getByRole("button", { name: "Submit item proposal" }),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(
      screen.getAllByText(/units per pack: enter a whole number/).length,
    ).toBeGreaterThan(0);
    fill("Supplier 1 units per pack", "3");
    fill("Supplier 1 purchase pack cost ($)", "1.005");
    fireEvent.click(
      screen.getByRole("button", { name: "Submit item proposal" }),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    fill("Supplier 1 purchase pack cost ($)", "1.00");
    fireEvent.click(
      screen.getByRole("button", { name: "Submit item proposal" }),
    );
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  });
  it("recomputes persisted evidence expiry in the sourcing queue and exposes no CSR approval action", async () => {
    mocks.list.mockResolvedValue({
      proposals: [
        {
          id: "p1",
          name: "Old item",
          manufacturer: "",
          model: "",
          size: "",
          packDescription: "Pack",
          source: "Evidence",
          notes: "",
          status: "open",
          comparison: {
            currency: "USD",
            quantity: 1,
            destination: "17401",
            service: "Ground",
            suppliers: [
              {
                id: "a",
                supplierName: "Expired supplier",
                source: "Old evidence",
                expiresAt: "2020-01-01T00:00:00Z",
                packCostCents: 1000,
                unitsPerPack: 1,
                minimumPacks: 1,
                availability: "unknown",
                leadTimeDays: null,
                terms: "",
                fees: fees.map((label, index) => ({
                  id: label,
                  label,
                  category: [
                    "inbound",
                    "dropship",
                    "freight",
                    "handling",
                    "packaging",
                    "other",
                  ][index],
                  amountCents: 0,
                  basis: "order",
                  count: 1,
                })),
              },
            ],
          },
        },
      ],
      hasMore: false,
    });
    mount();
    expect(await screen.findByText("Evidence expired")).toBeTruthy();
    expect(screen.getByText("Known subtotal $10.00")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Review proposal" }),
    ).toBeNull();
  });
});
