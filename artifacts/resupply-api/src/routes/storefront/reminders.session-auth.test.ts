// Tests for the session-auth fallback on /api/reminders/manage*.
//
// Before P5 the manage routes only accepted `?token=…` (the magic
// link from the confirmation email). Now they ALSO accept a
// signed-in session cookie — looked up by `req.shopCustomerEmail`
// (lowercased the same way the subscribe path stores it). Token
// wins when both are present so a deep-linked manage email always
// lands on the row it refers to, even if the recipient is signed
// in as a different customer.
//
// These tests stand up the storefront router with the standard
// supertest + supabase-mock harness and verify:
//   * GET /reminders/manage with a session (no token) looks up by
//     email, succeeds.
//   * GET /reminders/manage with NEITHER token NOR session 401s.
//   * GET /reminders/manage with a token still works (regression).
//   * PATCH /reminders/manage with a session (no token) succeeds.
//   * POST /reminders/manage/unsubscribe with a session (no token)
//     succeeds.
//   * Token wins over session when both are present.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";
import {
  makeRequireSignedInMock,
  type MockSignedInRef,
} from "../../test-helpers/auth-mocks";

const supabaseMock = installSupabaseMock();

const { mockSession } = vi.hoisted(() => ({
  mockSession: { current: null as MockSignedInRef["current"] },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSession),
);

// The reminderEmail module is referenced by the subscribe route imported
// at the top of reminders.ts; stub it so we don't pull in SendGrid.
vi.mock("../../lib/storefront/reminderEmail.js", () => ({
  sendReminderConfirmation: vi.fn(async () => ({ status: "skipped" as const })),
  sendReminderManageLink: vi.fn(async () => ({ status: "skipped" as const })),
}));

const SUB_ROW = {
  id: "sub-1",
  email: "pat@example.com",
  manage_token: "abc123abc123abc123",
  status: "active",
  items: [
    { sku: "maskCushion", lastReplacedAt: "2026-04-01", intervalDays: 30 },
  ],
  last_sent_at: null,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

async function buildApp(): Promise<Express> {
  // Dynamic import — must happen AFTER the vi.mock() calls above so the
  // mocked modules are in the resolver before reminders.ts loads them.
  const remindersRouter = (await import("./reminders.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api", remindersRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockSession.current = null;
});

describe("GET /api/reminders/manage — session-auth fallback (P5)", () => {
  it("with a session and no token, looks up by lowercased email", async () => {
    mockSession.current = {
      customerId: "cust-1",
      email: "Pat@Example.COM",
      displayName: "Pat Q.",
    };
    stageSupabaseResponse("reminder_subscriptions", "select", {
      data: SUB_ROW,
    });
    const app = await buildApp();

    const res = await request(app).get("/api/reminders/manage");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: "pat@example.com",
      status: "active",
    });
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "select");
    // Verify the lookup actually used the email column and the
    // lowercased session email, not the case-as-typed.
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["email", "pat@example.com"],
    });
  });

  it("with neither token nor session returns 401", async () => {
    const app = await buildApp();
    const res = await request(app).get("/api/reminders/manage");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("with a token only (legacy guest flow) still looks up by manage_token", async () => {
    stageSupabaseResponse("reminder_subscriptions", "select", {
      data: SUB_ROW,
    });
    const app = await buildApp();

    const res = await request(app)
      .get("/api/reminders/manage")
      .query({ token: "abc123abc123abc123" });

    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "select");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["manage_token", "abc123abc123abc123"],
    });
  });

  it("token wins over session when both are present", async () => {
    // A reasonable Bob-clicks-Alice's-emailed-link scenario: token in
    // the URL must trump the cookie so deep links are deterministic.
    mockSession.current = {
      customerId: "cust-bob",
      email: "bob@example.com",
      displayName: "Bob",
    };
    stageSupabaseResponse("reminder_subscriptions", "select", {
      data: SUB_ROW,
    });
    const app = await buildApp();

    const res = await request(app)
      .get("/api/reminders/manage")
      .query({ token: "abc123abc123abc123" });

    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "select");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["manage_token", "abc123abc123abc123"],
    });
    // The email column should NOT have been used as a filter on this
    // request — the token branch wins outright.
    const usedEmail = filters.some(
      (f) => f.verb === "eq" && f.args[0] === "email",
    );
    expect(usedEmail).toBe(false);
  });

  it("returns 404 when the session email has no subscription row", async () => {
    mockSession.current = {
      customerId: "cust-no-sub",
      email: "no-sub@example.com",
      displayName: null,
    };
    stageSupabaseResponse("reminder_subscriptions", "select", { data: null });
    const app = await buildApp();
    const res = await request(app).get("/api/reminders/manage");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/reminders/manage — session-auth fallback (P5)", () => {
  it("with a session and no token, updates the row matched by session email", async () => {
    mockSession.current = {
      customerId: "cust-1",
      email: "pat@example.com",
      displayName: "Pat Q.",
    };
    stageSupabaseResponse("reminder_subscriptions", "update", {
      data: SUB_ROW,
    });
    const app = await buildApp();

    const res = await request(app)
      .patch("/api/reminders/manage")
      .send({
        items: [
          { sku: "maskCushion", lastReplacedAt: "2026-05-01", intervalDays: 30 },
        ],
      });

    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "update");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["email", "pat@example.com"],
    });
  });

  it("with neither token nor session returns 401", async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch("/api/reminders/manage")
      .send({
        items: [
          { sku: "maskCushion", lastReplacedAt: "2026-05-01", intervalDays: 30 },
        ],
      });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/reminders/manage/unsubscribe — session-auth fallback (P5)", () => {
  it("with a session and no token, unsubscribes the row matched by session email", async () => {
    mockSession.current = {
      customerId: "cust-1",
      email: "pat@example.com",
      displayName: "Pat Q.",
    };
    stageSupabaseResponse("reminder_subscriptions", "update", {
      data: { id: SUB_ROW.id },
    });
    const app = await buildApp();

    const res = await request(app).post("/api/reminders/manage/unsubscribe");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "update");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["email", "pat@example.com"],
    });
  });

  it("with neither token nor session returns 401", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/reminders/manage/unsubscribe");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Regression — token-only flow still works for PATCH and unsubscribe
// ---------------------------------------------------------------------------
// The P5 change added session-auth as an alternative to token. These tests
// verify the existing token-only guest flow was not broken by the change.

describe("PATCH /api/reminders/manage — token-only flow regression (P5)", () => {
  it("with a token only (no session) updates the row by manage_token", async () => {
    stageSupabaseResponse("reminder_subscriptions", "update", {
      data: SUB_ROW,
    });
    const app = await buildApp();

    const res = await request(app)
      .patch("/api/reminders/manage")
      .query({ token: "abc123abc123abc123" })
      .send({
        items: [
          { sku: "maskCushion", lastReplacedAt: "2026-05-01", intervalDays: 30 },
        ],
      });

    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "update");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["manage_token", "abc123abc123abc123"],
    });
  });

  it("token wins over session for PATCH — lookup uses manage_token, not email", async () => {
    mockSession.current = {
      customerId: "cust-bob",
      email: "bob@example.com",
      displayName: "Bob",
    };
    stageSupabaseResponse("reminder_subscriptions", "update", {
      data: SUB_ROW,
    });
    const app = await buildApp();

    const res = await request(app)
      .patch("/api/reminders/manage")
      .query({ token: "abc123abc123abc123" })
      .send({
        items: [
          { sku: "maskCushion", lastReplacedAt: "2026-05-01", intervalDays: 30 },
        ],
      });

    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "update");
    // Must have used token column, not email.
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["manage_token", "abc123abc123abc123"],
    });
    const usedEmail = filters.some(
      (f) => f.verb === "eq" && f.args[0] === "email",
    );
    expect(usedEmail).toBe(false);
  });

  it("400s when PATCH body items contain an impossible calendar date (2026-02-31)", async () => {
    mockSession.current = {
      customerId: "cust-1",
      email: "pat@example.com",
      displayName: "Pat Q.",
    };
    const app = await buildApp();

    const res = await request(app)
      .patch("/api/reminders/manage")
      .send({
        items: [
          // Feb 31 is not a real date — JS rolls over to March 3 without
          // strict validation; the route must reject it with 400.
          { sku: "maskCushion", lastReplacedAt: "2026-02-31", intervalDays: 30 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid update");
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lastReplacedAt"),
      ]),
    );
  });
});

