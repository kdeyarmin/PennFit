// patient_therapy_nights — nightly CPAP usage rollup imported
// from a therapy-cloud partner (Phase E.1 / feature #18).
//
// Schema is partner-agnostic — the `source` column tags rows so
// data from multiple clouds can coexist for the same patient.
// See migration 0046 for the policy doc.

import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export type TherapyCloudSource = "resmed_airview" | "philips_care" | "manual";

export const patientTherapyNights = resupplySchema.table(
  "patient_therapy_nights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD in the patient's local TZ as the device reported. */
    nightDate: date("night_date").notNull(),
    source: text("source").notNull(),
    sourceEventId: text("source_event_id"),
    usageMinutes: integer("usage_minutes"),
    ahi: numeric("ahi", { precision: 5, scale: 2 }),
    leakRateLMin: numeric("leak_rate_l_min", { precision: 5, scale: 2 }),
    pressureP95Cmh2o: numeric("pressure_p95_cmh2o", { precision: 4, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientDateIdx: index("patient_therapy_nights_patient_date_idx").on(
      t.patientId,
      t.nightDate,
    ),
    patientNightSourceUnique: unique("patient_therapy_nights_unique").on(
      t.patientId,
      t.nightDate,
      t.source,
    ),
    sourceEnum: check(
      "patient_therapy_nights_source_enum",
      sql`${t.source} IN ('resmed_airview','philips_care','manual')`,
    ),
  }),
);

export type PatientTherapyNightRow = typeof patientTherapyNights.$inferSelect;
export type InsertPatientTherapyNightRow =
  typeof patientTherapyNights.$inferInsert;
