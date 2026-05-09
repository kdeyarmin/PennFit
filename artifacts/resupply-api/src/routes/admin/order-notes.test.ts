// Route tests for /admin/shop/orders/:orderId/notes (Phase 14).
//
// Mirrors customer-notes.test.ts. Coverage:
//   * 401 / 400 / 404 paths for both GET and POST
//   * GET returns the notes array
//   * POST validates body length (empty + over-limit)
//   * POST inserts + audits with non-PHI metadata; envelope never
//     contains the body content

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import orderNotesRouter from "./order-notes";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(orderNotesRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/shop/orders/:orderId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/shop/orders/${ORDER_ID}/notes`,
    );
    expect(res.status).toBe(401);
  });

  it("400s with malformed orderId", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      `/admin/shop/orders/has spaces!/notes`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_order_id");
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
  });

  it("404s when the order doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/shop/orders/${ORDER_ID}/notes`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });

  it("returns the notes list", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_orders", "select", { data: { id: ORDER_ID } });
    stageSupabaseResponse("shop_order_notes", "select", {
      data: [
        {
          id: "note_1",
          body: "UPS lost the package — opened claim #12345.",
          author_email: "ops@penn.example.com",
          author_user_id: "u_admin",
          created_at: new Date("2026-05-03T15:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get(
      `/admin/shop/orders/${ORDER_ID}/notes`,
    );
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]).toMatchObject({
      id: "note_1",
      body: "UPS lost the package — opened claim #12345.",
      authorEmail: "ops@penn.example.com",
    });
  });
});

describe("POST /admin/shop/orders/:orderId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/shop/orders/${ORDER_ID}/notes`)
      .send({ body: "test" });
    expect(res.status).toBe(401);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/orders/${ORDER_ID}/notes`)
      .send({ body: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("shop_order_notes", "insert")).toBe(0);
  });

  it("400s with over-limit body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/orders/${ORDER_ID}/notes`)
      .send({ body: "x".repeat(4001) });
    expect(res.status).toBe(400);
  });

  it("404s when the order doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/shop/orders/${ORDER_ID}/notes`)
      .send({ body: "Tracking shows delivered to wrong address" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
    expect(getSupabaseCallCount("shop_order_notes", "insert")).toBe(0);
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_orders", "select", { data: { id: ORDER_ID } });
    stageSupabaseResponse("shop_order_notes", "insert", {
      data: {
        id: "note_new",
        created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp())
      .post(`/admin/shop/orders/${ORDER_ID}/notes`)
      .send({
        body: "Customer reports box arrived crushed; refunding shipping.",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: "note_new",
      createdAt: "2026-05-04T12:00:00.000Z",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_order.note.create");
    expect(audit.targetTable).toBe("shop_order_notes");
    expect(audit.targetId).toBe("note_new");
    expect(audit.metadata).toEqual({
      order_id: ORDER_ID,
      body_length: "Customer reports box arrived crushed; refunding shipping."
        .length,
    });
    // Critical: no body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("crushed");
    expect(JSON.stringify(audit.metadata)).not.toContain("refunding");
  });
});
