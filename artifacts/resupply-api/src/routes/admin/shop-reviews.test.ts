// Route tests for the admin moderation endpoints in
// routes/admin/shop-reviews.ts. Coverage:
//   * non-admin → 403 (admin gate is real)
//   * approve sets status='approved' and stamps moderation metadata
//   * reject sets status='rejected' with the optional note
//   * 404 when the id doesn't match a row

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import shopReviewsAdminRouter from "./shop-reviews";

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", shopReviewsAdminRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_admin",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  process.env.NODE_ENV = "test";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  mockAdmin.current = null;
  supabaseMock.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe("POST /admin/shop/reviews/:id/approve", () => {
  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_1/approve",
    );
    expect([401, 403]).toContain(res.status);
  });

  it("flips status to approved and stamps moderation metadata", async () => {
    stubVerifiedAdmin();
    const moderatedAtIso = "2026-04-29T13:00:00.000Z";
    stageSupabaseResponse("shop_reviews", "update", {
      data: {
        id: "rev_1",
        status: "approved",
        moderated_at: moderatedAtIso,
        product_id: "prod_AirFitP10",
        author_email: "alice@example.com",
      },
    });
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_1/approve",
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    const updates = getSupabaseWritePayloads(
      "shop_reviews",
      "update",
    ) as Record<string, unknown>[];
    expect(updates[0]?.status).toBe("approved");
    expect(updates[0]?.moderated_by).toBe("user_admin");
    expect(updates[0]?.moderation_note).toBeNull();
    // PostgREST patches use ISO strings, not Date instances.
    expect(typeof updates[0]?.moderated_at).toBe("string");
  });

  it("returns 200 even when the moderation email cannot be sent (fail-soft)", async () => {
    // SENDGRID_API_KEY is unset in this test env so the helper takes
    // the `email_not_configured` no-op path. The handler must not
    // surface that as an error to the admin.
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_reviews", "update", {
      data: {
        id: "rev_5",
        status: "approved",
        moderated_at: new Date().toISOString(),
        product_id: "prod_x",
        author_email: "noone@example.com",
      },
    });
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_5/approve",
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("returns 404 when the row id doesn't match", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_reviews", "update", { data: null });
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_missing/approve",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/shop/reviews/:id/reject", () => {
  it("flips status to rejected and persists the moderator note", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_reviews", "update", {
      data: {
        id: "rev_2",
        status: "rejected",
        moderated_at: new Date().toISOString(),
        moderation_note: "Off-topic; not about the product.",
        product_id: "prod_x",
        author_email: "alice@example.com",
      },
    });
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/reviews/rev_2/reject")
      .send({ note: "Off-topic; not about the product." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    const updates = getSupabaseWritePayloads(
      "shop_reviews",
      "update",
    ) as Record<string, unknown>[];
    expect(updates[0]?.status).toBe("rejected");
    expect(updates[0]?.moderation_note).toBe(
      "Off-topic; not about the product.",
    );
    expect(updates[0]?.moderated_by).toBe("user_admin");
  });

  it("accepts an empty body (no note required)", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_reviews", "update", {
      data: {
        id: "rev_3",
        status: "rejected",
        moderated_at: new Date().toISOString(),
        moderation_note: null,
        product_id: "prod_x",
        author_email: "alice@example.com",
      },
    });
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/reviews/rev_3/reject")
      .send({});
    expect(res.status).toBe(200);
    const updates = getSupabaseWritePayloads(
      "shop_reviews",
      "update",
    ) as Record<string, unknown>[];
    expect(updates[0]?.moderation_note).toBeNull();
  });

  it("returns 404 when the row id doesn't match", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("shop_reviews", "update", { data: null });
    const res = await request(makeApp()).post(
      "/resupply-api/admin/shop/reviews/rev_missing/reject",
    );
    expect(res.status).toBe(404);
  });
});
