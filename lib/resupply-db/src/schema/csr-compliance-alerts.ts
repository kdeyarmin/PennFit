// csr_compliance_alerts — at-risk queue surfaced in the admin
// dashboard. See migration 0065 for the policy doc.
//
// Auto-created by the daily compliance scanner when the patient's
// adherence drops below the elapsed-window target, when no replies
// come back to a check-in send, or when consecutive vendor failures
// indicate the patient's contact info is stale. CSRs resolve rows
// from the dashboard with a short note — they're never deleted.
//
// Lifecycle: open → snoozed (with snoozedUntil) → open  → resolved.
// One *open* row per (patient, alert_type) — the partial unique
// index in the migration enforces that, and the scanner upserts
// rather than inserting a second open row.

import { sql } from "drizzle-orm";
import { check, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { patientOnboardingJourneys } from "./patient-onboarding-journeys";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export type CsrComplianceAlertType =
  | "low_usage"
  | "no_response"
  | "send_failure"
  | "manual";
export type CsrComplianceAlertSeverity = "info" | "warning" | "critical";
export type CsrComplianceAlertStatus = "open" | "snoozed" | "resolved";

export const csrComplianceAlerts = resupplySchema.table(
  "csr_compliance_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    journeyId: uuid("journey_id").references(
      () => patientOnboardingJourneys.id,
      { onDelete: "set null" },
    ),
    alertType: text("alert_type", {
      enum: ["low_usage", "no_response", "send_failure", "manual"],
    }).notNull(),
    severity: text("severity", {
      enum: ["info", "warning", "critical"],
    })
      .notNull()
      .default("warning"),
    /** One-line CSR-facing summary. Bounded — not PHI. */
    summary: text("summary").notNull(),
    /** Trigger-time metric snapshot. Schema is alert-type-specific. */
    metricSnapshot: jsonb("metric_snapshot").$type<Record<string, unknown>>(),
    status: text("status", { enum: ["open", "snoozed", "resolved"] })
      .notNull()
      .default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByEmail: text("resolved_by_email"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    alertTypeEnum: check(
      "csr_compliance_alerts_alert_type_enum",
      sql`${t.alertType} IN ('low_usage','no_response','send_failure','manual')`,
    ),
    severityEnum: check(
      "csr_compliance_alerts_severity_enum",
      sql`${t.severity} IN ('info','warning','critical')`,
    ),
    statusEnum: check(
      "csr_compliance_alerts_status_enum",
      sql`${t.status} IN ('open','snoozed','resolved')`,
    ),
    openIdx: index("csr_compliance_alerts_open_idx").on(
      t.status,
      t.severity,
      t.createdAt,
    ),
    patientIdx: index("csr_compliance_alerts_patient_idx").on(
      t.patientId,
      t.createdAt,
    ),
    // Partial unique index "open-only" is created in the migration.
  }),
);

export type CsrComplianceAlertRow = typeof csrComplianceAlerts.$inferSelect;
export type InsertCsrComplianceAlertRow =
  typeof csrComplianceAlerts.$inferInsert;
