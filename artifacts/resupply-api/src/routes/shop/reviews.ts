// /shop/products/:productId/reviews — public + author endpoints for
// product reviews on the cash-pay shop.
//
// Read endpoints (no auth) — used by the product detail page and the
// /shop product card aggregate:
//
//   GET /shop/products/:productId/reviews            — paginated list
//                                                      of approved reviews
//                                                      + aggregate stats.
//   GET /shop/products/reviews/aggregates?productIds — bulk aggregate
//                                                      lookup so the
//                                                      product card grid
//                                                      stays one round-trip.
//
// Author endpoints (requireSignedIn):
//
//   POST   /shop/products/:productId/reviews   — create (status='pending')
//   GET    /shop/me/reviews/:productId         — read own review (any status)
//   PATCH  /shop/me/reviews/:productId         — edit own (resets to pending)
//   DELETE /shop/me/reviews/:productId         — delete own (idempotent)
//
// Privacy: review bodies are public-shop content. Public read endpoints
// NEVER return authorEmail. The author email is denormalized at write
// time only for the admin moderation queue.
//
// Moderation: every new or edited review goes back to status='pending'
// and is invisible publicly until an admin approves via
// POST /admin/shop/reviews/:id/approve. See routes/admin/shop-reviews.ts.

import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { clerkClient } from "@clerk/express";
import { z } from "zod";

import { getDbPool, shopReviews } from "@workspace/resupply-db";
import type { InsertShopReviewRow } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  encodeCompositeCursor,
  parseCompositeCursor,
} from "../../lib/cursor";

const router: IRouter = Router();

const TITLE_MAX = 100;
const BODY_MIN = 20;
const BODY_MAX = 2000;
// NOTE: the admin reject-note cap (≤500 chars) lives with the admin
// route in routes/admin/shop-reviews.ts; this file only handles
// public/author surfaces, which never accept a moderation note.
const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 25;
const BULK_AGGREGATE_MAX = 50;

// Composite cursor helpers are shared with admin/shop-reviews.ts —
// see lib/cursor.ts for the format + ordering rationale.

/**
 * Reasonable upper bounds on a Stripe product id so a bogus path
 * param can't blow up Postgres parameter buffers. Stripe ids are
 * `prod_` + base62; 120 chars is comfortably above any real-world
 * length.
 */
const productIdSchema = z.string().min(1).max(120);

const writeBody = z
  .object({
    rating: z.number().int().min(1).max(5),
    title: z
      .string()
      .max(TITLE_MAX)
      .nullish()
      .transform((v) => (v == null ? null : v.trim() || null)),
    body: z.string().min(BODY_MIN).max(BODY_MAX),
  })
  .strict();

const listQuery = z
  .object({
    cursor: z.string().min(1).max(120).optional(),
    limit: z
      .union([z.number().int().min(1).max(LIST_MAX_LIMIT), z.string()])
      .optional()
      .transform((v) => {
        if (v == null) return LIST_DEFAULT_LIMIT;
        const n = typeof v === "number" ? v : Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) return LIST_DEFAULT_LIMIT;
        return Math.min(Math.max(1, Math.floor(n)), LIST_MAX_LIMIT);
      }),
  })
  .strict();

const aggregatesQuery = z
  .object({
    productIds: z
      .string()
      .min(1)
      .max(BULK_AGGREGATE_MAX * 121)
      .transform((s) =>
        s
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      ),
  })
  .strict();

/**
 * Stable HTML stripper for review title/body. Defense in depth on top
 * of the frontend's React escaping — a future surface that renders
 * the body as innerHTML would otherwise be at risk.
 */
