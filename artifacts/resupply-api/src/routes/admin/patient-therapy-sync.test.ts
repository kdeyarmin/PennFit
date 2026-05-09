// Route tests for /admin/patients/:id/therapy-nights[/sync]
// (Phase E.1).
//
// Coverage:
//   * 401 without admin
//   * GET returns nights ordered DESC; numeric coercion correct
//   * POST sync: 503 when adapter unconfigured; 502 on adapter
//     throw; happy-path imports + audits with non-PHI envelope.

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

type MockNight = {
  nightDate: string;
  sourceEventId: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
  pressureP95Cmh2o: number | null;
};
const adapterState = vi.hoisted(
  (): {
    configured: boolean;
    fetch: () => Promise<{ nights: MockNight[]; hasMore: boolean }>;
  } => ({
    configured: true,
    fetch: async () => ({ nights: [], hasMore: false }),
  }),
);
vi.mock("../../lib/therapy-cloud", () => ({
  adapterFor: () => ({
    source: "resmed_airview",
    get configured() {
      return adapterState.configured;
    },
    fetchNights: (...args: unknown[]) => adapterState.fetch(...(args as [])),
  }),
}));

import patientTherapySyncRouter from "./patient-therapy-sync";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientTherapySyncRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  adapterState.configured = true;
  adapterState.fetch = async () => ({ nights: [], hasMore: false });
});

describe("GET /admin/patients/:id/therapy-nights", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/therapy-nights`,
    );
    expect(res.status).toBe(401);
  });

  it("coerces numerics to JS numbers and returns DESC by night_date", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          id: "n_2",
          night_date: "2026-05-04",
          source: "resmed_airview",
          usage_minutes: 415,
          ahi: "1.20",
          leak_rate_l_min: "12.40",
          pressure_p95_cmh2o: "10.50",
        },
        {
          id: "n_1",
          night_date: "2026-05-03",
          source: "resmed_airview",
          usage_minutes: 390,
          ahi: null,
          leak_rate_l_min: null,
          pressure_p95_cmh2o: null,
        },
      ],
    });
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/therapy-nights`,
    );
    expect(res.status).toBe(200);
    expect(res.body.nights).toHaveLength(2);
    // Non-null numerics coerced through Number() — 1.20 → 1.2.
    expect(res.body.nights[0].ahi).toBe(1.2);
    expect(res.body.nights[0].leakRateLMin).toBe(12.4);
    // Null numerics pass through cleanly.
    expect(res.body.nights[1].ahi).toBeNull();
  });
});

describe("POST /admin/patients/:id/therapy-nights/sync", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({ source: "resmed_airview", partnerPatientId: "abc" });
    expect(res.status).toBe(401);
  });

  it("503s when the adapter is unconfigured", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    adapterState.configured = false;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({ source: "resmed_airview", partnerPatientId: "abc" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("therapy_cloud_not_configured");
  });

  it("502s on adapter throw, no partial writes", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    adapterState.fetch = async () => {
      throw new Error("upstream-down");
    };
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({ source: "resmed_airview", partnerPatientId: "abc" });
    expect(res.status).toBe(502);
    expect(getSupabaseWritePayloads("patient_therapy_nights", "upsert"))
      .toEqual([]);
  });

  it("imports + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    adapterState.fetch = async () => ({
      nights: [
        {
          nightDate: "2026-05-04",
          sourceEventId: "evt_1",
          usageMinutes: 415,
          ahi: 1.2,
          leakRateLMin: 12.4,
          pressureP95Cmh2o: 10.5,
        },
        {
          nightDate: "2026-05-03",
          sourceEventId: "evt_2",
          usageMinutes: 390,
          ahi: null,
          leakRateLMin: null,
          pressureP95Cmh2o: null,
        },
      ],
      hasMore: false,
    });
    stageSupabaseResponse("patient_therapy_nights", "upsert", { error: null });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({
        source: "resmed_airview",
        partnerPatientId: "abc",
        sinceDate: "2026-05-01",
      });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.source).toBe("resmed_airview");

    // The route uses bulk upsert: a SINGLE call passing the whole
    // array, not one call per row. That's why writePayloads returns
    // length 1 with an array payload.
    const upserts = getSupabaseWritePayloads(
      "patient_therapy_nights",
      "upsert",
    );
    expect(upserts).toHaveLength(1);
    const rows = upserts[0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      patient_id: PATIENT_ID,
      night_date: "2026-05-04",
      source: "resmed_airview",
      source_event_id: "evt_1",
      usage_minutes: 415,
      // numeric columns serialized as strings; the adapter contract
      // lets the route translate.
      ahi: "1.2",
      leak_rate_l_min: "12.4",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.therapy_nights.sync");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      source: "resmed_airview",
      import_count: 2,
      since_date: "2026-05-01",
    });
    // No PHI in the envelope: no usage / AHI / leak fields.
    expect(JSON.stringify(audit.metadata)).not.toContain("415");
    expect(JSON.stringify(audit.metadata)).not.toContain("1.2");
  });
});
