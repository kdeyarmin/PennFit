// Tests for routes/admin/patient-access-log.ts — the Audit Trail report.

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
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import patientAccessLogRouter from "./patient-access-log";

const ADMIN: MockAdminCtx = {
  userId: "u_admin_1",
  email: "ops@penn.example.com",
  role: "admin",
};
const AGENT: MockAdminCtx = {
  userId: "u_agent_1",
  email: "csr@penn.example.com",
  role: "agent",
};

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientAccessLogRouter);
  return app;
}

function stageRow(overrides: Record<string, unknown> = {}) {
  stageSupabaseResponse("patient_access_log", "select", {
    data: [
      {
        id: "row-1",
        admin_user_id: ADMIN.userId,
        admin_email: ADMIN.email,
        admin_role: "admin",
        action: "patients.view",
        method: "GET",
        path: `/resupply-api/patients/${PATIENT_ID}`,
        target_table: "patients",
        target_id: PATIENT_ID,
        patient_id: PATIENT_ID,
        status_code: 200,
        ip: "10.0.0.1",
        user_agent: "Mozilla/5.0",
        impersonator_user_id: null,
        occurred_at: "2026-06-20T15:00:00.000Z",
        ...overrides,
      },
    ],
    count: 1,
    error: null,
  });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/patient-access-log — access control", () => {
  it("401s when no session is present", async () => {
    const res = await request(makeApp()).get("/admin/patient-access-log");
    expect(res.status).toBe(401);
  });

  it("403s for a customer-service agent (admins only)", async () => {
    mockAdmin.current = AGENT;
    const res = await request(makeApp()).get("/admin/patient-access-log");
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/patient-access-log — JSON report", () => {
  it("returns rows with a resolved patient name", async () => {
    mockAdmin.current = ADMIN;
    stageRow();
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Pat",
          legal_last_name: "Example",
        },
      ],
      error: null,
    });

    const res = await request(makeApp()).get("/admin/patient-access-log");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      adminEmail: ADMIN.email,
      action: "patients.view",
      patientId: PATIENT_ID,
      patientName: "Pat Example",
      statusCode: 200,
    });
  });

  it("applies time-frame / employee / patient filters to the query", async () => {
    mockAdmin.current = ADMIN;
    stageRow();
    const res = await request(makeApp()).get(
      "/admin/patient-access-log" +
        "?from=2026-06-01&to=2026-06-20" +
        `&adminEmail=ops&patientId=${PATIENT_ID}&action=view`,
    );
    expect(res.status).toBe(200);

    const filters = getSupabaseFilterCalls("patient_access_log", "select");
    const verbs = filters.map((f) => f.verb);
    // org scope + time window + the three user filters + order/range.
    expect(verbs).toContain("gte"); // from
    expect(verbs).toContain("lte"); // to
    expect(verbs).toContain("ilike"); // adminEmail / action contains
    expect(
      filters.some((f) => f.verb === "eq" && f.args[0] === "patient_id"),
    ).toBe(true);
    // `to` was a date-only value → snapped to end-of-day inclusive.
    const lte = filters.find((f) => f.verb === "lte");
    expect(String(lte?.args[1])).toContain("2026-06-20T23:59:59");
  });

  it("rejects an out-of-range limit with 400", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/patient-access-log?limit=99999",
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable date with 400 (does not silently widen the window)", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/patient-access-log?from=notadate",
    );
    expect(res.status).toBe(400);
  });

  it("escapes ilike wildcards in adminEmail so they match literally", async () => {
    mockAdmin.current = ADMIN;
    stageRow();
    const res = await request(makeApp()).get(
      "/admin/patient-access-log?adminEmail=" + encodeURIComponent("ops%_x"),
    );
    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("patient_access_log", "select");
    const ilike = filters.find(
      (f) => f.verb === "ilike" && f.args[0] === "admin_email",
    );
    expect(ilike?.args[1]).toBe("%ops\\%\\_x%");
  });
});

describe("GET /admin/patient-access-log — CSV export", () => {
  it("streams a CSV attachment with a header row", async () => {
    mockAdmin.current = ADMIN;
    stageRow();
    stageSupabaseResponse("patients", "select", { data: [], error: null });

    const res = await request(makeApp()).get(
      "/admin/patient-access-log?format=csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain("audit-trail-");
    const [header] = res.text.split("\r\n");
    expect(header).toBe(
      "occurred_at,admin_email,admin_role,action,method,path,target_table,target_id,patient_id,patient_name,status_code,ip,user_agent,impersonator_user_id",
    );
    expect(res.text).toContain("patients.view");
  });
});