function stripHtml(input: string): string {
  // Drop script/style blocks *with* their inner contents first — a
  // simple tag-stripper would leave `alert(1)` from
  // `<script>alert(1)</script>` behind. Then strip remaining tags
  // and collapse whitespace. Defense in depth on top of React's
  // text-node escaping.
  return input
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface ReviewAuthorIdentity {
  displayName: string;
  email: string;
}

/**
 * Resolve the author's public display name + denormalized email from
 * Clerk. Display name is "FirstName L." (last initial only) so the
 * public review feed reads as a real person without exposing full
 * names. Falls back to "PennPaps customer" if the Clerk profile lacks
 * a usable first name.
 *
 * Throws on missing email — we will not insert a review row without
 * a way for the moderator to follow up.
 */
async function resolveAuthorIdentity(
  clerkUserId: string,
): Promise<ReviewAuthorIdentity> {
  const user = await clerkClient.users.getUser(clerkUserId);
  const primaryId = user.primaryEmailAddressId;
  const primary =
    user.emailAddresses.find((e) => e.id === primaryId) ??
    user.emailAddresses[0];
  const rawEmail = primary?.emailAddress ?? null;
  if (!rawEmail) {
    throw new Error("clerk_user_missing_email");
  }

  const first = (user.firstName ?? "").trim();
  const last = (user.lastName ?? "").trim();
  let displayName: string;
  if (first.length > 0 && last.length > 0) {
    displayName = `${first} ${last[0]}.`;
  } else if (first.length > 0) {
    displayName = first;
  } else {
    displayName = "PennPaps customer";
  }

  return { displayName, email: rawEmail.toLowerCase() };
}

/**
 * Compute aggregate stats for a single product from a row count map.
 * Centralized so the public list and the bulk aggregate endpoint
 * report numbers in the same shape.
 */
function aggregateFromRows(
  rows: Array<{ rating: number; n: number }>,
): {
  count: number;
  averageRating: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
} {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };
  let count = 0;
  let sum = 0;
  for (const r of rows) {
    const star = r.rating as 1 | 2 | 3 | 4 | 5;
    if (star >= 1 && star <= 5) {
      distribution[star] = r.n;
      count += r.n;
      sum += star * r.n;
    }
  }
  const averageRating = count === 0 ? 0 : Math.round((sum / count) * 10) / 10;
  return { count, averageRating, distribution };
}

// ───────────────────────────────────────────────────────────── public reads

router.get("/shop/products/:productId/reviews", async (req, res) => {
  const productIdParse = productIdSchema.safeParse(req.params.productId);
  if (!productIdParse.success) {
    res.status(400).json({ error: "invalid_product_id" });
    return;
  }
  const productId = productIdParse.data;

  const queryParse = listQuery.safeParse(req.query);
  if (!queryParse.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { cursor, limit } = queryParse.data;

  const db = drizzle(getDbPool());

  // Composite cursor `<ISO timestamp>__<id>` — see CURSOR_DELIM
  // comment for why a timestamp-only cursor is unsafe at page
  // boundaries when multiple reviews share a `createdAt`.
  const parsedCursor = parseCompositeCursor(cursor);
  if (!parsedCursor.ok) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }

  const baseFilter = and(
    eq(shopReviews.productId, productId),
    eq(shopReviews.status, "approved"),
  );

  // Strict-less composite predicate:
  //   created_at < ts OR (created_at = ts AND id < cursorId)
  // matches the `ORDER BY created_at DESC, id DESC` traversal.
  const cursorClause =
    parsedCursor.date && parsedCursor.id
      ? or(
          lt(shopReviews.createdAt, parsedCursor.date),
          and(
            eq(shopReviews.createdAt, parsedCursor.date),
            lt(shopReviews.id, parsedCursor.id),
          ),
        )
      : undefined;

  const items = await db
    .select({
      id: shopReviews.id,
      rating: shopReviews.rating,
      title: shopReviews.title,
      body: shopReviews.body,
      authorDisplayName: shopReviews.authorDisplayName,
      createdAt: shopReviews.createdAt,
    })
    .from(shopReviews)
    .where(cursorClause ? and(baseFilter, cursorClause) : baseFilter)
    .orderBy(desc(shopReviews.createdAt), desc(shopReviews.id))
    .limit(limit + 1);

  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  const lastItem = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCompositeCursor(lastItem.createdAt, lastItem.id)
      : null;

  // Aggregate is computed in a separate query but in the same
  // request so the product detail page renders the rating header
  // without a second round trip.
  const aggRows = await db
    .select({ rating: shopReviews.rating, n: sql<number>`count(*)::int` })
    .from(shopReviews)
    .where(
      and(
        eq(shopReviews.productId, productId),
        eq(shopReviews.status, "approved"),
      ),
    )
    .groupBy(shopReviews.rating);

  res.json({
    items: trimmed.map((it) => ({
      id: it.id,
      rating: it.rating,
      title: it.title,
      body: it.body,
      authorDisplayName: it.authorDisplayName,
      createdAt: it.createdAt.toISOString(),
    })),
    nextCursor,
    aggregate: aggregateFromRows(aggRows),
  });
});

