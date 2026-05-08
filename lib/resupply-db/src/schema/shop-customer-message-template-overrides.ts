// shop_customer_message_template_overrides — sparse per-customer
// overrides for the customer-message template library (Phase 3 of
// docs/proposals/customer-message-templates.md). Only created when
// an admin deliberately customises one (template_key, channel) for
// one customer.
//
// Sister table to message_templates (the global library). The
// override row's content fields are independently nullable so an
// admin can override JUST the SMS body for one customer while
// inheriting everything else from the global. The `is_active`
// column lets an admin SUPPRESS this customer for a single
// (template_key, channel) entirely — useful for "stop SMSing this
// patient on rx renewal but keep the email" patterns.
//
// PHI posture: same as message_templates. The body fields contain
// content, never patient data — variables are interpolated at
// render time. The required `note` field IS allowed to mention why
// the override exists (e.g. "patient requested email-only after the
// 2026-04 SMS opt-out incident") but is body-length-capped and
// surfaces in the audit envelope intentionally so ops can review
// non-default behaviour at a glance.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export const shopCustomerMessageTemplateOverrides = resupplySchema.table(
  "shop_customer_message_template_overrides",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /**
     * shop_customers.customer_id (text). Not FK-constrained because
     * shop_customers.customer_id has historically been a denormalised
     * pointer with various provenances (Stripe customer id,
     * auth.users id, anonymised guest id). The unique index below
     * binds at the (customer_id, template_key, channel) tuple.
     */
    customerId: text("customer_id").notNull(),
    /** Matches message_templates.template_key. */
    templateKey: text("template_key").notNull(),
    /** "email" | "sms" | "voice" | "push" — see channelEnum CHECK. */
    channel: text("channel").notNull(),
    /**
     * Override fields are independently nullable. A null field means
     * "inherit this field from the global template's value." All
     * three nulls + isActive=true → the override row exists but
     * does nothing; admins might create such a placeholder before
     * actually editing. All three nulls + isActive=false → suppress
     * this customer from the (template_key, channel) entirely.
     */
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Required-on-create at the application layer (Zod). Captures
     * WHY the override exists so a future admin reviewing the
     * record understands the call. Surfaces in the audit envelope
     * so ops can grep non-default behaviour.
     */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
    updatedBy: text("updated_by"),
  },
  (t) => ({
    customerKeyChannelIdx: uniqueIndex(
      "shop_customer_msg_tmpl_overrides_unique_idx",
    ).on(t.customerId, t.templateKey, t.channel),
    bodyTextLength: check(
      "shop_customer_msg_tmpl_overrides_body_text_max_length",
      sql`${t.bodyText} IS NULL OR length(${t.bodyText}) <= 50000`,
    ),
    bodyHtmlLength: check(
      "shop_customer_msg_tmpl_overrides_body_html_max_length",
      sql`${t.bodyHtml} IS NULL OR length(${t.bodyHtml}) <= 200000`,
    ),
    subjectLength: check(
      "shop_customer_msg_tmpl_overrides_subject_max_length",
      sql`${t.subject} IS NULL OR length(${t.subject}) <= 1000`,
    ),
    noteLength: check(
      "shop_customer_msg_tmpl_overrides_note_max_length",
      sql`${t.note} IS NULL OR length(${t.note}) <= 2000`,
    ),
    channelEnum: check(
      "shop_customer_msg_tmpl_overrides_channel_enum",
      sql`${t.channel} IN ('email','sms','voice','push')`,
    ),
  }),
);

export type ShopCustomerMessageTemplateOverrideRow =
  typeof shopCustomerMessageTemplateOverrides.$inferSelect;
export type InsertShopCustomerMessageTemplateOverrideRow =
  typeof shopCustomerMessageTemplateOverrides.$inferInsert;
