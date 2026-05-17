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

beforeAll(async () => {
  const mod = (await import("./app")) as { default: Express };
  app = mod.default;
});

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
});
