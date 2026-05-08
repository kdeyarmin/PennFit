// message_templates — admin-managed library of customer-facing
// message templates. See migration 0067 and docs/proposals/
// customer-message-templates.md for the full rationale and design.
//
// One row per (template_key, channel) tuple. The render path
// (`@workspace/resupply-templates`) reads from this table at send
// time, falling back to the call-site's hard-coded baseline if
// the row is missing or the lookup fails — so the table being
// unapplied (e.g. mid-deploy) never breaks customer comms.
//
// Phase 3 will add `shop_customer_message_template_overrides` for
// per-customer overrides. The render-path lookup signature already
// accepts a customerId so Phase 3 doesn't break call sites.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export type MessageTemplateChannel = "email" | "sms" | "voice" | "push";

export const messageTemplates = resupplySchema.table(
  "message_templates",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /**
     * Stable identifier the call site uses to look this up. Snake-
     * case domain.subject pattern: e.g. `onboarding.day_3`,
     * `rx_renewal.30_day`, `smart_trigger.usage_drop`,
     * `order.confirmation`, `auth.password_reset`.
     */
    templateKey: text("template_key").notNull(),
    /** "email" | "sms" | "voice" | "push" — see channelEnum CHECK below. */
    channel: text("channel").notNull(),
    /**
     * Required when channel="email". Null otherwise (sms/voice/push
     * have no subject line). Enforced at the application layer; not
     * a DB CHECK because a row may legitimately exist briefly with
     * subject=null while an admin is editing.
     */
    subject: text("subject"),
    /** Required when channel="email". Null otherwise. */
    bodyHtml: text("body_html"),
    /**
     * Always present. For voice channels this is the spoken
     * transcript (plain text — Phase 4 may add SSML support).
     */
    bodyText: text("body_text").notNull(),
    /**
     * Variables this template is allowed to reference. The render
     * path uses this both as the substitution allowlist (a `{{var}}`
     * outside this list stays literal so a typo is visible) and as
     * the source for the admin editor's "available variables" hint.
     * Stored on the row so the allowlist evolves with the template;
     * call sites declare the full set when seeding.
     */
    allowedVariables: jsonb("allowed_variables")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Disabled rows are ignored by the lookup — render falls back
     * to the hard-coded baseline. Use this to A/B-disable a single
     * channel without code changes.
     */
    isActive: boolean("is_active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdBy: text("created_by"),
  },
  (t) => ({
    keyChannelIdx: uniqueIndex("message_templates_key_channel_idx").on(
      t.templateKey,
      t.channel,
    ),
    activeKeyIdx: index("message_templates_active_key_idx").on(
      t.isActive,
      t.templateKey,
    ),
    bodyTextLength: check(
      "message_templates_body_text_max_length",
      sql`length(${t.bodyText}) <= 50000`,
    ),
    bodyHtmlLength: check(
      "message_templates_body_html_max_length",
      sql`${t.bodyHtml} IS NULL OR length(${t.bodyHtml}) <= 200000`,
    ),
    subjectLength: check(
      "message_templates_subject_max_length",
      sql`${t.subject} IS NULL OR length(${t.subject}) <= 1000`,
    ),
    channelEnum: check(
      "message_templates_channel_enum",
      sql`${t.channel} IN ('email','sms','voice','push')`,
    ),
  }),
);

export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type InsertMessageTemplateRow = typeof messageTemplates.$inferInsert;