router.get("/shop/products/reviews/aggregates", async (req, res) => {
  const parse = aggregatesQuery.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { productIds } = parse.data;
  if (productIds.length === 0) {
    res.json({ aggregates: {} });
    return;
  }
  if (productIds.length > BULK_AGGREGATE_MAX) {
    res
      .status(413)
      .json({ error: "too_many_product_ids", max: BULK_AGGREGATE_MAX });
    return;
  }

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      productId: shopReviews.productId,
      rating: shopReviews.rating,
      n: sql<number>`count(*)::int`,
    })
    .from(shopReviews)
    .where(
      and(
        // `inArray` produces the standard `product_id IN ($1, $2, …)`
        // form, which both pg and Drizzle bind correctly. We avoid
        // `= ANY($1)` because Drizzle binds the JS array as a single
        // text param rather than a typed pg array, which the planner
        // then can't match.
        inArray(shopReviews.productId, productIds),
        eq(shopReviews.status, "approved"),
      ),
    )
    .groupBy(shopReviews.productId, shopReviews.rating);

  // Group rows by productId so we can call aggregateFromRows once per
  // product. Always emit a zero-aggregate for every requested id so
  // the frontend doesn't need a "missing key" branch.
  const byProduct = new Map<string, Array<{ rating: number; n: number }>>();
  for (const r of rows) {
    const arr = byProduct.get(r.productId) ?? [];
    arr.push({ rating: r.rating, n: r.n });
    byProduct.set(r.productId, arr);
  }

  const aggregates: Record<
    string,
    { count: number; averageRating: number }
  > = {};
  for (const pid of productIds) {
    const agg = aggregateFromRows(byProduct.get(pid) ?? []);
    aggregates[pid] = {
      count: agg.count,
      averageRating: agg.averageRating,
    };
  }

  res.json({ aggregates });
});

// ────────────────────────────────────────────────────────── author endpoints

router.post(
  "/shop/products/:productId/reviews",
  requireSignedIn,
  async (req, res) => {
    const clerkUserId = req.userClerkId;
    if (!clerkUserId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    const productIdParse = productIdSchema.safeParse(req.params.productId);
    if (!productIdParse.success) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const productId = productIdParse.data;

    const bodyParse = writeBody.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { rating, title, body } = bodyParse.data;

    let identity: ReviewAuthorIdentity;
    try {
      identity = await resolveAuthorIdentity(clerkUserId);
    } catch (err) {
      req.log?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        "shop/reviews: clerk identity lookup failed",
      );
      res.status(400).json({ error: "author_identity_unavailable" });
      return;
    }

    const cleanTitle = title ? stripHtml(title).slice(0, TITLE_MAX) : null;
    const cleanBody = stripHtml(body);
    if (cleanBody.length < BODY_MIN) {
      res.status(400).json({ error: "body_too_short_after_sanitize" });
      return;
    }

    const insertRow: InsertShopReviewRow = {
      clerkUserId,
      productId,
      rating,
      title: cleanTitle,
      body: cleanBody,
      authorDisplayName: identity.displayName,
      authorEmail: identity.email,
      status: "pending",
    };

    try {
      const [inserted] = await db_insert(insertRow);
      if (!inserted) {
        res.status(500).json({ error: "insert_returned_no_row" });
        return;
      }
      res.status(201).json({
        id: inserted.id,
        status: inserted.status,
        rating: inserted.rating,
        title: inserted.title,
        body: inserted.body,
        createdAt: inserted.createdAt.toISOString(),
      });
    } catch (err) {
      // UNIQUE (clerk_user_id, product_id) violation → caller already
      // has a review for this product. The frontend should swap to the
      // edit affordance.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("shop_reviews_clerk_user_id_product_id_unique") ||
        msg.includes("duplicate key")
      ) {
        res.status(409).json({ error: "already_reviewed" });
        return;
      }
      throw err;
    }
  },
);

