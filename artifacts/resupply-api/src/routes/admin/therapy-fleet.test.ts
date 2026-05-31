// Route tests for /admin/therapy-fleet/{overview,worklist,worklist.csv}.
//
// Coverage:
//   * 401 without admin on every endpoint.
//   * overview: coerces the single RPC row into the nested KPI shape;
//     passes p_window_days through; 400 on bad query.
//   * worklist: maps RPC rows, attaches patient names from a batched
//     `patients` read, filters by reason, honors limit.
//   * worklist.csv: emits a header + one line per entry, escapes names.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import therapyFleetRouter from "./therapy-fleet";

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
  app.use(therapyFleetRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/therapy-fleet/overview", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/therapy-fleet/overview");
    expect(res.status).toBe(401);
  });

  it("400s on out-of-range windowDays", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/overview?windowDays=900",
    );
    expect(res.status).toBe(400);
  });

  it("coerces the single RPC row into nested KPIs and passes the window", async () => {
    mockAdmin.current = ADMIN;
    // PostgREST returns bigint/numeric as strings — exercise coercion.
    stageSupabaseRpcResponse("therapy_fleet_overview", {
      data: [
        {
          patients_with_data: "120",
          compliant: "70",
          at_risk: "25",
          non_compliant: "15",
          no_recent_data: "10",
          high_ahi: "8",
          high_leak: "12",
          low_usage: "18",
          avg_usage_minutes: "352.4",
          avg_ahi: "3.10",
          avg_leak_l_min: "18.6",
          total_nights: "2890",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/overview?windowDays=30",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.overview.patientsWithData).toBe(120);
    expect(res.body.overview.cohorts).toEqual({
      compliant: 70,
      atRisk: 25,
      nonCompliant: 15,
      noRecentData: 10,
    });
    expect(res.body.overview.clinicalFlags).toEqual({
      highAhi: 8,
      highLeak: 12,
      lowUsage: 18,
    });
    expect(res.body.overview.averages.usageMinutes).toBe(352.4);
    expect(res.body.overview.averages.ahi).toBe(3.1);
    expect(res.body.overview.totalNights).toBe(2890);
    expect(getSupabaseRpcArgs("therapy_fleet_overview")[0]).toEqual({
      p_window_days: 30,
    });
  });

  it("defaults missing/empty RPC data to zeros", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_fleet_overview", { data: [] });
    const res = await request(makeApp()).get("/admin/therapy-fleet/overview");
    expect(res.status).toBe(200);
    expect(res.body.overview.patientsWithData).toBe(0);
    expect(res.body.overview.averages.ahi).toBeNull();
  });
});

describe("GET /admin/therapy-fleet/worklist", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/therapy-fleet/worklist");
    expect(res.status).toBe(401);
  });

  it("maps RPC rows + attaches patient names", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [
        {
          patient_id: P1,
          nights_with_data: "12",
          nights_over_4h: "8",
          avg_usage_minutes: "201.5",
          avg_ahi: "6.40",
          avg_leak_l_min: "30.2",
          prior_avg_usage_minutes: "340.0",
          last_night_date: "2026-05-29",
          days_since_last_night: "2",
          reasons: [
            "compliance_risk",
            "high_ahi",
            "high_leak",
            "usage_decline",
          ],
          priority: "90",
        },
        {
          patient_id: P2,
          nights_with_data: "0",
          nights_over_4h: "0",
          avg_usage_minutes: null,
          avg_ahi: null,
          avg_leak_l_min: null,
          prior_avg_usage_minutes: "300.0",
          last_night_date: "2026-05-10",
          days_since_last_night: "21",
          reasons: ["no_recent_data"],
          priority: "30",
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
      "/admin/therapy-fleet/worklist?windowDays=30&limit=50",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.entries[0]).toMatchObject({
      patientId: P1,
      patientName: "Ada Lovelace",
      nightsOver4h: 8,
      avgAhi: 6.4,
      avgLeakLMin: 30.2,
      priority: 90,
      reasons: ["compliance_risk", "high_ahi", "high_leak", "usage_decline"],
    });
    expect(res.body.entries[1].patientName).toBe("Grace Hopper");
    // includeHandled defaults to false, so the route over-fetches
    // (limit*4, capped 500) to refill the page after hiding handled rows.
    expect(getSupabaseRpcArgs("therapy_fleet_worklist")[0]).toEqual({
      p_window_days: 30,
      p_limit: 200,
    });
  });

  it("filters by a single reason", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [
        {
          patient_id: P1,
          nights_with_data: "20",
          nights_over_4h: "20",
          avg_usage_minutes: "250",
          avg_ahi: "2.0",
          avg_leak_l_min: "30.0",
          prior_avg_usage_minutes: null,
          last_night_date: "2026-05-29",
          days_since_last_night: "2",
          reasons: ["high_leak"],
          priority: "15",
        },
        {
          patient_id: P2,
          nights_with_data: "5",
          nights_over_4h: "3",
          avg_usage_minutes: "120",
          avg_ahi: "2.0",
          avg_leak_l_min: "10.0",
          prior_avg_usage_minutes: null,
          last_night_date: "2026-05-29",
          days_since_last_night: "2",
          reasons: ["compliance_risk"],
          priority: "40",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P1, legal_first_name: "Ada", legal_last_name: "Lovelace" }],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/worklist?reason=high_leak",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].patientId).toBe(P1);
  });
});

