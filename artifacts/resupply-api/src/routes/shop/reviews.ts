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

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { readCustomerProfile } from "../../lib/customer-profile";
import { z } from "zod";
import sanitizeHtml from "sanitize-html";

import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  encodeCompositeCursor,
  isUuidCursorId,
  parseCompositeCursor,
} from "../../lib/cursor";

type ShopReviewInsert =
  Database["resupply"]["Tables"]["shop_reviews"]["Insert"];

const router: IRouter = Router();

// Cap review-write volume per signed-in customer (fall back to IP
// for any pre-auth burst). Reviews require requireSignedIn upstream,
// but we still cap volume because each write touches the moderation
// queue + product aggregate caches; a burst from one account would
// otherwise let a single attacker flood the queue.
const reviewWriteLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.userCustomerId ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

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

const reviewListQuery = z
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
  const textOnly = sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return textOnly.replace(/\s+/g, " ").trim();
}

interface ReviewAuthorIdentity {
  displayName: string;
  email: string;
}

/**
 * Resolve the author's public display name + denormalized email from
 * the auth provider. Display name is "FirstName L." (last initial only) so the
 * public review feed reads as a real person without exposing full
 * names. Falls back to "PennPaps customer" if the the auth provider profile lacks
 * a usable first name.
 *
 * Throws on missing email — we will not insert a review row without
 * a way for the moderator to follow up.
 */
