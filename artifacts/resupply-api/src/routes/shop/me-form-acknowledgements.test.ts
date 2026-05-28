// Route tests for /shop/me/form-acknowledgements.
//
// Coverage:
//   * 401 on POST without sign-in
//   * GET with no email returns patientLinked=false + empty forms list
//   * GET matches the latest signed version per form_kind
//   * GET shows currentVersion + upToDate=false when patient signed an older version
//   * POST 400 when formKind invalid
//   * POST 404 when patient lookup misses
//   * POST 201 happy path inserts with patient_portal source
//   * POST 200 idempotent on 23505 dupe

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | { customerId: string; email: string | null },
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import formAckRouter from "./me-form-acknowledgements";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(formAckRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/form-acknowledgements", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/form-acknowledgements");
    expect(res.status).toBe(401);
  });

  it("returns patientLinked=false with empty list when no email present", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/form-acknowledgements");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
    expect(res.body.forms).toEqual([]);
  });

  it("returns patientLinked=false when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/form-acknowledgements");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
  });

  it("returns full form list with latest signed version when patient exists", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_form_acknowledgements", "select", {
      data: [
        // Latest hipaa_npp ack (signed_at desc means first row is most recent)
        {
          form_kind: "hipaa_npp",
          form_version: "1.0",
          signed_at: "2026-05-01T00:00:00.000Z",
          source: "patient_portal",
        },
        // Older hipaa_npp ack — should be ignored
        {
          form_kind: "hipaa_npp",
          form_version: "0.9",
          signed_at: "2025-01-01T00:00:00.000Z",
          source: "patient_portal",
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/form-acknowledgements");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    const hipaa = res.body.forms.find(
      (f: { kind: string }) => f.kind === "hipaa_npp",
    );
    expect(hipaa.lastSignedVersion).toBe("1.0");
    expect(hipaa.lastSignedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(hipaa.upToDate).toBe(hipaa.currentVersion === "1.0");

    const aob = res.body.forms.find((f: { kind: string }) => f.kind === "aob");
    expect(aob.lastSignedVersion).toBeNull();
    expect(aob.upToDate).toBe(false);
  });
});

describe("POST /shop/me/form-acknowledgements", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post("/shop/me/form-acknowledgements")
      .send({ formKind: "hipaa_npp" });
    expect(res.status).toBe(401);
  });

  it("401s when email missing", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp())
      .post("/shop/me/form-acknowledgements")
      .send({ formKind: "hipaa_npp" });
    expect(res.status).toBe(401);
  });

  it("400s on invalid formKind", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/form-acknowledgements")
      .send({ formKind: "made_up_form" });
    expect(res.status).toBe(400);
  });

  it("404s when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp())
      .post("/shop/me/form-acknowledgements")
      .send({ formKind: "hipaa_npp" });
    expect(res.status).toBe(404);
  });

  it("201s and returns id on happy path", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_form_acknowledgements", "insert", {
      data: { id: "ack_1" },
    });
    const res = await request(makeApp())
      .post("/shop/me/form-acknowledgements")
      .send({ formKind: "hipaa_npp" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "ack_1", created: true });
  });

  it("returns 200 idempotent on 23505 dupe", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_form_acknowledgements", "insert", {
      error: { code: "23505", message: "dup" },
    });
    const res = await request(makeApp())
      .post("/shop/me/form-acknowledgements")
      .send({ formKind: "hipaa_npp" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: null, created: false });
  });
});
