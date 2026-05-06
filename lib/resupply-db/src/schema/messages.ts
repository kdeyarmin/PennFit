import { sql } from "drizzle-orm";
import { check, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { resupplySchema } from "./_schema";

/**
 * Messages — individual SMS / email / voice-transcript turns inside a
 * conversation.
 *
 * `body` is plaintext text. Routing fields (`direction`, `senderRole`,
 * `deliveryStatus`) live alongside.
 *
 * `vendorMetadata` (jsonb) stores Twilio/SendGrid envelope data —
 * message SID, error codes, segment counts. Operationally useful for
 * debugging deliveries.
 */
export const messages = resupplySchema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),

    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    /**
     * Who sent this message.
     *
     *   patient  — the resupply patient (SMS/voice/email channels)
     *   customer — the signed-in shop customer (in_app channel only)
     *   admin    — internal staff with full admin role
     *   agent    — internal staff with the limited customer-service-agent role
     *   system   — automated, e.g. workflow-generated event notes
     *
     * The role enum is enforced at the application layer (Drizzle
     * TS-only `text({ enum: [...] })`) — the underlying column is a
     * plain `text`, no Postgres enum type.
     */
    senderRole: text("sender_role", {
      enum: ["patient", "customer", "admin", "agent", "system"],
    }).notNull(),

    body: text("body").notNull(),

    // Vendor-side delivery state (twilio: queued/sent/delivered/undelivered/failed).
    deliveryStatus: text("delivery_status"),
    deliveryError: text("delivery_error"),

    // Envelope from the channel adapter — message SID, segment count, etc.
    vendorMetadata: jsonb("vendor_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),

    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    conversationIdx: index("messages_conversation_idx").on(t.conversationId),
    conversationCreatedIdx: index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    deliveryStatusIdx: index("messages_delivery_status_idx").on(
      t.deliveryStatus,
    ),
    senderRoleEnum: check(
      "messages_sender_role_enum",
      sql`${t.senderRole} IN ('patient','customer','admin','agent','system')`,
    ),
    bodyLength: check(
      "messages_body_max_length",
      sql`length(${t.body}) <= 10000`,
    ),
  }),
);

export type MessageRow = typeof messages.$inferSelect;
export type InsertMessageRow = typeof messages.$inferInsert;
