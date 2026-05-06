// shop_product_questions — customer-submitted questions about a
// shop product, answered by CSRs (Phase A.5 / feature #24 extension).
// See migration 0041 for the policy doc.
//
// Lifecycle is similar to shop_reviews: pending → answered (publicly
// visible) | rejected. Distinct table because the shape differs
// materially (no rating, has an admin-authored answer body, can be
// many-per-customer-per-product).

import { sql } from "drizzle-orm";
import { check, index, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export type ShopProductQuestionStatus = "pending" | "answered" | "rejected";

export const shopProductQuestions = resupplySchema.table(
  "shop_product_questions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /** Stripe product ID this question is about. Not a foreign key —
     *  Stripe is the catalog source of truth. */
    productId: text("product_id").notNull(),
    /** Shop-customer key of the asker. Required. */
    customerId: text("customer_id").notNull(),
    /** Public display name, denormalized at submit time as
     *  "FirstName L." (matches shop_reviews convention). */
    askerDisplayName: text("asker_display_name").notNull(),
    /** Denormalized for the admin moderation queue ONLY. Never
     *  returned by the public read endpoints. */
    askerEmail: text("asker_email").notNull(),
    /** The question. 10..1000 chars enforced at the API layer. */
    questionBody: text("question_body").notNull(),

    /** See ShopProductQuestionStatus jsdoc above. */
    status: text("status", { enum: ["pending", "answered", "rejected"] }).notNull().default("pending"),

    /** CSR-authored answer. Required to transition to status='answered'. */
    answerBody: text("answer_body"),
    answeredByEmail: text("answered_by_email"),
    answeredByUserId: text("answered_by_user_id"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),

    /** Admin's reason when status='rejected'. ≤500 chars. */
    moderationNote: text("moderation_note"),
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    moderatedBy: text("moderated_by"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    productStatusIdx: index("shop_product_questions_product_status_idx").on(
      t.productId,
      t.status,
    ),
    statusCreatedIdx: index("shop_product_questions_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    customerIdx: index("shop_product_questions_customer_idx").on(
      t.customerId,
      t.createdAt,
    ),
    statusEnum: check(
      "shop_product_questions_status_enum",
      sql`${t.status} IN ('pending','answered','rejected')`,
    ),
  }),
);

export type ShopProductQuestionRow = typeof shopProductQuestions.$inferSelect;
export type InsertShopProductQuestionRow =
  typeof shopProductQuestions.$inferInsert;
