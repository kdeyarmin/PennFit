// Route tests for GET /shop/me/education-feed.
//
// Coverage:
//   * 401 without sign-in
//   * Returns stage="new" with articles when no email (patientLinked=false)
//   * Returns stage="new" when patient lookup misses
//   * Computes daysOnTherapy from earliest therapy_night
//   * Falls back to patient created_at when no nights exist

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
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

import edRouter from "./me-education-feed";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(edRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/education-feed", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/education-feed");
    expect(res.status).toBe(401);
  });

  it("returns stage=new patientLinked=false when no email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/education-feed");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
    expect(res.body.stage).toBe("new");
    expect(res.body.daysOnTherapy).toBe(0);
    expect(Array.isArray(res.body.articles)).toBe(true);
  });

  it("returns stage=new patientLinked=false when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/education-feed");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
  });

  it("computes daysOnTherapy from the earliest therapy_night", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1", created_at: "2020-01-01T00:00:00Z" }],
    });
    // 100 days ago
    const earliest = new Date(Date.now() - 100 * 86400_000)
      .toISOString()
      .slice(0, 10);
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: { night_date: earliest },
    });
    const res = await request(makeApp()).get("/shop/me/education-feed");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.daysOnTherapy).toBeGreaterThanOrEqual(99);
    expect(res.body.daysOnTherapy).toBeLessThanOrEqual(101);
  });

  it("falls back to patient.created_at when no nights exist", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400_000).toISOString();
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1", created_at: fiveDaysAgo }],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: null });
    const res = await request(makeApp()).get("/shop/me/education-feed");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.daysOnTherapy).toBeGreaterThanOrEqual(4);
    expect(res.body.daysOnTherapy).toBeLessThanOrEqual(6);
  });
});
