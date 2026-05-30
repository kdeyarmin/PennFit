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

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// Stub the audit helper. Tests assert payload shape without
// touching a real audit log.
const logAuditMock = vi.hoisted(() =>
  vi.fn(async (_arg: unknown) => undefined),
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

import meClinicalInfoRouter from "./me-clinical-info";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meClinicalInfoRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  ensureShopCustomerRowMock.mockClear();
});

describe("GET /shop/me/clinical-info", () => {
  it("401s when no session", async () => {
    const res = await request(makeApp()).get("/shop/me/clinical-info");
    expect(res.status).toBe(401);
  });

  it("returns nulls for a customer with no info on file", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp()).get("/shop/me/clinical-info");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cpapDevice: null,
      physicianInfo: null,
      facialMeasurements: null,
    });
  });

  it("returns the persisted device + physician shape", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        cpap_device_json: {
          manufacturer: "ResMed",
          model: "AirSense 11",
          serialNumber: null,
          pressureSetting: null,
          humidifierSetting: null,
          notes: null,
        },
        physician_info_json: {
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
        facial_measurements_json: null,
      },
    });
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
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        cpap_device_json: null,
        physician_info_json: null,
        facial_measurements_json: null,
      },
    });
    const res = await request(makeApp()).put("/shop/me/clinical-info").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cpapDevice: null,
      physicianInfo: null,
      facialMeasurements: null,
    });
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("shop_customers", "update")).toBe(0);
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
    stageSupabaseResponse("shop_customers", "update", {
      data: {
        cpap_device_json: stored,
        physician_info_json: null,
        facial_measurements_json: null,
      },
    });
    const res = await request(makeApp())
      .put("/shop/me/clinical-info")
      .send({
        cpapDevice: { manufacturer: "ResMed", model: "AirSense 11" },
      });
    expect(res.status).toBe(200);
    expect(res.body.cpapDevice.manufacturer).toBe("ResMed");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const auditCall = logAuditMock.mock.calls[0]?.[0] as unknown as {
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
    stageSupabaseResponse("shop_customers", "update", {
      data: {
        cpap_device_json: null,
        physician_info_json: null,
        facial_measurements_json: null,
      },
    });
    const res = await request(makeApp())
      .put("/shop/me/clinical-info")
      .send({ cpapDevice: null });
    expect(res.status).toBe(200);
    expect(res.body.cpapDevice).toBeNull();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });
});
