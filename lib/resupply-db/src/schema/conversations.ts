import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { episodes } from "./episodes";
import { patients } from "./patients";
import { shopCustomers } from "./shop-customers";
import { resupplySchema } from "./_schema";

/**
 * Conversations — one thread of back-and-forth with a patient OR a
 * shop customer on a single channel.
 *
 * Subject identity is polymorphic and enforced by the DB-side
 * `conversations_subject_xor_check` (added in migration 0033):
 *
 *   * patient flow → patient_id + episode_id set, customer_id NULL.
 *     Channels: "sms" | "voice" | "email" (Twilio / SendGrid).
 *   * in-app flow  → customer_id set, patient_id + episode_id NULL.
 *     Channel: "in_app" (no vendor dispatch — pure DB persistence
 *     plus an out-of-band SendGrid notification email).
 *
 * A patient + episode can have multiple conversations (e.g. an SMS thread
 * that reached `closed`, then a follow-up phone call started a second
 * conversation). Channels do not mix inside one conversation row — that
 * keeps the message history readable and makes channel-specific
 * vendor metadata (Twilio SID, SendGrid message id) live with the right
 * rows. In-app threads use a single thread per customer (the customer-
 * facing /shop/me/messages endpoint upserts on customer_id).
 *
 * No PHI on this table. Subject is identified by patient_id/episode_id
 * or customer_id; the messages themselves carry the body content (see
 * `messages.ts`).
 */
export const conversations = resupplySchema.table(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Patient flow only. Nullable post-0033 so in-app shop-customer
     * threads can omit it. The XOR check enforces "set together with
     * episode_id (and customer_id null), or all-null with customer_id
     * set".
     */
    patientId: uuid("patient_id").references(() => patients.id, {
      onDelete: "cascade",
    }),
    /**
     * Patient flow only. Nullable post-0033 — see patientId comment.
     */
    episodeId: uuid("episode_id").references(() => episodes.id, {
      onDelete: "cascade",
    }),
    /**
     * Shop-customer (in-app) flow only. Nullable for backwards
     * compatibility with patient/episode rows. FK to
     * shop_customers.customer_id ON DELETE CASCADE so deleting a
     * shop customer also tears down their conversation history.
     */
    customerId: text("customer_id").references(() => shopCustomers.customerId, {
      onDelete: "cascade",
    }),

    channel: text("channel", {
      enum: ["sms", "voice", "email", "in_app"],
    }).notNull(),

    status: text("status", {
      enum: ["open", "awaiting_patient", "awaiting_admin", "closed"],
    })
      .notNull()
      .default("open"),

    // Optional vendor-side handle for the thread (Twilio conversation
    // SID, SendGrid thread id, etc). Not PHI.
    externalRef: text("external_ref"),

    // Last time a message was added to this conversation. Drives the
    // admin inbox sort order.
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),

    /**
     * In-app channel only. Updated by `POST /shop/me/messages/mark-read`
     * when the customer opens their /account messaging section.
     * Null until the customer reads at least once. The unread-count
     * helper compares this against `max(messages.created_at WHERE
     * direction='outbound')` to determine how many CSR replies are
     * still unread. Patient-flow rows leave this null forever.
     */
    customerLastReadAt: timestamp("customer_last_read_at", {
      withTimezone: true,
    }),

    /**
     * In-app channel only (Phase 13). Timestamp of the most recent
     * "you have a new message from PennPaps" SendGrid notification
     * sent for this thread. tryNotifyCustomerOfReply skips the email
     * when this is within the throttle window so a CSR sending
     * rapid-fire replies doesn't blast the customer's inbox. Null
     * means "no notification yet" (or pre-Phase-13 row) and the next
     * reply still triggers an email.
     */
    lastInAppNotificationAt: timestamp("last_in_app_notification_at", {
      withTimezone: true,
    }),

    // Assignment + SLA columns (migration 0021). assignedAdminUserId
    // mirrors the auth user id directly (no FK) so threads handled by
    // bootstrap env-var admins still work — those admins don't have
    // rows in admin_users yet.
    assignedAdminUserId: text("assigned_admin_user_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    priority: text("priority").notNull().default("normal"),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalatedTo: text("escalated_to"),
    escalationReason: text("escalation_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientIdx: index("conversations_patient_idx").on(t.patientId),
    episodeIdx: index("conversations_episode_idx").on(t.episodeId),
    channelStatusIdx: index("conversations_channel_status_idx").on(
      t.channel,
      t.status,
    ),
    lastMessageAtIdx: index("conversations_last_message_at_idx").on(
      t.lastMessageAt,
    ),
    // NOTE: migration 0021 creates three PARTIAL indexes
    //   conversations_assignee_active_idx
    //   conversations_sla_due_active_idx
    //   conversations_escalated_idx
    // Migration 0033 adds the customer_id partial index
    //   conversations_customer_id_idx (WHERE customer_id IS NOT NULL)
    // and the conversations_subject_xor_check CHECK constraint.
    // Drizzle can't express the WHERE clauses; the migration SQL is
    // the source of truth for those indexes / constraints.
    priorityEnum: check(
      "conversations_priority_enum",
      sql`${t.priority} IN ('low','normal','high','urgent')`,
    ),
  }),
);

export type ConversationRow = typeof conversations.$inferSelect;
export type InsertConversationRow = typeof conversations.$inferInsert;
