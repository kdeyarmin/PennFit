import { sql } from "drizzle-orm";
import {
  date,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { equipmentAssets } from "./equipment-assets";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_grievances — formal patient complaints, grievances, and
 * adverse events.
 *
 * Why three concerns share one table
 * ----------------------------------
 * From the supplier's record-keeping perspective they are
 * structurally identical: receive an issue from a patient, log who
 * it touched, classify severity, document what we did, when, and
 * who closed it. ACHC's Patient Rights standard, BOC's complaint
 * resolution standard, and CMS's adverse event reporting all read
 * from the same kind of row. Splitting them into three tables
 * would mean three near-identical state machines and three
 * separate places a CSR has to remember to log.
 *
 * The `kind` enum keeps each concern reportable separately:
 *   * `complaint`     — informal patient concern ("the box arrived
 *                       wet, my mask was damp"). Reported in the
 *                       accreditation binder under volume metrics.
 *   * `grievance`     — formal written complaint, must be acknowledged
 *                       within the timeframe each accreditor sets.
 *                       Higher visibility on the dashboard.
 *   * `adverse_event` — clinical event involving the equipment
 *                       (skin irritation, leak-related arousal, mold
 *                       in a humidifier, foam-degradation symptoms).
 *                       Potentially FDA MedWatch reportable; the row
 *                       captures the trigger but the report itself
 *                       is a follow-on workflow.
 *
 * Severity
 * --------
 *   * `low`      — service issue, easily resolved.
 *   * `moderate` — patient dissatisfaction, needs CSR follow-up.
 *   * `high`     — patient harm potential, regulatory exposure;
 *                  triggers same-day acknowledgement.
 *
 * Status state machine
 * --------------------
 *   open       -> acknowledged | resolved | escalated
 *   acknowledged -> resolved | escalated
 *   escalated  -> resolved
 *   resolved   -> reopened (rare)
 *   reopened   -> resolved
 *
 * Enforced at the route layer, not the DB (matches the inbound_faxes
 * and equipment_assets patterns).
 *
 * PHI posture
 * -----------
 * Each row references a patient_id; the issue summary almost
 * always contains PHI (symptom descriptions, perceived service
 * failures). Audit metadata records the row id + status + kind
 * only — never the summary.
 */
export const patientGrievances = resupplySchema.table(
  "patient_grievances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    /** Optional FK to the equipment_assets row when the grievance
     *  is tied to a specific device. ON DELETE SET NULL — the
     *  grievance survives the device row's lifecycle. */
    equipmentAssetId: uuid("equipment_asset_id").references(
      () => equipmentAssets.id,
      { onDelete: "set null" },
    ),

    kind: text("kind", {
      enum: ["complaint", "grievance", "adverse_event"],
    }).notNull(),

    severity: text("severity", {
      enum: ["low", "moderate", "high"],
    })
      .notNull()
      .default("low"),

    /** How the patient raised the issue — drives the
     *  "acknowledge by" timer in some accreditation regimes. */
    source: text("source", {
      enum: [
        "phone",
        "email",
        "sms",
        "in_person",
        "letter",
        "portal",
        "other",
      ],
    }).notNull(),

    /** Brief one-line summary. Required because surveyors scan
     *  these in tables — they need a glanceable label. */
    summary: varchar("summary", { length: 200 }).notNull(),
    /** Long-form description (the patient's actual words when
     *  possible). PHI. */
    description: text("description"),

    receivedAt: date("received_at").notNull(),

    status: text("status", {
      enum: ["open", "acknowledged", "escalated", "resolved", "reopened"],
    })
      .notNull()
      .default("open"),

    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** Stamped when status first transitions out of `open`. */
    acknowledgedByUserId: uuid("acknowledged_by_user_id"),

    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id"),

    /** When kind=adverse_event, whether the supplier filed a
     *  MedWatch / mandatory report. We don't model the report
     *  itself yet — boolean + free-text reference. */
    reportedToFda: text("reported_to_fda", {
      enum: ["yes", "no", "not_applicable"],
    })
      .notNull()
      .default("not_applicable"),
    fdaReportReference: varchar("fda_report_reference", { length: 64 }),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    patientIdx: index("patient_grievances_patient_idx").on(t.patientId),
    // Triage view: open / acknowledged grievances sorted by
    // severity then received-at, so the urgent ones surface first.
    statusSeverityIdx: index(
      "patient_grievances_status_severity_received_idx",
    ).on(t.status, t.severity, t.receivedAt),
  }),
);

export type PatientGrievanceRow = typeof patientGrievances.$inferSelect;
export type InsertPatientGrievanceRow =
  typeof patientGrievances.$inferInsert;
export type GrievanceKind = NonNullable<PatientGrievanceRow["kind"]>;
export type GrievanceSeverity = NonNullable<PatientGrievanceRow["severity"]>;
export type GrievanceStatus = NonNullable<PatientGrievanceRow["status"]>;
