// patient_smart_trigger_events — data-driven reorder nudges
// derived from patient_therapy_nights (Phase E.2 / feature #19).
// See migration 0047 for the policy doc.

import { sql } from "drizzle-orm";
import { check, date, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export type SmartTriggerKind =
  | "leak_rising"
  | "usage_dropping"
  | "cushion_wear"
  | "humidifier_drop";

export const SMART_TRIGGER_KINDS: ReadonlyArray<SmartTriggerKind> = [
  "leak_rising",
  "usage_dropping",
  "cushion_wear",
  "humidifier_drop",
];

export const patientSmartTriggerEvents = resupplySchema.table(
  "patient_smart_trigger_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["leak_rising", "usage_dropping", "cushion_wear", "humidifier_drop"],
    }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    windowStartDate: date("window_start_date").notNull(),
    windowEndDate: date("window_end_date").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedByEmail: text("dismissed_by_email"),
    dismissedReason: text("dismissed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    patientIdx: index("patient_smart_trigger_events_patient_idx").on(
      t.patientId,
      t.detectedAt,
    ),
    kindEnum: check(
      "patient_smart_trigger_events_kind_enum",
      sql`${t.kind} IN ('leak_rising','usage_dropping','cushion_wear','humidifier_drop')`,
    ),
    // Two partial indexes (`pending_idx`, `active_unique`) live in
    // the migration directly — drizzle-kit can't express the WHERE.
  }),
);

export type PatientSmartTriggerEventRow =
  typeof patientSmartTriggerEvents.$inferSelect;
export type InsertPatientSmartTriggerEventRow =
  typeof patientSmartTriggerEvents.$inferInsert;