describe("GET /admin/therapy-fleet/worklist.csv", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/worklist.csv",
    );
    expect(res.status).toBe(401);
  });

  it("emits a CSV header + one row per entry", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [
        {
          patient_id: P1,
          nights_with_data: "12",
          nights_over_4h: "8",
          avg_usage_minutes: "201.5",
          avg_ahi: "6.40",
          avg_leak_l_min: "30.2",
          prior_avg_usage_minutes: "340.0",
          last_night_date: "2026-05-29",
          days_since_last_night: "2",
          reasons: ["compliance_risk", "high_ahi"],
          priority: "65",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P1, legal_first_name: "Ada", legal_last_name: "Lovelace" }],
    });
    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/worklist.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toContain("patient_id,patient_name,priority,reasons");
    expect(lines[1]).toContain(P1);
    expect(lines[1]).toContain("Ada Lovelace");
    // Multi-reason cell is pipe-joined within one CSV field.
    expect(lines[1]).toContain("compliance_risk|high_ahi");
  });
});

describe("GET /admin/therapy-fleet/worklist — triage state", () => {
  function stageTwoRowRpc() {
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [
        {
          patient_id: P1,
          nights_with_data: "12",
          nights_over_4h: "8",
          avg_usage_minutes: "201.5",
          avg_ahi: "6.40",
          avg_leak_l_min: "30.2",
          prior_avg_usage_minutes: "340.0",
          last_night_date: "2026-05-29",
          days_since_last_night: "2",
          reasons: ["compliance_risk"],
          priority: "40",
        },
        {
          patient_id: P2,
          nights_with_data: "10",
          nights_over_4h: "9",
          avg_usage_minutes: "220",
          avg_ahi: "3.0",
          avg_leak_l_min: "10.0",
          prior_avg_usage_minutes: null,
          last_night_date: "2026-05-29",
          days_since_last_night: "2",
          reasons: ["compliance_risk"],
          priority: "40",
        },
      ],
    });
  }

  it("hides resolved + actively-snoozed patients by default and attaches action state", async () => {
    mockAdmin.current = ADMIN;
    stageTwoRowRpc();
    // P1 is resolved (hidden); P2 has an elapsed snooze (visible).
    stageSupabaseResponse("patient_worklist_actions", "select", {
      data: [
        {
          patient_id: P1,
          status: "resolved",
          snooze_until: null,
          note: null,
          updated_by_email: "csr@x",
          updated_at: "2026-05-30T00:00:00Z",
        },
        {
          patient_id: P2,
          status: "snoozed",
          snooze_until: "2000-01-01",
          note: "called",
          updated_by_email: "csr@x",
          updated_at: "2026-05-30T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P2, legal_first_name: "Grace", legal_last_name: "Hopper" }],
    });
    const res = await request(makeApp()).get("/admin/therapy-fleet/worklist");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].patientId).toBe(P2);
    expect(res.body.entries[0].action).toMatchObject({
      status: "snoozed",
      note: "called",
    });
  });

  it("includeHandled=true returns handled patients too", async () => {
    mockAdmin.current = ADMIN;
    stageTwoRowRpc();
    stageSupabaseResponse("patient_worklist_actions", "select", {
      data: [
        {
          patient_id: P1,
          status: "resolved",
          snooze_until: null,
          note: null,
          updated_by_email: null,
          updated_at: null,
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
      "/admin/therapy-fleet/worklist?includeHandled=true",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe("POST /admin/therapy-fleet/worklist/:patientId/action", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/therapy-fleet/worklist/${P1}/action`)
      .send({ action: "contacted" });
    expect(res.status).toBe(401);
  });

  it("404s on a non-uuid patient id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/therapy-fleet/worklist/not-a-uuid/action")
      .send({ action: "contacted" });
    expect(res.status).toBe(404);
  });

  it("400s when snoozed without snoozeUntil", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/therapy-fleet/worklist/${P1}/action`)
      .send({ action: "snoozed" });
    expect(res.status).toBe(400);
  });

  it("404s when the patient does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/therapy-fleet/worklist/${P1}/action`)
      .send({ action: "contacted" });
    expect(res.status).toBe(404);
  });

  it("upserts the action + audits without leaking the note", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: P1 } });
    stageSupabaseResponse("patient_worklist_actions", "upsert", {
      error: null,
    });
    const res = await request(makeApp())
      .post(`/admin/therapy-fleet/worklist/${P1}/action`)
      .send({
        action: "snoozed",
        snoozeUntil: "2026-06-15",
        note: "AHI 9 — called, will recheck",
      });
    expect(res.status).toBe(200);
    expect(res.body.action).toMatchObject({
      status: "snoozed",
      snoozeUntil: "2026-06-15",
      note: "AHI 9 — called, will recheck",
    });

    const upserts = getSupabaseWritePayloads(
      "patient_worklist_actions",
      "upsert",
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      patient_id: P1,
      status: "snoozed",
      snooze_until: "2026-06-15",
      note: "AHI 9 — called, will recheck",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("therapy.worklist.action.set");
    expect(audit.metadata).toMatchObject({
      patient_id: P1,
      status: "snoozed",
      snooze_until: "2026-06-15",
      has_note: true,
    });
    // The note body must never reach the audit log.
    expect(JSON.stringify(audit.metadata)).not.toContain("recheck");
  });

  it("clears snooze_until when the action is not 'snoozed'", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: P1 } });
    stageSupabaseResponse("patient_worklist_actions", "upsert", {
      error: null,
    });
    const res = await request(makeApp())
      .post(`/admin/therapy-fleet/worklist/${P1}/action`)
      .send({ action: "contacted", snoozeUntil: "2026-06-15" });
    expect(res.status).toBe(200);
    expect(res.body.action.snoozeUntil).toBeNull();
    const upserts = getSupabaseWritePayloads(
      "patient_worklist_actions",
      "upsert",
    );
    expect(upserts[0]).toMatchObject({
      status: "contacted",
      snooze_until: null,
    });
  });
});
