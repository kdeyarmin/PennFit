import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_maintenance_nudges — record of "we emailed this patient
 * about overdue hygiene tasks on date X." Used by the weekly nudge
 * worker to enforce a 7-day quiet period (no patient should hear
 * "wash your hose" twice in a week).
 *
 * Why not stamp a column on patient_maintenance_log
 * --------------------------------------------------
 * The log row records when the patient COMPLETED a task. We want
 * "when did we nudge them," which is independent — a single nudge
 * email lists multiple overdue tasks, and we don't want to add a
 * per-task column for something that's bundled at the patient level.
 *
 * Posture
 * -------
 *   * One row per nudge sent. The (patient_id, sent_at) shape
 *     makes "most recent nudge for this patient" a fast DESC scan.
 *   * `task_keys` is a JSONB array of the task keys we surfaced in
 *     that email. Surveyors / curious patients can answer "when did
 *     we nudge about the hose wash?" via the audit log without
 *     parsing email content.
 *   * `channel` is "email" today; the column exists so a future SMS
 *     dispatcher can land without a migration.
 *
 * No PHI: patient_id + timestamp + channel + task_keys. The email
 * body lives in SendGrid's history; we don't store it here.
 */
export const patientMaintenanceNudges = resupplySchema.table(
  "patient_maintenance_nudges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    channel: text("channel").notNull().default("email"),
    /** JSONB array of the catalog keys that were overdue when this
     *  nudge fired. Example: `["mask_wash", "tubing_wash"]`. */
    taskKeys: jsonb("task_keys")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientSentAtIdx: index(
      "patient_maintenance_nudges_patient_sent_at_idx",
    ).on(t.patientId, t.sentAt),
    channelEnum: check(
      "patient_maintenance_nudges_channel_enum",
      sql`${t.channel} IN ('email', 'sms')`,
    ),
  }),
);

export type PatientMaintenanceNudgeRow =
  typeof patientMaintenanceNudges.$inferSelect;
export type InsertPatientMaintenanceNudgeRow =
  typeof patientMaintenanceNudges.$inferInsert;