async function resolveAuthorIdentity(
  req: import("express").Request,
): Promise<ReviewAuthorIdentity> {
  const profile = await readCustomerProfile(req);
  const rawEmail = profile.email;
  if (!rawEmail) {
    throw new Error("customer_missing_email");
  }

  // Reviews show "First L." rather than the full name to keep the
  // public review list's signal-to-noise low. Split the displayName
  // on whitespace; the first token is the given name, and the
  // first letter of the LAST token is treated as the last initial.
  // Falls through to "PennPaps customer" when displayName is null
  // or unparseable.
  const tokens = (profile.displayName ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let displayName: string;
  if (tokens.length >= 2) {
    displayName = `${tokens[0]} ${tokens[tokens.length - 1]![0]}.`;
  } else if (tokens.length === 1) {
    displayName = tokens[0]!;
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
function aggregateFromRows(rows: Array<{ rating: number; n: number }>): {
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

  const queryParse = reviewListQuery.safeParse(req.query);
  if (!queryParse.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { cursor, limit } = queryParse.data;

  // Composite cursor `<ISO timestamp>__<id>` — see CURSOR_DELIM
  // comment for why a timestamp-only cursor is unsafe at page
  // boundaries when multiple reviews share a `createdAt`.
  const parsedCursor = parseCompositeCursor(cursor);
  if (!parsedCursor.ok) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }
  // shop_reviews.id is a UUID. Anything else would smuggle PostgREST
  // structural characters into the `.or()` expression below.
  if (parsedCursor.id !== null && !isUuidCursorId(parsedCursor.id)) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();

  // Strict-less composite predicate:
  //   created_at < ts OR (created_at = ts AND id < cursorId)
  // matches the `ORDER BY created_at DESC, id DESC` traversal.
  let itemsQuery = supabase
    .schema("resupply")
    .from("shop_reviews")
    .select(
      "id, customer_id, rating, title, body, author_display_name, created_at",
    )
    .eq("product_id", productId)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (parsedCursor.date && parsedCursor.id) {
    const cursorIso = parsedCursor.date.toISOString();
    itemsQuery = itemsQuery.or(
      `created_at.lt.${cursorIso},and(created_at.eq.${cursorIso},id.lt.${parsedCursor.id})`,
    );
  }
  const { data: items, error: itemsErr } = await itemsQuery;
  if (itemsErr) throw itemsErr;
  const itemRows = items ?? [];

  const hasMore = itemRows.length > limit;
  const trimmed = hasMore ? itemRows.slice(0, limit) : itemRows;
  const lastItem = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCompositeCursor(new Date(lastItem.created_at), lastItem.id)
      : null;

  // Verified-purchaser join. One indexed lookup per page (NOT per
  // row) against shop_order_items: ask Postgres for the distinct
  // customer_ids on the page that have at least one paid item for
  // this product. PostgREST has no `selectDistinct`, so we fetch
  // the matching customer_id values and de-dupe JS-side. Anonymous
  // reviewers (customerId === null) are never verified by definition.
  const reviewerIds = Array.from(
    new Set(
      trimmed
        .map((it) => it.customer_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  );
  const verifiedSet = new Set<string>();
  if (reviewerIds.length > 0) {
    const { data: verifiedRows, error: verifiedErr } = await supabase
      .schema("resupply")
      .from("shop_order_items")
      .select("customer_id")
      .eq("product_id", productId)
      .in("customer_id", reviewerIds);
    if (verifiedErr) throw verifiedErr;
    for (const row of verifiedRows ?? []) {
      if (row.customer_id) verifiedSet.add(row.customer_id);
    }
  }

  // Aggregate is computed in a separate query but in the same
  // request so the product detail page renders the rating header
  // without a second round trip. PostgREST has no GROUP BY; we
  // fetch just the rating column for approved rows and reduce
  // JS-side. Approved reviews per product are a bounded count.
  const { data: ratingRows, error: aggErr } = await supabase
    .schema("resupply")
    .from("shop_reviews")
    .select("rating")
    .eq("product_id", productId)
    .eq("status", "approved");
  if (aggErr) throw aggErr;
  const aggMap = new Map<number, number>();
  for (const r of ratingRows ?? []) {
    aggMap.set(r.rating, (aggMap.get(r.rating) ?? 0) + 1);
  }
  const aggRows = Array.from(aggMap.entries()).map(([rating, n]) => ({
    rating,
    n,
  }));

  res.json({
    items: trimmed.map((it) => ({
      id: it.id,
      rating: it.rating,
      title: it.title,
      body: it.body,
      authorDisplayName: it.author_display_name,
      verifiedPurchaser:
        it.customer_id != null && verifiedSet.has(it.customer_id),
      // PostgREST returns timestamptz as ISO string already.
      createdAt: it.created_at,
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

  // PostgREST has no GROUP BY. Fetch the rating column for every
  // approved review in the requested product set and group JS-side.
  // The result set is bounded by `BULK_AGGREGATE_MAX` products.
  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_reviews")
    .select("product_id, rating")
    .in("product_id", productIds)
    .eq("status", "approved");
  if (error) throw error;

  // Group rows by productId so we can call aggregateFromRows once per
  // product. Always emit a zero-aggregate for every requested id so
  // the frontend doesn't need a "missing key" branch.
  const byProduct = new Map<string, Map<number, number>>();
  for (const r of rows ?? []) {
    const m = byProduct.get(r.product_id) ?? new Map<number, number>();
    m.set(r.rating, (m.get(r.rating) ?? 0) + 1);
    byProduct.set(r.product_id, m);
  }

  const aggregates: Record<string, { count: number; averageRating: number }> =
    {};
  for (const pid of productIds) {
    const buckets = byProduct.get(pid);
    const aggInput = buckets
      ? Array.from(buckets.entries()).map(([rating, n]) => ({ rating, n }))
      : [];
    const agg = aggregateFromRows(aggInput);
    aggregates[pid] = {
      count: agg.count,
      averageRating: agg.averageRating,
    };
  }

  res.json({ aggregates });
});

// Site-wide aggregate across ALL approved reviews — powers the
// trust-signal strip on the marketing home page. PostgREST has no
// AVG/COUNT aggregate exposure, so we fetch the rating column for
// every approved review (bounded — startup-stage; admin-only growth)
// and aggregate JS-side. Returns 0/0 cleanly when no reviews exist
// (fresh install) so the frontend can hide the strip without a
// special-case.
router.get("/shop/reviews/site-aggregate", async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_reviews")
    .select("rating")
    .eq("status", "approved");
  if (error) throw error;
  const ratings = rows ?? [];
  let count = 0;
  let sum = 0;
  for (const r of ratings) {
    if (r.rating >= 1 && r.rating <= 5) {
      count++;
      sum += r.rating;
    }
  }
  // 5 minutes of public CDN-friendly caching is fine — a brand-new
  // approved review showing up in 5 minutes vs. immediately is
  // imperceptible on a marketing surface.
  res.set("Cache-Control", "public, max-age=300, s-maxage=300");
  res.json({
    count,
    averageRating: count === 0 ? 0 : Math.round((sum / count) * 10) / 10,
  });
});

// ────────────────────────────────────────────────────────── author endpoints

router.post(
  "/shop/products/:productId/reviews",
  requireSignedIn,
  reviewWriteLimiter,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
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
      identity = await resolveAuthorIdentity(req);
    } catch (err) {
      req.log?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        "shop/reviews: customer identity lookup failed",
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

    const insertRow: ShopReviewInsert = {
      customer_id: customerId,
      product_id: productId,
      rating,
      title: cleanTitle,
      body: cleanBody,
      author_display_name: identity.displayName,
      author_email: identity.email,
      status: "pending",
    };

    const supabase = getSupabaseServiceRoleClient();
    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("shop_reviews")
      .insert(insertRow)
      .select("id, status, rating, title, body, created_at")
      .limit(1)
      .maybeSingle();
    if (insertErr) {
      // UNIQUE (customer_id, product_id) violation → caller already
      // has a review for this product. The frontend should swap to the
      // edit affordance. PostgREST surfaces the constraint name
      // inconsistently — match the err.code first, then constraint /
      // message / details.
      const e = insertErr as {
        code?: string;
        constraint?: string;
        message?: string;
        details?: string;
      };
      const isDuplicate =
        e.code === "23505" &&
        (e.constraint === "shop_reviews_customer_id_product_id_unique" ||
          e.message?.includes("shop_reviews_customer_id_product_id_unique") ||
          e.details?.includes("shop_reviews_customer_id_product_id_unique") ||
          e.message?.includes("duplicate key"));
      if (isDuplicate) {
        res.status(409).json({ error: "already_reviewed" });
        return;
      }
      throw insertErr;
    }
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
      createdAt: inserted.created_at,
    });
  },
);

router.get("/shop/me/reviews/:productId", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const productIdParse = productIdSchema.safeParse(req.params.productId);
  if (!productIdParse.success) {
    res.status(400).json({ error: "invalid_product_id" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("shop_reviews")
    .select(
      "id, rating, title, body, status, moderation_note, created_at, updated_at",
    )
    .eq("customer_id", customerId)
    .eq("product_id", productIdParse.data)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
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
    moderationNote: row.moderation_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

router.patch(
  "/shop/me/reviews/:productId",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
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

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_reviews")
      .update({
        rating,
        title: cleanTitle,
        body: cleanBody,
        // Re-moderate every edit. Clear prior moderation metadata so
        // the admin queue reflects the new content cleanly.
        status: "pending",
        moderation_note: null,
        moderated_at: null,
        moderated_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId)
      .eq("product_id", productId)
      .select("id, rating, title, body, status, updated_at")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
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
      updatedAt: row.updated_at,
    });
  },
);

router.delete(
  "/shop/me/reviews/:productId",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const productIdParse = productIdSchema.safeParse(req.params.productId);
    if (!productIdParse.success) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    // Idempotent: 200 even if the row never existed. Returning the
    // delete count lets the frontend distinguish between "we just
    // deleted yours" and "you didn't have one to begin with" if it
    // ever cares to.
    const supabase = getSupabaseServiceRoleClient();
    const { data: deleted, error } = await supabase
      .schema("resupply")
      .from("shop_reviews")
      .delete()
      .eq("customer_id", customerId)
      .eq("product_id", productIdParse.data)
      .select("id");
    if (error) throw error;
    res.json({ ok: true, deleted: (deleted ?? []).length });
  },
);

export default router;
