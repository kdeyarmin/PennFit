import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_maintenance_log — per-patient hygiene completion record.
 *
 * Distinct from resupply (which tracks REPLACEMENT cadence of
 * cushion / hose / filter). This table tracks HYGIENE cadence —
 * daily mask wipe-down, weekly humidifier chamber wash, etc. Poor
 * mask hygiene is the #1 driver of leak-rate creep and the #2
 * driver of skin / sinus irritation in CPAP populations; surfacing
 * a checklist on /account directly drops "my mask started leaking"
 * tickets.
 *
 * Why a log table instead of a "next due" column on patients
 * --------------------------------------------------------
 *   * The set of tasks is small but versioned (we can add a new
 *     task in a deploy; old patients shouldn't suddenly look
 *     "behind"). A log keeps the history immutable.
 *   * Surveyors and curious patients both ask "when did I last
 *     wash my hose" — the log answers that without an audit
 *     subquery.
 *   * The "next due" date is computed from MAX(completed_at) +
 *     cadence in code, where the cadence catalog lives. Patients
 *     who haven't completed yet show "due today."
 *
 * Task catalog lives in code at
 * artifacts/resupply-api/src/lib/patient-maintenance/catalog.ts —
 * the DB only stores completion events. Adding / tuning a task
 * doesn't require a migration.
 *
 * PHI posture
 * -----------
 * This is patient hygiene data — sensitive but not directly
 * clinical. Audit envelopes record patient_id + task_key only;
 * the completed_at timestamp lives in the row and isn't logged.
 *
 * `source` is "patient_portal" today (the patient checks the box).
 * Future expansion ("csr_proxy" when a CSR logs on behalf of a
 * phone-call patient) doesn't need a migration.
 */
export const patientMaintenanceLog = resupplySchema.table(
  "patient_maintenance_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    /** Stable identifier from the catalog. Lowercase + underscores,
     *  same shape as the accreditation policy_key for consistency. */
    taskKey: varchar("task_key", { length: 64 }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Channel that recorded the completion. Catalog-defined so a
     *  text mistake doesn't enter analytics. */
    source: text("source").notNull().default("patient_portal"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Hot path: "what's the latest completion of <task> for this
    // patient." DESC on completed_at means MAX-aware reads are
    // an index-only scan.
    patientTaskCompletedIdx: index(
      "patient_maintenance_log_patient_task_completed_idx",
    ).on(t.patientId, t.taskKey, t.completedAt),
    taskKeyShape: check(
      "patient_maintenance_log_task_key_shape",
      sql`${t.taskKey} ~ '^[a-z0-9_]{1,64}$'`,
    ),
    sourceEnum: check(
      "patient_maintenance_log_source_enum",
      sql`${t.source} IN ('patient_portal', 'csr_proxy', 'system')`,
    ),
  }),
);

export type PatientMaintenanceLogRow =
  typeof patientMaintenanceLog.$inferSelect;
export type InsertPatientMaintenanceLogRow =
  typeof patientMaintenanceLog.$inferInsert;
