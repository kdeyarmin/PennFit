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

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as MockSignedInRef["current"] },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

const insertedValues: Record<string, unknown>[] = [];
const onConflictSets: Record<string, unknown>[] = [];
const deleteCalls: number[] = [];
const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const obj: Record<string, unknown> = {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return obj;
      },
      onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
        onConflictSets.push(cfg.set);
        return Promise.resolve();
      },
    };
    return obj;
  }),
  delete: vi.fn(() => {
    const obj: Record<string, unknown> = {
      where: () => {
        deleteCalls.push(1);
        return Promise.resolve();
      },
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

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
  selectQueue.length = 0;
  insertedValues.length = 0;
  onConflictSets.length = 0;
  deleteCalls.length = 0;
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
    const res = await request(makeApp()).get(
      "/shop/me/push-subscriptions/vapid-public-key",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("push_not_configured");
  });

  it("returns the configured key", async () => {
    mockSignedIn.current = USER_ID;
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "BKxxFAKEvapidpubkey1234";
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
    const res = await request(makeApp())
      .post("/shop/me/push-subscriptions")
      .send({
        endpoint: VALID_ENDPOINT,
        keys: { auth: "AUTH_B64", p256dh: "P256_B64" },
        expirationTime: null,
      });
    expect(res.status).toBe(204);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      customerId: USER_ID,
      endpoint: VALID_ENDPOINT,
      authB64: "AUTH_B64",
      p256dhB64: "P256_B64",
    });
    // The upsert path also sets the expired_at-clear + key rotation.
    expect(onConflictSets).toHaveLength(1);
    expect(onConflictSets[0]?.expiredAt).toBeNull();
    expect(onConflictSets[0]?.authB64).toBe("AUTH_B64");
  });
});

describe("DELETE /shop/me/push-subscriptions", () => {
  it("204s + scopes the delete to the caller's customer", async () => {
    mockSignedIn.current = USER_ID;
    const res = await request(makeApp())
      .delete("/shop/me/push-subscriptions")
      .send({ endpoint: VALID_ENDPOINT });
    expect(res.status).toBe(204);
    expect(deleteCalls).toHaveLength(1);
  });
});

describe("GET /shop/me/push-subscriptions", () => {
  it("never returns the endpoint URL (capability token)", async () => {
    mockSignedIn.current = USER_ID;
    selectQueue.push([
      {
        id: "ps_1",
        endpoint: VALID_ENDPOINT,
        userAgent: "Mozilla/5.0",
        createdAt: new Date("2026-05-04T12:00:00Z"),
      },
    ]);
    const res = await request(makeApp()).get("/shop/me/push-subscriptions");
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    const sub = res.body.subscriptions[0];
    expect(sub.id).toBe("ps_1");
    expect(sub.userAgent).toBe("Mozilla/5.0");
    expect(sub.endpoint).toBeUndefined();
  });
});
