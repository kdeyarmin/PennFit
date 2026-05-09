// Route tests for /shop/me/push-subscriptions (Phase C.1).
//
// Coverage:
//   * 401 on every verb without sign-in
//   * GET vapid-public-key: 503 when env unset, 200 when set
//   * POST: 400 on bad shape, 204 on valid + upsert
//   * DELETE: 204 on by-endpoint
//   * GET subscriptions: never returns the endpoint URL

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as MockSignedInRef["current"] },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import mePushSubscriptionsRouter from "./me-push-subscriptions";

const USER_ID = "user_abc";
const VALID_ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/abc";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(mePushSubscriptionsRouter);
  return app;
}

const originalEnv = { ...process.env };
beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});
afterEach(() => {
  // Restore env so a test that sets WEB_PUSH_VAPID_PUBLIC_KEY doesn't
  // leak into the next.
  process.env = { ...originalEnv };
});

describe("GET /shop/me/push-subscriptions/vapid-public-key", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get(
      "/shop/me/push-subscriptions/vapid-public-key",
    );
    expect(res.status).toBe(401);
  });

  it("503s when WEB_PUSH_VAPID_PUBLIC_KEY is unset", async () => {
    mockSignedIn.current = USER_ID;
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    delete process.env.WEB_PUSH_VAPID_SUBJECT;
    const res = await request(makeApp()).get(
      "/shop/me/push-subscriptions/vapid-public-key",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("push_not_configured");
  });

  it("503s when only the public key is set (Phase G.8 — full triple required)", async () => {
    mockSignedIn.current = USER_ID;
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "BKxxFAKEvapidpubkey1234";
    delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    delete process.env.WEB_PUSH_VAPID_SUBJECT;
    const res = await request(makeApp()).get(
      "/shop/me/push-subscriptions/vapid-public-key",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("push_not_configured");
  });

  it("returns the configured key when the full VAPID triple is set", async () => {
    mockSignedIn.current = USER_ID;
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "BKxxFAKEvapidpubkey1234";
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "PrivKeyForSigning";
    process.env.WEB_PUSH_VAPID_SUBJECT = "mailto:ops@pennpaps.com";
    const res = await request(makeApp()).get(
      "/shop/me/push-subscriptions/vapid-public-key",
    );
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe("BKxxFAKEvapidpubkey1234");
  });
});

describe("POST /shop/me/push-subscriptions", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post("/shop/me/push-subscriptions")
      .send({
        endpoint: VALID_ENDPOINT,
        keys: { auth: "a", p256dh: "b" },
      });
    expect(res.status).toBe(401);
  });

  it("400s with bad endpoint shape", async () => {
    mockSignedIn.current = USER_ID;
    const res = await request(makeApp())
      .post("/shop/me/push-subscriptions")
      .send({
        endpoint: "not-a-url",
        keys: { auth: "a", p256dh: "b" },
      });
    expect(res.status).toBe(400);
  });

  it("upserts on endpoint with auth + p256dh", async () => {
    mockSignedIn.current = USER_ID;
    stageSupabaseResponse("shop_customer_push_subscriptions", "upsert", {
      error: null,
    });
    const res = await request(makeApp())
      .post("/shop/me/push-subscriptions")
      .send({
        endpoint: VALID_ENDPOINT,
        keys: { auth: "AUTH_B64", p256dh: "P256_B64" },
        expirationTime: null,
      });
    expect(res.status).toBe(204);
    const upserts = getSupabaseWritePayloads(
      "shop_customer_push_subscriptions",
      "upsert",
    ) as Record<string, unknown>[];
    expect(upserts).toHaveLength(1);
    // PostgREST upsert merges insert + on-conflict-update into a
    // single payload — both halves of the legacy test (insert
    // values + onConflict.set) collapse to one assertion now. The
    // expired_at clear lives in the same payload.
    expect(upserts[0]).toMatchObject({
      customer_id: USER_ID,
      endpoint: VALID_ENDPOINT,
      auth_b64: "AUTH_B64",
      p256dh_b64: "P256_B64",
      expired_at: null,
    });
  });
});

describe("DELETE /shop/me/push-subscriptions", () => {
  it("204s + scopes the delete to the caller's customer", async () => {
    mockSignedIn.current = USER_ID;
    stageSupabaseResponse("shop_customer_push_subscriptions", "delete", {
      error: null,
    });
    const res = await request(makeApp())
      .delete("/shop/me/push-subscriptions")
      .send({ endpoint: VALID_ENDPOINT });
    expect(res.status).toBe(204);
    expect(
      getSupabaseCallCount("shop_customer_push_subscriptions", "delete"),
    ).toBe(1);
  });
});

describe("GET /shop/me/push-subscriptions", () => {
  it("never returns the endpoint URL (capability token)", async () => {
    mockSignedIn.current = USER_ID;
    stageSupabaseResponse("shop_customer_push_subscriptions", "select", {
      data: [
        {
          id: "ps_1",
          endpoint: VALID_ENDPOINT,
          user_agent: "Mozilla/5.0",
          created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
        },
      ],
    });
    const res = await request(makeApp()).get("/shop/me/push-subscriptions");
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    const sub = res.body.subscriptions[0];
    expect(sub.id).toBe("ps_1");
    expect(sub.userAgent).toBe("Mozilla/5.0");
    expect(sub.endpoint).toBeUndefined();
  });
});
