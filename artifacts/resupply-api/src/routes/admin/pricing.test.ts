import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluatePricing, type PricingInput } from "@workspace/resupply-domain";
const state = vi.hoisted(() => ({
  actors: [] as string[],
  counts: new Map<string, number>(),
  mutations: vi.fn(),
  activePrices: vi.fn(),
  resolved: vi.fn(),
  portfolio: vi.fn(),
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    (options: { max: number }) =>
    (req: Request, res: Response, next: NextFunction) => {
      const key = req.adminUserId ?? "no-actor";
      state.actors.push(key);
      const count = (state.counts.get(key) ?? 0) + 1;
      state.counts.set(key, count);
      if (count > options.max)
        return res.status(429).json({ error: "rate_limited" });
      return next();
    },
}));
vi.mock("../../middlewares/requireAdmin", () => ({
  requirePermission:
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      const actor = req.header("x-fixture-actor");
      if (!actor)
        return res.status(401).json({ error: "authentication_required" });
      req.adminUserId = actor;
      req.orgId = "00000000-0000-4000-8000-000000000001";
      req.adminGranularRole =
        req.header("x-fixture-role") === "csr" ? "csr" : "supervisor";
      if (req.adminGranularRole === "csr" && permission !== "pricing.evaluate")
        return res.status(403).json({ error: "permission_denied" });
      return next();
    },
}));
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (orgId: string) => ({
    orgId,
    raw: () => ({ schema: () => ({ rpc: state.portfolio }) }),
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { sku: "MASK" }, error: null }),
      };
      return query;
    },
  }),
}));
vi.mock("../../lib/pricing/service", async (original) => ({
  ...(await original<typeof import("../../lib/pricing/service")>()),
  mutatePricing: state.mutations,
  getActivePrices: state.activePrices,
  resolveScenario: state.resolved,
}));
import router from "./pricing";
const app = express();
app.use(express.json());
app.use(router);
const offer = {
  supplierName: "Fixture supplier",
  supplierSku: "M1",
  sku: "MASK",
  currency: "USD",
  unitCostCents: 4000,
  unitsPerPack: 1,
  minQuantity: 1,
  maxQuantity: null,
  status: "estimated",
  effectiveFrom: "2026-01-01T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  source: "Synthetic cost sheet",
  components: [],
};
beforeEach(() => {
  state.actors.length = 0;
  state.counts.clear();
  state.mutations.mockReset();
  state.activePrices.mockReset().mockResolvedValue(null);
  state.resolved.mockReset();
  state.portfolio.mockReset();
  state.mutations.mockImplementation(
    async (_scoped, actor, _operation, payload) => ({
      id: "00000000-0000-4000-8000-000000000002",
      version: 1,
      created_by: actor,
      created_at: "2026-09-14T00:00:00Z",
      data: payload,
    }),
  );
});
describe("pricing HTTP boundary", () => {
  it("saves server-calculated comparable margins and prior price provenance in batch previews", async () => {
    const scenario = {
      validUntil: "2099-01-01T00:00:00Z",
      revenue: { mode: "self_pay", shippingChargedCents: 0 },
      lines: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          sku: "MASK",
          description: "Mask",
          quantity: 1,
          unitAmountCents: 10000,
          fulfillmentMethod: "stock",
          offerId: "00000000-0000-4000-8000-000000000002",
          offerVersion: 2,
        },
      ],
    };
    const input: PricingInput = {
      currency: "USD",
      evaluatedAt: "2026-09-14T12:00:00Z",
      lines: [
        {
          id: scenario.lines[0].id,
          sku: "MASK",
          quantity: 1,
          unitPriceCents: 10000,
          unitCostCents: 3000,
          costStatus: "verified",
        },
      ],
      costs: [],
      revenue: { mode: "self_pay", shippingChargedCents: 0 },
      policy: {
        targetMarginBps: 4000,
        floorMarginBps: 2000,
        basis: "contribution",
      },
    };
    state.resolved.mockResolvedValue({
      scenario,
      input,
      evaluation: evaluatePricing(input),
      dependencies: [],
      policyId: "policy",
      policyVersion: 2,
    });
    state.activePrices.mockResolvedValue({
      id: "old-list",
      entries: [
        {
          scenario: {
            ...scenario,
            lines: [{ ...scenario.lines[0], unitAmountCents: 8000 }],
          },
          evaluation: { contributionCents: 999999 },
        },
      ],
    });
    state.mutations.mockImplementationOnce(
      async (_scoped, _actor, _operation, payload) => ({
        id: "batch",
        entries: payload.entries,
        name: payload.name,
        created_at: "2026-09-14T12:00:00Z",
      }),
    );
    const response = await request(app)
      .post("/admin/pricing/batches/preview")
      .set("x-fixture-actor", "manager")
      .send({ name: "Reviewed portfolio", scenarios: [scenario] });
    expect(response.status).toBe(201);
    expect(response.body.entries[0]).toMatchObject({
      evaluation: { contributionCents: 7000 },
      comparison: {
        status: "comparable",
        previousPriceListId: "old-list",
        previousEntryIndexes: [0],
        previousUnitAmounts: [
          { sku: "MASK", quantity: 1, unitAmountCents: 8000 },
        ],
        previousEvaluation: { contributionCents: 5000 },
      },
    });
    expect(state.mutations.mock.calls[0][3].entries[0].comparison).toEqual(
      response.body.entries[0].comparison,
    );
  });
  it("passes validated tenant filters to the portfolio and reports a next page", async () => {
    state.portfolio.mockResolvedValue({
      data: ["A", "B"].map((sku) => ({
        sku,
        name: sku,
        category: "mask",
        offers: [],
        has_more_offers: false,
      })),
      error: null,
    });
    const response = await request(app)
      .get(
        "/admin/pricing/portfolio?q=mask&category=mask&supplier=sample&offset=50&limit=1",
      )
      .set("x-fixture-actor", "manager");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          sku: "A",
          name: "A",
          category: "mask",
          offers: [],
          hasMoreOffers: false,
          activeEntries: [],
        },
      ],
      hasMore: true,
    });
    expect(state.portfolio).toHaveBeenCalledWith("pricing_portfolio", {
      p_org_id: "00000000-0000-4000-8000-000000000001",
      p_q: "mask",
      p_category: "mask",
      p_supplier: "sample",
      p_offset: 50,
      p_limit: 2,
      p_active_offer_ids: [],
    });
  });
  it("filters published contexts by their actual supplier and preserves matches outside the offer payload cap", async () => {
    const offerA = "00000000-0000-4000-8000-000000000101";
    const offerB = "00000000-0000-4000-8000-000000000102";
    const context = (offerId: string) => ({
      scenario: { lines: [{ sku: "MASK", quantity: 1, offerId }] },
    });
    state.activePrices.mockResolvedValue({
      id: "published",
      entries: [context(offerA), context(offerB)],
    });
    state.portfolio.mockResolvedValue({
      data: [
        {
          sku: "MASK",
          name: "Mask",
          category: "mask",
          offers: [],
          has_more_offers: true,
          matching_offer_ids: [offerA],
          active_suppliers: [
            { sku: "MASK", offerId: offerA, supplierName: "Supplier A" },
            { sku: "MASK", offerId: offerB, supplierName: "Supplier B" },
          ],
        },
      ],
      error: null,
    });
    const response = await request(app)
      .get("/admin/pricing/portfolio?supplier=Supplier%20A")
      .set("x-fixture-actor", "manager");
    expect(response.status).toBe(200);
    expect(response.body.items[0].activeEntries).toEqual([
      {
        batchId: "published",
        entryIndex: 0,
        entry: context(offerA),
        suppliers: [
          { sku: "MASK", offerId: offerA, supplierName: "Supplier A" },
        ],
      },
    ]);
    expect(state.portfolio.mock.calls[0][1].p_active_offer_ids).toEqual([
      offerA,
      offerB,
    ]);
  });
  it.each([
    ["get", "/admin/pricing/state"],
    ["get", "/admin/pricing/summary"],
    ["get", "/admin/pricing/portfolio"],
    ["post", "/admin/pricing/portfolio/refresh"],
    ["post", "/admin/pricing/evaluate"],
    ["post", "/admin/pricing/offers"],
    [
      "post",
      "/admin/pricing/quotes/00000000-0000-4000-8000-000000000002/approve",
    ],
    [
      "post",
      "/admin/pricing/policies/00000000-0000-4000-8000-000000000002/publish",
    ],
  ] as const)(
    "authenticates %s %s before consuming the actor rate limit",
    async (method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
      expect(state.actors).toHaveLength(0);
      expect(state.mutations).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["get", "/admin/pricing/summary"],
    ["get", "/admin/pricing/portfolio"],
    ["post", "/admin/pricing/portfolio/refresh"],
    ["post", "/admin/pricing/offers"],
    [
      "post",
      "/admin/pricing/quotes/00000000-0000-4000-8000-000000000002/approve",
    ],
    [
      "post",
      "/admin/pricing/policies/00000000-0000-4000-8000-000000000002/publish",
    ],
  ] as const)("keeps management authority on %s %s", async (method, path) => {
    const pending = request(app)[method](path);
    const response = await pending
      .set("x-fixture-actor", "csr-a")
      .set("x-fixture-role", "csr");
    expect(response.status).toBe(403);
    expect(state.actors).toHaveLength(0);
    expect(state.mutations).not.toHaveBeenCalled();
  });
  it("supports a reviewed 100-row import and applies rate limits after actor resolution", async () => {
    for (let index = 0; index < 100; index++)
      expect(
        (
          await request(app)
            .post("/admin/pricing/offers")
            .set("x-fixture-actor", "reviewer-a")
            .send(offer)
        ).status,
      ).toBe(201);
    expect(
      (
        await request(app)
          .post("/admin/pricing/offers")
          .set("x-fixture-actor", "reviewer-b")
          .send(offer)
      ).status,
    ).toBe(201);
    expect(state.counts.get("reviewer-a")).toBe(100);
    expect(state.counts.get("reviewer-b")).toBe(1);
    expect(state.actors).not.toContain("no-actor");
  });
  it("persists provisional supplier evidence and derives exact costs without quote authority", async () => {
    const comparison = {
      currency: "USD",
      quantity: 3,
      destination: "19000",
      service: "Ground",
      suppliers: [
        {
          id: "candidate",
          supplierName: "Candidate",
          source: "Quote",
          expiresAt: "2099-01-01T00:00:00Z",
          packCostCents: 501,
          unitsPerPack: 2,
          minimumPacks: 1,
          availability: "available",
          leadTimeDays: 3,
          terms: "Synthetic",
          fees: [
            "inbound",
            "dropship",
            "freight",
            "handling",
            "packaging",
            "other",
          ].map((category) => ({
            id: category,
            label: category,
            category,
            amountCents: 0,
            basis: "order",
            count: 1,
          })),
        },
      ],
    };
    const body = {
      name: "Candidate mask",
      manufacturer: "Example",
      model: "Candidate",
      size: "M",
      packDescription: "Two",
      source: "Quote",
      notes: "Synthetic",
      comparison,
    };
    const response = await request(app)
      .post("/admin/pricing/proposals")
      .set("x-fixture-actor", "csr")
      .set("x-fixture-role", "csr")
      .send(body);
    expect(response.status).toBe(201);
    expect(response.body.comparison).toEqual(comparison);
    expect(response.body.comparisonResult.suppliers[0]).toMatchObject({
      status: "estimated",
      packsToBuy: 2,
      surplusUnits: 1,
      goodsCostCents: 1002,
      deliveredCostCents: 1002,
    });
    expect(state.mutations.mock.calls[0][3]).toEqual(body);
    expect(response.body.comparisonResult).not.toHaveProperty("evaluation");
    state.mutations.mockClear();
    const forged = await request(app)
      .post("/admin/pricing/proposals")
      .set("x-fixture-actor", "csr")
      .send({ ...body, comparisonResult: { deliveredCostCents: 0 } });
    expect(forged.status).toBe(400);
    const duplicated = await request(app)
      .post("/admin/pricing/proposals")
      .set("x-fixture-actor", "csr")
      .send({
        ...body,
        comparison: {
          ...comparison,
          suppliers: [comparison.suppliers[0], comparison.suppliers[0]],
        },
      });
    expect(duplicated.status).toBe(422);
    expect(state.mutations).not.toHaveBeenCalled();
  });
  it("rejects unsigned, unauthorized and malformed cost writes before persistence", async () => {
    expect(
      (await request(app).post("/admin/pricing/offers").send(offer)).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/admin/pricing/offers")
          .set("x-fixture-actor", "csr-a")
          .set("x-fixture-role", "csr")
          .send(offer)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/admin/pricing/offers")
          .set("x-fixture-actor", "reviewer-a")
          .send({ ...offer, unitCostCents: 4.01 })
      ).status,
    ).toBe(400);
    expect(state.mutations).not.toHaveBeenCalled();
  });
});
