import { describe, expect, it, vi } from "vitest";
import type { OrgScopedClient } from "@workspace/resupply-db";
import {
  approveDeliveryReview,
  deliveryPreviewSchema,
  previewDeliveryReview,
} from "./delivery-review";
import type { ResolvedScenario, Scenario } from "../pricing/contracts";
import { pricingDestinationFingerprint } from "../pricing/shipping";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-09-14T12:00:00Z"),
  expiresAt = "2026-09-20T12:00:00Z";
const address = {
  line1: "12 Synthetic St",
  city: "York",
  state: "PA",
  zip: "17401",
};
const revenue = {
  mode: "insurance",
  expectedCollectibleCents: 8000,
  allowedCents: 9000,
  status: "verified",
  source: "Original verified evidence",
  expiresAt,
};
const line = {
  id: id(1),
  sku: "MASK",
  description: "Mask",
  quantity: 2,
  unitAmountCents: 10000,
  offerId: id(2),
  offerVersion: 1,
  fulfillmentMethod: "stock",
};
const body = {
  delivery: { country: "US", service: "Ground" },
  freight: { amountCents: 700, source: "New delivery estimate", expiresAt },
};

it.each([
  "revision_conflict",
  "delivery_snapshot_changed",
  "delivery_review_expired",
  "delivery_review_superseded",
])("preserves the delivery conflict %s returned as PT409", async (message) => {
  const rpc = vi.fn().mockResolvedValue({
    data: null,
    error: { code: "PT409", message },
  });
  const scoped = {
    orgId: id(9),
    raw: () => ({ schema: () => ({ rpc }) }),
  } as unknown as OrgScopedClient;
  await expect(
    approveDeliveryReview(scoped, id(4), id(12), "manager", {
      revision: 1,
      reason: "Updated delivery verified",
      allowException: false,
    }),
  ).rejects.toMatchObject({ code: message, status: 409 });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("approve_csr_delivery_review", {
    p_org_id: id(9),
    p_order_id: id(4),
    p_review_id: id(12),
    p_actor: "manager",
    p_revision: 1,
    p_reason: "Updated delivery verified",
    p_allow_exception: false,
  });
});

