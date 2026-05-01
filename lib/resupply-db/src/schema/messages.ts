import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    senderRole: text("sender_role", {
      enum: ["patient", "admin", "agent", "system"],
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
    // Replay-protection: each inbound Twilio MessageSid must be unique.
    // The partial expression index (direction = 'inbound') ensures the
    // constraint only applies to inbound messages and does not interfere
    // with outbound rows that never carry a twilio_message_sid. Created
    // by migration 0018_messages_twilio_sid_unique.sql.
    twilioSidInboundUniq: uniqueIndex(
      "messages_twilio_sid_inbound_uniq",
    )
      .on(sql`(${t.vendorMetadata}->>'twilio_message_sid')`)
      .where(sql`direction = 'inbound'`),
  }),
);

export type MessageRow = typeof messages.$inferSelect;
export type InsertMessageRow = typeof messages.$inferInsert;
