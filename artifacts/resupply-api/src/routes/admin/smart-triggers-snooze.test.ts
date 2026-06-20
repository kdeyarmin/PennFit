// Route tests for POST /admin/smart-triggers/:id/snooze.
//
// Coverage:
//   * 401 without admin
//   * 400 on non-UUID id / invalid days (out of 1..90)
//   * 404 when the event doesn't exist
//   * 409 when the event is already dismissed (dismiss is terminal)
//   * happy path: stamps snoozed_until ~= now + days, returns it
//
// Audit invariant: metadata carries patient_id/kind/days only — never
// the therapy values that drove detection.

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

import smartTriggersRouter from "./smart-triggers";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const PATIENT_ID = "99999999-2222-4333-8444-555555555555";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(smartTriggersRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("POST /admin/smart-triggers/:id/snooze", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post(
      `/admin/smart-triggers/${EVENT_ID}/snooze`,
    );
    expect(res.status).toBe(401);
  });

  it("400s on a non-UUID id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/smart-triggers/not-a-uuid/snooze")
      .send({ days: 7 });
    expect(res.status).toBe(400);
  });

  it("400s on out-of-range days", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/smart-triggers/${EVENT_ID}/snooze`)
      .send({ days: 365 });
    expect(res.status).toBe(400);
  });

  it("404s when the event does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .post(`/admin/smart-triggers/${EVENT_ID}/snooze`)
      .send({ days: 7 });
    expect(res.status).toBe(404);
  });

  it("409s when the event is already dismissed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: {
        id: EVENT_ID,
        patient_id: PATIENT_ID,
        kind: "pressure_at_max",
        dismissed_at: "2026-06-01T00:00:00Z",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/smart-triggers/${EVENT_ID}/snooze`)
      .send({ days: 7 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_dismissed");
  });

  it("snoozes an active event and stamps snoozed_until ~ now + days", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: {
        id: EVENT_ID,
        patient_id: PATIENT_ID,
        kind: "ahi_rising",
        dismissed_at: null,
      },
    });
    stageSupabaseResponse("patient_smart_trigger_events", "update", {
      data: null,
    });

    const before = Date.now();
    const res = await request(makeApp())
      .post(`/admin/smart-triggers/${EVENT_ID}/snooze`)
      .send({ days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(EVENT_ID);

    const snoozedMs = new Date(res.body.snoozedUntil).getTime();
    const expected = before + 7 * 24 * 60 * 60 * 1000;
    // within a minute of now + 7 days
    expect(Math.abs(snoozedMs - expected)).toBeLessThan(60_000);

    const writes = getSupabaseWritePayloads(
      "patient_smart_trigger_events",
      "update",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      snoozed_by_email: ADMIN.email,
    });
    expect(writes[0]).toHaveProperty("snoozed_until");

    // Audit carries only structural fields — no therapy values.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const auditArg = logAuditMock.mock.calls[0]![0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(auditArg.action).toBe("patient.smart_trigger.snoozed");
    expect(auditArg.metadata).toMatchObject({
      patient_id: PATIENT_ID,
      kind: "ahi_rising",
      days: 7,
    });
  });
});
