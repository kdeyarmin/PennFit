// shop_reviews — customer-submitted product reviews for the cash-pay
// shop. Any signed-in customer can submit one review per
// product (UNIQUE on customer_id + product_id). Every review is
// PENDING by default and only becomes publicly visible after an
// admin approves it (status='approved'). Edits to an approved review
// reset status back to 'pending' so the moderator re-vets the change.
//
// Privacy: review bodies are public-shop content (no PHI on the
// cash-pay surface). authorDisplayName is denormalized at submit
// time as "FirstName L." for public rendering. authorEmail is
// denormalized for the admin moderation queue ONLY and is never
// returned by the public read endpoints.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * Lifecycle of a single review row:
 *   `pending`  — submitted by author, awaiting admin moderation.
 *                Visible to the author (so they see "Pending approval"
 *                on the product page) but never to the public.
 *   `approved` — admin approved; included in public read endpoints
 *                and in the aggregate rating.
 *   `rejected` — admin rejected with optional `moderation_note`. Not
 *                shown publicly. Author sees the note + an "Edit and
 *                resubmit" affordance which transitions back to
 *                `pending` via PATCH.
 */
export type ShopReviewStatus = "pending" | "approved" | "rejected";

export const shopReviews = resupplySchema.table(
  "shop_reviews",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /**
     * Shop-customer key of the review author. Required —
     * anonymous / guest reviews are out of scope (no stable
     * identity for one-per-user enforcement or moderation appeals).
     */
    customerId: text("customer_id").notNull(),
    /**
     * Stripe product ID this review is about. Not a foreign key —
     * Stripe is the catalog source of truth and product IDs can
     * outlive a temporary local mirror.
     */
    productId: text("product_id").notNull(),
    /** 1..5 inclusive, enforced by CHECK constraint. */
    rating: integer("rating").notNull(),
    /** Optional headline; trimmed to 100 chars at the API layer. */
    title: text("title"),
    /** Required body; 20..2000 chars enforced at the API layer. */
    body: text("body").notNull(),
    /**
     * Public display name, denormalized at submit time as
     * "FirstName L." (e.g. "Sarah K."). Falls back to "PennPaps
     * customer" when the the auth provider profile lacks a first name. Stored
     * here so public reads never need a auth lookup AND so a
     * later the auth provider profile rename doesn't silently rewrite already-
     * approved review attribution.
     */
    authorDisplayName: text("author_display_name").notNull(),
    /**
     * Denormalized author email for the admin moderation queue
     * ONLY. Never returned by the public read endpoints. Lowercased
     * at write time for consistency with the rest of the shop.
     */
    authorEmail: text("author_email").notNull(),
    /** See ShopReviewStatus jsdoc above. */
    status: text("status").notNull().default("pending"),
    /** Admin's reason when status='rejected'. ≤500 chars. */
    moderationNote: text("moderation_note"),
    /** When the most recent moderation decision was applied. */
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    /** auth user ID of the moderating admin. */
    moderatedBy: text("moderated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Touched on every PATCH; used for ordering author's own view. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    /**
     * One review per (author, product). The admin queue and the
     * 409-on-duplicate-create logic both rely on this. Composite
     * index also accelerates "did this user already review this
     * product?" lookups for the product detail page.
     */
    authorProductUnique: uniqueIndex(
      "shop_reviews_customer_id_product_id_unique",
    ).on(t.customerId, t.productId),
    /**
     * Public reads filter by `product_id = $1 AND status = 'approved'`
     * with newest-first ordering. Compound index covers the predicate
     * cleanly. Aggregate (count + avg) reads share this index too.
     */
    productStatusIdx: index("shop_reviews_product_id_status_idx").on(
      t.productId,
      t.status,
    ),
    /**
     * Admin moderation queue scans `status = 'pending' ORDER BY
     * created_at DESC`. Compound index supports both the predicate
     * and the ordering.
     */
    statusCreatedAtIdx: index("shop_reviews_status_created_at_idx").on(
      t.status,
      t.createdAt,
    ),
    /** Domain integrity: rating is a 1..5 star value. */
    ratingRange: check(
      "shop_reviews_rating_range",
      sql`${t.rating} >= 1 AND ${t.rating} <= 5`,
    ),
    /** Domain integrity: status is one of the three known values. */
    statusEnum: check(
      "shop_reviews_status_enum",
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
  }),
);

export type ShopReviewRow = typeof shopReviews.$inferSelect;
export type InsertShopReviewRow = typeof shopReviews.$inferInsert;
