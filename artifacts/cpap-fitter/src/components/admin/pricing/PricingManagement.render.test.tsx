// @vitest-environment jsdom
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
  clearSessionCache,
  SessionMutationCache,
} from "@workspace/resupply-auth-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatientListItem } from "@workspace/api-client-react/admin";

const mocks = vi.hoisted(() => ({
  profiles: vi.fn(),
  saveProfile: vi.fn(),
  catalog: vi.fn(),
  policies: vi.fn(),
  savePolicy: vi.fn(),
  publish: vi.fn(),
  confirm: vi.fn(),
  offers: vi.fn(),
  saveOffer: vi.fn(),
}));
vi.mock("@/lib/admin/pricing-api", () => ({
  pricingKey: ["admin", "pricing"],
  getPricingRevenueProfiles: mocks.profiles,
  savePricingRevenueProfile: mocks.saveProfile,
  getPricingPolicies: mocks.policies,
  savePricingPolicy: mocks.savePolicy,
  publishPricingPolicy: mocks.publish,
  getPricingOffers: mocks.offers,
  savePricingOffer: mocks.saveOffer,
}));
vi.mock("@/lib/admin/catalog-api", () => ({
  SUPPLY_CATEGORIES: ["mask", "tubing"],
  fetchCatalog: mocks.catalog,
}));
vi.mock("@/hooks/use-confirm-dialog", () => ({
  useConfirmDialog: () => [mocks.confirm, null],
}));
vi.mock("../PatientSearchCombobox", () => ({
  PatientSearchCombobox: ({
    onChange,
    disabled,
  }: {
    onChange: (patient: PatientListItem) => void;
    disabled: boolean;
  }) => (
    <div>
      <button
        disabled={disabled}
        onClick={() =>
          onChange({
            id: "patient-1",
            firstName: "Synthetic",
            lastName: "One",
          } as PatientListItem)
        }
      >
        Choose first patient
      </button>
      <button
        disabled={disabled}
        onClick={() =>
          onChange({
            id: "patient-2",
            firstName: "Synthetic",
            lastName: "Two",
          } as PatientListItem)
        }
      >
        Choose second patient
      </button>
    </div>
  ),
}));
import { PricingRevenueProfilesPanel } from "./PricingRevenueProfilesPanel";
import { PricingPolicyPanel } from "./PricingPolicyPanel";
import { PricingOffersPanel } from "./PricingOffersPanel";

const offer = {
  id: "offer-1",
  version: 4,
  supplierName: "Fixture supplier",
  supplierSku: "M1",
  sku: "MASK",
  currency: "USD",
  unitCostCents: 4200,
  unitsPerPack: 1,
  minQuantity: 1,
  maxQuantity: null,
  status: "verified",
  source: "Fixture supplier contract",
  effectiveFrom: "2026-01-01T00:00:00Z",
  expiresAt: "2099-12-31T23:59:59.999Z",
  availability: "available",
  leadTimeDays: 0,
  returnTerms: "Unopened items only",
  clinicalSuitability: "Confirm prescribed model and size",
  deliveryScope: {
    country: "US",
    postalPrefixes: ["190", "191"],
    service: "Ground",
    fulfillmentMethods: ["dropship"],
  },
  components: [
    {
      id: "shared-freight",
      label: "Delivery freight",
      category: "freight",
      basis: "order",
      amountCents: 700,
      quantity: 1,
      status: "verified",
    },
  ],
};

