// patient_therapy_links — durable per-patient mapping to a
// therapy-cloud (ResMed AirView, Philips Care) account so the
// nightly sync worker can fetch usage data without an admin
// re-entering the partner id. See migration 0064 for the policy doc.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export type TherapyLinkSource = "resmed_airview" | "philips_care";
export type TherapyLinkStatus = "active" | "paused" | "revoked";

export const patientTherapyLinks = resupplySchema.table(
  "patient_therapy_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    partnerPatientId: text("partner_patient_id").notNull(),
    deviceSerial: text("device_serial"),
    status: text("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncStatus: text("last_sync_status"),
    lastSyncError: text("last_sync_error"),
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
      "patient_therapy_links_source_enum",
      sql`${t.source} IN ('resmed_airview','philips_care')`,
    ),
    statusEnum: check(
      "patient_therapy_links_status_enum",
      sql`${t.status} IN ('active','paused','revoked')`,
    ),
    partnerUnique: unique("patient_therapy_links_partner_unique").on(
      t.source,
      t.partnerPatientId,
    ),
    // The "one-active-link-per-(patient,source)" rule is a partial
    // unique index in SQL — Drizzle doesn't model partial uniques
    // natively, so it's enforced by the migration only. Inserts
    // that violate it surface as the index name in the PG error.
    scanIdx: index("patient_therapy_links_scan_idx").on(
      t.status,
      t.lastSyncedAt,
    ),
  }),
);

export type PatientTherapyLinkRow = typeof patientTherapyLinks.$inferSelect;
export type InsertPatientTherapyLinkRow =
  typeof patientTherapyLinks.$inferInsert;
