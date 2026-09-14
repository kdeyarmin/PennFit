import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  actors: [] as string[],
  counts: new Map<string, number>(),
  mutations: vi.fn(),
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