const profile = {
  id: "profile-1",
  version: 3,
  name: "Verified payer fixture",
  patientId: "patient-1",
  lines: [{ sku: "MASK", quantity: 2 }],
  allowedCents: 10000,
  expectedCollectibleCents: 9000,
  source: "Fixture remittance",
  effectiveFrom: "2026-01-01T00:00:00Z",
  expiresAt: "2099-12-31T23:59:59.999Z",
  createdAt: "2026-09-14T00:00:00Z",
};
const policy = {
  id: "policy-1",
  version: 1,
  name: "Approved company policy",
  effectiveFrom: "2026-01-01T00:00:00Z",
  expiresAt: "2099-12-31T23:59:59.999Z",
  createdAt: "2026-09-14T00:00:00Z",
  createdBy: "manager",
  rules: {
    targetMarginBps: 4000,
    floorMarginBps: 2500,
    basis: "contribution" as const,
  },
};
const policyState = {
  revision: 2,
  enabled: true,
  enforceQuotes: false,
  policy,
  activePriceListId: null,
};
function mount(child: React.ReactNode) {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>{child}</QueryClientProvider>,
  );
  return { client, ...view };
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function startProfile() {
  mount(<PricingRevenueProfilesPanel canManage />);
  fireEvent.click(screen.getByRole("button", { name: "Choose first patient" }));
  await screen.findByText(
    "No collection profiles are recorded for this patient.",
  );
  fill("Collection profile name", "Verified payer fixture");
  fill("Evidence / payer reference", "Verified source fixture");
  fill("Total allowed revenue ($)", "100.00");
  fill("Expected total collections ($)", "90.25");
  fill("Evidence valid through (UTC)", "2099-12-31");
  fill("Covered item 1 search", "mask");
  await screen.findByRole("option", { name: "Mask · MASK" });
  fill("Covered item 1", "MASK");
  fill("Covered item 1 quantity", "2");
}
function fillPolicy() {
  fill("Policy name", "Scoped fixture policy");
  fill("Target margin (%)", "40");
  fill("Approval floor (%)", "25");
  fill("Valid through (UTC)", "2099-12-31");
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profiles.mockResolvedValue({ profiles: [], hasMore: false });
  mocks.saveProfile.mockResolvedValue({ ...profile, version: 1 });
  mocks.catalog.mockResolvedValue({
    products: [{ sku: "MASK", name: "Mask", active: true }],
    total: 1,
    categories: ["mask"],
  });
  mocks.policies.mockResolvedValue({ policies: [policy] });
  mocks.savePolicy.mockResolvedValue(policy);
  mocks.publish.mockResolvedValue(policyState);
  mocks.confirm.mockResolvedValue(true);
  mocks.offers.mockResolvedValue({ offers: [offer], hasMore: false });
  mocks.saveOffer.mockResolvedValue({ ...offer, version: 5 });
});
afterEach(cleanup);

