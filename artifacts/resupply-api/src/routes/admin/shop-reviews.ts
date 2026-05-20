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
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  encodeCompositeCursor,
  isUuidCursorId,
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

const reviewListQuery = z
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

// Customer-review moderation queue. Treated as inbox-tier work
// alongside product-questions and customer-followups — every CSR
// who handles inbound customer touchpoints uses this surface.
router.get("/admin/shop/reviews", requirePermission("conversations.manage"), async (req, res) => {
  const parse = reviewListQuery.safeParse(req.query);
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
  // shop_reviews.id is a UUID. Reject anything else so a hostile
  // cursor can't smuggle PostgREST structural characters into the
  // `.or()` filter expression below.
  if (parsedCursor.id !== null && !isUuidCursorId(parsedCursor.id)) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  let listQuery = supabase
    .schema("resupply")
    .from("shop_reviews")
    .select(
      "id, product_id, rating, title, body, author_display_name, author_email, status, moderation_note, moderated_at, created_at, updated_at",
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (status !== "all") listQuery = listQuery.eq("status", status);
  // Composite cursor predicate: `created_at < ts OR (created_at = ts
  // AND id < cursorId)` — see lib/cursor.ts for why a timestamp-only
  // cursor is unsafe at page boundaries when reviews share a created_at.
  if (parsedCursor.date && parsedCursor.id) {
    const cursorIso = parsedCursor.date.toISOString();
    listQuery = listQuery.or(
      `created_at.lt.${cursorIso},and(created_at.eq.${cursorIso},id.lt.${parsedCursor.id})`,
    );
  }
  const { data: rows, error } = await listQuery;
  if (error) throw error;

  const all = rows ?? [];
  const hasMore = all.length > limit;
  const trimmed = hasMore ? all.slice(0, limit) : all;
  const lastRow = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCompositeCursor(new Date(lastRow.created_at), lastRow.id)
      : null;

  res.json({
    items: trimmed.map((r) => ({
      id: r.id,
      productId: r.product_id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      authorDisplayName: r.author_display_name,
      authorEmail: r.author_email,
      status: r.status,
      moderationNote: r.moderation_note,
      // PostgREST returns timestamptz as ISO string already.
      moderatedAt: r.moderated_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    nextCursor,
  });
});

router.post(
  "/admin/shop/reviews/:id/approve",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_reviews.approve", preset: "mutation" }),
  async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const adminId = req.adminUserId ?? null;
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_reviews")
      .update({
        status: "approved",
        moderation_note: null,
        moderated_at: nowIso,
        moderated_by: adminId,
        updated_at: nowIso,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select("id, status, moderated_at, product_id, author_email")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found_or_not_pending" });
      return;
    }
    req.log?.info?.(
      { reviewId: row.id, decision: "approved" },
      "shop/admin/reviews: review approved",
    );
    // FAIL-SOFT: never block the moderation 200 on email infra. The
    // helper wraps every error path; we only log the outcome.
    try {
      const productName = await resolveProductDisplayName(row.product_id);
      const productUrl = buildProductUrl(req, row.product_id);
      const result = await sendReviewApprovedEmail({
        to: row.author_email,
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
      moderatedAt: row.moderated_at,
    });
  },
);

router.post(
  "/admin/shop/reviews/:id/reject",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_reviews.reject", preset: "mutation" }),
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
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_reviews")
      .update({
        status: "rejected",
        moderation_note: parse.data.note ?? null,
        moderated_at: nowIso,
        moderated_by: adminId,
        updated_at: nowIso,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select(
        "id, status, moderated_at, moderation_note, product_id, author_email",
      )
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found_or_not_pending" });
      return;
    }
    req.log?.info?.(
      { reviewId: row.id, decision: "rejected" },
      "shop/admin/reviews: review rejected",
    );
    // FAIL-SOFT: rejection notice. Same contract as the approve path.
    try {
      const productName = await resolveProductDisplayName(row.product_id);
      const editUrl = buildProductUrl(req, row.product_id);
      const result = await sendReviewRejectedEmail({
        to: row.author_email,
        productName,
        moderationNote: row.moderation_note,
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
      moderatedAt: row.moderated_at,
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
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_reviews.unreject", preset: "mutation" }),
  async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const adminId = req.adminUserId ?? null;
    const supabase = getSupabaseServiceRoleClient();
    // Guard: only `rejected` rows are eligible. The status filter on
    // the UPDATE keeps a concurrent rejected→approved transition from
    // racing into a pending state.
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_reviews")
      .update({
        status: "pending",
        moderation_note: null,
        moderated_at: null,
        moderated_by: adminId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "rejected")
      .select("id, status, moderated_at")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
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
      moderatedAt: row.moderated_at,
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
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "shop_reviews.note", preset: "mutation" }),
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
  const supabase = getSupabaseServiceRoleClient();
  // Same guard as unreject: only `rejected` rows can have their
  // note edited. Approved + pending rows have no public note slot.
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("shop_reviews")
    .update({
      moderation_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "rejected")
    .select("id, status, moderation_note, moderated_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
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
    moderationNote: row.moderation_note,
    moderatedAt: row.moderated_at,
  });
});

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
