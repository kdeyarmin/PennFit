// patient_integration_snapshots — cached per-vendor snapshot for
// the admin "Device data" tab (ResMed AirView, Philips Care, Health
// Connect). See migration 0065 for the policy doc.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export type IntegrationSnapshotSource =
  | "resmed_airview"
  | "philips_care"
  | "health_connect";
export type IntegrationSnapshotStatus = "ok" | "partial" | "error";

export const patientIntegrationSnapshots = resupplySchema.table(
  "patient_integration_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    partnerPatientId: text("partner_patient_id").notNull(),
    /** IntegrationSnapshot shape — validated by Zod in the API layer. */
    payload: jsonb("payload").notNull(),
    fetchStatus: text("fetch_status").notNull().default("ok"),
    fetchError: text("fetch_error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    sourceEnum: check(
      "patient_integration_snapshots_source_enum",
      sql`${t.source} IN ('resmed_airview','philips_care','health_connect')`,
    ),
    statusEnum: check(
      "patient_integration_snapshots_status_enum",
      sql`${t.fetchStatus} IN ('ok','partial','error')`,
    ),
    patientSourceUnique: unique(
      "patient_integration_snapshots_unique",
    ).on(t.patientId, t.source),
    patientIdx: index("patient_integration_snapshots_patient_idx").on(
      t.patientId,
    ),
    fetchedIdx: index("patient_integration_snapshots_fetched_idx").on(
      t.fetchedAt,
    ),
  }),
);

export type PatientIntegrationSnapshotRow =
  typeof patientIntegrationSnapshots.$inferSelect;
export type InsertPatientIntegrationSnapshotRow =
  typeof patientIntegrationSnapshots.$inferInsert;