describe("verified insurance evidence management", () => {
  it("keeps immutable profile versions distinct during history refresh and revision selection", async () => {
    const old = {
      ...profile,
      version: 2,
      name: "Earlier evidence",
      expectedCollectibleCents: 8000,
    };
    mocks.profiles.mockResolvedValue({
      profiles: [profile, old],
      hasMore: false,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client } = mount(<PricingRevenueProfilesPanel canManage />);
      fireEvent.click(
        screen.getByRole("button", { name: "Choose first patient" }),
      );
      await screen.findByText("Earlier evidence");
      expect(
        logged.mock.calls.some((args) =>
          args.some((value) => String(value).includes("same key")),
        ),
      ).toBe(false);
      mocks.profiles.mockResolvedValue({
        profiles: [
          { ...profile, version: 4, name: "Latest evidence" },
          profile,
        ],
        hasMore: false,
      });
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ["admin", "pricing", "revenue-profiles"],
        });
      });
      await screen.findByText("Latest evidence");
      expect(screen.queryByText("Earlier evidence")).toBeNull();
      fireEvent.click(
        within(
          screen.getByText("Verified payer fixture").closest("article")!,
        ).getByRole("button", { name: "Revise profile" }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "Save verified collection profile",
        }),
      );
      await waitFor(() =>
        expect(mocks.saveProfile).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedVersion: 3,
            expectedCollectibleCents: 9000,
          }),
        ),
      );
    } finally {
      logged.mockRestore();
    }
  });
  it("requires a complete allocation and counts a signed collection adjustment once", async () => {
    await startProfile();
    fill("Expected primary insurer collections ($)", "80.00");
    fireEvent.click(
      screen.getByRole("button", { name: "Save verified collection profile" }),
    );
    expect(mocks.saveProfile).not.toHaveBeenCalled();
    fill("Expected secondary collections ($)", "5.00");
    fill("Expected patient collections ($)", "10.00");
    fill("Signed collection adjustment ($)", "-4.75");
    fireEvent.click(
      screen.getByRole("button", { name: "Save verified collection profile" }),
    );
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveProfile.mock.calls[0][0]).toMatchObject({
      expectedCollectibleCents: 9025,
      expectedInsurerCents: 8000,
      expectedSecondaryCents: 500,
      expectedPatientCents: 1000,
      collectionAdjustmentCents: -475,
    });
  });
  it("records the exact patient, item quantity and cents without adding patient liability", async () => {
    await startProfile();
    fireEvent.click(
      screen.getByRole("button", { name: "Save verified collection profile" }),
    );
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveProfile.mock.calls[0][0]).toMatchObject({
      patientId: "patient-1",
      lines: [{ sku: "MASK", quantity: 2 }],
      allowedCents: 10000,
      expectedCollectibleCents: 9025,
      source: "Verified source fixture",
    });
    expect(mocks.saveProfile.mock.calls[0][0]).not.toHaveProperty("id");
  });
  it.each(["100.01", "90.001", "-1"])(
    "refuses invalid or above-allowed expected collection %s",
    async (value) => {
      await startProfile();
      fill("Expected total collections ($)", value);
      fireEvent.click(
        screen.getByRole("button", {
          name: "Save verified collection profile",
        }),
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(mocks.saveProfile).not.toHaveBeenCalled();
    },
  );
  it("keeps the immutable version and exact item scope across a failed revision retry", async () => {
    mocks.profiles.mockResolvedValue({ profiles: [profile], hasMore: false });
    mocks.saveProfile.mockRejectedValueOnce(
      new Error("Revision service unavailable"),
    );
    mount(<PricingRevenueProfilesPanel canManage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose first patient" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Revise profile" }),
    );
    fill("Expected total collections ($)", "88.25");
    fireEvent.click(
      screen.getByRole("button", { name: "Save verified collection profile" }),
    );
    await screen.findByText("Revision service unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(2));
    for (const call of mocks.saveProfile.mock.calls)
      expect(call[0]).toMatchObject({
        id: "profile-1",
        expectedVersion: 3,
        patientId: "patient-1",
        lines: [{ sku: "MASK", quantity: 2 }],
        expectedCollectibleCents: 8825,
      });
  });
  it("clears the prior patient draft before another patient is selected", async () => {
    await startProfile();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose second patient" }),
    );
    await waitFor(() =>
      expect(mocks.profiles).toHaveBeenLastCalledWith(
        0,
        "patient-2",
        "history",
      ),
    );
    expect(
      (screen.getByLabelText("Collection profile name") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (screen.getByLabelText("Covered item 1") as HTMLSelectElement).value,
    ).toBe("");
    fireEvent.click(
      screen.getByRole("button", { name: "Save verified collection profile" }),
    );
    expect(mocks.saveProfile).not.toHaveBeenCalled();
  });
  it("allows CSR reading while withholding verification mutations", async () => {
    mocks.profiles.mockResolvedValue({ profiles: [profile], hasMore: false });
    mount(<PricingRevenueProfilesPanel canManage={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose first patient" }),
    );
    await screen.findByText("Verified payer fixture");
    expect(screen.queryByRole("button", { name: "Revise profile" })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Save verified collection profile",
      }),
    ).toBeNull();
  });
  it("suppresses a late verification callback after the account cache changes", async () => {
    let resolve!: (value: unknown) => void;
    mocks.saveProfile.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mocks.profiles.mockResolvedValue({ profiles: [profile], hasMore: false });
    const { client } = mount(<PricingRevenueProfilesPanel canManage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose first patient" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Revise profile" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save verified collection profile" }),
    );
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalled());
    await act(() => clearSessionCache(client));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => resolve({ ...profile, version: 4 }));
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByText(/Verified collection profile saved/)).toBeNull();
  });
});

