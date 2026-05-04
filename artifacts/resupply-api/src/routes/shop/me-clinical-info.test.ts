// Route tests for routes/shop/me-clinical-info.ts.
//
// Coverage:
//   * 401 when the caller has no session
//   * GET returns nulls for a fresh customer (no row written yet)
//   * GET returns persisted values
//   * PUT validation: NPI must be 10 digits, ZIP must be 5/9, email
//     must look like an email, manufacturer required when device set
//   * PUT no-op (empty body) does not write
//   * PUT with cpapDevice writes the row + audits
//   * PUT with `null` clears the corresponding field
//
// We mock the DB at the drizzle layer (no live pool) and stub the
// audit helper so we can assert it was called with the expected
// non-PHI metadata envelope.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// Stub the audit helper. Tests assert payload shape without
// touching a real audit log.
const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

// Stub the ensure-row helper so the route doesn't need a real
// shop_customers row to exist.
const ensureShopCustomerRowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
vi.mock("../../lib/stripe/customer", () => ({
  ensureShopCustomerRow: ensureShopCustomerRowMock,
}));

// Drizzle stub. The route does:
//   GET → SELECT cpapDevice/physicianInfo FROM shop_customers WHERE … LIMIT 1
//   PUT → UPDATE shop_customers SET … WHERE … RETURNING cpapDevice/physicianInfo
// (and a SELECT in the no-op path)
// We push the result for each query into the queues in order.
const selectQueue: unknown[][] = [];
const updateQueue: unknown[][] = [];
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
  update: vi.fn(() => {
    const result = updateQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => obj,
      returning: () => Promise.resolve(result),
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

// Imported AFTER the vi.mock calls above so the route picks up the
// stubbed modules.
import meClinicalInfoRouter from "./me-clinical-info";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meClinicalInfoRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  selectQueue.length = 0;
  updateQueue.length = 0;
  logAuditMock.mockClear();
  ensureShopCustomerRowMock.mockClear();
  dbStub.select.mockClear();
  dbStub.update.mockClear();
});

describe("GET /shop/me/clinical-info", () => {
  it("401s when no session", async () => {
    const res = await request(makeApp()).get("/shop/me/clinical-info");
    expect(res.status).toBe(401);
  });

  it("returns nulls for a customer with no info on file", async () => {
    mockSignedIn.current = "cust_1";
    selectQueue.push([]);
    const res = await request(makeApp()).get("/shop/me/clinical-info");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cpapDevice: null, physicianInfo: null });
  });

  it("returns the persisted device + physician shape", async () => {
    mockSignedIn.current = "cust_1";
    selectQueue.push([
      {
        cpapDevice: {
          manufacturer: "ResMed",
          model: "AirSense 11",
          serialNumber: null,
          pressureSetting: null,
          humidifierSetting: null,
          notes: null,
        },
        physicianInfo: {
          name: "Dr. Anna Singh",
          practice: null,
          phone: null,
          fax: null,
          email: null,
          addressLine1: null,
          addressLine2: null,
          city: null,
          state: null,
          postalCode: null,
          npi: null,
        },
      },
    ]);
    const res = await request(makeApp()).get("/shop/me/clinical-info");
    expect(res.status).toBe(200);
    expect(res.body.cpapDevice.manufacturer).toBe("ResMed");
    expect(res.body.physicianInfo.name).toBe("Dr. Anna Singh");
  });
});

describe("PUT /shop/me/clinical-info", () => {
  it("401s when no session", async () => {
    const res = await request(makeApp()).put("/shop/me/clinical-info").send({});
    expect(res.status).toBe(401);
  });

  it("rejects an invalid NPI", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .put("/shop/me/clinical-info")
      .send({
        physicianInfo: { name: "Dr. Anna", npi: "not-ten-digits" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed ZIP", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .put("/shop/me/clinical-info")
      .send({
        physicianInfo: { name: "Dr. Anna", postalCode: "abcde" },
      });
    expect(res.status).toBe(400);
  });

  it("rejects a missing manufacturer when cpapDevice is set", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .put("/shop/me/clinical-info")
      .send({ cpapDevice: { model: "AirSense 11" } });
    expect(res.status).toBe(400);
  });

  it("no-op PUT (empty body) returns current values without an audit", async () => {
    mockSignedIn.current = "cust_1";
    selectQueue.push([{ cpapDevice: null, physicianInfo: null }]);
    const res = await request(makeApp()).put("/shop/me/clinical-info").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cpapDevice: null, physicianInfo: null });
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("writes the device, returns it, and audits with non-PHI metadata", async () => {
    mockSignedIn.current = "cust_1";
    const stored = {
      manufacturer: "ResMed",
      model: "AirSense 11",
      serialNumber: null,
      pressureSetting: null,
      humidifierSetting: null,
      notes: null,
    };
    updateQueue.push([{ cpapDevice: stored, physicianInfo: null }]);
    const res = await request(makeApp())
      .put("/shop/me/clinical-info")
      .send({
        cpapDevice: { manufacturer: "ResMed", model: "AirSense 11" },
      });
    expect(res.status).toBe(200);
    expect(res.body.cpapDevice.manufacturer).toBe("ResMed");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const auditCall = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(auditCall.action).toBe("shop_customer.clinical_info.update");
    expect(auditCall.targetTable).toBe("shop_customers");
    expect(auditCall.targetId).toBe("cust_1");
    expect(auditCall.metadata.changed).toEqual(["cpapDevice"]);
    // Critical: NO actual PHI in the audit envelope.
    expect(JSON.stringify(auditCall.metadata)).not.toContain("ResMed");
    expect(JSON.stringify(auditCall.metadata)).not.toContain("AirSense");
  });

  it("clears a field when given null", async () => {
    mockSignedIn.current = "cust_1";
    updateQueue.push([{ cpapDevice: null, physicianInfo: null }]);
    const res = await request(makeApp())
      .put("/shop/me/clinical-info")
      .send({ cpapDevice: null });
    expect(res.status).toBe(200);
    expect(res.body.cpapDevice).toBeNull();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });
});
