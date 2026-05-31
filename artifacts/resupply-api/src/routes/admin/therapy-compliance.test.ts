// Route tests for /admin/therapy-compliance/{summary,setups,setups.csv}.
//
// Coverage:
//   * 401 without admin on every endpoint.
//   * summary: coerces the single RPC row into the nested KPI shape.
//   * setups: maps RPC rows, attaches patient names, filters by status.
//   * setups.csv: header + one line per setup.

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
  stageSupabaseRpcResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import therapyComplianceRouter from "./therapy-compliance";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(therapyComplianceRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/therapy-compliance/summary", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/summary",
    );
    expect(res.status).toBe(401);
  });

  it("coerces the single RPC row into nested KPIs", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_setup_adherence_summary", {
      data: [
        {
          patients_in_window: "30",
          qualified: "18",
          on_track: "7",
          at_risk: "5",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/summary",
    );
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      patientsInWindow: 30,
      qualified: 18,
      onTrack: 7,
      atRisk: 5,
    });
  });

  it("defaults missing RPC data to zeros", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_setup_adherence_summary", { data: [] });
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/summary",
    );
    expect(res.status).toBe(200);
    expect(res.body.summary.patientsInWindow).toBe(0);
  });
});

describe("GET /admin/therapy-compliance/setups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/setups",
    );
    expect(res.status).toBe(401);
  });

  it("maps RPC rows + attaches patient names", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_setup_adherence_list", {
      data: [
        {
          patient_id: P1,
          first_night_date: "2026-04-10",
          days_elapsed: "51",
          days_remaining: "38",
          nights_in_window: "40",
          nights_over_4h: "12",
          best_30day_count: "12",
          nights_needed: "9",
          status: "on_track",
        },
        {
          patient_id: P2,
          first_night_date: "2026-03-20",
          days_elapsed: "72",
          days_remaining: "17",
          nights_in_window: "30",
          nights_over_4h: "3",
          best_30day_count: "3",
          nights_needed: "18",
          status: "at_risk",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: P1, legal_first_name: "Ada", legal_last_name: "Lovelace" },
        { id: P2, legal_first_name: "Grace", legal_last_name: "Hopper" },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/setups",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.setups[0]).toMatchObject({
      patientId: P1,
      patientName: "Ada Lovelace",
      best30dayCount: 12,
      nightsNeeded: 9,
      daysRemaining: 38,
      status: "on_track",
    });
    expect(res.body.setups[1]).toMatchObject({
      patientName: "Grace Hopper",
      status: "at_risk",
    });
  });

  it("filters by status", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_setup_adherence_list", {
      data: [
        {
          patient_id: P1,
          first_night_date: "2026-04-10",
          days_elapsed: "51",
          days_remaining: "38",
          nights_in_window: "40",
          nights_over_4h: "12",
          best_30day_count: "12",
          nights_needed: "9",
          status: "on_track",
        },
        {
          patient_id: P2,
          first_night_date: "2026-03-20",
          days_elapsed: "72",
          days_remaining: "17",
          nights_in_window: "30",
          nights_over_4h: "3",
          best_30day_count: "3",
          nights_needed: "18",
          status: "at_risk",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P2, legal_first_name: "Grace", legal_last_name: "Hopper" }],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/setups?status=at_risk",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.setups[0].patientId).toBe(P2);
  });

  it("400s on an unknown status", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/setups?status=whatever",
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/therapy-compliance/setups.csv", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/setups.csv",
    );
    expect(res.status).toBe(401);
  });

  it("emits a CSV header + one row per setup", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_setup_adherence_list", {
      data: [
        {
          patient_id: P1,
          first_night_date: "2026-04-10",
          days_elapsed: "51",
          days_remaining: "38",
          nights_in_window: "40",
          nights_over_4h: "12",
          best_30day_count: "12",
          nights_needed: "9",
          status: "on_track",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P1, legal_first_name: "Ada", legal_last_name: "Lovelace" }],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-compliance/setups.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toContain("patient_id,patient_name,status");
    expect(lines[1]).toContain(P1);
    expect(lines[1]).toContain("Ada Lovelace");
    expect(lines[1]).toContain("on_track");
  });
});
