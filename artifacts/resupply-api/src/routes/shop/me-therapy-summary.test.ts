// Route tests for GET /shop/me/therapy-summary.
//
// Coverage:
//   * 401 without sign-in
//   * Empty hasData=false patientLinked=false when no shop email present
//   * Empty patientLinked=false when patient lookup returns 0 rows
//   * Empty patientLinked=false when patient lookup is ambiguous (>1)
//   * Empty patientLinked=true with no nights returns empty projection
//   * Projects nights with usage->hours conversion and Medicare adherence
//   * Same-night dedupe favours higher-priority source
//   * Numeric metrics arrive from PostgREST as strings; cast cleanly

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

import therapySummaryRouter from "./me-therapy-summary";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(therapySummaryRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/therapy-summary", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/therapy-summary");
    expect(res.status).toBe(401);
  });

  it("returns empty + patientLinked=false when no shop email present", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/therapy-summary");
    expect(res.status).toBe(200);
    expect(res.body.hasData).toBe(false);
    expect(res.body.patientLinked).toBe(false);
    expect(res.body.nights).toEqual([]);
  });

  it("returns empty + patientLinked=false when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/therapy-summary");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
  });

  it("returns empty + patientLinked=false when patient lookup is ambiguous (>1 match)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p_1" }, { id: "p_2" }],
    });
    const res = await request(makeApp()).get("/shop/me/therapy-summary");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
  });

  it("returns empty + patientLinked=true when patient exists but has no nights", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/therapy-summary");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.hasData).toBe(false);
    expect(res.body.nightsWithData).toBe(0);
  });

  it("projects nights and computes Medicare compliance", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        // 5 hours — compliant
        {
          night_date: "2026-05-01",
          source: "resmed_airview",
          usage_minutes: 300,
          ahi: "2.5",
          leak_rate_l_min: "12.0",
          pressure_p95_cmh2o: "11.5",
        },
        // 6 hours — compliant
        {
          night_date: "2026-05-02",
          source: "resmed_airview",
          usage_minutes: 360,
          ahi: "3.0",
          leak_rate_l_min: "10.0",
          pressure_p95_cmh2o: "11.0",
        },
        // 3 hours — NOT compliant
        {
          night_date: "2026-05-03",
          source: "resmed_airview",
          usage_minutes: 180,
          ahi: "4.0",
          leak_rate_l_min: "15.0",
          pressure_p95_cmh2o: "10.5",
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/therapy-summary");
    expect(res.status).toBe(200);
    expect(res.body.hasData).toBe(true);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.nightsWithData).toBe(3);
    expect(res.body.compliantNights).toBe(2);
    // 2/3 ~= 0.67
    expect(res.body.complianceRate).toBeCloseTo(0.67, 1);
    // avg usage = (5+6+3)/3 = 4.67
    expect(res.body.avgUsageHours).toBeCloseTo(4.67, 1);
    expect(res.body.avgAhi).toBeCloseTo(3.17, 1);
    expect(res.body.nights).toHaveLength(3);
    // Sorted by date desc — May 03 first, with 3 hours of usage.
    expect(res.body.nights[0].date).toBe("2026-05-03");
    expect(res.body.nights[0].usageHours).toBe(3);
  });

  it("dedupes same-night entries, keeping higher-priority source", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        // Lower priority (manual) duplicate — should be ignored
        {
          night_date: "2026-05-01",
          source: "manual",
          usage_minutes: 999,
          ahi: "99.0",
          leak_rate_l_min: "99.0",
          pressure_p95_cmh2o: "99.0",
        },
        // Higher priority (resmed_airview) — should win
        {
          night_date: "2026-05-01",
          source: "resmed_airview",
          usage_minutes: 300,
          ahi: "2.5",
          leak_rate_l_min: "12.0",
          pressure_p95_cmh2o: "11.5",
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/therapy-summary");
    expect(res.status).toBe(200);
    expect(res.body.nights).toHaveLength(1);
    expect(res.body.nights[0].source).toBe("resmed_airview");
    expect(res.body.nights[0].usageHours).toBe(5);
  });
});
