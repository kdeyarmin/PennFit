// Route tests for the admin moderation endpoints in
// routes/admin/shop-reviews.ts. Mirrors the fluent-stub pattern used
// by abandoned-carts.test.ts. Coverage:
//   * non-admin → 403 (admin gate is real)
//   * approve sets status='approved' and stamps moderation metadata
//   * reject sets status='rejected' with the optional note
//   * 404 when the id doesn't match a row

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuthMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...a: unknown[]) => getAuthMock(...a),
  clerkClient: {
    users: { getUser: (...a: unknown[]) => getUserMock(...a) },
  },
}));

const updateQueue: unknown[] = [];
let lastUpdateSet: Record<string, unknown> | null = null;

const dbStub = {
  select: vi.fn(() => ({
    from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
  })),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: (v: Record<string, unknown>) => {
        lastUpdateSet = v;
        return obj;
      },
      where: () => obj,
      returning: () => Promise.resolve(updateQueue.shift() ?? []),
    };
    return obj;
  }),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));
vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

import shopReviewsAdminRouter from "./shop-reviews";

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", shopReviewsAdminRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  getAuthMock.mockReturnValue({ userId: "user_admin" });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "eml_1",
    emailAddresses: [
      {
        id: "eml_1",
        emailAddress: ALLOWED_EMAIL,
        verification: { status: "verified" },
      },
    ],
  });
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = "test";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  updateQueue.length = 0;
  lastUpdateSet = null;
  getAuthMock.mockReset();
  getUserMock.mockReset();
  dbStub.update.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe("POST /admin/shop/reviews/:id/approve", () => {
  it("rejects callers without admin sign-in", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_1/approve",
    );
    expect([401, 403]).toContain(res.status);
  });

  it("flips status to approved and stamps moderation metadata", async () => {
    stubVerifiedAdmin();
    const moderatedAt = new Date("2026-04-29T13:00:00Z");
    updateQueue.push([
      {
        id: "rev_1",
        status: "approved",
        moderatedAt,
        productId: "prod_AirFitP10",
        authorEmail: "alice@example.com",
      },
    ]);
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_1/approve",
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(lastUpdateSet?.status).toBe("approved");
    expect(lastUpdateSet?.moderatedBy).toBe("user_admin");
    expect(lastUpdateSet?.moderationNote).toBeNull();
    expect(lastUpdateSet?.moderatedAt).toBeInstanceOf(Date);
  });

  it("returns 200 even when the moderation email cannot be sent (fail-soft)", async () => {
    // SENDGRID_API_KEY is unset in this test env so the helper takes
    // the `email_not_configured` no-op path. The handler must not
    // surface that as an error to the admin.
    stubVerifiedAdmin();
    updateQueue.push([
      {
        id: "rev_5",
        status: "approved",
        moderatedAt: new Date(),
        productId: "prod_x",
        authorEmail: "noone@example.com",
      },
    ]);
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_5/approve",
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("returns 404 when the row id doesn't match", async () => {
    stubVerifiedAdmin();
    updateQueue.push([]);
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_missing/approve",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/shop/reviews/:id/reject", () => {
  it("flips status to rejected and persists the moderator note", async () => {
    stubVerifiedAdmin();
    updateQueue.push([
      {
        id: "rev_2",
        status: "rejected",
        moderatedAt: new Date(),
        moderationNote: "Off-topic; not about the product.",
        productId: "prod_x",
        authorEmail: "alice@example.com",
      },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/reviews/rev_2/reject")
      .send({ note: "Off-topic; not about the product." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(lastUpdateSet?.status).toBe("rejected");
    expect(lastUpdateSet?.moderationNote).toBe(
      "Off-topic; not about the product.",
    );
    expect(lastUpdateSet?.moderatedBy).toBe("user_admin");
  });

  it("accepts an empty body (no note required)", async () => {
    stubVerifiedAdmin();
    updateQueue.push([
      {
        id: "rev_3",
        status: "rejected",
        moderatedAt: new Date(),
        moderationNote: null,
        productId: "prod_x",
        authorEmail: "alice@example.com",
      },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/reviews/rev_3/reject")
      .send({});
    expect(res.status).toBe(200);
    expect(lastUpdateSet?.moderationNote).toBeNull();
  });

  it("returns 404 when the row id doesn't match", async () => {
    stubVerifiedAdmin();
    updateQueue.push([]);
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_missing/reject",
    );
    expect(res.status).toBe(404);
  });
});
