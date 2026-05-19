// Smoke-test the shop route tree against the live Express app.
// Loads src/app.ts directly (no worker, no DB connections at import
// time) and curls every shop-facing endpoint. Auth-gated endpoints
// should 401; public ones should 4xx with a validation error (not
// a 5xx routing crash); the route mount itself is what we care
// about. Removed after the run.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

// Provide the minimum env app.ts validates at import. We don't
// actually hit a DB — the routes that need Postgres will throw on
// the supabase client call, which surfaces as 5xx; we don't probe
// those here.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://x:x@127.0.0.1:1/x";
process.env.RESUPPLY_LINK_HMAC_KEY =
  process.env.RESUPPLY_LINK_HMAC_KEY ?? "a".repeat(48);
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "x";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "x";

let app: Express;

// Dynamic import (not a top-level `import`) so the env-var defaults
// above are in place before app.ts runs its boot-time validation.
// The 30 s budget is generous on purpose — when the rest of the
// suite is loading in parallel, the worker pool that resolves this
// import can be CPU-starved for several seconds before it gets a
// turn. The previous 10 s default tripped intermittently on busy
// CI runners; the import itself completes in ~100 ms once it does
// get the CPU.
beforeAll(async () => {
  const mod = (await import("./app")) as { default: Express };
  app = mod.default;
}, 30_000);

