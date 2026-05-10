// Route tests for the public + author endpoints in routes/shop/reviews.ts.
//
// Coverage focuses on the contracts that matter for trust and safety:
//   * unauthenticated POST/PATCH/DELETE → 401
//   * POST creates with status='pending' (admin must approve before
//     a review goes public)
//   * POST 409 on UNIQUE (customer_id, product_id) violation
//   * POST strips HTML from title + body before insert
//   * PATCH always resets status to 'pending' (re-moderate every edit)
//   * DELETE is idempotent (200 even with zero rows deleted)
//   * Public GET works without sign-in

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as string | MockSignedInProfile | null,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import reviewsRouter from "./reviews";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", reviewsRouter);
  return app;
}

function stubSignedIn(userId = "user_alice"): void {
  mockSignedIn.current = {
    customerId: userId,
    email: "alice@example.com",
    displayName: "Alice Walker",
  };
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

const VALID_BODY = {
  rating: 5,
  title: "Comfortable and well-made",
  body: "Held a great seal all night and the strap is comfy.",
};

describe("GET /shop/reviews/site-aggregate", () => {
  it("returns count + averageRating for the trust strip", async () => {
    // Route fetches the rating column for every approved row and
    // aggregates JS-side. Four 5-stars + one 4 → avg 4.8.
    stageSupabaseResponse("shop_reviews", "select", {
      data: [
        { rating: 5 },
        { rating: 5 },
        { rating: 5 },
        { rating: 5 },
        { rating: 4 },
      ],
    });
    const res = await request(makeApp()).get(
      "/resupply-api/shop/reviews/site-aggregate",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 5, averageRating: 4.8 });
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });

  it("returns zeros cleanly when there are no approved reviews", async () => {
    stageSupabaseResponse("shop_reviews", "select", { data: [] });
    const res = await request(makeApp()).get(
      "/resupply-api/shop/reviews/site-aggregate",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, averageRating: 0 });
  });
});

