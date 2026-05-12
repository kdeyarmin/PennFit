import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * appointment_requests — patient-initiated requests for a fitting,
 * follow-up, or coaching call. Lands in an admin queue (CSR triage).
 *
 * Posture
 * -------
 *   * No FK to a patients row — requests come from the storefront
 *     identity (shop_customer email), not necessarily a clinical
 *     patient row. CSR may attach to a patient on triage.
 *   * Free-form `topic` + preferred-time window. We're not running
 *     a real calendar — this is a request inbox.
 *   * Status: new → contacted → scheduled | declined | cancelled.
 */
export const appointmentRequests = resupplySchema.table(
  "appointment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requesterEmail: varchar("requester_email", { length: 254 }).notNull(),
    requesterName: varchar("requester_name", { length: 200 }),
    requesterPhone: varchar("requester_phone", { length: 32 }),
    topic: varchar("topic", { length: 200 }).notNull(),
    preferredWindow: varchar("preferred_window", { length: 200 }),
    notes: text("notes"),
    status: varchar("status", { length: 16 }).notNull().default("new"),
    attachedPatientId: uuid("attached_patient_id"),
    assignedAdminUserId: text("assigned_admin_user_id"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    // Tele-visit meeting URL — set by the CSR when the topic is
    // telehealth_consult and the appointment is confirmed.
    // Patient-facing reminders read this column.
    meetingUrl: text("meeting_url"),
    meetingProvider: varchar("meeting_provider", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    statusIdx: index("appointment_requests_status_idx").on(t.status),
    statusEnum: check(
      "appointment_requests_status_enum",
      sql`${t.status} IN ('new','contacted','scheduled','declined','cancelled')`,
    ),
  }),
);

export type AppointmentRequestRow = typeof appointmentRequests.$inferSelect;
export type InsertAppointmentRequestRow =
  typeof appointmentRequests.$inferInsert;
