// /admin/shop/backorders + /admin/shop/sku-substitutes.
//
// This file was committed EMPTY (9c4e30457) and has been failing the run
// as "no test suite found" ever since — a red signal everybody learned to
// ignore, on routes that mutate operational data.
//
// The two surfaces deliberately gate DIFFERENTLY, and that difference is
// the thing most likely to be "simplified" by someone tidying up:
//
//   * backorder marks are CSR day-to-day work (`returns.manage`);
//   * substitution rules encode a clinical preference order and are
//     admin-only (`requireAdminOnly`), because a CSR quietly re-ordering
//     which mask substitutes for which is a clinical decision wearing an
//     inventory costume.
//
// Also pinned: every handler fails CLOSED on missing tenant context (an
// unscoped write here would edit another practice's catalog), a unique-
// violation becomes a 409 rather than a 500, and clearing an already-
// cleared row is refused rather than silently re-stamped.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const ROW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const { mockAdmin, state } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  state: {
    rows: {} as Record<string, Array<Record<string, unknown>>>,
    writes: [] as Array<{ table: string; op: string; payload: unknown }>,
    /** Simulate the unique index rejecting a duplicate. */
    uniqueViolation: false,
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ): void => next();
  return {
    adminReadRateLimiter: passthrough,
    adminWriteRateLimiter: passthrough,
    adminRateLimit: () => passthrough,
  };
});

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: async () => undefined,
}));

vi.mock("@workspace/resupply-db", () => {
  function builder(table: string) {
    let rows = [...(state.rows[table] ?? [])];
    const settle = () => ({ data: rows, error: null });
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (c: string, v: unknown) => {
        rows = rows.filter((r) => r[c] === v);
        return self;
      },
      is: () => self,
      order: () => self,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return self;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      insert: (payload: unknown) => {
        state.writes.push({ table, op: "insert", payload });
        return {
          select: () => ({
            single: async () =>
              state.uniqueViolation
                ? { data: null, error: { code: "23505", message: "dup" } }
                : { data: { id: ROW_ID }, error: null },
          }),
        };
      },
      update: (payload: unknown) => {
        state.writes.push({ table, op: "update", payload });
        return {
          eq: () => Promise.resolve({ error: null }),
        };
      },
      delete: () => {
        state.writes.push({ table, op: "delete", payload: null });
        return { eq: () => Promise.resolve({ error: null }) };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(settle()),
    };
    return self;
  }
  return { getOrgScopedClient: () => ({ from: builder }) };
});

let app: Express;

function signIn(role: "admin" | "agent", orgId: string | null = MOCK_ORG_ID) {
  mockAdmin.current = {
    userId: "u-1",
    email: "staff@example.com",
    role,
    ...(role === "agent" ? { granularRole: "csr" as const } : {}),
    orgId,
  };
}

