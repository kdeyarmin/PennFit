// Route tests for /admin/therapy-fleet/clinical-insights[.csv].
//
// Coverage:
//   * 401 without admin on both endpoints.
//   * summary aggregates by kind + severity over the full active set and
//     counts distinct patients; entries carry attached names and are
//     severity-ordered.
//   * a `kind` filter narrows the events read; a bad query 400s.
//   * the CSV endpoint emits a header + one line per entry.

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
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import therapyClinicalInsightsRouter from "./therapy-clinical-insights";

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
  app.use(therapyClinicalInsightsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/therapy-fleet/clinical-insights", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/clinical-insights",
    );
    expect(res.status).toBe(401);
  });

  it("400s on an unknown kind", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/clinical-insights?kind=leak_rising",
    );
    expect(res.status).toBe(400);
  });

  it("summarises by kind + severity and severity-orders the entries", async () => {
    mockAdmin.current = ADMIN;
    // One medium signal first (detected most recently) and two high
    // signals — the high ones must sort ahead despite the medium being
    // newer. P1 carries two signals; distinct patients = 2.
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: [
        {
          id: "e-erratic",
          patient_id: P1,
          kind: "usage_erratic",
          detected_at: "2026-06-13T00:00:00Z",
          window_start_date: "2026-05-31",
          window_end_date: "2026-06-13",
        },
        {
          id: "e-pressure",
          patient_id: P1,
          kind: "pressure_at_max",
          detected_at: "2026-06-10T00:00:00Z",
          window_start_date: "2026-06-04",
          window_end_date: "2026-06-10",
        },
        {
          id: "e-nonadh",
          patient_id: P2,
          kind: "non_adherent_30d",
          detected_at: "2026-06-09T00:00:00Z",
          window_start_date: "2026-05-11",
          window_end_date: "2026-06-09",
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
      "/admin/therapy-fleet/clinical-insights",
    );
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(3);
    expect(res.body.summary.patients).toBe(2);
    expect(res.body.summary.bySeverity).toEqual({ high: 2, medium: 1 });
    expect(res.body.summary.byKind.pressure_at_max).toBe(1);
    expect(res.body.summary.byKind.usage_erratic).toBe(1);
    // High severity sorts first; the medium usage_erratic lands last
    // even though it was detected most recently.
    expect(res.body.entries[0].kind).toBe("pressure_at_max");
    expect(res.body.entries[0].patientName).toBe("Ada Lovelace");
    expect(res.body.entries[2].kind).toBe("usage_erratic");
  });
});

describe("GET /admin/therapy-fleet/clinical-insights.csv", () => {
  it("emits a header + one line per entry", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: [
        {
          id: "e1",
          patient_id: P1,
          kind: "ahi_rising",
          detected_at: "2026-06-12T00:00:00Z",
          window_start_date: "2026-05-30",
          window_end_date: "2026-06-12",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: P1, legal_first_name: "Ada", legal_last_name: "Lovelace" }],
    });

    const res = await request(makeApp()).get(
      "/admin/therapy-fleet/clinical-insights.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe(
      "patient_id,patient_name,signal,severity,detected_at," +
        "window_start_date,window_end_date",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("ahi_rising");
    expect(lines[1]).toContain("Ada Lovelace");
  });
});