function fixture() {
  const scenario = {
    patientId: id(8),
    validUntil: expiresAt,
    lines: [line],
    revenue,
    revenueProfileId: id(14),
    revenueProfileVersion: 1,
    costs: [
      {
        id: "old-freight",
        label: "Old freight",
        category: "freight",
        basis: "order",
        quantity: 1,
        amountCents: 50,
        status: "verified",
        expiresAt,
      },
    ],
  };
  const tables: Record<string, Array<Record<string, unknown>>> = {
    csr_order_requests: [
      {
        id: id(4),
        status: "signed",
        patient_id: id(8),
        pricing_quote_id: id(6),
        items: [line],
      },
    ],
    pricing_quotes: [
      {
        id: id(6),
        org_id: id(9),
        status: "bound",
        patient_id: id(8),
        bound_order_id: id(4),
        revision: 1,
        scenario,
        input: { revenue },
        evaluation: { netRevenueCents: 8000, totalVariableCostCents: 4000 },
        lines: [line],
      },
    ],
    pricing_state: [
      {
        org_id: id(9),
        revision: 1,
        enabled: true,
        current_policy_id: id(3),
        active_price_list_id: null,
      },
    ],
    pricing_policies: [
      {
        id: id(3),
        version: 1,
        data: {
          effectiveFrom: "2026-01-01T00:00:00Z",
          expiresAt,
          rules: {
            targetMarginBps: 4000,
            floorMarginBps: 2000,
            basis: "contribution",
          },
        },
      },
    ],
    patients: [{ id: id(8), address }],
    products: [{ sku: "MASK", active: true, category: "mask" }],
    pricing_offers: [
      {
        id: id(2),
        version: 2,
        data: {
          supplierName: "Supplier",
          supplierSku: "M1",
          sku: "MASK",
          currency: "USD",
          unitCostCents: 2000,
          unitsPerPack: 1,
          minQuantity: 1,
          maxQuantity: null,
          status: "verified",
          availability: "available",
          effectiveFrom: "2026-01-01T00:00:00Z",
          expiresAt,
          source: "New supplier costs",
          components: [],
        },
      },
    ],
    pricing_shipping_quotes: [
      {
        id: id(10),
        expires_at: "2026-09-14T12:10:00Z",
        cost_cents: 900,
        data: {
          patientId: id(8),
          lines: [{ sku: "MASK", quantity: 2 }],
          patientAddressSnapshot: address,
          destinationFingerprint: pricingDestinationFingerprint(address),
        },
      },
    ],
  };
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) =>
    name === "pricing_current_offers"
      ? { data: tables.pricing_offers, error: null }
      : { data: { id: id(12) }, error: null },
  );
  const scoped = {
    orgId: id(9),
    raw: () => ({ schema: () => ({ rpc }) }),
    from(table: string) {
      let rows = tables[table] ?? [];
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          rows = rows.filter((r) => r[key] === value);
          return q;
        },
        in: (key: string, values: unknown[]) => {
          rows = rows.filter((r) => values.includes(r[key]));
          return q;
        },
        order: () => q,
        lte: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return q;
    },
  } as unknown as OrgScopedClient;
  return { scoped, tables, rpc };
}
describe("delivery review recalculates fixed accepted economics", () => {
  it("renews expired verified fees and reserves only with explicit unchanged-cost evidence", async () => {
    const { scoped, tables, rpc } = fixture();
    const scenario = tables.pricing_quotes[0].scenario as Scenario;
    const expired = "2026-09-01T00:00:00Z";
    scenario.costs!.push({
      id: "handling",
      label: "Handling",
      category: "handling",
      basis: "order",
      amountCents: 300,
      quantity: 1,
      status: "verified",
      expiresAt: expired,
    });
    scenario.processing = {
      rateBps: 0,
      fixedCents: 30,
      basis: "net_sales",
      status: "verified",
      expiresAt: expired,
    };
    scenario.adjustments = {
      riskCostCents: 200,
      status: "verified",
      expiresAt: expired,
    };
    await expect(
      previewDeliveryReview(scoped, id(4), "manager", body, now),
    ).rejects.toThrow("stale_dependencies");
    const costVerification = {
      source: "Fee schedule and reserve reviewed; all amounts unchanged",
      expiresAt,
    };
    const result = await previewDeliveryReview(
      scoped,
      id(4),
      "manager",
      { ...body, costVerification },
      now,
    );
    expect(result.evaluation.totalVariableCostCents).toBe(5230);
    expect(result.evaluation.netRevenueCents).toBe(8000);
    const payload = rpc.mock.calls.find(
      (call) => call[0] === "save_csr_delivery_review",
    )?.[1].p_payload as ResolvedScenario & {
      unchangedCostVerification: unknown;
    };
    expect(payload.scenario.processing).toMatchObject({
      rateBps: 0,
      fixedCents: 30,
      status: "verified",
      expiresAt,
    });
    expect(payload.scenario.adjustments).toMatchObject({
      riskCostCents: 200,
      status: "verified",
      expiresAt,
    });
    expect(payload.unchangedCostVerification).toEqual(costVerification);
  });
  it.each(["missing", "estimated"] as const)(
    "does not turn %s costs into verified amounts through unchanged-cost confirmation",
    async (status) => {
      const { scoped, tables, rpc } = fixture();
      (tables.pricing_quotes[0].scenario as Scenario).costs!.push({
        id: "handling",
        label: "Handling",
        category: "handling",
        basis: "order",
        amountCents: status === "missing" ? null : 300,
        quantity: 1,
        status,
      });
      await expect(
        previewDeliveryReview(
          scoped,
          id(4),
          "manager",
          { ...body, costVerification: { source: "New note", expiresAt } },
          now,
        ),
      ).rejects.toThrow("verified_unchanged_costs_required");
      expect(
        rpc.mock.calls.some((call) => call[0] === "save_csr_delivery_review"),
      ).toBe(false);
    },
  );
  it("grandfathers signed amounts above a newer unit ceiling while retaining the current margin floor", async () => {
    const { scoped, tables } = fixture();
    const policy = tables.pricing_policies[0].data as {
      rules: Record<string, unknown>;
    };
    policy.rules.priceCeilingCents = 9000;
    expect(
      (await previewDeliveryReview(scoped, id(4), "manager", body, now))
        .approvalClass,
    ).toBe("firm");
    expect(
      (
        await previewDeliveryReview(
          scoped,
          id(4),
          "manager",
          {
            ...body,
            freight: { ...body.freight, amountCents: 4000 },
          },
          now,
        )
      ).approvalClass,
    ).toBe("blocked");
  });
  it("caps a carrier-backed delivery review at the actual rate expiry", async () => {
    const { scoped } = fixture();
    const result = await previewDeliveryReview(
      scoped,
      id(4),
      "manager",
      {
        delivery: body.delivery,
        shippingQuoteId: id(10),
      },
      now,
    );
    expect(result.expiresAt).toBe("2026-09-14T12:10:00.000Z");
    expect(result.evaluation.totalVariableCostCents).toBe(4900);
  });
  it("requires a fresh review across a scheduled policy rule change", async () => {
    const { scoped, tables } = fixture();
    const policy = tables.pricing_policies[0].data as Record<string, unknown>;
    policy.overrides = [
      {
        scope: "sku",
        value: "MASK",
        priority: 1,
        effectiveFrom: "2026-09-14T12:05:00Z",
        expiresAt,
        rules: {
          targetMarginBps: 5000,
          floorMarginBps: 3000,
          basis: "contribution",
        },
      },
    ];
    expect(
      (await previewDeliveryReview(scoped, id(4), "manager", body, now))
        .expiresAt,
    ).toBe("2026-09-14T12:05:00.000Z");
  });
  it("refreshes supplier costs and replaces old freight while fixing billed and collectible amounts", async () => {
    const { scoped, rpc } = fixture();
    const result = await previewDeliveryReview(
      scoped,
      id(4),
      "manager",
      body,
      now,
    );
    expect(result.evaluation.netRevenueCents).toBe(8000);
    expect(result.evaluation.totalVariableCostCents).toBe(4700);
    expect(result.approvalClass).toBe("firm");
    const saved = rpc.mock.calls.find(
      (call) => call[0] === "save_csr_delivery_review",
    );
    const payload = saved?.[1].p_payload as ResolvedScenario;
    expect(payload.scenario.lines[0]).toMatchObject({
      unitAmountCents: 10000,
      quantity: 2,
      offerVersion: 2,
    });
    expect(payload.input.lines[0].unitPriceCents).toBe(10000);
    expect(payload.scenario.revenue).toMatchObject({
      expectedCollectibleCents: 8000,
    });
    expect(payload.scenario.revenueProfileId).toBeUndefined();
    expect(result.expiresAt).toBe("2026-09-14T12:30:00.000Z");
  });
  it("requires renewed verification of expired fixed revenue, without changing its amount", async () => {
    const { scoped, tables } = fixture();
    tables.pricing_quotes[0].input = {
      revenue: { ...revenue, expiresAt: "2026-09-01T00:00:00Z" },
    };
    await expect(
      previewDeliveryReview(scoped, id(4), "manager", body, now),
    ).rejects.toThrow("stale_dependencies");
    const result = await previewDeliveryReview(
      scoped,
      id(4),
      "manager",
      {
        ...body,
        revenueVerification: {
          source: "Manager reconfirmed same allowed collections",
          expiresAt,
        },
      },
      now,
    );
    expect(result.evaluation.netRevenueCents).toBe(8000);
  });
  it("blocks a new delivery cost below the current floor instead of recommending a new patient amount", async () => {
    const { scoped } = fixture();
    const result = await previewDeliveryReview(
      scoped,
      id(4),
      "manager",
      { ...body, freight: { ...body.freight, amountCents: 4000 } },
      now,
    );
    expect(result.approvalClass).toBe("blocked");
    expect(result.evaluation.netRevenueCents).toBe(8000);
    expect(result.evaluation.meetsFloor).toBe(false);
  });
  it("never treats the previous destination's freight estimate as current", async () => {
    const { scoped } = fixture();
    const result = await previewDeliveryReview(
      scoped,
      id(4),
      "manager",
      { delivery: body.delivery },
      now,
    );
    expect(result.approvalClass).toBe("blocked");
    expect(
      result.evaluation.issues.some((issue) => issue.code === "missing_input"),
    ).toBe(true);
  });
  it("rejects duplicate freight evidence and unrecognized accepted-term overrides", () => {
    expect(
      deliveryPreviewSchema.safeParse({ ...body, shippingQuoteId: id(10) })
        .success,
    ).toBe(false);
    expect(
      deliveryPreviewSchema.safeParse({
        ...body,
        lines: [{ ...line, unitAmountCents: 20000 }],
      }).success,
    ).toBe(false);
  });
  it("cannot preview an order outside the scoped organization", async () => {
    const { scoped, tables, rpc } = fixture();
    tables.csr_order_requests = [];
    await expect(
      previewDeliveryReview(scoped, id(4), "manager", body, now),
    ).rejects.toThrow("signed_priced_order_required");
    expect(rpc).not.toHaveBeenCalled();
  });
});
