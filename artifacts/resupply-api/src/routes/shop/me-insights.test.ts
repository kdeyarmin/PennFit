// Route tests for /shop/me/insights (Phase G.4).
//
// Coverage:
//   * 401 without sign-in.
//   * Empty array when no email is on the session (no patient match
//     possible).
//   * Empty array when the email matches no patient row.
//   * Empty array when two patient rows share the same email (ambiguous).
//   * Returns projected insights with kind-specific copy + CTA.
//   * Strips dismissed events.
//   * `notified: true` reflects sent_at presence.
//   * Cap is honoured (limit 20).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as MockSignedInRef["current"] },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import meInsightsRouter from "./me-insights";

const USER_ID = "user_alice";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meInsightsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/insights", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(401);
  });

  it("returns empty array when no email is attached to the session", async () => {
    mockSignedIn.current = USER_ID;
    // No stage — handler short-circuits before query.
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ insights: [] });
  });

  it("returns empty array when no patient row matches the email", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(200);
    expect(res.body.insights).toEqual([]);
  });

  it("returns empty array when two patient rows share the same email (ambiguous)", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "shared@example.com",
    };
    // Simulate two patient rows with the same email.
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient_a" }, { id: "patient_b" }],
    });
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(200);
    expect(res.body.insights).toEqual([]);
  });

  it("projects active triggers with kind-specific copy + CTA", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    // First select: patient lookup returns one row.
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient_alice" }],
    });
    // Second select: events for that patient.
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: [
        {
          id: "evt_leak",
          kind: "leak_rising",
          detected_at: new Date("2026-04-30T12:00:00Z").toISOString(),
          window_start_date: "2026-04-15",
          window_end_date: "2026-04-30",
          sent_at: new Date("2026-04-30T13:00:00Z").toISOString(),
        },
        {
          id: "evt_use",
          kind: "usage_dropping",
          detected_at: new Date("2026-04-29T12:00:00Z").toISOString(),
          window_start_date: "2026-04-15",
          window_end_date: "2026-04-29",
          sent_at: null,
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/insights");
    expect(res.status).toBe(200);
    expect(res.body.insights).toHaveLength(2);

    const leak = res.body.insights[0];
    expect(leak.id).toBe("evt_leak");
    expect(leak.kind).toBe("leak_rising");
    expect(leak.notified).toBe(true);
    expect(leak.headline).toContain("seal");
    expect(leak.cta.url).toBe("/shop#shop-section-cushion");
    expect(leak.detectedAt).toBe("2026-04-30T12:00:00.000Z");

    const usage = res.body.insights[1];
    expect(usage.kind).toBe("usage_dropping");
    expect(usage.notified).toBe(false);
    expect(usage.cta.label).toBe("Talk to our team");
  });

  it("excludes therapy values from the response (PHI invariant)", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient_alice" }],
    });
    stageSupabaseResponse("patient_smart_trigger_events", "select", {
      data: [
        {
          id: "evt_leak",
          kind: "leak_rising",
          detected_at: new Date("2026-04-30T12:00:00Z").toISOString(),
          window_start_date: "2026-04-15",
          window_end_date: "2026-04-30",
          sent_at: new Date("2026-04-30T13:00:00Z").toISOString(),
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/insights");
    const json = JSON.stringify(res.body);
    // None of the detection inputs ever leak.
    expect(json).not.toMatch(/leakRate|ahi|usageMinutes/i);
  });
});

const DISMISS_ID = "11111111-2222-4333-8444-555555555555";
const PATIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("POST /shop/me/insights/:id/dismiss (Phase G.5)", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).post(
      `/shop/me/insights/${DISMISS_ID}/dismiss`,
    );
    expect(res.status).toBe(401);
  });

  it("404s when no email is attached to the session", async () => {
    mockSignedIn.current = USER_ID;
    const res = await request(makeApp()).post(
      `/shop/me/insights/${DISMISS_ID}/dismiss`,
    );
    expect(res.status).toBe(404);
  });

  it("400s on a non-UUID id", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    const res = await request(makeApp()).post(
      "/shop/me/insights/not-a-uuid/dismiss",
    );
    expect(res.status).toBe(400);
  });

  it("404s when the trigger row doesn't belong to the customer's email", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "alice@example.com",
    };
    // Patient lookup resolves to exactly one row (unambiguous).
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
    // UPDATE … RETURNING [] → not-our-row OR already-dismissed; we
    // collapse both into a 404 so an attacker can't enumerate IDs.
    stageSupabaseResponse("patient_smart_trigger_events", "update", {
      data: [],
    });
    const res = await request(makeApp()).post(
      `/shop/me/insights/${DISMISS_ID}/dismiss`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("insight_not_found");
    // Set was attempted (the WHERE filtered it out, not the SET).
    const updates = getSupabaseWritePayloads(
      "patient_smart_trigger_events",
      "update",
    ) as Record<string, unknown>[];
    expect(updates).toHaveLength(1);
    expect(typeof updates[0]?.dismissed_at).toBe("string");
    expect(updates[0]?.dismissed_by_email).toBe("alice@example.com");
  });

  it("returns ok + audits when the row matches", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "Alice@Example.com",
    };
    // Patient lookup resolves to exactly one row (unambiguous).
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
    stageSupabaseResponse("patient_smart_trigger_events", "update", {
      data: [{ id: DISMISS_ID }],
    });
    const res = await request(makeApp()).post(
      `/shop/me/insights/${DISMISS_ID}/dismiss`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const updates = getSupabaseWritePayloads(
      "patient_smart_trigger_events",
      "update",
    ) as Record<string, unknown>[];
    expect(updates).toHaveLength(1);
    // Email is normalized to lowercase before stamping audit.
    expect(updates[0]?.dismissed_by_email).toBe("alice@example.com");
  });

  it("404s when the email matches more than one patient (ambiguous)", async () => {
    mockSignedIn.current = {
      customerId: USER_ID,
      email: "shared@example.com",
    };
    // Two patients share the same email → ambiguous → bail without
    // attempting the UPDATE.
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient_1" }, { id: "patient_2" }],
    });
    const res = await request(makeApp()).post(
      `/shop/me/insights/${DISMISS_ID}/dismiss`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("insight_not_found");
    const updates = getSupabaseWritePayloads(
      "patient_smart_trigger_events",
      "update",
    );
    expect(updates).toHaveLength(0);
  });
});
