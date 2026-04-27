import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { encryptedText } from "../encryption";
import { conversations } from "./conversations";
import { resupplySchema } from "./_schema";

/**
 * Messages — individual SMS / email / voice-transcript turns inside a
 * conversation.
 *
 * Why `body` is encrypted:
 *   Patient turns frequently contain PHI (names, addresses, even
 *   diagnosis details when they ramble at the agent). The whole body is
 *   pgcrypto-encrypted; routing fields the system needs to query on
 *   (`direction`, `senderRole`, `deliveryStatus`) live in plaintext.
 *
 * `vendorMetadata` (jsonb, plaintext) stores Twilio/SendGrid envelope
 * data — message SID, error codes, segment counts. It is operationally
 * useful and never carries PHI.
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
      enum: ["patient", "operator", "agent", "system"],
    }).notNull(),

    // Encrypted body. Use `encrypt(value)` to write and
    // `decrypt(messages.body)` to read.
    body: encryptedText("body").notNull(),

    // Vendor-side delivery state (twilio: queued/sent/delivered/undelivered/failed).
    deliveryStatus: text("delivery_status"),
    deliveryError: text("delivery_error"),

    // Plaintext envelope from the channel adapter — message SID,
    // segment count, etc. Never PHI.
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
  }),
);

export type MessageRow = typeof messages.$inferSelect;
export type InsertMessageRow = typeof messages.$inferInsert;
