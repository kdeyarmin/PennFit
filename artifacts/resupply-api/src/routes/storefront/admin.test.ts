// Integration tests for CSRF enforcement on storefront admin routes (P1.3).
//
// Scope: only the routes changed in this PR — specifically the
// `POST /admin/reminders/send-due` route which had `requireCsrf` added
// to its middleware chain.
//
// The `requireAdmin` gate (applied via `router.use("/admin", requireAdmin)`)
// is mocked out so tests can isolate CSRF behaviour without a real session
// or database. External dependencies (Supabase, email, logger) are stubbed
// to prevent import-time side effects.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports of the module under test).
// ---------------------------------------------------------------------------

vi.mock("../../middlewares/requireAdmin", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdminOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Stub Supabase — the POST /admin/reminders/send-due handler queries
// reminder_subscriptions then updates them.  The CSRF check fires before
// any of that, so these stubs are only hit on the "CSRF passes" path.
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: (_s: string) => ({
      from: (_t: string) => ({
        select: (_c: string, _opts?: unknown) =>
          Promise.resolve({ data: [], error: null }),
        update: (_v: unknown) => ({
          eq: (_col: string, _val: unknown) =>
            Promise.resolve({ error: null }),
        }),
        insert: (_v: unknown) => Promise.resolve({ error: null }),
      }),
    }),
  }),
}));

// Stub the reminder email sender — never reaches real SendGrid in tests.
vi.mock("../../lib/storefront/reminderEmail", () => ({
  sendReminderDue: vi.fn(async () => ({
    configured: false,
    delivered: false,
    error: "not configured in test",
  })),
}));

// admin.ts also mounts adminUsersRouter which imports auth helpers.
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => {
    throw new Error("test: getAuthDeps should not be called in CSRF tests");
  },
}));

vi.mock("@workspace/resupply-auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@workspace/resupply-auth")>();
  return {
    ...real,
    inviteTeamMember: vi.fn(),
    revokeTeamMember: vi.fn(),
    updateTeamMemberRole: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Import the router under test.
// ---------------------------------------------------------------------------
import adminRouter from "./admin";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  return app;
}

const CSRF_TOKEN = "admin-csrf-token-xyz789";
const CSRF_COOKIE = `pf_csrf=${CSRF_TOKEN}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /admin/reminders/send-due — CSRF enforcement", () => {
  it("returns 403 csrf_failed when the X-PF-CSRF header is absent", async () => {
    const res = await request(makeApp())
      .post("/admin/reminders/send-due")
      .set("Cookie", CSRF_COOKIE)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when the pf_csrf cookie is absent", async () => {
    const res = await request(makeApp())
      .post("/admin/reminders/send-due")
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when neither cookie nor header is present", async () => {
    const res = await request(makeApp())
      .post("/admin/reminders/send-due")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when cookie and header values are mismatched", async () => {
    const res = await request(makeApp())
      .post("/admin/reminders/send-due")
      .set("Cookie", "pf_csrf=token-one")
      .set("x-pf-csrf", "token-two")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("does not leak the failure reason in the 403 response body", async () => {
    const res = await request(makeApp())
      .post("/admin/reminders/send-due")
      .set("Cookie", CSRF_COOKIE)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.reason).toBeUndefined();
    expect(res.body.error).toBe("csrf_failed");
  });

  it("includes a human-readable message in the 403 response body", async () => {
    const res = await request(makeApp())
      .post("/admin/reminders/send-due")
      .send({});

    expect(res.status).toBe(403);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it("passes the CSRF gate and reaches the handler when cookie and header match", async () => {
    // When CSRF succeeds the handler runs, finds no due reminders
    // (our Supabase stub returns []), and responds with a 200 summary.
    const res = await request(makeApp())
      .post("/admin/reminders/send-due")
      .set("Cookie", CSRF_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({});

    // Should NOT be a CSRF failure — the handler is reached.
    expect(res.status).not.toBe(403);
    expect(res.body?.error).not.toBe("csrf_failed");
  });
});