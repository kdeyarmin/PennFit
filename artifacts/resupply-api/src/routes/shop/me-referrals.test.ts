// Route tests for /shop/me/referrals.
//
// Coverage:
//   * 401 without sign-in (GET + POST)
//   * GET returns empty when no email present
//   * GET returns empty when patient lookup misses
//   * GET projects referrals + computes stats
//   * POST 400 when refereeEmail is malformed
//   * POST 404 when patient lookup misses
//   * POST 201 happy path inserts referral with status=pending
//   * Generated code uses URL-safe 62-char alphabet only

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

import referralsRouter from "./me-referrals";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(referralsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/referrals", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/referrals");
    expect(res.status).toBe(401);
  });

  it("returns empty when no email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/referrals");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      referrals: [],
      patientLinked: false,
      stats: null,
    });
  });

  it("computes stats from referral rows", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_referrals", "select", {
      data: [
        {
          id: "r_1",
          code: "ABC123",
          referee_email: "bob@b.test",
          referee_name: "Bob",
          status: "converted",
          converted_at: "2026-01-15T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "r_2",
          code: "DEF456",
          referee_email: null,
          referee_name: null,
          status: "pending",
          converted_at: null,
          created_at: "2026-02-01T00:00:00Z",
        },
        {
          id: "r_3",
          code: "GHI789",
          referee_email: null,
          referee_name: null,
          status: "pending",
          converted_at: null,
          created_at: "2026-03-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/referrals");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.stats).toEqual({ total: 3, converted: 1, pending: 2 });
    expect(res.body.referrals).toHaveLength(3);
  });
});

describe("POST /shop/me/referrals", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).post("/shop/me/referrals").send({});
    expect(res.status).toBe(401);
  });

  it("401s when email is missing", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).post("/shop/me/referrals").send({});
    expect(res.status).toBe(401);
  });

  it("400s on malformed referee email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/referrals")
      .send({ refereeEmail: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("404s when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).post("/shop/me/referrals").send({});
    expect(res.status).toBe(404);
  });

  it("201s and persists referral on happy path with URL-safe code", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_referrals", "insert", {
      data: { id: "ref_1", code: "abc123XYZ0" },
    });
    const res = await request(makeApp())
      .post("/shop/me/referrals")
      .send({ refereeEmail: "bob@b.test", refereeName: "Bob" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "ref_1", code: "abc123XYZ0" });

    const writes = getSupabaseWritePayloads("patient_referrals", "insert");
    const payload = writes[0] as {
      referrer_patient_id: string;
      code: string;
      referee_email: string | null;
      status: string;
    };
    expect(payload.referrer_patient_id).toBe("p_1");
    expect(payload.referee_email).toBe("bob@b.test");
    expect(payload.status).toBe("pending");
    // Generated code must be URL-safe (62-char alphabet, 10 chars)
    expect(payload.code).toMatch(/^[A-Za-z0-9]{10}$/);
  });
});