describe("POST /api/reminders/manage/unsubscribe — token-only flow regression (P5)", () => {
  it("with a token only (no session) unsubscribes by manage_token", async () => {
    stageSupabaseResponse("reminder_subscriptions", "update", {
      data: { id: SUB_ROW.id },
    });
    const app = await buildApp();

    const res = await request(app)
      .post("/api/reminders/manage/unsubscribe")
      .query({ token: "abc123abc123abc123" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "update");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["manage_token", "abc123abc123abc123"],
    });
  });

  it("token wins over session for unsubscribe — lookup uses manage_token, not email", async () => {
    mockSession.current = {
      customerId: "cust-bob",
      email: "bob@example.com",
      displayName: "Bob",
    };
    stageSupabaseResponse("reminder_subscriptions", "update", {
      data: { id: SUB_ROW.id },
    });
    const app = await buildApp();

    const res = await request(app)
      .post("/api/reminders/manage/unsubscribe")
      .query({ token: "abc123abc123abc123" });

    expect(res.status).toBe(200);
    const filters = getSupabaseFilterCalls("reminder_subscriptions", "update");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["manage_token", "abc123abc123abc123"],
    });
    const usedEmail = filters.some(
      (f) => f.verb === "eq" && f.args[0] === "email",
    );
    expect(usedEmail).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveManageLookup — edge: session email is null
// ---------------------------------------------------------------------------
// If attachSignedIn runs but yields no email (unusual but possible when the
// customer row has a null email), the route must fall through to 401 rather
// than querying with a null value that would match every row.

describe("GET /api/reminders/manage — null session email falls through to 401", () => {
  it("returns 401 when the session exists but has no email", async () => {
    mockSession.current = {
      customerId: "cust-no-email",
      email: null,
      displayName: "Ghost",
    };
    const app = await buildApp();
    const res = await request(app).get("/api/reminders/manage");
    // A null email must NOT be passed to the eq() filter — it would match
    // every row whose email is NULL. The route must 401 in this case.
    expect(res.status).toBe(401);
  });
});
