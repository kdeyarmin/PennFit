// Route tests for /admin/patients/:id/same-or-similar.
//
// Focus: the GET handler now enriches each cached check with the computed
// RUL `window` from the pure domain rule (evaluateSameOrSimilar), so the
// stored last-dispense date drives a "clears on <date>" the SPA can show.

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

import sameOrSimilarRouter from "./same-or-similar";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(sameOrSimilarRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  logAuditMock.mockClear();
  supabaseMock.reset();
});

describe("GET /admin/patients/:id/same-or-similar", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/same-or-similar`,
    );
    expect(res.status).toBe(401);
  });

  it("computes an active RUL window from a recent last_dispense_on", () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    stageSupabaseResponse("medicare_same_or_similar_checks", "select", {
      data: [
        {
          id: "c1",
          patient_id: PATIENT_ID,
          hcpcs_code: "E0601",
          status: "active",
          last_dispense_on: recent,
          checked_at: "2026-06-01T00:00:00Z",
        },
      ],
    });
    return request(makeApp())
      .get(`/admin/patients/${PATIENT_ID}/same-or-similar`)
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body.checks).toHaveLength(1);
        expect(res.body.checks[0].window.status).toBe("active");
        expect(res.body.checks[0].window.blocked).toBe(true);
        expect(res.body.checks[0].window.clearsOn).toBeTruthy();
        expect(res.body.checks[0].window.daysUntilClear).toBeGreaterThan(0);
      });
  });

  it("reports a clear window when there is no last_dispense_on", () => {
    mockAdmin.current = { userId: "u_1", email: "a@a", role: "admin" };
    stageSupabaseResponse("medicare_same_or_similar_checks", "select", {
      data: [
        {
          id: "c2",
          patient_id: PATIENT_ID,
          hcpcs_code: "E0601",
          status: "unknown",
          last_dispense_on: null,
          checked_at: "2026-06-01T00:00:00Z",
        },
      ],
    });
    return request(makeApp())
      .get(`/admin/patients/${PATIENT_ID}/same-or-similar`)
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body.checks[0].window.status).toBe("clear");
        expect(res.body.checks[0].window.blocked).toBe(false);
      });
  });
});
