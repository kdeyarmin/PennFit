import { sql } from "drizzle-orm";
import {
  customType,
  index,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
 *   See migration 0012 — short version is "PHI write surface
 *   minimization" and "lock-contention isolation". Don't move these
 *   columns onto patients without re-reading that migration.
 *
 * Reads:
 *   `last_message_preview` is a bytea column populated via the
 *   `encrypt()` SQL helper exactly like `messages.body`. Reads must
 *   wrap it in `decrypt()` in the projection — the customType below
 *   refuses direct read/write to keep plaintext out of the Drizzle
 *   driver path.
 *
 * Writes:
 *   Don't write through Drizzle directly. Use
 *   `upsertPatientLatestMessage()` (lib/resupply-db/src/projections),
 *   which does the conversation→patient lookup, truncates the body
 *   to PREVIEW_MAX_CHARS, and applies the out-of-order guard.
 */

const REFUSE_DIRECT_READ =
  'Refusing to read encrypted column "last_message_preview" through ' +
  "Drizzle's default decoder — wrap with decrypt() in your projection.";
const REFUSE_DIRECT_WRITE =
  'Refusing to write encrypted column "last_message_preview" through ' +
  "Drizzle's default encoder — go through upsertPatientLatestMessage().";

const encryptedPreview = customType<{ data: string; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(): Buffer {
    throw new Error(REFUSE_DIRECT_WRITE);
  },
  fromDriver(): string {
    throw new Error(REFUSE_DIRECT_READ);
  },
});

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
    lastMessagePreview: encryptedPreview("last_message_preview").notNull(),
    lastMessageConversationId: uuid("last_message_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    recentIdx: index("patient_latest_message_recent_idx").on(
      sql`${t.lastMessageAt} DESC`,
    ),
  }),
);

export type PatientLatestMessageRow =
  typeof patientLatestMessage.$inferSelect;
