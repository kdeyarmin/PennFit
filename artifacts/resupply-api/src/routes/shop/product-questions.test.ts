// Route tests for /shop/products/:productId/questions (Phase A.5).
//
// Coverage:
//   * GET 400 with malformed product id; 200 with empty list
//   * POST 401 without sign-in
//   * POST 400 with too-short body
//   * POST 201 inserts with formatted display name + lowercased email

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import productQuestionsRouter from "./product-questions";

const PRODUCT_ID = "prod_abc123";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productQuestionsRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/products/:productId/questions", () => {
  it("400s with a malformed product id", async () => {
    const res = await request(makeApp()).get(
      "/shop/products/has spaces!/questions",
    );
    expect(res.status).toBe(400);
  });

  it("returns an empty list when nothing is answered", async () => {
    stageSupabaseResponse("shop_product_questions", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/shop/products/${PRODUCT_ID}/questions`,
    );
    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
  });
});

describe("POST /shop/products/:productId/questions", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post(`/shop/products/${PRODUCT_ID}/questions`)
      .send({ questionBody: "Does this fit a 10cm pressure setting?" });
    expect(res.status).toBe(401);
  });

  it("400s with a body too short to be useful", async () => {
    mockSignedIn.current = {
      customerId: "user_1",
      email: "shopper@example.com",
      displayName: "Anna Singh",
    };
    const res = await request(makeApp())
      .post(`/shop/products/${PRODUCT_ID}/questions`)
      .send({ questionBody: "fits?" });
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("shop_product_questions", "insert")).toBe(0);
  });

  it("inserts with formatted display name + lowercased email", async () => {
    mockSignedIn.current = {
      customerId: "user_1",
      email: "Shopper@Example.COM",
      displayName: "Anna Singh",
    };
    stageSupabaseResponse("shop_product_questions", "insert", {
      data: {
        id: "q_1",
        status: "pending",
        created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp())
      .post(`/shop/products/${PRODUCT_ID}/questions`)
      .send({ questionBody: "Does this fit at 10 cm?" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("q_1");
    expect(res.body.status).toBe("pending");

    const inserts = getSupabaseWritePayloads(
      "shop_product_questions",
      "insert",
    ) as Record<string, unknown>[];
    expect(inserts).toHaveLength(1);
    const v = inserts[0]!;
    // FirstName L. format mirrors shop_reviews.
    expect(v.asker_display_name).toBe("Anna S.");
    // Email lowercased so admin moderation queues match consistently.
    expect(v.asker_email).toBe("shopper@example.com");
    expect(v.product_id).toBe(PRODUCT_ID);
    expect(v.customer_id).toBe("user_1");
  });
});