describe("shop route tree mount (smoke)", () => {
  it("rejects an unauthenticated GET /shop/me/comm-prefs with 401", async () => {
    const res = await request(app).get("/resupply-api/shop/me/comm-prefs");
    expect(res.status).toBe(401);
  });

  it("rejects an empty POST /shop/fitter-leads with 400 invalid_body", async () => {
    const res = await request(app)
      .post("/resupply-api/shop/fitter-leads")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects an opt-out POST /shop/fitter-leads with 400", async () => {
    const res = await request(app)
      .post("/resupply-api/shop/fitter-leads")
      .send({ email: "alice@example.com", marketingOptIn: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("marketing_opt_in_required");
  });

  it("rejects an invalid /shop/insurance-leads body with 400", async () => {
    const res = await request(app)
      .post("/resupply-api/shop/insurance-leads")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects an unauthenticated GET /shop/me/orders with 401", async () => {
    const res = await request(app).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated GET /shop/me/subscriptions with 401", async () => {
    const res = await request(app).get("/resupply-api/shop/me/subscriptions");
    expect(res.status).toBe(401);
  });

  // Every /shop/me/subscriptions/:id/* sub-route MUST resolve to a
  // handler (and gate on auth). The pre-existing 44ae317 regression
  // had all six declared at /me/subscriptions/* with no /shop prefix,
  // silently 404'ing every customer-facing call. These cases lock
  // the SPA → backend path contract in place.
  for (const sub of ["cancel", "pause", "resume", "cadence"] as const) {
    it(`rejects an unauthenticated POST /shop/me/subscriptions/:id/${sub} with 401 (not 404)`, async () => {
      const res = await request(app).post(
        `/resupply-api/shop/me/subscriptions/sub_test_1/${sub}`,
      );
      expect(res.status).toBe(401);
    });
  }
  it("rejects an unauthenticated GET /shop/me/subscriptions/:id/cadence-options with 401 (not 404)", async () => {
    const res = await request(app).get(
      "/resupply-api/shop/me/subscriptions/sub_test_1/cadence-options",
    );
    expect(res.status).toBe(401);
  });

  // Cover the other auth-gated /shop/me/* sub-paths the SPA hits.
  // None should 404 — that would mean the route is mounted at the
  // wrong path again.
  // Note: GET /shop/me itself uses `attachSignedIn` (not require), so
  // it returns 200 for anonymous callers — intentionally public. The
  // sub-paths below all use `requireSignedIn` and must 401.
  const meGets = [
    "/shop/me/clinical-info",
    "/shop/me/dashboard",
    "/shop/me/education-feed",
    "/shop/me/equipment",
    "/shop/me/insights",
    "/shop/me/insurance",
    "/shop/me/maintenance",
    "/shop/me/messages",
    "/shop/me/messages/unread-count",
    "/shop/me/push-subscriptions",
    "/shop/me/quarterly-summary",
    "/shop/me/referrals",
    "/shop/me/reorder-suggestions",
    "/shop/me/returns",
    "/shop/me/substitutions",
    "/shop/me/therapy-summary",
  ];
  for (const p of meGets) {
    it(`rejects an unauthenticated GET ${p} with 401 (not 404)`, async () => {
      const res = await request(app).get(`/resupply-api${p}`);
      expect(res.status).toBe(401);
    });
  }

  // Public POSTs we can prove are routed without a DB round-trip:
  // both reject empty bodies at the zod gate before any Supabase
  // call. A 404 here would mean the mount path is wrong.
  it("rejects POST /shop/back-in-stock with 400 on empty body", async () => {
    const res = await request(app)
      .post("/resupply-api/shop/back-in-stock")
      .send({});
    expect(res.status).toBe(400);
  });

  // /shop/checkout is mounted and reachable. In this no-config test
  // environment Stripe is unconfigured so the handler 503s before
  // the body parse; what matters here is the route is FOUND (not 404).
  it("finds POST /shop/checkout (status != 404)", async () => {
    const res = await request(app)
      .post("/resupply-api/shop/checkout")
      .send({});
    expect(res.status).not.toBe(404);
  });

  // /admin/rt-overview: must require admin auth (not 404) and the
  // CSV variant must mount alongside the JSON one.
  it("rejects unauthenticated GET /admin/rt-overview with 401", async () => {
    const res = await request(app).get("/resupply-api/admin/rt-overview");
    expect(res.status).toBe(401);
  });
  it("rejects unauthenticated GET /admin/rt-overview.csv with 401", async () => {
    const res = await request(app).get(
      "/resupply-api/admin/rt-overview.csv",
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // UUID cursor validation (PR: cursor injection guard)
  //
  // /shop/products/:productId/reviews is a public read endpoint — no auth
  // required — so we can reach the cursor-parsing layer without a token.
  // The two new scenarios exercise the isUuidCursorId guard that was added
  // in this PR: a composite cursor whose id half is not a valid UUID must
  // be rejected with 400 / invalid_cursor before it reaches the PostgREST
  // `.or()` filter builder.
  // ---------------------------------------------------------------------------
  it("rejects a composite cursor with a non-UUID id half on the public reviews route with 400 invalid_cursor", async () => {
    // Cursor is structurally valid (`<ISO>__<id>`) but the id half is a
    // Stripe-style string rather than a UUID — the new isUuidCursorId gate
    // must catch it.
    const nonUuidCursor = "2026-01-15T10:00:00.000Z__shrev_01HZX6Y3K9";
    const res = await request(app).get(
      `/resupply-api/shop/products/prod_test_123/reviews?cursor=${encodeURIComponent(nonUuidCursor)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
  });

  it("rejects a cursor with a PostgREST metachar-smuggling id on the public reviews route with 400 invalid_cursor", async () => {
    // The hostile cursor attempts to inject an extra `.or()` predicate.
    // The id half contains `)` and `,` which PostgREST treats as structural
    // delimiters; isUuidCursorId must reject it before it reaches the query.
    const hostileCursor =
      "2026-01-15T10:00:00.000Z__8c4c4c8e-0e8e-4c8e-8c4c-4c8e0e8e4c8e),customer_id.neq.foo";
    const res = await request(app).get(
      `/resupply-api/shop/products/prod_test_123/reviews?cursor=${encodeURIComponent(hostileCursor)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
  });

  it("rejects a timestamp-only (no-delimiter) cursor on the public reviews route with 400 invalid_cursor", async () => {
    // A bare ISO timestamp without the `__<id>` half is a legacy cursor
    // format. parseCompositeCursor rejects it; this confirms the rejection
    // surfaces as 400 from the route rather than a 5xx.
    const legacyCursor = "2026-01-15T10:00:00.000Z";
    const res = await request(app).get(
      `/resupply-api/shop/products/prod_test_123/reviews?cursor=${encodeURIComponent(legacyCursor)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
  });

  // Admin routes that carry the new UUID cursor guard are all behind
  // requireAdmin / requirePermission, so the auth gate fires before the
  // cursor check. These tests confirm the routes are mounted and auth-gated
  // (not 404) — the unit tests in cursor.test.ts cover the guard logic.
  it("rejects unauthenticated GET /admin/shop/returns with 401 (not 404)", async () => {
    const res = await request(app).get("/resupply-api/admin/shop/returns");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET /admin/shop/reviews with 401 (not 404)", async () => {
    const res = await request(app).get("/resupply-api/admin/shop/reviews");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET /admin/shop/product-questions with 401 (not 404)", async () => {
    const res = await request(app).get(
      "/resupply-api/admin/shop/product-questions",
    );
    expect(res.status).toBe(401);
  });
});
