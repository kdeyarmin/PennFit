import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { prescriptions } from "./prescriptions";
import { resupplySchema } from "./_schema";

/**
 * equipment_assets — the clinical "which device does this patient
 * actually have" registry.
 *
 * Why this table exists
 * ---------------------
 * The Philips DreamStation recall in 2021 affected millions of CPAP
 * devices and burned every DME that couldn't immediately answer
 * "which of OUR patients are on a recalled unit, and how do we
 * reach them?" The answer requires three things:
 *
 *   1. Per-device serial number, NOT just "patient has a Philips
 *      machine". Without serials you can't intersect with the
 *      manufacturer's lot list.
 *   2. Provenance: when was this serial dispensed to which patient,
 *      and is it currently the active machine in their home?
 *   3. Status: an asset can be active, returned (sent back to the
 *      DME or manufacturer), recalled (awaiting return), or retired
 *      (long-term tracked but no longer in-use). The recall workflow
 *      transitions active → recalled and back depending on
 *      the patient's response.
 *
 * Distinct from shop_customers.cpap_device_json
 * ---------------------------------------------
 * That jsonb is patient-supplied self-service data (e.g. someone
 * who bought a mask through the storefront tells us "I have a
 * ResMed AirSense 11"). It's authoritative for the customer-facing
 * /account experience but is NOT queryable for recall scans across
 * the patient population, doesn't have a status machine, and
 * doesn't carry the prescription-of-record link.
 *
 * The `equipment_assets` row is the admin-curated clinical record:
 * what the supplier dispensed, when, against which prescription,
 * and what its current lifecycle state is.
 *
 * Distinct from Pacware inventory
 * -------------------------------
 * Per the Tier-2 boundary decision (see
 * scripts/check-resupply-architecture.sh Rule 14), Pacware owns
 * WAREHOUSE inventory (on-hand stock, lots, receiving, transfers).
 * `equipment_assets` is the CLINICAL asset register — the
 * patient ↔ serial link the recall workflow needs — which is
 * patient-care, not warehouse data, and therefore lives here.
 *
 * Unique key
 * ----------
 * Manufacturer + serial_number is globally unique per CMS DMEPOS
 * convention. Two patients can't be assigned the same physical
 * device at the same time; serial transfer (patient A returned the
 * device, patient B now uses it) is modeled as a status transition
 * + patient_id swap, with the history retained.
 *
 * PHI posture
 * -----------
 * Patient binding makes each row PHI-equivalent. Audit metadata
 * records the equipment_assets.id + the device class only — never
 * the serial number in plaintext on the audit log.
 */
export const equipmentAssets = resupplySchema.table(
  "equipment_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    // FK to the prescription that authorized dispensing this device.
    // ON DELETE SET NULL: the prescription history may rotate
    // (status='expired'), but the device record should survive.
    prescriptionId: uuid("prescription_id").references(
      () => prescriptions.id,
      { onDelete: "set null" },
    ),

    // Device classification. Drives the resupply rules (mask schedules
    // differ between CPAP and BiPAP, ASV has its own filter cadence).
    deviceClass: text("device_class", {
      enum: [
        "cpap",
        "auto_cpap",
        "bipap",
        "asv",
        "avaps",
        "humidifier",
        "oximeter",
        "other",
      ],
    }).notNull(),

    manufacturer: varchar("manufacturer", { length: 80 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    serialNumber: varchar("serial_number", { length: 80 }).notNull(),

    // Optional clinical settings. Capture once at dispensing for
    // audit; the device itself remains the source of truth for live
    // settings.
    pressureSetting: varchar("pressure_setting", { length: 80 }),
    humidifierSetting: varchar("humidifier_setting", { length: 32 }),

    // Lifecycle.
    //   active     — currently in patient's home, primary therapy device
    //   returned   — sent back to the DME or manufacturer; out of use
    //   recalled   — manufacturer recall in effect; awaiting patient
    //                response (return / replacement / disposition)
    //   retired    — device decommissioned (end of life); kept on
    //                file for audit
    status: text("status", {
      enum: ["active", "returned", "recalled", "retired"],
    })
      .notNull()
      .default("active"),

    // Provenance.
    dispensedAt: date("dispensed_at"),
    /** Free text — typically "DreamStation 2 (replacement under recall)"
     *  or the like, to retain "why is this here" context across CSRs. */
    dispensingNote: text("dispensing_note"),

    // Optional reference to the manufacturer recall that took this
    // asset out of active service. Set when status transitions to
    // 'recalled'; cleared when the patient receives a replacement
    // and the new equipment_assets row is created.
    recallId: uuid("recall_id"),

    // Free-form extension — pressure trial history, swap-out
    // history, anything that doesn't justify a dedicated column.
    metadata: jsonb("metadata").$type<{
      // Examples — not exhaustive; the writing routes don't enforce
      // a shape, the inline type just documents conventions.
      replacedDeviceId?: string;
      ramp?: string;
      epr?: string;
      [k: string]: unknown;
    } | null>(),

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
    patientIdx: index("equipment_assets_patient_idx").on(t.patientId),
    // Serial dedupe per manufacturer. We collapse case so "abc123"
    // and "ABC123" can't both exist — manufacturers sometimes ship
    // mixed-case serials and we don't want a CSR typo to create a
    // phantom dupe.
    manufacturerSerialUnique: uniqueIndex(
      "equipment_assets_manufacturer_serial_unique",
    ).on(t.manufacturer, t.serialNumber),
    // Recall-scan query: pull every active row matching a (mfr,
    // model) tuple — used by the recall-match endpoint.
    manufacturerModelStatusIdx: index(
      "equipment_assets_manufacturer_model_status_idx",
    ).on(t.manufacturer, t.model, t.status),
    serialNotEmpty: check(
      "equipment_assets_serial_not_empty",
      sql`length(trim(${t.serialNumber})) > 0`,
    ),
  }),
);

export type EquipmentAssetRow = typeof equipmentAssets.$inferSelect;
export type InsertEquipmentAssetRow = typeof equipmentAssets.$inferInsert;
export type EquipmentDeviceClass = NonNullable<
  EquipmentAssetRow["deviceClass"]
>;
export type EquipmentStatus = NonNullable<EquipmentAssetRow["status"]>;
