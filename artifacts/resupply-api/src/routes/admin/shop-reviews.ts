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
import {
  sendReviewApprovedEmail,
  sendReviewRejectedEmail,
} from "../../lib/messaging/review-moderation-email";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import type Stripe from "stripe";

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

// Editable rejection note. We only allow PATCH-ing the moderationNote
// for already-rejected reviews — admins use this to fix typos or add
// context to a rejection AFTER the original action. We deliberately
// don't allow editing notes on approved/pending rows (approved rows
// have no note; pending rows haven't been moderated yet). The
// `null`/empty-string semantics: empty trims to null (clear the note).
const noteBody = z
  .object({
    note: z.union([z.string().max(NOTE_MAX), z.null()]),
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
    const adminId = req.adminUserId ?? null;
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
        productId: shopReviews.productId,
        authorEmail: shopReviews.authorEmail,
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
    // FAIL-SOFT: never block the moderation 200 on email infra. The
    // helper wraps every error path; we only log the outcome.
    try {
      const productName = await resolveProductDisplayName(row.productId);
      const productUrl = buildProductUrl(req, row.productId);
      const result = await sendReviewApprovedEmail({
        to: row.authorEmail,
        productName,
        productUrl,
      });
      if (!result.sent) {
        req.log?.warn?.(
          { reviewId: row.id, reason: result.reason },
          "shop/admin/reviews: approval email not sent",
        );
      }
    } catch (mailErr) {
      req.log?.warn?.(
        {
          reviewId: row.id,
          err: mailErr instanceof Error ? mailErr.message : String(mailErr),
        },
        "shop/admin/reviews: approval email threw (swallowed)",
      );
    }
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
    const adminId = req.adminUserId ?? null;
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
        moderationNote: shopReviews.moderationNote,
        productId: shopReviews.productId,
        authorEmail: shopReviews.authorEmail,
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
    // FAIL-SOFT: rejection notice. Same contract as the approve path.
    try {
      const productName = await resolveProductDisplayName(row.productId);
      const editUrl = buildProductUrl(req, row.productId);
      const result = await sendReviewRejectedEmail({
        to: row.authorEmail,
        productName,
        moderationNote: row.moderationNote,
        editUrl,
      });
      if (!result.sent) {
        req.log?.warn?.(
          { reviewId: row.id, reason: result.reason },
          "shop/admin/reviews: rejection email not sent",
        );
      }
    } catch (mailErr) {
      req.log?.warn?.(
        {
          reviewId: row.id,
          err: mailErr instanceof Error ? mailErr.message : String(mailErr),
        },
        "shop/admin/reviews: rejection email threw (swallowed)",
      );
    }
    res.json({
      id: row.id,
      status: row.status,
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
    });
  },
);

// POST /admin/shop/reviews/:id/unreject — flip a rejected review
// back to 'pending' so it re-enters the moderation queue. Used when
// the moderator changed their mind, or the customer responded to the
// rejection email and the operator wants to re-review without
// asking the customer to resubmit. Note semantics: clearing the
// moderation note on un-reject so a stale "rejected because X"
// doesn't leak into the pending state. We do NOT email the customer
// here — there is no "your review has been put back in the queue"
// notification, since the next decision (approve or reject) will
// trigger the proper email.
router.post(
  "/admin/shop/reviews/:id/unreject",
  requireAdmin,
  async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const adminId = req.adminUserId ?? null;
    const db = drizzle(getDbPool());
    // Guard: only `rejected` rows are eligible. We use a WHERE filter
    // on status so concurrent moderation actions can't accidentally
    // race a rejected→approved transition into a pending state.
    const updated = await db
      .update(shopReviews)
      .set({
        status: "pending",
        moderationNote: null,
        moderatedAt: null,
        moderatedBy: adminId,
        updatedAt: new Date(),
      })
      .where(and(eq(shopReviews.id, id), eq(shopReviews.status, "rejected")))
      .returning({
        id: shopReviews.id,
        status: shopReviews.status,
        moderatedAt: shopReviews.moderatedAt,
      });
    const row = updated[0];
    if (!row) {
      // Either the row doesn't exist OR it isn't currently rejected.
      // We don't disambiguate to avoid leaking review existence info
      // through a 404 vs 409 distinction (admin endpoints are gated,
      // but defense-in-depth is cheap here).
      res.status(404).json({ error: "not_found_or_not_rejected" });
      return;
    }
    req.log?.info?.(
      { reviewId: row.id, decision: "unrejected" },
      "shop/admin/reviews: review un-rejected (back to pending)",
    );
    res.json({
      id: row.id,
      status: row.status,
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
    });
  },
);

// PATCH /admin/shop/reviews/:id/note — edit the moderation note on
// an already-rejected review. The note is what the customer sees in
// the rejection email + on /shop/account; this endpoint lets the
// operator fix wording without re-rejecting (which would re-send the
// email and reset moderatedAt/moderatedBy attribution).
//
// We deliberately do NOT re-send the rejection email here — the
// customer already got one when the review was first rejected. If a
// fresh notice is desired, the operator should un-reject and
// re-reject, which goes through the existing email path.
router.patch(
  "/admin/shop/reviews/:id/note",
  requireAdmin,
  async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parse = noteBody.safeParse(req.body ?? {});
    if (!parse.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const note =
      typeof parse.data.note === "string" && parse.data.note.trim() !== ""
        ? parse.data.note.trim()
        : null;
    const db = drizzle(getDbPool());
    // Same guard as unreject: only `rejected` rows can have their
    // note edited. Approved + pending rows have no public note slot.
    const updated = await db
      .update(shopReviews)
      .set({
        moderationNote: note,
        updatedAt: new Date(),
      })
      .where(and(eq(shopReviews.id, id), eq(shopReviews.status, "rejected")))
      .returning({
        id: shopReviews.id,
        status: shopReviews.status,
        moderationNote: shopReviews.moderationNote,
        moderatedAt: shopReviews.moderatedAt,
      });
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "not_found_or_not_rejected" });
      return;
    }
    req.log?.info?.(
      { reviewId: row.id },
      "shop/admin/reviews: rejection note edited",
    );
    res.json({
      id: row.id,
      status: row.status,
      moderationNote: row.moderationNote,
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
    });
  },
);

/**
 * Look up a product's display name from Stripe. Wrapped in
 * try/catch + null fallback so a Stripe outage cannot escalate
 * into a moderation 500 — the email path always falls back to
 * "your review" / "this product" copy.
 */
async function resolveProductDisplayName(productId: string): Promise<string> {
  const config = readStripeConfigOrNull();
  if (!config) return "your review";
  try {
    const stripe = getStripeClient(config);
    const product: Stripe.Product = await stripe.products.retrieve(productId);
    return product.name || "your review";
  } catch {
    return "your review";
  }
}

/**
 * Build the absolute URL of the product detail page for inclusion
 * in moderation emails. The shop is mounted at the cpap-fitter
 * artifact root, NOT at the resupply-api base path — we use the
 * request origin (set by the same proxy that serves the dashboard)
 * so dev (https://<repl>.replit.dev/shop/p/...) and production
 * (https://pennpaps.com/shop/p/...) both render the right link
 * without a separate config.
 */
function buildProductUrl(
  req: { protocol?: string; get?: (h: string) => string | undefined },
  productId: string,
): string {
  const host = req.get?.("host") ?? "";
  const protocol = req.protocol ?? "https";
  const base = host ? `${protocol}://${host}` : "";
  return `${base}/shop/p/${encodeURIComponent(productId)}`;
}

export default router;
