// Tests for the collections-worklist transition routes
// (pause / resolve / cancel). Coverage focuses on two fixed defects:
//   1. A transition on an unknown / cross-tenant run id must 404 and NOT
//      log a dunning event (PostgREST reports no error on a zero-row
//      update, which previously produced a phantom event + false success).
//   2. The logged dunning event must carry a distinct, schema-valid
//      outcome per action (cancel no longer shares "paused" with pause)
//      and the run's actual ladder step (not a hardcoded "statement").

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
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const isFeatureEnabledMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import collectionsWorklistRouter from "./collections-worklist";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(collectionsWorklistRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  isFeatureEnabledMock.mockClear();
  isFeatureEnabledMock.mockResolvedValue(true);
  logAuditMock.mockClear();
});

describe("POST /admin/billing/collections/:id/{pause,resolve,cancel}", () => {
  it("404s and logs NO event when the run does not exist (zero-row update)", async () => {
    stubAdmin();
    // Update matched nothing (unknown id, or a run in another tenant).
    stageSupabaseResponse("patient_dunning_runs", "update", {
      data: [],
      error: null,
    });

    const res = await request(makeApp())
      .post(`/admin/billing/collections/${RUN_ID}/cancel`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "not_found" });
    // The phantom-event bug: no dunning event may be written for a run
    // that wasn't actually transitioned.
    expect(getSupabaseCallCount("patient_dunning_events", "insert")).toBe(0);
  });

  it.each([
    { action: "resolve", outcome: "resolved", status: "resolved" },
    { action: "pause", outcome: "paused", status: "paused" },
    { action: "cancel", outcome: "skipped", status: "cancelled" },
  ])(
    "$action logs outcome '$outcome' against the run's current step",
    async ({ action, outcome, status }) => {
      stubAdmin();
      stageSupabaseResponse("patient_dunning_runs", "update", {
        data: [{ id: RUN_ID, current_step: "final_notice" }],
        error: null,
      });
      stageSupabaseResponse("patient_dunning_events", "insert", {
        error: null,
      });

      const res = await request(makeApp())
        .post(`/admin/billing/collections/${RUN_ID}/${action}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const runUpdate = getSupabaseWritePayloads(
        "patient_dunning_runs",
        "update",
      )[0] as Record<string, unknown>;
      expect(runUpdate.status).toBe(status);

      const event = getSupabaseWritePayloads(
        "patient_dunning_events",
        "insert",
      )[0] as Record<string, unknown>;
      expect(event.outcome).toBe(outcome);
      // The run's actual ladder step, not a hardcoded "statement".
      expect(event.step).toBe("final_notice");
      expect(event.detail).toBe(`manual_${action}`);
    },
  );

  it("does not conflate cancel with pause (distinct outcomes)", async () => {
    // Regression: both previously logged outcome "paused".
    stubAdmin();
    stageSupabaseResponse("patient_dunning_runs", "update", {
      data: [{ id: RUN_ID, current_step: "statement" }],
      error: null,
    });
    stageSupabaseResponse("patient_dunning_events", "insert", { error: null });
    await request(makeApp())
      .post(`/admin/billing/collections/${RUN_ID}/cancel`)
      .send({});
    const event = getSupabaseWritePayloads(
      "patient_dunning_events",
      "insert",
    )[0] as Record<string, unknown>;
    expect(event.outcome).not.toBe("paused");
  });
});
