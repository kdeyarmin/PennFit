// patient_onboarding_journeys — first-90-day adherence-coaching
// enrollment per patient (Phase B.1 / feature #17). See migration
// 0042 for the original policy doc and 0065 for the day3/day60
// cadence expansion + multi-channel delivery.
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
/**
 * Day labels used in the cadence + audit envelopes. `day1` is retained
 * for backward compatibility with rows enrolled before the 0065
 * expansion; new code only schedules day3/day7/day30/day60/day90.
 */
export type OnboardingDayLabel =
  | "day1"
  | "day3"
  | "day7"
  | "day30"
  | "day60"
  | "day90";

/** Day labels in send-order. Imported by the dispatcher to compute
 *  the next-due check-in given the row's per-day timestamps. The
 *  legacy `day1` slot is intentionally absent — the new cadence
 *  shifts the first nudge to day-3 (peak mask-discomfort window).  */
export const ONBOARDING_DAYS: ReadonlyArray<{
  label: OnboardingDayLabel;
  offsetDays: number;
}> = [
  { label: "day3", offsetDays: 3 },
  { label: "day7", offsetDays: 7 },
  { label: "day30", offsetDays: 30 },
  { label: "day60", offsetDays: 60 },
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
    // Legacy day1 slot — preserved on rows enrolled pre-0065 so the
    // audit history isn't lost. The current cadence does not write to
    // this column for new sends.
    day1SentAt: timestamp("day1_sent_at", { withTimezone: true }),
    day3SentAt: timestamp("day3_sent_at", { withTimezone: true }),
    day7SentAt: timestamp("day7_sent_at", { withTimezone: true }),
    day30SentAt: timestamp("day30_sent_at", { withTimezone: true }),
    day60SentAt: timestamp("day60_sent_at", { withTimezone: true }),
    day90SentAt: timestamp("day90_sent_at", { withTimezone: true }),
    status: text("status", { enum: ["active", "completed", "paused"] }).notNull().default("active"),
    enrolledByEmail: text("enrolled_by_email").notNull(),
    enrolledByUserId: text("enrolled_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
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
