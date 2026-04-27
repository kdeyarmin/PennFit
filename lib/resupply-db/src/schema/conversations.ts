import { sql } from "drizzle-orm";
import {
  index,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { episodes } from "./episodes";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * Conversations — one thread of back-and-forth with a patient on a single
 * channel for a single episode.
 *
 * A patient + episode can have multiple conversations (e.g. an SMS thread
 * that reached `closed`, then a follow-up phone call started a second
 * conversation). Channels do not mix inside one conversation row — that
 * keeps the message history readable and makes channel-specific
 * vendor metadata (Twilio SID, SendGrid message id) live with the right
 * rows.
 *
 * No PHI on this table. The patient is identified by `patientId`; the
 * messages themselves carry the encrypted content (see `messages.ts`).
 */
export const conversations = resupplySchema.table(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),

    channel: text("channel", { enum: ["sms", "voice", "email"] }).notNull(),

    status: text("status", {
      enum: ["open", "awaiting_patient", "awaiting_operator", "closed"],
    })
      .notNull()
      .default("open"),

    // Optional vendor-side handle for the thread (Twilio conversation
    // SID, SendGrid thread id, etc). Not PHI.
    externalRef: text("external_ref"),

    // Last time a message was added to this conversation. Drives the
    // operator inbox sort order.
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),

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
  }),
);

export type ConversationRow = typeof conversations.$inferSelect;
export type InsertConversationRow = typeof conversations.$inferInsert;
