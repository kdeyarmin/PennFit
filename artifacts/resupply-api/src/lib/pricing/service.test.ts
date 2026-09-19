import { describe, expect, it, vi } from "vitest";
import type { Json, OrgScopedClient } from "@workspace/resupply-db";
import { preparePortfolioBatch, refreshPortfolioScenario } from "./portfolio";
import { pricingDestinationFingerprint } from "./shipping";
import {
  approvalClass,
  mutatePricing,
  assertPublishedAmounts,
  prepareCsrPricing,
  resolvedPolicyRules,
  resolveScenario,
} from "./service";
import {
  actualSchema,
  offerSchema,
  policyRulesSchema,
  scenarioSchema,
  type Scenario,
} from "./contracts";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-09-14T12:00:00Z");
const expiry = "2026-09-20T12:00:00Z";
const scenario: Scenario = {
  patientId: id(8),
  validUntil: "2026-09-15T12:00:00Z",
  delivery: { country: "US", service: "Ground" },
  lines: [
    {
      id: id(1),
      sku: "MASK",
      description: "Mask",
      quantity: 1,
      unitAmountCents: 10000,
      offerId: id(2),
      offerVersion: 1,
      fulfillmentMethod: "stock",
    },
  ],
  revenue: {
    mode: "insurance",
    expectedCollectibleCents: 10000,
    status: "verified",
    source: "Verified benefit fixture",
    expiresAt: expiry,
  },
};
function fixture() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    pricing_state: [
      {
        org_id: id(9),
        revision: 1,
        enabled: true,
        enforce_quotes: true,
        current_policy_id: id(3),
        active_price_list_id: null,
      },
    ],
    pricing_policies: [
      {
        id: id(3),
        version: 1,
        data: {
          name: "Explicit policy",
          effectiveFrom: "2026-01-01T00:00:00Z",
          expiresAt: expiry,
          rules: {
            targetMarginBps: 4000,
            floorMarginBps: 2000,
            basis: "contribution",
          },
        },
      },
    ],
    patients: [
      {
        id: id(8),
        address: {
          line1: "Synthetic",
          city: "Test",
          state: "PA",
          zip: "19000",
        },
      },
    ],
    products: [{ sku: "MASK", active: true }],
    pricing_offers: [
      {
        id: id(2),
        version: 1,
        is_current: true,
        data: {
          supplierName: "Supplier A",
          supplierSku: "M1",
          sku: "MASK",
          currency: "USD",
          unitCostCents: 4000,
          unitsPerPack: 1,
          minQuantity: 1,
          maxQuantity: null,
          status: "verified",
          availability: "available",
          deliveryScope: {
            country: "US",
            postalPrefixes: ["19"],
            service: "Ground",
            fulfillmentMethods: ["stock", "dropship"],
          },
          effectiveFrom: "2026-01-01T00:00:00Z",
          expiresAt: expiry,
          source: "Invoice fixture",
          components: [
            {
              id: "freight",
              label: "Freight",
              category: "freight",
              basis: "order",
              amountCents: 1000,
              quantity: 1,
              status: "verified",
            },
          ],
        },
      },
    ],
  };
  const rpc = vi.fn(
    async (
      operation: string,
      args: { p_ids?: string[] },
    ): Promise<{
      data: Array<Record<string, unknown>> | null;
      error: { code: string; message: string } | null;
    }> => {
      if (operation === "pricing_current_offers")
        return {
          data: tables.pricing_offers.filter(
            (row) => !args.p_ids || args.p_ids.includes(row.id as string),
          ),
          error: null,
        };
      return { data: null, error: null };
    },
  );
  const scoped = {
    orgId: id(9),
    raw: () => ({ schema: () => ({ rpc }) }),
    from(table: string) {
      let rows = tables[table] ?? [];
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          rows = rows.filter((row) => row[key] === value);
          return query;
        },
        lte: () => query,
        order: () => query,
        limit: () => query,
        in: (key: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[key]));
          return query;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    },
  } as unknown as OrgScopedClient;
  return { scoped, tables, rpc };
}
describe("pricing financial authority", () => {
  it("preserves billed amounts separately from verified insurance collections", async () => {
    const { scoped } = fixture();
    const input = structuredClone(scenario);
    input.lines[0].unitAmountCents = 80000;
    const result = await resolveScenario(scoped, input, {
      mayVerify: true,
      now,
    });
    expect(result.evaluation.netRevenueCents).toBe(10000);
    expect(result.input.lines[0].unitPriceCents).toBe(80000);
    expect(approvalClass(result)).toBe("firm");
  });
  it("round-trips evaluated scenarios while ignoring a client-supplied destination snapshot", async () => {
    const { scoped, tables } = fixture();
    const result = await resolveScenario(scoped, scenario, {
      mayVerify: true,
      now,
    });
    const roundTrip = scenarioSchema.parse({
      ...result.scenario,
      deliveryAddressSnapshot: { zip: "forged" },
    });
    const rechecked = await resolveScenario(scoped, roundTrip, {
      mayVerify: true,
      now,
    });
    expect(rechecked.scenario.deliveryAddressSnapshot).toEqual(
      tables.patients[0].address,
    );
  });
  it("cannot self-certify CSR insurance evidence", async () => {
    const { scoped } = fixture();
    const result = await resolveScenario(scoped, scenario, {
      mayVerify: false,
      now,
    });
    expect(result.input.revenue).toMatchObject({ status: "estimated" });
    expect(approvalClass(result)).toBe("exception");
  });
  it("cannot bypass a hard floor using manager exception approval", async () => {
    const { scoped } = fixture();
    const input = structuredClone(scenario);
    input.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 5500,
      status: "estimated",
    };
    const result = await resolveScenario(scoped, input, {
      mayVerify: false,
      now,
    });
    expect(approvalClass(result)).toBe("blocked");
  });
  it("rejects expired or replaced supplier versions before computing", async () => {
    const { scoped, tables } = fixture();
    tables.pricing_offers[0].version = 2;
    await expect(
      resolveScenario(scoped, scenario, { mayVerify: true, now }),
    ).rejects.toMatchObject({ code: "stale_dependencies" });
  });
  it("requires exact full supplier packs", async () => {
    const { scoped, tables } = fixture();
    (tables.pricing_offers[0].data as Record<string, unknown>).unitsPerPack = 3;
    await expect(
      resolveScenario(scoped, scenario, { mayVerify: true, now }),
    ).rejects.toMatchObject({ code: "pack_quantity_mismatch" });
  });
  it("blocks missing freight while allowing explicit known zero", async () => {
    const { scoped, tables } = fixture();
    const offer = tables.pricing_offers[0].data as {
      components: Array<Record<string, unknown>>;
    };
    offer.components = [];
    const missing = await resolveScenario(scoped, scenario, {
      mayVerify: true,
      now,
    });
    expect(approvalClass(missing)).toBe("blocked");
    const input = structuredClone(scenario);
    input.costs = [
      {
        id: "freight",
        label: "Included delivery",
        category: "freight",
        basis: "order",
        amountCents: 0,
        quantity: 1,
        status: "verified",
      },
    ];
    const knownZero = await resolveScenario(scoped, input, {
      mayVerify: true,
      now,
    });
    expect(approvalClass(knownZero)).toBe("firm");
  });
  it("deduplicates one supplier order fee across two canonical lines", async () => {
    const { scoped, tables } = fixture();
    const second = structuredClone(tables.pricing_offers[0]);
    second.id = id(4);
    (second.data as Record<string, unknown>).sku = "TUBE";
    (second.data as Record<string, unknown>).expiresAt = "2026-09-21T12:00:00Z";
    tables.pricing_offers.push(second);
    tables.products.push({ sku: "TUBE", active: true });
    const input = structuredClone(scenario);
    input.lines.push({
      ...input.lines[0],
      id: id(5),
      offerId: id(4),
      sku: "TUBE",
    });
    const result = await resolveScenario(scoped, input, {
      mayVerify: true,
      now,
    });
    expect(result.evaluation.additionalFulfillmentCostCents).toBe(1000);
    expect(result.input.costs).toHaveLength(1);
  });
  it("does not use one supplier freight charge to cover another supplier", async () => {
    const { scoped, tables } = fixture();
    const second = structuredClone(tables.pricing_offers[0]);
    second.id = id(4);
    Object.assign(second.data as object, {
      sku: "TUBE",
      supplierName: "Supplier B",
      components: [],
    });
    tables.pricing_offers.push(second);
    tables.products.push({ sku: "TUBE", active: true });
    const input = structuredClone(scenario);
    input.lines.push({
      ...input.lines[0],
      id: id(5),
      offerId: id(4),
      sku: "TUBE",
    });
    expect(
      approvalClass(
        await resolveScenario(scoped, input, { mayVerify: true, now }),
      ),
    ).toBe("blocked");
  });
  it("uses shared freight coverage when another SKU from that supplier omits it", async () => {
    const { scoped, tables } = fixture();
    const second = structuredClone(tables.pricing_offers[0]);
    second.id = id(4);
    Object.assign(second.data as object, { sku: "TUBE", components: [] });
    tables.pricing_offers.push(second);
    tables.products.push({ sku: "TUBE", active: true });
    const input = structuredClone(scenario);
    input.lines.push({
      ...input.lines[0],
      id: id(5),
      offerId: id(4),
      sku: "TUBE",
    });
    input.revenue = {
      ...scenario.revenue,
      expectedCollectibleCents: 20000,
    } as Scenario["revenue"];
    const result = await resolveScenario(scoped, input, {
      mayVerify: true,
      now,
    });
    expect(approvalClass(result)).toBe("firm");
    expect(result.evaluation.additionalFulfillmentCostCents).toBe(1000);
  });
  it.each(["unit", "included_goods"])(
    "does not let %s freight on one item cover a sibling item",
    async (basis) => {
      const { scoped, tables } = fixture();
      const first = tables.pricing_offers[0].data as {
        components: Array<Record<string, unknown>>;
      };
      if (basis === "unit") first.components[0].basis = "unit";
      else first.components[0].includedInId = "goods";
      const second = structuredClone(tables.pricing_offers[0]);
      second.id = id(4);
      Object.assign(second.data as object, { sku: "TUBE", components: [] });
      tables.pricing_offers.push(second);
      tables.products.push({ sku: "TUBE", active: true });
      const input = structuredClone(scenario);
      input.lines.push({
        ...input.lines[0],
        id: id(5),
        offerId: id(4),
        sku: "TUBE",
      });
      input.revenue = {
        ...scenario.revenue,
        expectedCollectibleCents: 20000,
      } as Scenario["revenue"];
      const result = await resolveScenario(scoped, input, {
        mayVerify: true,
        now,
      });
      expect(approvalClass(result)).toBe("blocked");
      expect(
        result.input.costs?.some((cost) =>
          cost.id.startsWith("missing-freight:"),
        ),
      ).toBe(true);
    },
  );
  it("does not use an unscoped manual unit fee as whole-order freight coverage", async () => {
    const { scoped, tables } = fixture();
    (tables.pricing_offers[0].data as { components: unknown[] }).components =
      [];
    const input = structuredClone(scenario);
    input.costs = [
      {
        id: "unit-freight",
        label: "Single-unit fee",
        category: "freight",
        basis: "unit",
        amountCents: 0,
        quantity: 1,
        status: "verified",
      },
    ];
    expect(
      approvalClass(
        await resolveScenario(scoped, input, { mayVerify: true, now }),
      ),
    ).toBe("blocked");
  });
  it.each(["Express", undefined])(
    "rejects carrier rates without a matching service (%s)",
    async (service) => {
      const { scoped, tables } = fixture();
      (tables.pricing_offers[0].data as { components: unknown[] }).components =
        [];
      tables.pricing_shipping_quotes = [
        {
          id: id(41),
          cost_cents: 100,
          expires_at: expiry,
          data: {
            patientId: id(8),
            lines: [{ sku: "MASK", quantity: 1 }],
            patientAddressSnapshot: tables.patients[0].address,
            destinationFingerprint: pricingDestinationFingerprint(
              tables.patients[0].address as Json,
            ),
            service,
          },
        },
      ];
      await expect(
        resolveScenario(
          scoped,
          { ...scenario, shippingQuoteId: id(41) },
          { mayVerify: true, now },
        ),
      ).rejects.toMatchObject({ code: "shipping_quote_mismatch" });
    },
  );
  it("accepts the exact quoted carrier service", async () => {
    const { scoped, tables } = fixture();
    (tables.pricing_offers[0].data as { components: unknown[] }).components =
      [];
    tables.pricing_shipping_quotes = [
      {
        id: id(41),
        cost_cents: 100,
        expires_at: expiry,
        data: {
          patientId: id(8),
          lines: [{ sku: "MASK", quantity: 1 }],
          patientAddressSnapshot: tables.patients[0].address,
          destinationFingerprint: pricingDestinationFingerprint(
            tables.patients[0].address as Json,
          ),
          service: "Ground",
        },
      },
    ];
    const result = await resolveScenario(
      scoped,
      { ...scenario, shippingQuoteId: id(41) },
      { mayVerify: true, now },
    );
    expect(approvalClass(result)).toBe("firm");
    expect(result.evaluation.additionalFulfillmentCostCents).toBe(100);
  });
  it("lets CSRs reuse verified insurance evidence only for the exact patient and items", async () => {
    const { scoped, tables } = fixture();
    tables.pricing_revenue_profiles = [
      {
        id: id(40),
        version: 1,
        data: {
          patientId: id(8),
          lines: [{ sku: "MASK", quantity: 1 }],
          expectedCollectibleCents: 10000,
          allowedCents: 11000,
          source: "Verified fixture",
          expiresAt: expiry,
        },
      },
    ];
    const input = {
      ...scenario,
      revenueProfileId: id(40),
      revenueProfileVersion: 1,
    };
    expect(
      approvalClass(
        await resolveScenario(scoped, input, { mayVerify: false, now }),
      ),
    ).toBe("firm");
    (
      tables.pricing_revenue_profiles[0].data as Record<string, unknown>
    ).patientId = id(88);
    await expect(
      resolveScenario(scoped, input, { mayVerify: false, now }),
    ).rejects.toMatchObject({ code: "revenue_profile_mismatch" });
  });
  it("resolves explicit policy precedence without default business targets", () => {
    const { tables } = fixture();
    const base = tables.pricing_policies[0].data as unknown as Parameters<
      typeof resolvedPolicyRules
    >[0];
    const rules = { ...base.rules, targetMarginBps: 4500 };
    const policy = {
      ...base,
      overrides: [
        {
          scope: "revenue_mode" as const,
          value: "insurance",
          priority: 999,
          effectiveFrom: base.effectiveFrom,
          expiresAt: expiry,
          rules: { ...rules, targetMarginBps: 3000 },
        },
        {
          scope: "sku" as const,
          value: "MASK",
          priority: 0,
          effectiveFrom: base.effectiveFrom,
          expiresAt: expiry,
          rules,
        },
      ],
    };
    expect(
      resolvedPolicyRules(policy, scenario, new Map(), now).targetMarginBps,
    ).toBe(4500);
  });
  it("blocks a quote that exceeds its selected SKU ceiling even when its margin passes", async () => {
    const { scoped, tables } = fixture();
    const policy = tables.pricing_policies[0].data as {
      rules: Record<string, unknown>;
    };
    policy.rules.priceCeilingCents = 9000;
    const result = await resolveScenario(scoped, scenario, {
      mayVerify: true,
      now,
    });
    expect(result.evaluation.meetsTarget).toBe(true);
    expect(result.evaluation.issues).toContainEqual(
      expect.objectContaining({ code: "price_ceiling_exceeded" }),
    );
    expect(approvalClass(result)).toBe("blocked");
  });
  it("preserves accepted delivery-review amounts without bypassing hard financial limits", async () => {
    const { scoped, tables } = fixture();
    const policy = tables.pricing_policies[0].data as {
      rules: Record<string, unknown>;
    };
    policy.rules.priceCeilingCents = 9000;
    const options = { mayVerify: true, now, preserveAcceptedUnitAmounts: true };
    expect(
      approvalClass(await resolveScenario(scoped, scenario, options)),
    ).toBe("firm");
    policy.rules.minimumContributionCents = 6000;
    const blocked = await resolveScenario(scoped, scenario, options);
    expect(blocked.evaluation.meetsMinimumContribution).toBe(false);
    expect(approvalClass(blocked)).toBe("blocked");
  });
  it("enforces published amounts when a future quote selects matching catalog items", () => {
    const batch = { entries: [{ scenario }] } as unknown as Parameters<
      typeof assertPublishedAmounts
    >[1];
    expect(() => assertPublishedAmounts(scenario, batch)).not.toThrow();
    const changed = structuredClone(scenario);
    changed.lines[0].unitAmountCents -= 1;
    expect(() => assertPublishedAmounts(changed, batch)).toThrow(
      "active_price_mismatch",
    );
    changed.lines[0].quantity = 2;
    expect(() => assertPublishedAmounts(changed, batch)).toThrow(
      "published_price_context_required",
    );
  });
  it("blocks inactive or unresolved canonical SKUs", async () => {
    const { scoped, tables } = fixture();
    tables.products[0].active = false;
    await expect(
      resolveScenario(scoped, scenario, { mayVerify: true, now }),
    ).rejects.toMatchObject({ code: "unresolved_sku" });
  });
  it("resolves verified freight for the postalCode address shape written by PacWare imports", async () => {
    const { scoped, tables } = fixture();
    const address = tables.patients[0].address as Record<string, unknown>;
    address.postalCode = address.zip;
    delete address.zip;
    const resolved = await resolveScenario(scoped, scenario, {
      mayVerify: true,
      now,
    });
    expect(resolved.input.lines[0].costStatus).toBe("verified");
    expect(approvalClass(resolved)).toBe("firm");
    expect(resolved.scenario.deliveryAddressSnapshot).toEqual(address);
  });
  it("does not treat supplier freight as valid for any destination", async () => {
    const { scoped, tables } = fixture();
    (tables.patients[0].address as Record<string, unknown>).zip = "99501";
    await expect(
      resolveScenario(scoped, scenario, { mayVerify: true, now }),
    ).rejects.toMatchObject({ code: "offer_outside_delivery_scope" });
  });
  it("keeps missing scope or supplier availability explicit estimates", async () => {
    const { scoped, tables } = fixture();
    delete (tables.pricing_offers[0].data as Record<string, unknown>)
      .deliveryScope;
    expect(
      approvalClass(
        await resolveScenario(scoped, scenario, { mayVerify: true, now }),
      ),
    ).toBe("exception");
  });
  it("caps quote expiry to every source including verified insurance", async () => {
    const { scoped } = fixture();
    const input = structuredClone(scenario);
    input.revenue = {
      ...scenario.revenue,
      expiresAt: "2026-09-14T18:00:00Z",
    } as Scenario["revenue"];
    await expect(
      resolveScenario(scoped, input, { mayVerify: true, now }),
    ).rejects.toMatchObject({ code: "quote_exceeds_source_expiry" });
  });
  it("permits exact bound replay without changing the accepted quote on later cost updates", async () => {
    const { scoped, tables, rpc } = fixture();
    tables.pricing_quotes = [
      {
        id: id(7),
        revision: 2,
        status: "bound",
        patient_id: id(8),
        input: { revenue: scenario.revenue },
        lines: scenario.lines,
      },
    ];
    const result = await prepareCsrPricing(scoped, {
      quoteId: id(7),
      quoteRevision: 2,
      patientId: id(8),
      items: scenario.lines,
    });
    expect(result.status).toBe("bound");
    expect(rpc).not.toHaveBeenCalled();
    await expect(
      prepareCsrPricing(scoped, {
        quoteId: id(7),
        quoteRevision: 2,
        patientId: id(8),
        items: [{ ...scenario.lines[0], quantity: 2 }],
      }),
    ).rejects.toMatchObject({ code: "quote_lines_mismatch" });
  });
  it("handles the one-row composite result returned by the Data API during order preparation", async () => {
    const { scoped, tables, rpc } = fixture();
    const row = {
      id: id(7),
      revision: 2,
      status: "approved",
      patient_id: id(8),
      input: { revenue: scenario.revenue },
      lines: scenario.lines,
    };
    tables.pricing_quotes = [row];
    rpc.mockResolvedValueOnce({ data: [row], error: null });
    expect(
      await prepareCsrPricing(scoped, {
        quoteId: id(7),
        quoteRevision: 2,
        patientId: id(8),
        items: scenario.lines,
      }),
    ).toMatchObject({ id: id(7), status: "approved" });
  });
});
describe("pricing request validation", () => {
  it.each([
    "price_list_contexts_changed",
    "revision_conflict",
    "stale_dependencies",
    "schedule_exists",
  ])(
    "maps deterministic %s to409 without serialization retry semantics",
    async (message) => {
      const { scoped, rpc } = fixture();
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: "PT409", message },
      });
      await expect(
        mutatePricing(scoped, "fixture", "activate", {}),
      ).rejects.toMatchObject({
        code: message,
        status: 409,
      });
    },
  );
  it("does not invent a margin policy or accept fractional cents", () => {
    expect(policyRulesSchema.safeParse({}).success).toBe(false);
    expect(
      scenarioSchema.safeParse({
        ...scenario,
        lines: [{ ...scenario.lines[0], unitAmountCents: 1.01 }],
      }).success,
    ).toBe(false);
  });
  it("requires optimistic offer revisions and verified known costs", () => {
    const { tables } = fixture();
    const offer = tables.pricing_offers[0].data as object;
    expect(offerSchema.safeParse({ ...offer, id: id(2) }).success).toBe(false);
    expect(
      offerSchema.safeParse({ ...offer, unitCostCents: null }).success,
    ).toBe(false);
  });
  it("rejects collectible amounts above allowed and mismatched actual provenance", () => {
    expect(
      scenarioSchema.safeParse({
        ...scenario,
        revenue: {
          mode: "insurance",
          expectedCollectibleCents: 10000,
          allowedCents: 9000,
          status: "verified",
        },
      }).success,
    ).toBe(false);
    expect(
      actualSchema.safeParse({
        source: "supplier_invoice",
        sourceRef: "1",
        economicEventId: "1",
        kind: "revenue",
        amountCents: 5000,
        occurredAt: now.toISOString(),
      }).success,
    ).toBe(false);
  });
});
describe("explicit portfolio refresh", () => {
  const catalogScenario = (): Scenario => ({
    ...structuredClone(scenario),
    patientId: undefined,
    delivery: { country: "US", postalCode: "19000", service: "Ground" },
    validUntil: "2026-01-01T00:00:00Z",
  });
  it("refreshes the same supplier to its current version and respects the new expiry", async () => {
    const { scoped, tables } = fixture();
    tables.pricing_offers[0].version = 2;
    const offer = tables.pricing_offers[0].data as Record<string, unknown>;
    offer.unitCostCents = 4500;
    offer.expiresAt = "2026-09-14T12:05:00Z";
    const result = await refreshPortfolioScenario(
      scoped,
      catalogScenario(),
      now,
    );
    expect(result.scenario.lines[0]).toMatchObject({
      offerId: id(2),
      offerVersion: 2,
      unitAmountCents: 10000,
    });
    expect(result.input.lines[0].unitCostCents).toBe(4500);
    expect(result.scenario.validUntil).toBe("2026-09-14T12:05:00.000Z");
    expect(result.scenario.revenue).toEqual(scenario.revenue);
  });
  it("never renews expired manual evidence", async () => {
    const { scoped } = fixture();
    const submitted = catalogScenario();
    submitted.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 10000,
      status: "verified",
      source: "Old benefit",
      expiresAt: "2026-09-14T11:59:00Z",
    };
    await expect(
      refreshPortfolioScenario(scoped, submitted, now),
    ).rejects.toMatchObject({ code: "stale_dependencies" });
  });
  it("rejects missing current offers and patient-linked reviews", async () => {
    const { scoped, tables } = fixture();
    tables.pricing_offers = [];
    await expect(
      refreshPortfolioScenario(scoped, catalogScenario(), now),
    ).rejects.toMatchObject({ code: "stale_dependencies" });
    await expect(
      refreshPortfolioScenario(scoped, scenario, now),
    ).rejects.toMatchObject({ code: "catalog_batch_cannot_link_patient" });
  });
  it("preserves unselected bundle prices while refreshing their costs and retaining paused-list coverage", async () => {
    const { scoped, tables } = fixture();
    const old = { ...catalogScenario(), validUntil: "2026-09-15T12:00:00Z" };
    const bundle = structuredClone(old);
    bundle.lines[0].unitAmountCents = 9000;
    bundle.lines.push({
      ...bundle.lines[0],
      id: id(10),
      sku: "TUBE",
      offerId: id(11),
      unitAmountCents: 5000,
    });
    bundle.revenue = {
      ...scenario.revenue,
      expectedCollectibleCents: 20000,
    } as Scenario["revenue"];
    tables.products.push({ sku: "TUBE", active: true });
    tables.pricing_offers.push({
      ...tables.pricing_offers[0],
      id: id(11),
      data: {
        ...(tables.pricing_offers[0].data as object),
        sku: "TUBE",
        unitCostCents: 1000,
      },
    });
    tables.pricing_state[0].active_price_list_id = id(12);
    tables.pricing_state[0].enabled = false;
    tables.pricing_price_lists = [
      { id: id(12), entries: [{ scenario: old }, { scenario: bundle }] },
    ];
    const selected = structuredClone(old);
    selected.lines[0].unitAmountCents = 11000;
    const result = await preparePortfolioBatch(scoped, [selected], true, now);
    expect(result.expectedActivePriceListId).toBe(id(12));
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.changeKind)).toEqual([
      "selected",
      "retained",
    ]);
    expect(
      result.entries[1].scenario.lines.map((line) => line.unitAmountCents),
    ).toEqual([9000, 5000]);
    expect(
      result.entries[1].input.lines.map((line) => line.unitCostCents),
    ).toEqual([4000, 1000]);
    expect(result.entries[1].approvalClass).toBe("firm");
  });
  it("reports exact retained contexts that need renewed evidence instead of dropping them", async () => {
    const { scoped, tables } = fixture();
    const selected = {
      ...catalogScenario(),
      validUntil: "2026-09-15T12:00:00Z",
    };
    const retained = structuredClone(selected);
    retained.lines[0].quantity = 2;
    retained.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 20000,
      status: "verified",
      source: "Old evidence",
      expiresAt: "2020-01-01T00:00:00Z",
    };
    tables.pricing_state[0].active_price_list_id = id(12);
    tables.pricing_price_lists = [
      { id: id(12), entries: [{ scenario: selected }, { scenario: retained }] },
    ];
    await expect(
      preparePortfolioBatch(scoped, [selected], true, now),
    ).rejects.toMatchObject({
      code: "retained_context_requires_review",
      issues: [{ path: "insurance:MASK:2", message: "stale_dependencies" }],
    });
  });
});
