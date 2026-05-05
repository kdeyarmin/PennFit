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

const selectQueue: unknown[][] = [];
const insertQueue: unknown[][] = [];
const insertedValues: Record<string, unknown>[] = [];
const insertShouldThrow: { current: Error | null } = { current: null };
const deleteCalls: number[] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const result = insertQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        if (insertShouldThrow.current) {
          const err = insertShouldThrow.current;
          insertShouldThrow.current = null;
          // Drizzle would throw asynchronously off the .returning()
          // promise; we simulate by rejecting there.
          return {
            returning: () => Promise.reject(err),
          };
        }
        return obj;
      },
      returning: () => Promise.resolve(result),
    };
    return obj;
  }),
  delete: vi.fn(() => {
    const obj: Record<string, unknown> = {
      where: () => {
        deleteCalls.push(1);
        return Promise.resolve();
      },
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

import productCompatibilityAdminRouter from "./product-compatibility";

const PRODUCT_ID = "prod_abc123";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productCompatibilityAdminRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  insertQueue.length = 0;
  insertedValues.length = 0;
  insertShouldThrow.current = null;
  deleteCalls.length = 0;
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
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    insertQueue.push([{ id: "compat_1" }]);
    const res = await request(makeApp())
      .post(`/admin/shop/products/${PRODUCT_ID}/compatibility`)
      .send({
        machineManufacturer: "ResMed",
        machineModel: "AirSense 11",
        notes: "Verified by vendor",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("compat_1");
    expect(insertedValues[0]).toMatchObject({
      productId: PRODUCT_ID,
      machineManufacturer: "ResMed",
      machineModel: "AirSense 11",
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
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const uniqueErr = Object.assign(new Error("dup"), { code: "23505" });
    insertShouldThrow.current = uniqueErr;
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
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: ENTRY_ID,
        productId: "prod_someone_else",
        manufacturer: "ResMed",
        model: null,
      },
    ]);
    const res = await request(makeApp()).delete(
      `/admin/shop/products/${PRODUCT_ID}/compatibility/${ENTRY_ID}`,
    );
    expect(res.status).toBe(404);
    expect(deleteCalls).toEqual([]);
  });

  it("deletes + audits", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: ENTRY_ID,
        productId: PRODUCT_ID,
        manufacturer: "ResMed",
        model: "AirSense 11",
      },
    ]);
    const res = await request(makeApp()).delete(
      `/admin/shop/products/${PRODUCT_ID}/compatibility/${ENTRY_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ENTRY_ID, deleted: true });
    expect(deleteCalls).toHaveLength(1);
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
