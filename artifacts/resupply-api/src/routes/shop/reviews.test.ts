// Route tests for the public + author endpoints in routes/shop/reviews.ts.
//
// Mirrors the fluent-stub pattern used by routes/admin/abandoned-carts.test.ts.
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

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as string | MockSignedInProfile | null,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

function fluent(result: unknown) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    set: () => obj,
    values: () => obj,
    orderBy: () => obj,
    groupBy: () => Promise.resolve(result),
    limit: () => Promise.resolve(result),
    returning: () => Promise.resolve(result),
    onConflictDoUpdate: () => Promise.resolve(undefined),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

const selectQueue: unknown[] = [];
const insertQueue: unknown[] = [];
const updateQueue: unknown[] = [];
const deleteQueue: unknown[] = [];
const insertErrorQueue: Array<Error | null> = [];
let lastInsertValues: unknown = null;
let lastUpdateSet: Record<string, unknown> | null = null;

const selectDistinctQueue: unknown[] = [];

const dbStub = {
  select: vi.fn(() => fluent(selectQueue.shift() ?? [])),
  // selectDistinct is used by the public reviews list to compute the
  // verified-purchaser flag — one query per page that returns the
  // distinct customer_ids on the page that have a paid order item
  // for the requested product. Same fluent shape as `select`.
  selectDistinct: vi.fn(() => fluent(selectDistinctQueue.shift() ?? [])),
  insert: vi.fn(() => {
    const obj: Record<string, unknown> = {
      values: (v: unknown) => {
        lastInsertValues = v;
        return obj;
      },
      returning: () => {
        const err = insertErrorQueue.shift() ?? null;
        if (err) return Promise.reject(err);
        return Promise.resolve(insertQueue.shift() ?? []);
      },
    };
    return obj;
  }),
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
  delete: vi.fn(() => {
    const obj: Record<string, unknown> = {
      where: () => obj,
      returning: () => Promise.resolve(deleteQueue.shift() ?? []),
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
  selectQueue.length = 0;
  selectDistinctQueue.length = 0;
  insertQueue.length = 0;
  updateQueue.length = 0;
  deleteQueue.length = 0;
  insertErrorQueue.length = 0;
  lastInsertValues = null;
  lastUpdateSet = null;
  mockSignedIn.current = null;
  dbStub.select.mockClear();
  dbStub.selectDistinct.mockClear();
  dbStub.insert.mockClear();
  dbStub.update.mockClear();
  dbStub.delete.mockClear();
});

const VALID_BODY = {
  rating: 5,
  title: "Comfortable and well-made",
  body: "Held a great seal all night and the strap is comfy.",
};

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
    insertQueue.push([
      {
        id: "rev_1",
        status: "pending",
        rating: 5,
        title: "Comfortable and well-made",
        body: "Held a great seal all night and the strap is comfy.",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await request(makeApp())
      .post("/resupply-api/shop/products/prod_1/reviews")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    // Display name is denormalized as "FirstName L."
    expect(
      (lastInsertValues as { authorDisplayName?: string } | null)
        ?.authorDisplayName,
    ).toBe("Alice W.");
    // Email is denormalized lowercase for the admin queue
    expect(
      (lastInsertValues as { authorEmail?: string } | null)?.authorEmail,
    ).toBe("alice@example.com");
    // Status is forced to pending — never trust client input here
    expect((lastInsertValues as { status?: string } | null)?.status).toBe(
      "pending",
    );
  });

  it("strips HTML from title and body before insert", async () => {
    stubSignedIn();
    insertQueue.push([
      {
        id: "rev_2",
        status: "pending",
        rating: 4,
        title: "ok",
        body: "fine product really long enough body to clear the minimum threshold for the test scenario",
        createdAt: new Date(),
      },
    ]);
    await request(makeApp())
      .post("/resupply-api/shop/products/prod_1/reviews")
      .send({
        rating: 4,
        title: "<script>alert(1)</script>OK",
        body: "<p>fine product really <b>long</b> enough body to clear the minimum threshold for the test scenario</p>",
      });
    const insert = lastInsertValues as {
      title?: string;
      body?: string;
    } | null;
    expect(insert?.title).toBe("OK");
    expect(insert?.body).not.toContain("<");
    expect(insert?.body).not.toContain(">");
  });

  it("returns 409 when the user already has a review for this product", async () => {
    stubSignedIn();
    insertErrorQueue.push(
      new Error(
        'duplicate key value violates unique constraint "shop_reviews_customer_id_product_id_unique"',
      ),
    );
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
    updateQueue.push([
      {
        id: "rev_1",
        rating: 4,
        title: null,
        body: "edited body that is plenty long enough to satisfy the validator threshold",
        status: "pending",
        updatedAt: new Date(),
      },
    ]);
    const res = await request(makeApp())
      .patch("/resupply-api/shop/me/reviews/prod_1")
      .send({
        rating: 4,
        title: null,
        body: "edited body that is plenty long enough to satisfy the validator threshold",
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(lastUpdateSet?.status).toBe("pending");
    // Prior moderation metadata must be cleared so the admin queue
    // shows the edit cleanly.
    expect(lastUpdateSet?.moderationNote).toBeNull();
    expect(lastUpdateSet?.moderatedAt).toBeNull();
    expect(lastUpdateSet?.moderatedBy).toBeNull();
  });

  it("returns 404 when no row matches", async () => {
    stubSignedIn();
    updateQueue.push([]);
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
    deleteQueue.push([]);
    const res = await request(makeApp()).delete(
      "/resupply-api/shop/me/reviews/prod_1",
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(0);
  });

  it("returns 200 with deleted=1 when a row was removed", async () => {
    stubSignedIn();
    deleteQueue.push([{ id: "rev_1" }]);
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
    const createdAt = new Date("2026-01-01T00:00:00Z");
    selectQueue.push([
      {
        id: "rev_1",
        customerId: "user_bob",
        rating: 5,
        title: "Great",
        body: "Loved it. Five stars from me on this one.",
        authorDisplayName: "Bob R.",
        createdAt,
      },
    ]);
    // Verified-purchaser query: bob has bought this product so the
    // verified pill should light up.
    selectDistinctQueue.push([{ customerId: "user_bob" }]);
    selectQueue.push([
      { rating: 5, n: 4 },
      { rating: 4, n: 1 },
    ]);
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
    selectQueue.push([
      {
        id: "rev_2",
        customerId: "user_charlie",
        rating: 4,
        title: "Decent",
        body: "Fine for the price, took a couple nights to get used to.",
        authorDisplayName: "Charlie K.",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);
    // No matching buyer rows.
    selectDistinctQueue.push([]);
    selectQueue.push([{ rating: 4, n: 1 }]);
    const res = await request(makeApp()).get(
      "/resupply-api/shop/products/prod_1/reviews",
    );
    expect(res.status).toBe(200);
    expect(res.body.items[0].verifiedPurchaser).toBe(false);
  });

  it("does not crash when there are no reviews on the page (empty IN list)", async () => {
    selectQueue.push([]); // no reviews
    // selectDistinct is NOT called when the page is empty (route
    // short-circuits the IN lookup) but we push a sentinel anyway so
    // a regression that does call it doesn't blow up the test.
    selectDistinctQueue.push([]);
    selectQueue.push([]); // empty aggregate
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
    selectQueue.push([{ productId: "prod_1", rating: 5, n: 2 }]);
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
