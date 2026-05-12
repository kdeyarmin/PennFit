import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { equipmentAssets } from "./equipment-assets";
import { equipmentRecalls } from "./equipment-recalls";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * recall_notifications — per-asset audit row that records "we
 * matched this asset against this recall and (will / did) notify
 * the patient." One row per (recall_id, asset_id) — a recall
 * touches each affected asset at most once, regardless of how
 * many times the match job re-runs.
 *
 * Why a dedicated table and not a column on equipment_assets
 * ----------------------------------------------------------
 *   * The same asset can be touched by multiple recalls over its
 *     lifetime (Philips DreamStation 2021 had two separate
 *     recalls).
 *   * Notification state (queued → sent | failed | bounced) is
 *     per-recall, not per-asset.
 *   * Surveyors specifically ask "show me when patient X was
 *     notified about recall Y" — having a dedicated row makes
 *     that answer one SELECT.
 *
 * Posture
 * -------
 *   * (recall_id, asset_id) is UNIQUE — the matcher upserts
 *     idempotently so re-running it is safe.
 *   * `patient_id` is denormalized off the asset's owner at match
 *     time. Captured here so the audit history survives a future
 *     patient row deletion.
 *   * `channel` is set when the SEND step picks the row up
 *     (separate worker, deferred); the match phase leaves it null
 *     and only stamps "queued."
 *
 * No PHI: the row identifies asset + patient by id; the recall
 * letter content lives in equipment_recalls.body.
 */
export const recallNotifications = resupplySchema.table(
  "recall_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recallId: uuid("recall_id")
      .notNull()
      .references(() => equipmentRecalls.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => equipmentAssets.id, { onDelete: "cascade" }),
    /**
     * Soft FK — we want the audit row to survive a patient
     * deletion (same posture as patient_grievances).
     */
    patientId: uuid("patient_id").notNull(),

    status: text("status").notNull().default("queued"),
    channel: text("channel"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failedReason: text("failed_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    recallAssetUnique: uniqueIndex(
      "recall_notifications_recall_asset_unique",
    ).on(t.recallId, t.assetId),
    // Hot path for the (future) send worker: "queued rows, oldest
    // first." Partial index keeps it cheap as the table grows.
    queuedIdx: index("recall_notifications_queued_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
    statusEnum: check(
      "recall_notifications_status_enum",
      sql`${t.status} IN ('queued', 'sent', 'failed', 'bounced', 'skipped')`,
    ),
    channelEnum: check(
      "recall_notifications_channel_enum",
      sql`${t.channel} IS NULL OR ${t.channel} IN ('email', 'sms', 'letter')`,
    ),
    // Soft FK to patients via index (no constraint) — keeps audit
    // history alive across patient row deletion.
    patientIdx: index("recall_notifications_patient_idx").on(t.patientId),
  }),
);

export type RecallNotificationRow = typeof recallNotifications.$inferSelect;
export type InsertRecallNotificationRow =
  typeof recallNotifications.$inferInsert;

// Reference the patients import so the linter doesn't strip it —
// the column is a SOFT FK, but the import documents the intent.
void patients;
