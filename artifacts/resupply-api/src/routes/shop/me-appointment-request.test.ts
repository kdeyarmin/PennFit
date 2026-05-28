// Route tests for /shop/me/appointment-request.
//
// Coverage:
//   * 401 on POST without sign-in
//   * GET with no email returns empty list (no DB read)
//   * GET hides stale meeting_url (>24h past scheduled_for)
//   * GET keeps fresh meeting_url
//   * GET keeps meeting_url when scheduledFor is null
//   * POST 400 on invalid body (missing topic)
//   * POST 401 when email missing
//   * POST 201 happy path inserts with the customer email + display name
//   * GET filters to status in (new, contacted, scheduled)

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseFilterCalls,
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import appointmentRouter from "./me-appointment-request";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(appointmentRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/appointment-request", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/appointment-request");
    expect(res.status).toBe(401);
  });

  it("returns empty when no email is present", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).get("/shop/me/appointment-request");
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
  });

  it("masks stale meeting_url and preserves fresh urls", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const past = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    stageSupabaseResponse("appointment_requests", "select", {
      data: [
        {
          id: "stale",
          topic: "Annual review",
          preferred_window: null,
          status: "scheduled",
          scheduled_for: past,
          meeting_url: "https://zoom.us/j/old",
          meeting_provider: "zoom",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "fresh",
          topic: "Mask fitting",
          preferred_window: null,
          status: "scheduled",
          scheduled_for: future,
          meeting_url: "https://zoom.us/j/new",
          meeting_provider: "zoom",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "unsched",
          topic: "Triage",
          preferred_window: null,
          status: "new",
          scheduled_for: null,
          meeting_url: "https://zoom.us/j/triage",
          meeting_provider: "zoom",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/appointment-request");
    expect(res.status).toBe(200);
    const ids = res.body.requests.map((r: { id: string }) => r.id);
    expect(ids).toEqual(["stale", "fresh", "unsched"]);
    const stale = res.body.requests.find((r: { id: string }) => r.id === "stale");
    expect(stale.meetingUrl).toBeNull();
    const fresh = res.body.requests.find((r: { id: string }) => r.id === "fresh");
    expect(fresh.meetingUrl).toBe("https://zoom.us/j/new");
    const unsched = res.body.requests.find(
      (r: { id: string }) => r.id === "unsched",
    );
    expect(unsched.meetingUrl).toBe("https://zoom.us/j/triage");
  });

  it("filters server-side to non-terminal statuses (in [new, contacted, scheduled])", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("appointment_requests", "select", { data: [] });
    await request(makeApp()).get("/shop/me/appointment-request");
    const calls = getSupabaseFilterCalls("appointment_requests", "select");
    const inCall = calls.find((c) => c.verb === "in");
    expect(inCall?.args[0]).toBe("status");
    expect(inCall?.args[1]).toEqual(["new", "contacted", "scheduled"]);
  });
});

describe("POST /shop/me/appointment-request", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post("/shop/me/appointment-request")
      .send({ topic: "Triage" });
    expect(res.status).toBe(401);
  });

  it("400s on invalid body (missing topic)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/appointment-request")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("401s when email is missing", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp())
      .post("/shop/me/appointment-request")
      .send({ topic: "Triage" });
    expect(res.status).toBe(401);
  });

  it("inserts the request with email + display name", async () => {
    mockSignedIn.current = {
      customerId: "cust_1",
      email: "alice@me.test",
      displayName: "Alice",
    };
    stageSupabaseResponse("appointment_requests", "insert", {
      data: { id: "appt_1" },
    });
    const res = await request(makeApp())
      .post("/shop/me/appointment-request")
      .send({
        topic: "Mask refit",
        preferredWindow: "weekday mornings",
        notes: "leak around bridge of nose",
        phone: "+15555550100",
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "appt_1" });
    const writes = getSupabaseWritePayloads("appointment_requests", "insert");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      requester_email: "alice@me.test",
      requester_name: "Alice",
      topic: "Mask refit",
      preferred_window: "weekday mornings",
    });
  });
});