/**
 * Thin wrapper around the insert so the route handler stays readable
 * and the duplicate-key error path is the only place that needs the
 * try/catch. Returns the freshly-inserted row.
 */
async function db_insert(row: InsertShopReviewRow) {
  const db = drizzle(getDbPool());
  return db
    .insert(shopReviews)
    .values(row)
    .returning({
      id: shopReviews.id,
      status: shopReviews.status,
      rating: shopReviews.rating,
      title: shopReviews.title,
      body: shopReviews.body,
      createdAt: shopReviews.createdAt,
    });
}

router.get("/shop/me/reviews/:productId", requireSignedIn, async (req, res) => {
  const clerkUserId = req.userClerkId;
  if (!clerkUserId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const productIdParse = productIdSchema.safeParse(req.params.productId);
  if (!productIdParse.success) {
    res.status(400).json({ error: "invalid_product_id" });
    return;
  }
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopReviews.id,
      rating: shopReviews.rating,
      title: shopReviews.title,
      body: shopReviews.body,
      status: shopReviews.status,
      moderationNote: shopReviews.moderationNote,
      createdAt: shopReviews.createdAt,
      updatedAt: shopReviews.updatedAt,
    })
    .from(shopReviews)
    .where(
      and(
        eq(shopReviews.clerkUserId, clerkUserId),
        eq(shopReviews.productId, productIdParse.data),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    id: row.id,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status,
    moderationNote: row.moderationNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
});

router.patch(
  "/shop/me/reviews/:productId",
  requireSignedIn,
  async (req, res) => {
    const clerkUserId = req.userClerkId;
    if (!clerkUserId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const productIdParse = productIdSchema.safeParse(req.params.productId);
    if (!productIdParse.success) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const productId = productIdParse.data;

    const bodyParse = writeBody.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { rating, title, body } = bodyParse.data;

    const cleanTitle = title ? stripHtml(title).slice(0, TITLE_MAX) : null;
    const cleanBody = stripHtml(body);
    if (cleanBody.length < BODY_MIN) {
      res.status(400).json({ error: "body_too_short_after_sanitize" });
      return;
    }

    const db = drizzle(getDbPool());
    const updated = await db
      .update(shopReviews)
      .set({
        rating,
        title: cleanTitle,
        body: cleanBody,
        // Re-moderate every edit. Clear prior moderation metadata so
        // the admin queue reflects the new content cleanly.
        status: "pending",
        moderationNote: null,
        moderatedAt: null,
        moderatedBy: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(shopReviews.clerkUserId, clerkUserId),
          eq(shopReviews.productId, productId),
        ),
      )
      .returning({
        id: shopReviews.id,
        rating: shopReviews.rating,
        title: shopReviews.title,
        body: shopReviews.body,
        status: shopReviews.status,
        updatedAt: shopReviews.updatedAt,
      });
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      id: row.id,
      rating: row.rating,
      title: row.title,
      body: row.body,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    });
  },
);

router.delete(
  "/shop/me/reviews/:productId",
  requireSignedIn,
  async (req, res) => {
    const clerkUserId = req.userClerkId;
    if (!clerkUserId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const productIdParse = productIdSchema.safeParse(req.params.productId);
    if (!productIdParse.success) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const db = drizzle(getDbPool());
    // Idempotent: 200 even if the row never existed. Returning the
    // delete count lets the frontend distinguish between "we just
    // deleted yours" and "you didn't have one to begin with" if it
    // ever cares to.
    const deleted = await db
      .delete(shopReviews)
      .where(
        and(
          eq(shopReviews.clerkUserId, clerkUserId),
          eq(shopReviews.productId, productIdParse.data),
        ),
      )
      .returning({ id: shopReviews.id });
    res.json({ ok: true, deleted: deleted.length });
  },
);

// Suppress unused-import warning for `asc` — keeping it imported in
// case a future endpoint wants oldest-first author timeline; trivially
// removable. No-op runtime cost.
void asc;

export default router;
