// Route tests for /shop/me/insurance.
//
// Coverage:
//   * 401 without sign-in (GET + POST)
//   * GET returns null + patientLinked=false when no email
//   * GET returns the primary coverage projection when present
//   * POST 400 on invalid body
//   * POST 404 when patient lookup misses
//   * POST creates a new primary coverage when none exists (201 + created:true)
//   * POST updates existing primary and CRITICALLY clears verified_at
//   * POST update echoes existing id with created:false

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

import insuranceRouter from "./me-insurance";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(insuranceRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/insurance", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/insurance");
    expect(res.status).toBe(401);
  });

  it("returns null + patientLinked=false when no email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/insurance");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ coverage: null, patientLinked: false });
  });

  it("projects existing coverage row", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: {
        id: "cov_1",
        rank: "primary",
        payer_name: "Acme Insurance",
        plan_name: "PPO Gold",
        member_id: "ABC123",
        group_number: "G-100",
        effective_date: "2026-01-01",
        termination_date: null,
        verified_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      },
    });
    const res = await request(makeApp()).get("/shop/me/insurance");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.coverage.payerName).toBe("Acme Insurance");
    expect(res.body.coverage.memberId).toBe("ABC123");
    expect(res.body.coverage.verifiedAt).toBe("2026-02-01T00:00:00Z");
  });
});

describe("POST /shop/me/insurance", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).post("/shop/me/insurance").send({});
    expect(res.status).toBe(401);
  });

  it("400s on invalid body", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/insurance")
      .send({ payerName: "" });
    expect(res.status).toBe(400);
  });

  it("404s when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).post("/shop/me/insurance").send({
      payerName: "Acme",
      memberId: "X123",
    });
    expect(res.status).toBe(404);
  });

  it("creates primary coverage when none exists (201)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("insurance_coverages", "select", { data: null });
    stageSupabaseResponse("insurance_coverages", "insert", {
      data: { id: "cov_new" },
    });

    const res = await request(makeApp()).post("/shop/me/insurance").send({
      payerName: "Acme",
      memberId: "X123",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "cov_new", created: true });
  });

  it("updates existing coverage and CLEARS verified_at (CSR re-verification)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { id: "cov_existing" },
    });
    stageSupabaseResponse("insurance_coverages", "update", { data: null });

    const res = await request(makeApp()).post("/shop/me/insurance").send({
      payerName: "New Payer",
      memberId: "Y456",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "cov_existing", created: false });

    const writes = getSupabaseWritePayloads("insurance_coverages", "update");
    const payload = writes[0] as Record<string, unknown>;
    expect(payload.verified_at).toBeNull();
    expect(payload.verified_by_user_id).toBeNull();
    expect(payload.payer_name).toBe("New Payer");
    expect(payload.member_id).toBe("Y456");
  });
});