describe("complete scoped pricing policies", () => {
  it("submits independent full rules with a bounded exact-item override", async () => {
    mount(<PricingPolicyPanel state={policyState} canManage canPublish />);
    fillPolicy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add scoped override" }),
    );
    fill("Override 1 match", "MASK");
    fill("Override 1 priority", "10");
    fill("Override 1 target margin (%)", "45");
    fill("Override 1 minimum contribution ($)", "12.34");
    fireEvent.click(screen.getByRole("button", { name: "Save draft policy" }));
    await waitFor(() => expect(mocks.savePolicy).toHaveBeenCalledTimes(1));
    expect(mocks.savePolicy.mock.calls[0][0]).toMatchObject({
      rules: { targetMarginBps: 4000 },
      overrides: [
        {
          scope: "sku",
          value: "MASK",
          priority: 10,
          rules: {
            targetMarginBps: 4500,
            floorMarginBps: 2500,
            minimumContributionCents: 1234,
            priceIncrementCents: 1,
            basis: "contribution",
          },
        },
      ],
    });
  });
  it("blocks override dates outside the parent policy", async () => {
    mount(<PricingPolicyPanel state={policyState} canManage canPublish />);
    fillPolicy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add scoped override" }),
    );
    fill("Override 1 match", "MASK");
    fill("Override 1 valid through (UTC)", "2100-01-01");
    fireEvent.click(screen.getByRole("button", { name: "Save draft policy" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.savePolicy).not.toHaveBeenCalled();
  });
  it("publishes only the enforcement setting shown at confirmation time", async () => {
    let resolve!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount(<PricingPolicyPanel state={policyState} canManage canPublish />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish this policy" }),
    );
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Require an approved insurance review before creating patient orders",
      }),
    );
    await act(async () => resolve(true));
    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith("policy-1", {
        enabled: true,
        enforceQuotes: false,
        expectedStateRevision: 2,
      }),
    );
  });
});

