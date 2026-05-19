// Integration tests for CSRF enforcement on the storefront orders route
// (P1.3).
//
// Scope: the `POST /orders` route, which had `requireCsrfWhenSession` added
// to its middleware chain between `attachSignedIn` and the handler body.
//
// Key behaviour under test:
//   1. Anonymous requests (no `pf_session` cookie) pass through the CSRF
//      gate unconditionally — blocking them would break the guest order flow.
//   2. Authenticated requests (pf_session present) are required to supply a
//      matching `pf_csrf` cookie + `X-PF-CSRF` header. Missing or mismatched
//      tokens produce 403 `csrf_failed`.
//
// `attachSignedIn` is mocked to a simple pass-through because it queries the
// database. The raw `pf_session` cookie is still forwarded in the Cookie
// header so that `requireCsrfWhenSession` (which reads the raw header, not
// `req.userCustomerId`) can detect an authenticated context.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks.
// ---------------------------------------------------------------------------

// attachSignedIn is a "soft" auth gate — it never rejects, it just attaches
// customer context when a session is present. We replace it with a no-op so
// the test does not need a real DB. Note: requireCsrfWhenSession reads the
// raw Cookie header directly (via readCookie), so mocking attachSignedIn
// does NOT affect whether requireCsrfWhenSession sees the pf_session cookie.
vi.mock("../../middlewares/requireSignedIn", () => ({
  attachSignedIn: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSignedIn: (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }, _next: () => void) => {
    res.status(401).json({ error: "sign_in_required" });
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Stub Supabase — only reached when the full handler runs (CSRF + valid body).
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: (_s: string) => ({
      from: (_t: string) => ({
        insert: (_v: unknown) => ({
          select: (_c: string) => ({
            limit: (_n: number) => ({
              maybeSingle: async () => ({ data: { id: "order-1" }, error: null }),
            }),
          }),
        }),
        update: (_v: unknown) => ({
          eq: (_col: string, _val: unknown) =>
            Promise.resolve({ error: null }),
        }),
        select: (_c: string) => ({
          eq: (_col: string, _val: unknown) => ({
            limit: (_n: number) => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

// Stub the order-email sender.
vi.mock("../../lib/storefront/orderEmail", () => ({
  sendOrderToPenn: vi.fn(async () => ({
    delivered: false,
    configured: false,
    error: "not configured in test",
  })),
  generateOrderReference: vi.fn(() => "PENN-TEST001"),
}));

// Stub the Stripe customer helper.
vi.mock("../../lib/stripe/customer", () => ({
  ensureShopCustomerRow: vi.fn(async () => "cus_test"),
}));

// ---------------------------------------------------------------------------
// Import the router under test.
// ---------------------------------------------------------------------------
import ordersRouter from "./orders";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(ordersRouter);
  return app;
}

const CSRF_TOKEN = "orders-csrf-token-abc";
const CSRF_COOKIE = `pf_csrf=${CSRF_TOKEN}`;
const SESSION_COOKIE = "pf_session=session-token-123";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /orders — requireCsrfWhenSession: anonymous pass-through", () => {
  it("does not block a request that has no pf_session cookie", async () => {
    // Anonymous patient: no session cookie at all. The CSRF gate must
    // allow this through, regardless of CSRF material presence.
    // The handler will receive the request and return some non-403 response
    // (likely 400 due to missing required body fields, or 503 if sendgrid not configured).
    const res = await request(makeApp())
      .post("/orders")
      .send({});

    expect(res.status).not.toBe(403);
    expect(res.body?.error).not.toBe("csrf_failed");
  });

  it("does not block an anonymous request even when only the CSRF header is set", async () => {
    // Without a session, CSRF enforcement is skipped — header presence is
    // irrelevant and should not cause any error.
    const res = await request(makeApp())
      .post("/orders")
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({});

    expect(res.status).not.toBe(403);
    expect(res.body?.error).not.toBe("csrf_failed");
  });

  it("does not block an anonymous request even when only the CSRF cookie is set", async () => {
    // A request carrying pf_csrf but not pf_session has no auth context
    // to replay, so the CSRF gate must pass it through.
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", CSRF_COOKIE)
      .send({});

    expect(res.status).not.toBe(403);
    expect(res.body?.error).not.toBe("csrf_failed");
  });
});

describe("POST /orders — requireCsrfWhenSession: authenticated enforcement", () => {
  it("returns 403 csrf_failed when session is present but CSRF header is absent", async () => {
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when session is present but pf_csrf cookie is absent", async () => {
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", SESSION_COOKIE)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when session present and neither cookie nor header is set", async () => {
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", SESSION_COOKIE)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when session present and token values mismatch", async () => {
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", `${SESSION_COOKIE}; pf_csrf=token-A`)
      .set("x-pf-csrf", "token-B")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("does not leak the failure reason in the 403 response body", async () => {
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
      .send({});

    // CSRF check fails (missing header) → 403 must only include `error`
    // and `message`, never a `reason`.
    expect(res.status).toBe(403);
    expect(res.body.reason).toBeUndefined();
    expect(res.body.error).toBe("csrf_failed");
  });

  it("includes a human-readable message in the 403 response body", async () => {
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", SESSION_COOKIE)
      .send({});

    expect(res.status).toBe(403);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it("passes the CSRF gate and reaches the handler when cookie and header match", async () => {
    // Authenticated caller with valid CSRF tokens. The handler receives
    // the request, fails on body validation (empty body), and returns a
    // non-CSRF 400 or similar. Key assertion: NOT a csrf_failed 403.
    const res = await request(makeApp())
      .post("/orders")
      .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({});

    expect(res.status).not.toBe(403);
    expect(res.body?.error).not.toBe("csrf_failed");
  });
});
