// Route tests for /admin/shop/products/:productId/compatibility
// (Phase B.3).
//
// Coverage:
//   * 401 without admin
//   * POST inserts + audits + 409 on unique-violation
//   * DELETE 404 when entry doesn't belong to the product
//   * DELETE removes + audits

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
  getSupabaseWritePayloads,
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

import productCompatibilityAdminRouter from "./product-compatibility";

const PRODUCT_ID = "prod_abc123";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productCompatibilityAdminRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("POST /admin/shop/products/:productId/compatibility", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/shop/products/${PRODUCT_ID}/compatibility`)
      .send({ machineManufacturer: "ResMed" });
    expect(res.status).toBe(401);
  });

  it("inserts + audits", async () => {
    mockAdmin.current = ADMIN;
    // INSERT … RETURNING with .single() returns the inserted row directly.
    stageSupabaseResponse("shop_product_compatibility", "insert", {
      data: { id: "compat_1" },
    });
    const res = await request(makeApp())
      .post(`/admin/shop/products/${PRODUCT_ID}/compatibility`)
      .send({
        machineManufacturer: "ResMed",
        machineModel: "AirSense 11",
        notes: "Verified by vendor",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("compat_1");

    const inserted = getSupabaseWritePayloads(
      "shop_product_compatibility",
      "insert",
    )[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      product_id: PRODUCT_ID,
      machine_manufacturer: "ResMed",
      machine_model: "AirSense 11",
      notes: "Verified by vendor",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_product_compatibility.add");
    expect(audit.metadata).toEqual({
      product_id: PRODUCT_ID,
      machine_manufacturer: "ResMed",
      machine_model: "AirSense 11",
    });
  });

  it("409s on unique-violation (already exists)", async () => {
    mockAdmin.current = ADMIN;
    // PostgREST surfaces the duplicate-key violation as a `code: "23505"`
    // error envelope; the route catches it and maps to 409.
    stageSupabaseResponse("shop_product_compatibility", "insert", {
      error: { code: "23505", message: "duplicate key" },
    });
    const res = await request(makeApp())
      .post(`/admin/shop/products/${PRODUCT_ID}/compatibility`)
      .send({ machineManufacturer: "ResMed", machineModel: "AirSense 11" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_exists");
  });
});

describe("DELETE /admin/shop/products/:productId/compatibility/:entryId", () => {
  const ENTRY_ID = "11111111-1111-4111-8111-111111111111";

  it("404s when the entry belongs to a different product", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_product_compatibility", "select", {
      data: {
        id: ENTRY_ID,
        product_id: "prod_someone_else",
        machine_manufacturer: "ResMed",
        machine_model: null,
      },
    });
    const res = await request(makeApp()).delete(
      `/admin/shop/products/${PRODUCT_ID}/compatibility/${ENTRY_ID}`,
    );
    expect(res.status).toBe(404);
    expect(getSupabaseCallCount("shop_product_compatibility", "delete")).toBe(
      0,
    );
  });

  it("deletes + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_product_compatibility", "select", {
      data: {
        id: ENTRY_ID,
        product_id: PRODUCT_ID,
        machine_manufacturer: "ResMed",
        machine_model: "AirSense 11",
      },
    });
    stageSupabaseResponse("shop_product_compatibility", "delete", {
      error: null,
    });
    const res = await request(makeApp()).delete(
      `/admin/shop/products/${PRODUCT_ID}/compatibility/${ENTRY_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ENTRY_ID, deleted: true });
    expect(getSupabaseCallCount("shop_product_compatibility", "delete")).toBe(
      1,
    );
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_product_compatibility.remove");
    expect(audit.metadata).toEqual({
      product_id: PRODUCT_ID,
      manufacturer: "ResMed",
      model: "AirSense 11",
    });
  });
});
