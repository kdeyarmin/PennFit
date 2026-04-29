// /admin/shop/reviews/* — moderation queue for customer-submitted
// product reviews. Every review starts status='pending' and only
// becomes publicly visible after a row here flips it to 'approved'.
//
// Endpoints (all requireAdmin-gated):
//
//   GET  /admin/shop/reviews?status=pending|approved|rejected|all
//                                              — paginated queue, newest
//                                                first, full author email
//                                                included for accountability.
//   POST /admin/shop/reviews/:id/approve       — flip to status='approved',
//                                                stamp moderatedAt + moderatedBy.
//   POST /admin/shop/reviews/:id/reject        — flip to status='rejected'
//                                                with optional moderation note.
//
// Privacy: this is the ONLY surface that returns authorEmail; the
// public read endpoints (routes/shop/reviews.ts) never expose it.
// Logs in this file emit only the review id, never the email or body.

import { Router, type IRouter } from "express";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDbPool, shopReviews } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import {
  encodeCompositeCursor,
  parseCompositeCursor,
} from "../../lib/cursor";

const router: IRouter = Router();

const NOTE_MAX = 500;
const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;

const statusFilter = z
  .enum(["pending", "approved", "rejected", "all"])
  .default("pending");

const listQuery = z
  .object({
    status: statusFilter,
    cursor: z.string().min(1).max(120).optional(),
    limit: z
      .union([z.number().int(), z.string()])
      .optional()
      .transform((v) => {
        if (v == null) return LIST_DEFAULT_LIMIT;
        const n = typeof v === "number" ? v : Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) return LIST_DEFAULT_LIMIT;
        return Math.min(Math.max(1, Math.floor(n)), LIST_MAX_LIMIT);
      }),
  })
  .strict();

const rejectBody = z
  .object({
    note: z.string().max(NOTE_MAX).optional(),
  })
  .strict();

router.get("/admin/shop/reviews", requireAdmin, async (req, res) => {
  const parse = listQuery.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { status, cursor, limit } = parse.data;
  const parsedCursor = parseCompositeCursor(cursor);
  if (!parsedCursor.ok) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }

  const db = drizzle(getDbPool());
  const statusFilterClause =
    status === "all" ? undefined : eq(shopReviews.status, status);
  // Strict-less composite predicate matching `ORDER BY created_at
  // DESC, id DESC` — see lib/cursor.ts for why a timestamp-only
  // cursor is unsafe at page boundaries when reviews share a
  // createdAt.
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

  // Compose the WHERE clause; `and()` with undefineds is awkward so
  // we filter before passing.
  const clauses = [statusFilterClause, cursorClause].filter(
    (c): c is NonNullable<typeof c> => c != null,
  );
  const whereClause =
    clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : and(...clauses);

  const rows = await db
    .select({
      id: shopReviews.id,
      productId: shopReviews.productId,
      rating: shopReviews.rating,
      title: shopReviews.title,
      body: shopReviews.body,
      authorDisplayName: shopReviews.authorDisplayName,
      authorEmail: shopReviews.authorEmail,
      status: shopReviews.status,
      moderationNote: shopReviews.moderationNote,
      moderatedAt: shopReviews.moderatedAt,
      createdAt: shopReviews.createdAt,
      updatedAt: shopReviews.updatedAt,
    })
    .from(shopReviews)
    .where(whereClause)
    .orderBy(desc(shopReviews.createdAt), desc(shopReviews.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCompositeCursor(lastRow.createdAt, lastRow.id)
      : null;

  res.json({
    items: trimmed.map((r) => ({
      id: r.id,
      productId: r.productId,
      rating: r.rating,
      title: r.title,
      body: r.body,
      authorDisplayName: r.authorDisplayName,
      authorEmail: r.authorEmail,
      status: r.status,
      moderationNote: r.moderationNote,
      moderatedAt: r.moderatedAt ? r.moderatedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    nextCursor,
  });

  // Touch unused imports — `or`, `sql` may be useful in a future
  // multi-status filter but aren't needed now. Keeping the imports
  // would be wasteful; we removed them.
});

// Throwaway suppression: imports `or`/`sql` aren't used. ESLint will
// flag them otherwise, so reference them as `void`.
void or;
void sql;

router.post(
  "/admin/shop/reviews/:id/approve",
  requireAdmin,
  async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const adminId = req.adminClerkId ?? null;
    const db = drizzle(getDbPool());
    const updated = await db
      .update(shopReviews)
      .set({
        status: "approved",
        moderationNote: null,
        moderatedAt: new Date(),
        moderatedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(shopReviews.id, id))
      .returning({
        id: shopReviews.id,
        status: shopReviews.status,
        moderatedAt: shopReviews.moderatedAt,
      });
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    req.log?.info?.(
      { reviewId: row.id, decision: "approved" },
      "shop/admin/reviews: review approved",
    );
    res.json({
      id: row.id,
      status: row.status,
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
    });
  },
);

router.post(
  "/admin/shop/reviews/:id/reject",
  requireAdmin,
  async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parse = rejectBody.safeParse(req.body ?? {});
    if (!parse.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const adminId = req.adminClerkId ?? null;
    const db = drizzle(getDbPool());
    const updated = await db
      .update(shopReviews)
      .set({
        status: "rejected",
        moderationNote: parse.data.note ?? null,
        moderatedAt: new Date(),
        moderatedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(shopReviews.id, id))
      .returning({
        id: shopReviews.id,
        status: shopReviews.status,
        moderatedAt: shopReviews.moderatedAt,
      });
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    req.log?.info?.(
      { reviewId: row.id, decision: "rejected" },
      "shop/admin/reviews: review rejected",
    );
    res.json({
      id: row.id,
      status: row.status,
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
    });
  },
);

export default router;