describe("supplier applicability and scope", () => {
  it("refreshes a conflicting supplier revision while preserving edits until current version is explicitly loaded", async () => {
    mocks.offers
      .mockResolvedValueOnce({ offers: [offer], hasMore: false })
      .mockResolvedValue({
        offers: [{ ...offer, version: 5, unitCostCents: 4500 }],
        hasMore: false,
      });
    mocks.saveOffer.mockRejectedValueOnce(new Error("Revision conflict"));
    mount(<PricingOffersPanel canManage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Revise offer" }),
    );
    fill("Goods cost per sellable unit ($)", "44.00");
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    await screen.findByText("Revision conflict");
    await waitFor(() => expect(mocks.offers).toHaveBeenCalledTimes(2));
    expect(mocks.offers).toHaveBeenLastCalledWith(0, undefined, "latest");
    expect(
      (
        screen.getByLabelText(
          "Goods cost per sellable unit ($)",
        ) as HTMLInputElement
      ).value,
    ).toBe("44.00");
    fireEvent.click(screen.getByRole("button", { name: "Revise offer" }));
    expect(
      (
        screen.getByLabelText(
          "Goods cost per sellable unit ($)",
        ) as HTMLInputElement
      ).value,
    ).toBe("45.00");
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    await waitFor(() => expect(mocks.saveOffer).toHaveBeenCalledTimes(2));
    expect(mocks.saveOffer.mock.calls[1][0]).toMatchObject({
      id: "offer-1",
      expectedVersion: 5,
      unitCostCents: 4500,
    });
  });
  it("preserves supplier terms, known zero lead time and exact delivery scope when revising costs", async () => {
    mount(<PricingOffersPanel canManage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Revise offer" }),
    );
    fill("Goods cost per sellable unit ($)", "43.25");
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    await waitFor(() => expect(mocks.saveOffer).toHaveBeenCalledTimes(1));
    expect(mocks.saveOffer.mock.calls[0][0]).toMatchObject({
      id: "offer-1",
      expectedVersion: 4,
      unitCostCents: 4325,
      availability: "available",
      leadTimeDays: 0,
      returnTerms: offer.returnTerms,
      clinicalSuitability: offer.clinicalSuitability,
      deliveryScope: offer.deliveryScope,
      components: offer.components,
    });
  });
  it("does not renew or promote component evidence while revising unrelated supplier terms", async () => {
    const revised = {
      ...offer,
      effectiveFrom: "2090-01-01T11:15:00.000Z",
      expiresAt: "2099-12-31T11:45:17.123Z",
      components: [
        {
          ...offer.components[0],
          status: "estimated",
          expiresAt: "2099-02-01T12:45:32.456Z",
        },
        {
          ...offer.components[0],
          id: "handling",
          category: "handling",
          status: "missing",
          amountCents: null,
        },
      ],
    };
    mocks.offers.mockResolvedValue({ offers: [revised], hasMore: false });
    mount(<PricingOffersPanel canManage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Revise offer" }),
    );
    fill("Supplier return terms", "Updated return instructions");
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    await waitFor(() => expect(mocks.saveOffer).toHaveBeenCalledTimes(1));
    expect(mocks.saveOffer.mock.calls[0][0]).toMatchObject({
      status: "verified",
      effectiveFrom: revised.effectiveFrom,
      expiresAt: revised.expiresAt,
      components: revised.components,
    });
  });
  it("does not save verified freight without its explicit coverage", async () => {
    mocks.offers.mockResolvedValue({
      offers: [{ ...offer, deliveryScope: null }],
      hasMore: false,
    });
    mount(<PricingOffersPanel canManage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Revise offer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.saveOffer).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Delivery fee coverage is documented",
      }),
    );
    fill("Delivery country code", "US");
    fill("Covered postal prefixes", "190, 191");
    fill("Quoted delivery service", "Ground");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Supplier dropship delivery" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    await waitFor(() => expect(mocks.saveOffer).toHaveBeenCalledTimes(1));
    expect(mocks.saveOffer.mock.calls[0][0].deliveryScope).toEqual(
      offer.deliveryScope,
    );
  });
  it("preserves optional metadata in a reviewed CSV while keeping imported costs estimated", async () => {
    mount(<PricingOffersPanel canManage />);
    fill(
      "Supplier offers CSV",
      "sku,supplier,supplier_sku,unit_cost,source,expires,availability,lead_time_days,return_terms,clinical_suitability,country,postal_prefixes,delivery_service,fulfillment_methods\nMASK,Fixture supplier,M1,42.00,Fixture source,2099-12-31,limited,3,Unopened only,Prescribed model,US,190|191,Ground,dropship",
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Import 1 reviewed rows" }),
    );
    await waitFor(() => expect(mocks.saveOffer).toHaveBeenCalledTimes(1));
    expect(mocks.saveOffer.mock.calls[0][0]).toMatchObject({
      status: "estimated",
      availability: "limited",
      leadTimeDays: 3,
      returnTerms: "Unopened only",
      clinicalSuitability: "Prescribed model",
      deliveryScope: offer.deliveryScope,
    });
  });
  it("distinguishes unknown lead time from zero and rejects fractional lead days", async () => {
    mount(<PricingOffersPanel canManage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Revise offer" }),
    );
    fill("Supplier lead time (days)", "1.5");
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    expect(mocks.saveOffer).not.toHaveBeenCalled();
    fill("Supplier lead time (days)", "");
    fireEvent.click(
      screen.getByRole("button", { name: "Save supplier offer" }),
    );
    await waitFor(() => expect(mocks.saveOffer).toHaveBeenCalledTimes(1));
    expect(mocks.saveOffer.mock.calls[0][0].leadTimeDays).toBeNull();
  });
});
