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

import patientTherapySnapshotRouter, {
  buildTherapySnapshot,
  type SnapshotNight,
} from "./patient-therapy-snapshot";

// CSR holds patients.read; RT does too. fitter/fulfillment map to the
// same effective role, so patients.read is the right CSR-serving gate.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

const PATIENT_ID = "patient_1";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientTherapySnapshotRouter);
  return app;
}

function night(over: Partial<SnapshotNight>): SnapshotNight {
  return {
    nightDate: "2026-06-01",
    usageMinutes: 300,
    ahi: 3,
    leakLMin: 10,
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildTherapySnapshot (pure)", () => {
  it("aggregates usage/compliance/AHI/leak and freshness", () => {
    const snap = buildTherapySnapshot(
      [
        night({ nightDate: "2026-06-01", usageMinutes: 300 }), // compliant
        night({ nightDate: "2026-06-02", usageMinutes: 180 }), // not compliant
        night({ nightDate: "2026-06-03", usageMinutes: 480 }), // compliant
      ],
      30,
      "2026-06-05",
    );
    expect(snap.hasData).toBe(true);
    expect(snap.nightsWithData).toBe(3);
    expect(snap.compliantNights).toBe(2);
    expect(snap.complianceRatePct).toBe(66.7);
    expect(snap.avgUsageHours).toBe(5.3); // (300+180+480)/3/60 = 5.33h
    expect(snap.lastNightDate).toBe("2026-06-03");
    expect(snap.staleDays).toBe(2); // 06-03 → 06-05
  });

  it("dedups duplicate dates and ignores null usage in averages", () => {
    const snap = buildTherapySnapshot(
      [
        night({ nightDate: "2026-06-01", usageMinutes: 300 }),
        night({ nightDate: "2026-06-01", usageMinutes: 999 }), // dup — dropped
        night({ nightDate: "2026-06-02", usageMinutes: null }),
      ],
      30,
      "2026-06-03",
    );
    expect(snap.nightsWithData).toBe(2);
    expect(snap.avgUsageHours).toBe(5); // only the 300-min night counts
    expect(snap.compliantNights).toBe(1);
  });

  it("returns hasData=false with no nights", () => {
    const snap = buildTherapySnapshot([], 30, "2026-06-03");
    expect(snap.hasData).toBe(false);
    expect(snap.complianceRatePct).toBeNull();
    expect(snap.staleDays).toBeNull();
  });
});

describe("GET /admin/patients/:id/therapy-snapshot", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/therapy-snapshot`,
    );
    expect(res.status).toBe(401);
  });

  it("returns the snapshot for a CSR (patients.read)", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          night_date: "2026-06-03",
          usage_minutes: 480,
          ahi: 2,
          leak_rate_l_min: 8,
        },
        {
          night_date: "2026-06-02",
          usage_minutes: 180,
          ahi: 4,
          leak_rate_l_min: 14,
        },
        {
          night_date: "2026-06-01",
          usage_minutes: 300,
          ahi: 3,
          leak_rate_l_min: 10,
        },
      ],
    });
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/therapy-snapshot`,
    );
    expect(res.status).toBe(200);
    expect(res.body.patientId).toBe(PATIENT_ID);
    expect(res.body.hasData).toBe(true);
    expect(res.body.nightsWithData).toBe(3);
    expect(res.body.compliantNights).toBe(2);
  });
});
