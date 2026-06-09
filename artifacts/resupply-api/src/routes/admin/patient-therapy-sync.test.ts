// Route tests for /admin/patients/:id/therapy-nights[/sync]
// (Phase E.1).
//
// Coverage:
//   * 401 without admin
//   * GET returns nights ordered DESC; numeric coercion correct
//   * POST sync: 503 when adapter unconfigured; 502 on adapter
//     throw; happy-path imports + audits with non-PHI envelope.
//
// PR change (adminRateLimit removal):
//   * POST /admin/patients/:id/therapy-nights/sync had adminRateLimit
//     removed. Verify the spy is never called and no 429 is returned.

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

// ── adminRateLimit spy — verifies it is NOT called ───────────────────────────
// adminRateLimit was removed from this route in this PR. Mock the module so we
// can assert the factory is never invoked.
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn(
    (_opts: { name: string; preset?: string }) =>
      (
        _req: import("express").Request,
        _res: import("express").Response,
        next: import("express").NextFunction,
      ) => {
        next();
      },
  ),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

type MockNight = {
  nightDate: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
  pressureP95Cmh2o: number | null;
};
type FetchResult =
  | { ok: true; snapshot: Record<string, unknown> }
  | { ok: false; error: string };

// Build a valid IntegrationSnapshot (matches integrationSnapshotSchema)
// from a bare list of nights so the route's real normalize+validate+
// persist path runs against the supabase mock.
function snapshotFromNights(nights: MockNight[]): {
  ok: true;
  snapshot: Record<string, unknown>;
} {
  return {
    ok: true,
    snapshot: {
      source: "resmed_airview",
      partnerPatientId: "abc",
      settings: null,
      compliance: null,
      recentNights: nights,
      supplies: [],
    },
  };
}

const adapterState = vi.hoisted(
  (): {
    availability: "configured" | "stub" | "unavailable";
    fetch: () => Promise<FetchResult>;
  } => ({
    availability: "configured",
    fetch: async () => snapshotFromNights([]),
  }),
);
vi.mock("../../lib/integrations/registry", () => ({
  getIntegrationAdaptersWithDbOverrides: async () =>
    new Map([
      [
        "resmed_airview",
        {
          source: "resmed_airview",
          availability: () =>
            adapterState.availability === "unavailable"
              ? { status: "unavailable", reason: "no_credentials" }
              : adapterState.availability === "stub"
                ? { status: "stub", reason: "no_credentials" }
                : { status: "configured" },
          fetchSnapshot: (...args: unknown[]) =>
            adapterState.fetch(...(args as [])),
        },
      ],
    ]),
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
  adminRateLimitSpy.mockClear();
  logAuditMock.mockClear();
  adapterState.availability = "configured";
  adapterState.fetch = async () => snapshotFromNights([]);
});

// ── PR change: verify adminRateLimit is NOT invoked ─────────────────────────

describe("POST /admin/patients/:id/therapy-nights/sync — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called (middleware was removed from this route)", async () => {
    // Send any request through the router; the spy should remain uncalled
    // because the route file no longer imports or registers adminRateLimit.
    await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({ source: "resmed_airview", partnerPatientId: "abc" });
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    adapterState.fetch = async () => snapshotFromNights([]);
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({ source: "resmed_airview", partnerPatientId: "abc" });
    expect(res.status).not.toBe(429);
  });
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

  it("503s when the adapter is unavailable", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    adapterState.availability = "unavailable";
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
    expect(
      getSupabaseWritePayloads("patient_therapy_nights", "upsert"),
    ).toEqual([]);
  });

  it("502s when the adapter reports an error result", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    adapterState.fetch = async () => ({ ok: false, error: "auth_failed" });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({ source: "resmed_airview", partnerPatientId: "abc" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("therapy_cloud_fetch_failed");
    expect(
      getSupabaseWritePayloads("patient_therapy_nights", "upsert"),
    ).toEqual([]);
  });

  it("imports + audits with non-PHI envelope (all-null nights skipped)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    adapterState.fetch = async () =>
      snapshotFromNights([
        {
          nightDate: "2026-05-04",
          usageMinutes: 415,
          ahi: 1.2,
          leakRateLMin: 12.4,
          pressureP95Cmh2o: 10.5,
        },
        {
          // All-null night: persistTherapyNights skips it so a
          // no-data stub row doesn't pollute the compliance window.
          nightDate: "2026-05-03",
          usageMinutes: null,
          ahi: null,
          leakRateLMin: null,
          pressureP95Cmh2o: null,
        },
      ]);
    stageSupabaseResponse("patient_therapy_nights", "upsert", { error: null });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-nights/sync`)
      .send({
        source: "resmed_airview",
        partnerPatientId: "abc",
        sinceDate: "2026-05-01",
      });

    expect(res.status).toBe(200);
    // Only the night carrying data is persisted; the all-null night
    // is skipped by the shared persistence helper.
    expect(res.body.imported).toBe(1);
    expect(res.body.source).toBe("resmed_airview");

    // persistTherapyNights batches a chunk: a SINGLE upsert call
    // passing the deduped array of rows that carried data.
    const upserts = getSupabaseWritePayloads(
      "patient_therapy_nights",
      "upsert",
    );
    expect(upserts).toHaveLength(1);
    const rows = upserts[0] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patient_id: PATIENT_ID,
      night_date: "2026-05-04",
      source: "resmed_airview",
      // source_event_id is derived deterministically as source:night.
      source_event_id: "resmed_airview:2026-05-04",
      usage_minutes: 415,
      // numeric columns serialized as strings.
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
      import_count: 1,
      since_date: "2026-05-01",
    });
    // No PHI in the envelope: no usage / AHI / leak fields.
    expect(JSON.stringify(audit.metadata)).not.toContain("415");
    expect(JSON.stringify(audit.metadata)).not.toContain("1.2");
  });
});
