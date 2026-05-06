import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * Patient latest-message projection (W3 T-A5/A6/A7).
 *
 * 1:1 with patients — exactly one row per patient who has ever
 * exchanged at least one message. Patients with zero messages have
 * no row here, which is also why every read joins LEFT to project a
 * NULL last-message into the response shape.
 *
 * Why a separate table and not denormalization onto patients:
 *   See migration 0012 — short version is "lock-contention isolation"
 *   (the projection is rewritten on every message, while patients is
 *   admin-edited rarely). Don't move these columns onto patients
 *   without re-reading that migration.
 *
 * Reads/writes:
 *   `last_message_preview` is plaintext text, capped at
 *   `PREVIEW_MAX_CHARS` characters by `upsertPatientLatestMessage()`
 *   (lib/resupply-db/src/projections). Always go through that helper
 *   for writes — it does the conversation→patient lookup and applies
 *   the out-of-order guard.
 */
export const patientLatestMessage = resupplySchema.table(
  "patient_latest_message",
  {
    patientId: uuid("patient_id")
      .primaryKey()
      .references(() => patients.id, { onDelete: "cascade" }),
    lastMessageAt: timestamp("last_message_at", {
      withTimezone: true,
    }).notNull(),
    lastMessageDirection: text("last_message_direction", {
      enum: ["inbound", "outbound"],
    }).notNull(),
    lastMessagePreview: text("last_message_preview").notNull(),
    lastMessageConversationId: uuid("last_message_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    recentIdx: index("patient_latest_message_recent_idx").on(
      sql`${t.lastMessageAt} DESC`,
    ),
  }),
);

export type PatientLatestMessageRow = typeof patientLatestMessage.$inferSelect;
