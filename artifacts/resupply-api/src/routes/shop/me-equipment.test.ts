// Route tests for /shop/me/equipment.
//
// Coverage:
//   * 401 without sign-in
//   * GET returns empty + patientLinked=false when no email
//   * GET returns empty + patientLinked=false when patient lookup misses
//   * GET projects equipment rows to camelCase
//   * POST 401 when email missing
//   * POST 400 on invalid body
//   * POST 404 when patient lookup misses
//   * POST 201 happy path normalises manufacturer (upper) and serial (upper, no whitespace)
//   * POST 409 on 23505 duplicate serial

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import equipmentRouter from "./me-equipment";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(equipmentRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/equipment", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/equipment");
    expect(res.status).toBe(401);
  });

  it("returns patientLinked=false when no email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/equipment");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
    expect(res.body.assets).toEqual([]);
  });

  it("returns patientLinked=false when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/equipment");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
  });

  it("projects equipment rows", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [
        {
          id: "eq_1",
          device_class: "cpap",
          manufacturer: "RESMED",
          model: "AirSense 11",
          serial_number: "ABC123",
          status: "active",
          dispensed_at: "2026-01-01",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/equipment");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.assets).toEqual([
      {
        id: "eq_1",
        deviceClass: "cpap",
        manufacturer: "RESMED",
        model: "AirSense 11",
        serialNumber: "ABC123",
        status: "active",
        dispensedAt: "2026-01-01",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });
});

describe("POST /shop/me/equipment", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).post("/shop/me/equipment").send({});
    expect(res.status).toBe(401);
  });

  it("401s when email missing", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).post("/shop/me/equipment").send({});
    expect(res.status).toBe(401);
  });

  it("400s on invalid body", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/equipment")
      .send({ deviceClass: "made_up" });
    expect(res.status).toBe(400);
  });

  it("404s when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).post("/shop/me/equipment").send({
      deviceClass: "cpap",
      manufacturer: "ResMed",
      model: "AirSense 11",
      serialNumber: "abc 123",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_linked");
  });

  it("normalises manufacturer + serial on happy path (201)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("equipment_assets", "insert", {
      data: { id: "eq_new" },
    });
    const res = await request(makeApp()).post("/shop/me/equipment").send({
      deviceClass: "cpap",
      manufacturer: "ResMed",
      model: "AirSense 11",
      serialNumber: "abc 12  3",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "eq_new" });

    const writes = getSupabaseWritePayloads("equipment_assets", "insert");
    const payload = writes[0] as Record<string, unknown>;
    expect(payload.manufacturer).toBe("RESMED");
    // Whitespace stripped, uppercased.
    expect(payload.serial_number).toBe("ABC123");
    expect(payload.patient_id).toBe("p_1");
    expect(payload.dispensing_note).toMatch(/self-registered/);
  });

  it("409s when serial already on file (23505)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("equipment_assets", "insert", {
      error: { code: "23505", message: "dup" },
    });
    const res = await request(makeApp()).post("/shop/me/equipment").send({
      deviceClass: "cpap",
      manufacturer: "ResMed",
      model: "AirSense 11",
      serialNumber: "X",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("serial_already_registered");
  });
});
