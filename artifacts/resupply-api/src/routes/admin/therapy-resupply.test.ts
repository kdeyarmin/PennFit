// Route tests for /admin/therapy-resupply/{summary,opportunities,…csv}.
//
// Coverage:
//   * 401 without admin on every endpoint.
//   * summary: coerces the single RPC row into the nested KPI shape;
//     passes p_due_within_days through; 400 on bad query.
//   * opportunities: maps RPC rows, attaches patient names from a
//     batched `patients` read, filters by category, coerces high_leak.
//   * opportunities.csv: header + one line per item, booleans rendered.

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
  getSupabaseRpcArgs,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import therapyResupplyRouter from "./therapy-resupply";

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
  app.use(therapyResupplyRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/therapy-resupply/summary", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/therapy-resupply/summary");
    expect(res.status).toBe(401);
  });

  it("400s on out-of-range dueWithinDays", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/therapy-resupply/summary?dueWithinDays=900",
    );
    expect(res.status).toBe(400);
  });

  it("coerces the single RPC row into nested KPIs and passes the horizon", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_resupply_summary", {
      data: [
        {
          patients_with_due: "42",
          items_due: "97",
          items_overdue: "31",
          masks_due: "20",
          cushions_due: "25",
          tubing_due: "18",
          filters_due: "34",
          high_leak_refit: "7",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-resupply/summary?dueWithinDays=14",
    );
    expect(res.status).toBe(200);
    expect(res.body.dueWithinDays).toBe(14);
    expect(res.body.summary.patientsWithDue).toBe(42);
    expect(res.body.summary.itemsDue).toBe(97);
    expect(res.body.summary.itemsOverdue).toBe(31);
    expect(res.body.summary.byCategory).toEqual({
      mask: 20,
      cushion: 25,
      tubing: 18,
      filter: 34,
    });
    expect(res.body.summary.highLeakRefit).toBe(7);
    expect(getSupabaseRpcArgs("therapy_resupply_summary")[0]).toEqual({
      p_due_within_days: 14,
    });
  });

  it("defaults missing RPC data to zeros", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_resupply_summary", { data: [] });
    const res = await request(makeApp()).get("/admin/therapy-resupply/summary");
    expect(res.status).toBe(200);
    expect(res.body.summary.itemsDue).toBe(0);
    expect(res.body.dueWithinDays).toBe(0);
  });
});

describe("GET /admin/therapy-resupply/opportunities", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/therapy-resupply/opportunities",
    );
    expect(res.status).toBe(401);
  });

  it("maps RPC rows + attaches patient names + coerces high_leak", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_resupply_opportunities", {
      data: [
        {
          patient_id: P1,
          source: "resmed_airview",
          category: "mask",
          description: "AirFit P10 Nasal Pillow",
          last_replaced_date: "2026-02-01",
          next_eligible_date: "2026-05-01",
          days_until_eligible: "-30",
          high_leak: true,
          fetched_at: "2026-05-30T04:30:00.000Z",
        },
        {
          patient_id: P2,
          source: "philips_care",
          category: "filter",
          description: "Disposable filter",
          last_replaced_date: "2026-04-15",
          next_eligible_date: "2026-05-29",
          days_until_eligible: "2",
          high_leak: false,
          fetched_at: "2026-05-30T04:30:00.000Z",
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
      "/admin/therapy-resupply/opportunities?dueWithinDays=14&limit=50",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.opportunities[0]).toMatchObject({
      patientId: P1,
      patientName: "Ada Lovelace",
      category: "mask",
      daysUntilEligible: -30,
      highLeak: true,
    });
    expect(res.body.opportunities[1]).toMatchObject({
      patientName: "Grace Hopper",
      category: "filter",
      highLeak: false,
    });
    expect(getSupabaseRpcArgs("therapy_resupply_opportunities")[0]).toEqual({
      p_due_within_days: 14,
      p_limit: 50,
    });
  });

  it("filters by category", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_resupply_opportunities", {
      data: [
        {
          patient_id: P1,
          source: "resmed_airview",
          category: "mask",
          description: "Mask",
          last_replaced_date: null,
          next_eligible_date: "2026-05-01",
          days_until_eligible: "-30",
          high_leak: true,
          fetched_at: null,
        },
        {
          patient_id: P2,
          source: "resmed_airview",
          category: "filter",
          description: "Filter",
          last_replaced_date: null,
          next_eligible_date: "2026-05-01",
          days_until_eligible: "-30",
          high_leak: false,
          fetched_at: null,
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P1, legal_first_name: "Ada", legal_last_name: "Lovelace" }],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-resupply/opportunities?category=mask",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.opportunities[0].patientId).toBe(P1);
    expect(res.body.opportunities[0].category).toBe("mask");
  });

  it("400s on an unknown category", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/therapy-resupply/opportunities?category=spaceship",
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/therapy-resupply/opportunities.csv", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/therapy-resupply/opportunities.csv",
    );
    expect(res.status).toBe(401);
  });

  it("emits a CSV header + one row per item", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_resupply_opportunities", {
      data: [
        {
          patient_id: P1,
          source: "resmed_airview",
          category: "mask",
          description: "AirFit P10",
          last_replaced_date: "2026-02-01",
          next_eligible_date: "2026-05-01",
          days_until_eligible: "-30",
          high_leak: true,
          fetched_at: "2026-05-30T04:30:00.000Z",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P1, legal_first_name: "Ada", legal_last_name: "Lovelace" }],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-resupply/opportunities.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toContain("patient_id,patient_name,source,category");
    expect(lines[1]).toContain(P1);
    expect(lines[1]).toContain("Ada Lovelace");
    expect(lines[1]).toContain("mask");
    expect(lines[1]).toContain("true");
  });
});
