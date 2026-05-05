// patient_onboarding_journeys — first-90-day adherence-coaching
// enrollment per patient (Phase B.1 / feature #17). See migration
// 0042 for the policy doc.
//
// One active row per patient (enforced by the partial unique index).
// Once day90_sent_at is set, the dispatcher transitions status to
// `completed`. CSRs can manually pause / resume via the admin
// endpoints if a patient wants fewer touches.

import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export type PatientOnboardingStatus = "active" | "completed" | "paused";
export type OnboardingDayLabel = "day1" | "day7" | "day30" | "day90";

/** Day labels in send-order. Imported by the dispatcher to compute
 *  the next-due check-in given the row's per-day timestamps. */
export const ONBOARDING_DAYS: ReadonlyArray<{
  label: OnboardingDayLabel;
  offsetDays: number;
}> = [
  { label: "day1", offsetDays: 1 },
  { label: "day7", offsetDays: 7 },
  { label: "day30", offsetDays: 30 },
  { label: "day90", offsetDays: 90 },
];

export const patientOnboardingJourneys = resupplySchema.table(
  "patient_onboarding_journeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    /** Therapy-start anchor; cadence is offsetDays from this. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    day1SentAt: timestamp("day1_sent_at", { withTimezone: true }),
    day7SentAt: timestamp("day7_sent_at", { withTimezone: true }),
    day30SentAt: timestamp("day30_sent_at", { withTimezone: true }),
    day90SentAt: timestamp("day90_sent_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    enrolledByEmail: text("enrolled_by_email").notNull(),
    enrolledByUserId: text("enrolled_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    statusEnum: check(
      "patient_onboarding_journeys_status_enum",
      sql`${t.status} IN ('active','completed','paused')`,
    ),
    activeStartedIdx: index(
      "patient_onboarding_journeys_active_started_idx",
    ).on(t.startedAt),
    // The partial unique index (active-only) is created by the
    // migration directly — drizzle-kit can't express the WHERE.
  }),
);

export type PatientOnboardingJourneyRow =
  typeof patientOnboardingJourneys.$inferSelect;
export type InsertPatientOnboardingJourneyRow =
  typeof patientOnboardingJourneys.$inferInsert;