beforeEach(async () => {
  vi.resetModules();
  state.rows = {
    shop_backorders: [
      {
        id: ROW_ID,
        sku: "A7034",
        marked_at: "2026-06-01T00:00:00.000Z",
        cleared_at: null,
        notes: "vendor delay",
        marked_by_user_id: null,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
    shop_sku_substitutes: [],
  };
  state.writes = [];
  state.uniqueViolation = false;
  signIn("admin");
  const router = (await import("./shop-backorders")).default;
  app = express();
  app.use(express.json());
  app.use(router);
});

describe("backorders — the CSR-facing surface", () => {
  it("lists rows in the shape the console renders", async () => {
    const res = await request(app).get("/admin/shop/backorders");
    expect(res.status).toBe(200);
    expect(res.body.backorders).toHaveLength(1);
    expect(res.body.backorders[0]).toMatchObject({
      id: ROW_ID,
      sku: "A7034",
      clearedAt: null,
    });
  });

  it("marks a SKU backordered", async () => {
    const res = await request(app)
      .post("/admin/shop/backorders")
      .send({ sku: "A7035", notes: "on order" });
    expect(res.status).toBe(201);
    expect(state.writes[0]).toMatchObject({
      table: "shop_backorders",
      op: "insert",
    });
  });

  it("turns a unique violation into a 409, not a 500", async () => {
    // A CSR marking a SKU that is already marked is an ordinary race,
    // not a server error, and a 500 sends them to an engineer.
    state.uniqueViolation = true;
    const res = await request(app)
      .post("/admin/shop/backorders")
      .send({ sku: "A7034" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_backordered");
  });

  it.each([
    { sku: "" },
    { sku: "has spaces" },
    { sku: "A7034", unexpected: true },
    {},
  ])("rejects a malformed mark body %o", async (body) => {
    const res = await request(app).post("/admin/shop/backorders").send(body);
    expect(res.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });

  it("clears an open backorder and appends the note", async () => {
    const res = await request(app)
      .post(`/admin/shop/backorders/${ROW_ID}/clear`)
      .send({ notes: "restocked" });
    expect(res.status).toBe(200);
    const update = state.writes.find((w) => w.op === "update");
    expect(
      (update?.payload as { notes: string; cleared_at: string }).notes,
    ).toContain("cleared: restocked");
    expect((update?.payload as { cleared_at: string }).cleared_at).toBeTruthy();
  });

  it("refuses to clear a row that is already cleared", async () => {
    // Re-stamping would move the cleared timestamp and lose when the
    // SKU actually came back.
    state.rows.shop_backorders = [
      {
        id: ROW_ID,
        sku: "A7034",
        cleared_at: "2026-06-02T00:00:00.000Z",
        notes: null,
      },
    ];
    const res = await request(app)
      .post(`/admin/shop/backorders/${ROW_ID}/clear`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_cleared");
    expect(state.writes.filter((w) => w.op === "update")).toHaveLength(0);
  });

  it("404s a clear for an id that does not exist", async () => {
    state.rows.shop_backorders = [];
    const res = await request(app)
      .post(`/admin/shop/backorders/${ROW_ID}/clear`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("404s — not 500 — on an id that is not a uuid", async () => {
    const res = await request(app)
      .post("/admin/shop/backorders/not-a-uuid/clear")
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("substitution rules are admin-only, and that is deliberate", () => {
  it("lets an admin create a substitution", async () => {
    const res = await request(app)
      .post("/admin/shop/sku-substitutes")
      .send({ primarySku: "A7034", alternativeSku: "A7035" });
    expect(res.status).toBe(201);
  });

  it("refuses a CSR, who CAN mark backorders", async () => {
    // The difference is the point: a substitution encodes a clinical
    // preference order, and re-ordering it is a clinical decision
    // wearing an inventory costume.
    signIn("agent");
    const create = await request(app)
      .post("/admin/shop/sku-substitutes")
      .send({ primarySku: "A7034", alternativeSku: "A7035" });
    expect(create.status).toBe(403);

    const patch = await request(app)
      .patch(`/admin/shop/sku-substitutes/${ROW_ID}`)
      .send({ priority: 5 });
    expect(patch.status).toBe(403);

    const del = await request(app).delete(
      `/admin/shop/sku-substitutes/${ROW_ID}`,
    );
    expect(del.status).toBe(403);

    // …while the CSR's own surface still works.
    const mark = await request(app)
      .post("/admin/shop/backorders")
      .send({ sku: "A7099" });
    expect(mark.status).toBe(201);
  });

  it("refuses a substitution of a SKU for itself", async () => {
    const res = await request(app)
      .post("/admin/shop/sku-substitutes")
      .send({ primarySku: "A7034", alternativeSku: "A7034" });
    expect(res.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });

  it("turns a duplicate pair into a 409", async () => {
    state.uniqueViolation = true;
    const res = await request(app)
      .post("/admin/shop/sku-substitutes")
      .send({ primarySku: "A7034", alternativeSku: "A7035" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate_pair");
  });

  it.each([
    { primarySku: "A7034", alternativeSku: "A7035", priority: 0 },
    { primarySku: "A7034", alternativeSku: "A7035", priority: 1001 },
    { primarySku: "bad sku", alternativeSku: "A7035" },
    { primarySku: "A7034" },
  ])("rejects a malformed substitution %o", async (body) => {
    const res = await request(app)
      .post("/admin/shop/sku-substitutes")
      .send(body);
    expect(res.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });
});

describe("tenant context", () => {
  it.each([
    ["get", "/admin/shop/backorders"],
    ["get", "/admin/shop/sku-substitutes"],
  ])("fails closed on %s %s without an org", async (method, path) => {
    signIn("admin", null);
    const res = await request(app)[method as "get"](path);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "tenant_context_missing" });
  });

  it("writes NOTHING when the tenant is unknown", async () => {
    // An unscoped write here would edit another practice's catalog.
    signIn("admin", null);
    const res = await request(app)
      .post("/admin/shop/backorders")
      .send({ sku: "A7034" });
    expect(res.status).toBe(500);
    expect(state.writes).toHaveLength(0);
  });
});
