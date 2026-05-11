import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * equipment_recalls — manufacturer recall notices the supplier is
 * tracking, with the match criteria the recall-scan engine uses to
 * intersect with the equipment_assets registry.
 *
 * Why this table exists
 * ---------------------
 * When a manufacturer issues a recall (Philips DreamStation 2021,
 * the foam-degradation recall, was the canonical example), the DME
 * needs to:
 *
 *   1. Identify every dispensed device that matches the recall
 *      criteria — manufacturer + model + (optionally) a serial
 *      range or explicit serial list.
 *   2. Reach those patients within the manufacturer's deadline.
 *   3. Track the resolution per-patient (replacement device
 *      shipped / repair authorized / customer declined).
 *
 * Step 1 is what this table makes possible. The recall-scan
 * endpoint reads `equipment_recalls` rows where status='active'
 * and runs them against `equipment_assets.{manufacturer, model,
 * serial_number}` to surface affected patients.
 *
 * Match criteria
 * --------------
 * Three orthogonal criteria, all optional but at least one
 * required (enforced by the route, not the DB):
 *
 *   * `manufacturer` (required for any meaningful match) — string
 *     equality, lower-cased on compare.
 *   * `model_match` — optional string equality. NULL means "any
 *     model from this manufacturer".
 *   * `serial_match` jsonb — optional. Either:
 *       { "kind": "range", "from": "X1", "to": "X9999" }   — string
 *         range comparison (works for the serial schemes used by
 *         ResMed, Philips, Fisher & Paykel).
 *       { "kind": "list", "serials": ["S1", "S2", ...] }   — explicit
 *         enumeration for one-off recalls.
 *       NULL means "every serial for this manufacturer + model".
 *
 * Severity
 * --------
 *   * `urgent`   — stop using the device immediately (e.g. fire
 *                  hazard, foam degradation). The CSR queue is
 *                  triaged within hours, not days.
 *   * `priority` — replace within the manufacturer's window
 *                  (typical CMS / FDA Class II recall).
 *   * `advisory` — informational; no immediate action required
 *                  (e.g. firmware update advisory).
 *
 * PHI posture
 * -----------
 * Recall metadata is NOT PHI — it's manufacturer notice text. The
 * cross-product with patients (which patient owns which serial) is
 * derived at scan time and surfaced only inside the admin-gated
 * recall-scan endpoint.
 */
export const equipmentRecalls = resupplySchema.table(
  "equipment_recalls",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The manufacturer's own recall reference, when one was assigned
    // (FDA recall numbers like "Z-XXXX-2021", or the manufacturer's
    // internal recall code). Unique so a CSR can't accidentally
    // double-record the same recall.
    recallReference: varchar("recall_reference", { length: 64 }).notNull(),

    /** Human-readable summary for the recalls list UI. */
    title: varchar("title", { length: 200 }).notNull(),

    manufacturer: varchar("manufacturer", { length: 80 }).notNull(),

    /** Optional model exact-match. NULL = any model from manufacturer. */
    modelMatch: varchar("model_match", { length: 120 }),

    /** Optional serial-number match criteria — see class comment. */
    serialMatch: jsonb("serial_match").$type<
      | { kind: "range"; from: string; to: string }
      | { kind: "list"; serials: string[] }
      | null
    >(),

    severity: text("severity", {
      enum: ["urgent", "priority", "advisory"],
    })
      .notNull()
      .default("priority"),

    // Lifecycle. Active recalls feed the recall-scan and the daily
    // alert digest. Closed recalls remain on file for audit but no
    // longer scan.
    status: text("status", { enum: ["active", "closed"] })
      .notNull()
      .default("active"),

    issuedAt: date("issued_at"),
    /** Manufacturer-stated deadline for return/replacement, when one
     *  is published. NULL when open-ended. */
    deadlineAt: date("deadline_at"),

    /** Public reference URL (FDA recall page, manufacturer notice). */
    referenceUrl: text("reference_url"),

    description: text("description"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    recallReferenceUnique: uniqueIndex(
      "equipment_recalls_reference_unique",
    ).on(t.recallReference),
    // Active recalls are the hot path of the scan endpoint.
    activeIdx: index("equipment_recalls_status_idx").on(t.status, t.severity),
    referenceNotEmpty: check(
      "equipment_recalls_reference_not_empty",
      sql`length(trim(${t.recallReference})) > 0`,
    ),
  }),
);

export type EquipmentRecallRow = typeof equipmentRecalls.$inferSelect;
export type InsertEquipmentRecallRow = typeof equipmentRecalls.$inferInsert;
export type EquipmentRecallSeverity = NonNullable<
  EquipmentRecallRow["severity"]
>;
export type EquipmentRecallStatus = NonNullable<EquipmentRecallRow["status"]>;
