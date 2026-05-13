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
import { resupplySchema } from "./_schema";

/**
 * recall_remediation_actions — per-asset record of what we DID
 * about a recall, once the patient was notified (Phase 4 of the
 * recall workflow built earlier).
 *
 * Manufacturer recall letters say "return the device" or "destroy
 * the device" or "we'll replace it." Surveyors and the FDA both
 * ask "show me you handled every affected unit." This table is
 * that answer.
 *
 * Posture
 * -------
 *   * One row per (recall_id, asset_id) — same shape as
 *     recall_notifications, with UNIQUE on the pair to keep the
 *     log idempotent.
 *   * `action` is the verb (returned_to_manufacturer / destroyed /
 *     replaced / patient_declined / lost / unreachable). The full
 *     set is documented inline.
 *   * `evidence_url` points at the supporting artifact — a return
 *     shipping label, a destruction certificate photo, or the
 *     correspondence saying the patient declined. Optional but
 *     surveyors specifically ask for it on "destroyed" rows.
 *   * `notes` is free-form CSR commentary; bounded.
 *
 * FK posture: recall + asset both CASCADE on delete. Since both
 * upstream rows are themselves audit artifacts (deletions are rare
 * and require an admin), the cascade is safer than orphans.
 */
export const recallRemediationActions = resupplySchema.table(
  "recall_remediation_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recallId: uuid("recall_id")
      .notNull()
      .references(() => equipmentRecalls.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => equipmentAssets.id, { onDelete: "cascade" }),

    /**
     * The verb. See the check constraint for the canonical set.
     *
     * `returned_to_manufacturer` — patient sent unit back per
     *   manufacturer instructions.
     * `destroyed` — patient or DME destroyed the unit per
     *   manufacturer instructions (requires evidence_url).
     * `replaced` — manufacturer issued a replacement; old unit
     *   is dealt with separately.
     * `patient_declined` — patient was notified but refused to
     *   take action. We log this so the audit story includes
     *   "we tried; they said no."
     * `lost` — patient says the unit is no longer in their
     *   possession (sold, gifted, discarded).
     * `unreachable` — patient cannot be contacted after N
     *   attempts (typically 3 across email + SMS + voice).
     */
    action: text("action").notNull(),
    evidenceUrl: text("evidence_url"),
    notes: text("notes"),
    performedByUserId: text("performed_by_user_id"),

    performedAt: timestamp("performed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
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
      "recall_remediation_actions_recall_asset_unique",
    ).on(t.recallId, t.assetId),
    recallIdx: index("recall_remediation_actions_recall_idx").on(t.recallId),
    actionEnum: check(
      "recall_remediation_actions_action_enum",
      sql`${t.action} IN ('returned_to_manufacturer','destroyed','replaced','patient_declined','lost','unreachable')`,
    ),
  }),
);

export type RecallRemediationActionRow =
  typeof recallRemediationActions.$inferSelect;
export type InsertRecallRemediationActionRow =
  typeof recallRemediationActions.$inferInsert;
