// Route tests for /admin/company-calendar — the shared, staff-wide
// appointment calendar.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseWritePayloads,
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
// adminRateLimit → transparent passthrough so the rate limiter never
// interferes with the route contract under test.
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

import companyCalendarRouter from "./company-calendar";

const STAFF: MockAdminCtx = {
  userId: "u_admin_1",
  email: "ops@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

const PATIENT_ID = "11111111-1111-4111-a111-111111111111";
const EVENT_ID = "22222222-2222-4222-a222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(companyCalendarRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/company-calendar", () => {
  it("401s without a signed-in staff member", async () => {
    const res = await request(makeApp()).get("/admin/company-calendar");
    expect(res.status).toBe(401);
  });

  it("returns events with the patient name resolved (two-step fetch)", async () => {
    mockAdmin.current = STAFF;
    stageSupabaseResponse("company_calendar_events", "select", {
      data: [
        {
          id: EVENT_ID,
          patient_id: PATIENT_ID,
          event_type: "fitting_in_person",
          starts_at: "2026-06-10T14:00:00.000Z",
          ends_at: "2026-06-10T14:30:00.000Z",
          location: "Suite 200",
          notes: null,
          created_by_user_id: "u_admin_1",
          created_by_email: "ops@penn.example.com",
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: PATIENT_ID, legal_first_name: "Jane", legal_last_name: "Doe" },
      ],
    });

    const res = await request(makeApp()).get("/admin/company-calendar");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      id: EVENT_ID,
      patientId: PATIENT_ID,
      patientFirstName: "Jane",
      patientLastName: "Doe",
      eventType: "fitting_in_person",
      location: "Suite 200",
    });
  });

  it("rejects a malformed window", async () => {
    mockAdmin.current = STAFF;
    const res = await request(makeApp()).get(
      "/admin/company-calendar?from=not-a-date",
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/company-calendar", () => {
  it("401s without a signed-in staff member", async () => {
    const res = await request(makeApp()).post("/admin/company-calendar").send({
      patientId: PATIENT_ID,
      eventType: "setup_virtual",
      startsAt: "2026-06-10T14:00:00.000Z",
      endsAt: "2026-06-10T14:30:00.000Z",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an end before the start", async () => {
    mockAdmin.current = STAFF;
    const res = await request(makeApp()).post("/admin/company-calendar").send({
      patientId: PATIENT_ID,
      eventType: "setup_virtual",
      startsAt: "2026-06-10T15:00:00.000Z",
      endsAt: "2026-06-10T14:30:00.000Z",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing patient", async () => {
    mockAdmin.current = STAFF;
    const res = await request(makeApp()).post("/admin/company-calendar").send({
      eventType: "setup_virtual",
      startsAt: "2026-06-10T14:00:00.000Z",
      endsAt: "2026-06-10T14:30:00.000Z",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown event type", async () => {
    mockAdmin.current = STAFF;
    const res = await request(makeApp()).post("/admin/company-calendar").send({
      patientId: PATIENT_ID,
      eventType: "haircut",
      startsAt: "2026-06-10T14:00:00.000Z",
      endsAt: "2026-06-10T14:30:00.000Z",
    });
    expect(res.status).toBe(400);
  });

  it("creates an appointment and stamps the author", async () => {
    mockAdmin.current = STAFF;
    stageSupabaseResponse("company_calendar_events", "insert", {
      data: { id: EVENT_ID },
    });

    const res = await request(makeApp()).post("/admin/company-calendar").send({
      patientId: PATIENT_ID,
      eventType: "fitting_virtual",
      startsAt: "2026-06-10T14:00:00.000Z",
      endsAt: "2026-06-10T14:30:00.000Z",
      location: "https://meet.example.com/abc",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: EVENT_ID });

    const [payload] = getSupabaseWritePayloads(
      "company_calendar_events",
      "insert",
    );
    expect(payload).toMatchObject({
      patient_id: PATIENT_ID,
      event_type: "fitting_virtual",
      starts_at: "2026-06-10T14:00:00.000Z",
      ends_at: "2026-06-10T14:30:00.000Z",
      location: "https://meet.example.com/abc",
      created_by_user_id: "u_admin_1",
      created_by_email: "ops@penn.example.com",
    });
  });
});

describe("PATCH /admin/company-calendar/:id", () => {
  it("404s when the appointment does not exist", async () => {
    mockAdmin.current = STAFF;
    stageSupabaseResponse("company_calendar_events", "update", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/company-calendar/${EVENT_ID}`)
      .send({ eventType: "follow_up" });
    expect(res.status).toBe(404);
  });

  it("updates fields and bumps updated_at", async () => {
    mockAdmin.current = STAFF;
    stageSupabaseResponse("company_calendar_events", "update", {
      data: { id: EVENT_ID },
    });
    const res = await request(makeApp())
      .patch(`/admin/company-calendar/${EVENT_ID}`)
      .send({ eventType: "consultation", notes: "bring backup mask" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const [payload] = getSupabaseWritePayloads(
      "company_calendar_events",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(payload).toMatchObject({
      event_type: "consultation",
      notes: "bring backup mask",
    });
    expect(typeof payload.updated_at).toBe("string");
  });
});

describe("DELETE /admin/company-calendar/:id", () => {
  it("401s without a signed-in staff member", async () => {
    const res = await request(makeApp()).delete(
      `/admin/company-calendar/${EVENT_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("deletes the appointment", async () => {
    mockAdmin.current = STAFF;
    const res = await request(makeApp()).delete(
      `/admin/company-calendar/${EVENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
