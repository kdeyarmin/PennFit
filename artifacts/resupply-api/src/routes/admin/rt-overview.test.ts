// Tests for /admin/rt-overview + /admin/rt-overview.csv.

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

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import rtOverviewRouter from "./rt-overview";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "rt@penn.example.com",
  role: "admin",
};

const P1 = "p1111111-1111-4111-8111-111111111111";
const P2 = "p2222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", rtOverviewRouter);
  return app;
}

beforeEach(() => {
  logAuditMock.mockClear();
  mockAdmin.current = ADMIN;
  supabaseMock.reset();
});

describe("GET /admin/rt-overview", () => {
  it("401s without admin auth", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get("/resupply-api/admin/rt-overview");
    expect(res.status).toBe(401);
  });

  it("400s on an out-of-range window", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/admin/rt-overview?days=500",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("returns an empty fleet when no patient has an active therapy link", async () => {
    stageSupabaseResponse("patient_therapy_links", "select", { data: [] });
    const res = await request(makeApp()).get("/resupply-api/admin/rt-overview");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.summary).toEqual({
      totalActive: 0,
      totalAlerting: 0,
      totalStale: 0,
    });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });

  it("composes per-patient rows with alerts + averages + sort order", async () => {
    stageSupabaseResponse("patient_therapy_links", "select", {
      data: [
        {
          patient_id: P1,
          source: "airview",
          status: "active",
          last_synced_at: "2026-05-17T03:00:00Z",
          last_sync_status: "ok",
        },
        {
          patient_id: P2,
          source: "care_orchestrator",
          status: "active",
          last_synced_at: "2026-05-17T03:00:00Z",
          last_sync_status: "ok",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: P1,
          pacware_id: "PW-001",
          legal_first_name: "Alice",
          legal_last_name: "Adams",
        },
        {
          id: P2,
          pacware_id: "PW-002",
          legal_first_name: "Bob",
          legal_last_name: "Brown",
        },
      ],
    });
    // Alice: 3 nights with ahi=2,4,6 → avg 4.0; leak avg 12
    // Bob: 0 nights in window (stale)
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          patient_id: P1,
          night_date: "2026-05-15",
          usage_minutes: 360,
          ahi: "2.0",
          leak_rate_l_min: "10",
        },
        {
          patient_id: P1,
          night_date: "2026-05-16",
          usage_minutes: 420,
          ahi: "4.0",
          leak_rate_l_min: "12",
        },
        {
          patient_id: P1,
          night_date: "2026-05-17",
          usage_minutes: 480,
          ahi: "6.0",
          leak_rate_l_min: "14",
        },
      ],
    });
    // Bob has an active alert; Alice has none. Bob should sort to top
    // by the alerting-first rule, even though he has no nights.
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: [
        {
          patient_id: P2,
          kind: "leak_rising",
          detected_at: "2026-05-15T02:00:00Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/resupply-api/admin/rt-overview");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    // Bob (alerting) sorts before Alice (no alerts).
    expect(res.body.rows[0].patientId).toBe(P2);
    expect(res.body.rows[0].activeAlerts).toEqual([
      {
        kind: "leak_rising",
        label: "Leak rising",
        detectedAt: "2026-05-15T02:00:00Z",
      },
    ]);
    expect(res.body.rows[1].patientId).toBe(P1);
    expect(res.body.rows[1].nightsInWindow).toBe(3);
    expect(res.body.rows[1].ahiAvg).toBe(4);
    expect(res.body.rows[1].leakAvg).toBe(12);
    expect(res.body.rows[1].usageMinutesAvg).toBe(420);
    expect(res.body.summary.totalActive).toBe(1);
    expect(res.body.summary.totalAlerting).toBe(1);
    // Bob has a link but no nights in window → stale
    expect(res.body.summary.totalStale).toBe(1);
  });

  it("audit row is counts-only (never contains patient ids or PHI)", async () => {
    stageSupabaseResponse("patient_therapy_links", "select", {
      data: [
        {
          patient_id: P1,
          source: "airview",
          status: "active",
          last_synced_at: null,
          last_sync_status: null,
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: P1,
          pacware_id: "PW-001",
          legal_first_name: "Alice",
          legal_last_name: "Adams",
        },
      ],
    });
    await request(makeApp()).get("/resupply-api/admin/rt-overview");
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("admin.rt_overview.read");
    const meta = JSON.stringify(audit.metadata);
    expect(meta).not.toContain("Alice");
    expect(meta).not.toContain("PW-001");
    expect(meta).not.toContain(P1);
    expect(audit.metadata.window_days).toBe(7);
  });
});

describe("GET /admin/rt-overview.csv", () => {
  it("returns a CSV attachment with header + escaped cells", async () => {
    stageSupabaseResponse("patient_therapy_links", "select", {
      data: [
        {
          patient_id: P1,
          source: "airview",
          status: "active",
          last_synced_at: null,
          last_sync_status: null,
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: P1,
          pacware_id: "PW-001",
          // Name contains a comma — must be quote-escaped per RFC 4180.
          legal_first_name: "Alice, Jr.",
          legal_last_name: "Adams",
        },
      ],
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: [],
    });

    const res = await request(makeApp()).get(
      "/resupply-api/admin/rt-overview.csv",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="rt-overview-/);
    const lines = (res.text as string).split("\n").filter((l) => l.length);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "pacware_id,last_name,first_name,nights_in_window,last_night_date,stale_days,ahi_avg,leak_avg,usage_minutes_avg,active_alerts,therapy_link_sources",
    );
    // Quote-wrap around "Alice, Jr." preserves the embedded comma.
    expect(lines[1]).toContain('"Alice, Jr."');
  });
});
