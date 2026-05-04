import { sql } from "drizzle-orm";
import {
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { messages } from "./messages";
import { resupplySchema } from "./_schema";

/**
 * Message attachments — media files attached to inbound or outbound
 * messages.
 *
 * Today this is populated by the SMS/MMS inbound webhook ingesting
 * Twilio MediaUrl[N] into our private object store; the same table
 * will hold inbound email attachments when that path needs them.
 *
 * `object_key` is a `/objects/uploads/<uuid>` path that the API's
 * ObjectStorageService can resolve to a GCS file. The bytes are
 * NOT stored here — only the metadata.
 *
 * `twilio_media_sid` carries Twilio's globally unique media id when
 * the source is MMS (null otherwise). The companion partial unique
 * index in migration 0029 enforces replay protection: a re-delivered
 * webhook can't double-ingest the same media.
 */
export const messageAttachments = resupplySchema.table(
  "message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),

    /** GCS object path inside PRIVATE_OBJECT_DIR (e.g. /objects/uploads/<uuid>). */
    objectKey: text("object_key").notNull(),

    /** Best-effort original filename. Browser-supplied → not trusted. */
    filename: varchar("filename", { length: 255 }),

    /** Server-validated MIME type at ingest time. */
    contentType: varchar("content_type", { length: 120 }).notNull(),

    /** Actual bytes uploaded; mirrored from GCS metadata at ingest. */
    sizeBytes: integer("size_bytes").notNull(),

    /** Twilio's globally unique media SID; null for non-Twilio sources. */
    twilioMediaSid: text("twilio_media_sid"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    messageIdx: index("message_attachments_message_idx").on(t.messageId),
    twilioSidUniq: uniqueIndex("message_attachments_twilio_media_sid_unique")
      .on(t.twilioMediaSid)
      .where(sql`${t.twilioMediaSid} IS NOT NULL`),
  }),
);

export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
export type InsertMessageAttachmentRow = typeof messageAttachments.$inferInsert;
