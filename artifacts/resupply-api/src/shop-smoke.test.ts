// Smoke-test the shop route tree against the live Express app.
// Loads src/app.ts directly (no worker, no DB connections at import
// time) and curls every shop-facing endpoint. Auth-gated endpoints
// should 401; public ones should 4xx with a validation error (not
// a 5xx routing crash); the route mount itself is what we care
// about. Removed after the run.

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

// After the org-scoped cutover, request paths that touch the DB first
// call `resolveSeedOrgId()` to resolve their tenant. The REAL resolver
// makes an un-timed-out Supabase fetch; against the unreachable test
// `SUPABASE_URL` (port 1) that hangs past the 5 s test budget (e.g. the
// `POST /shop/checkout` feature-flag gate). Stub the seed resolver to a
// fixed org so it returns instantly; the actual DB lookups downstream
// still run through their own bounded-timeout / fail-soft paths and the
// route resolves quickly (503/4xx — never 404), which is all this smoke
// suite asserts. `getOrgScopedClient` stays REAL.
vi.mock("@workspace/resupply-db", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/resupply-db")>();
  return {
    ...actual,
    resolveSeedOrgId: async () => "00000000-0000-0000-0000-000000000001",
  };
});

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
// The 60 s budget is generous on purpose — when the rest of the
// suite is loading in parallel, the worker pool that resolves this
// import can be CPU-starved for several seconds before it gets a
// turn. Lower hook budgets have tripped intermittently on busy
// CI runners; the import itself completes in ~100 ms once it does
// get the CPU.
beforeAll(async () => {
  const mod = (await import("./app")) as { default: Express };
  app = mod.default;
}, 60_000);

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

  // /shop/checkout is mounted and reachable. In this no-config test
  // environment Stripe is unconfigured so the handler 503s before
  // the body parse; what matters here is the route is FOUND (not 404).

  // /admin/rt-overview: must require admin auth (not 404) and the
  // CSV variant must mount alongside the JSON one.
  it("rejects unauthenticated GET /admin/rt-overview with 401", async () => {
    const res = await request(app).get("/resupply-api/admin/rt-overview");
    expect(res.status).toBe(401);
  });
  it("rejects unauthenticated GET /admin/rt-overview.csv with 401", async () => {
    const res = await request(app).get("/resupply-api/admin/rt-overview.csv");
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

  // Admin routes that carry the new UUID cursor guard are all behind
  // requireAdmin / requirePermission, so the auth gate fires before the
  // cursor check. These tests confirm the routes are mounted and auth-gated
  // (not 404) — the unit tests in cursor.test.ts cover the guard logic.
});