describe("POST /shop/products/:productId/reviews", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/products/prod_1/reviews")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("sign_in_required");
  });

  it("creates with status='pending' and a denormalized author display name", async () => {
    stubSignedIn();
    stageSupabaseResponse("shop_reviews", "insert", {
      data: {
        id: "rev_1",
        status: "pending",
        rating: 5,
        title: "Comfortable and well-made",
        body: "Held a great seal all night and the strap is comfy.",
        created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/products/prod_1/reviews")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    const inserts = getSupabaseWritePayloads(
      "shop_reviews",
      "insert",
    ) as Record<string, unknown>[];
    expect(inserts).toHaveLength(1);
    // Display name is denormalized as "FirstName L."
    expect(inserts[0]?.author_display_name).toBe("Alice W.");
    // Email is denormalized lowercase for the admin queue
    expect(inserts[0]?.author_email).toBe("alice@example.com");
    // Status is forced to pending — never trust client input here
    expect(inserts[0]?.status).toBe("pending");
  });

  it("strips HTML from title and body before insert", async () => {
    stubSignedIn();
    stageSupabaseResponse("shop_reviews", "insert", {
      data: {
        id: "rev_2",
        status: "pending",
        rating: 4,
        title: "ok",
        body: "fine product really long enough body to clear the minimum threshold for the test scenario",
        created_at: new Date().toISOString(),
      },
    });
    await request(makeApp())
      .post("/resupply-api/shop/products/prod_1/reviews")
      .send({
        rating: 4,
        title: "<script>alert(1)</script>OK",
        body: "<p>fine product really <b>long</b> enough body to clear the minimum threshold for the test scenario</p>",
      });
    const insert = getSupabaseWritePayloads(
      "shop_reviews",
      "insert",
    )[0] as Record<string, unknown>;
    expect(insert?.title).toBe("OK");
    expect(typeof insert?.body).toBe("string");
    expect(insert?.body as string).not.toContain("<");
    expect(insert?.body as string).not.toContain(">");
  });

  it("returns 409 when the user already has a review for this product", async () => {
    stubSignedIn();
    // PostgREST surfaces the unique-constraint violation as a
    // `code: "23505"` error envelope.
    stageSupabaseResponse("shop_reviews", "insert", {
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "shop_reviews_customer_id_product_id_unique"',
      },
    });
    const res = await request(makeApp())
      .post("/resupply-api/shop/products/prod_1/reviews")
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_reviewed");
  });

  it("rejects bodies shorter than 20 chars after sanitization", async () => {
    stubSignedIn();
    const res = await request(makeApp())
      .post("/resupply-api/shop/products/prod_1/reviews")
      .send({ rating: 5, body: "<p>too short</p>" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /shop/me/reviews/:productId", () => {
  it("always resets status to 'pending' for re-moderation", async () => {
    stubSignedIn();
    stageSupabaseResponse("shop_reviews", "update", {
      data: {
        id: "rev_1",
        rating: 4,
        title: null,
        body: "edited body that is plenty long enough to satisfy the validator threshold",
        status: "pending",
        updated_at: new Date().toISOString(),
      },
    });
    const res = await request(makeApp())
      .patch("/resupply-api/shop/me/reviews/prod_1")
      .send({
        rating: 4,
        title: null,
        body: "edited body that is plenty long enough to satisfy the validator threshold",
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    const updates = getSupabaseWritePayloads(
      "shop_reviews",
      "update",
    ) as Record<string, unknown>[];
    expect(updates[0]?.status).toBe("pending");
    // Prior moderation metadata must be cleared so the admin queue
    // shows the edit cleanly.
    expect(updates[0]?.moderation_note).toBeNull();
    expect(updates[0]?.moderated_at).toBeNull();
    expect(updates[0]?.moderated_by).toBeNull();
  });

  it("returns 404 when no row matches", async () => {
    stubSignedIn();
    stageSupabaseResponse("shop_reviews", "update", { data: null });
    const res = await request(makeApp())
      .patch("/resupply-api/shop/me/reviews/prod_1")
      .send({
        rating: 4,
        body: "edited body that is plenty long enough to satisfy the threshold",
      });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /shop/me/reviews/:productId", () => {
  it("returns 200 with deleted=0 when nothing to delete (idempotent)", async () => {
    stubSignedIn();
    stageSupabaseResponse("shop_reviews", "delete", { data: [] });
    const res = await request(makeApp()).delete(
      "/resupply-api/shop/me/reviews/prod_1",
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(0);
  });

  it("returns 200 with deleted=1 when a row was removed", async () => {
    stubSignedIn();
    stageSupabaseResponse("shop_reviews", "delete", {
      data: [{ id: "rev_1" }],
    });
    const res = await request(makeApp()).delete(
      "/resupply-api/shop/me/reviews/prod_1",
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
  });

  it("rejects unauthenticated DELETE", async () => {
    const res = await request(makeApp()).delete(
      "/resupply-api/shop/me/reviews/prod_1",
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /shop/products/:productId/reviews (public)", () => {
  it("requires no auth and returns approved reviews + aggregate", async () => {
    const createdAtIso = new Date("2026-01-01T00:00:00Z").toISOString();
    // 1) Reviews list.
    stageSupabaseResponse("shop_reviews", "select", {
      data: [
        {
          id: "rev_1",
          customer_id: "user_bob",
          rating: 5,
          title: "Great",
          body: "Loved it. Five stars from me on this one.",
          author_display_name: "Bob R.",
          created_at: createdAtIso,
        },
      ],
    });
    // 2) Verified-purchaser lookup.
    stageSupabaseResponse("shop_order_items", "select", {
      data: [{ customer_id: "user_bob" }],
    });
    // 3) Aggregate ratings.
    stageSupabaseResponse("shop_reviews", "select", {
      data: [
        { rating: 5 },
        { rating: 5 },
        { rating: 5 },
        { rating: 5 },
        { rating: 4 },
      ],
    });
    const res = await request(makeApp()).get(
      "/resupply-api/shop/products/prod_1/reviews",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].authorDisplayName).toBe("Bob R.");
    // Public reads never expose the author's email or user id
    expect(res.body.items[0].authorEmail).toBeUndefined();
    expect(res.body.items[0].customerId).toBeUndefined();
    expect(res.body.items[0].verifiedPurchaser).toBe(true);
    expect(res.body.aggregate.count).toBe(5);
    expect(res.body.aggregate.averageRating).toBe(4.8);
    expect(res.body.aggregate.distribution[5]).toBe(4);
  });

  it("marks verifiedPurchaser=false when the reviewer has not bought the product", async () => {
    stageSupabaseResponse("shop_reviews", "select", {
      data: [
        {
          id: "rev_2",
          customer_id: "user_charlie",
          rating: 4,
          title: "Decent",
          body: "Fine for the price, took a couple nights to get used to.",
          author_display_name: "Charlie K.",
          created_at: new Date("2026-01-02T00:00:00Z").toISOString(),
        },
      ],
    });
    // No matching buyer rows.
    stageSupabaseResponse("shop_order_items", "select", { data: [] });
    stageSupabaseResponse("shop_reviews", "select", {
      data: [{ rating: 4 }],
    });
    const res = await request(makeApp()).get(
      "/resupply-api/shop/products/prod_1/reviews",
    );
    expect(res.status).toBe(200);
    expect(res.body.items[0].verifiedPurchaser).toBe(false);
  });

  it("does not crash when there are no reviews on the page (empty IN list)", async () => {
    stageSupabaseResponse("shop_reviews", "select", { data: [] });
    // verified-buyer lookup is skipped when there are no reviewers,
    // so we don't stage shop_order_items here.
    stageSupabaseResponse("shop_reviews", "select", { data: [] });
    const res = await request(makeApp()).get(
      "/resupply-api/shop/products/prod_1/reviews",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.aggregate.count).toBe(0);
  });
});

describe("GET /shop/products/reviews/aggregates (bulk)", () => {
  it("returns zero-aggregate for products with no approved reviews", async () => {
    // Bulk aggregate fetches the rating column for every approved
    // review across the requested product ids in one round-trip and
    // groups JS-side.
    stageSupabaseResponse("shop_reviews", "select", {
      data: [
        { product_id: "prod_1", rating: 5 },
        { product_id: "prod_1", rating: 5 },
      ],
    });
    const res = await request(makeApp()).get(
      "/resupply-api/shop/products/reviews/aggregates?productIds=prod_1,prod_2",
    );
    expect(res.status).toBe(200);
    expect(res.body.aggregates.prod_1.count).toBe(2);
    expect(res.body.aggregates.prod_1.averageRating).toBe(5);
    expect(res.body.aggregates.prod_2).toEqual({
      count: 0,
      averageRating: 0,
    });
  });

  it("rejects more than 50 productIds with 413", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `prod_${i}`).join(",");
    const res = await request(makeApp()).get(
      `/resupply-api/shop/products/reviews/aggregates?productIds=${ids}`,
    );
    expect(res.status).toBe(413);
  });
});
