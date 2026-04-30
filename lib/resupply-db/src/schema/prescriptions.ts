import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { encryptedJson } from "../encryption";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * Prescriptions — the doctor's order that authorises a patient to receive
 * resupply items on a given cadence.
 *
 * Why each column lives where it does:
 *   - `patientId` — owning patient. ON DELETE CASCADE is intentional:
 *     when a patient row is deleted (admin-initiated PHI purge), every
 *     prescription on file is also deleted.
 *   - `itemSku` and `cadenceDays` — the operational fields the eligibility
 *     engine reads on every tick. Plaintext, indexed.
 *   - `validFrom` / `validUntil` — date bounds on the order. Plaintext,
 *     not PHI on their own.
 *   - `details` — encrypted JSON for the doctor-provided narrative
 *     (diagnosis text, fitting notes). PHI per HIPAA, so encrypted.
 *
 * Multiple prescriptions per patient are allowed; the eligibility engine
 * picks the most recent active prescription for a given SKU.
 */
export const prescriptions = resupplySchema.table(
  "prescriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    // What item the script authorises. SKU is the Pacware product code;
    // we don't manage a product catalogue here, we just key off the SKU.
    itemSku: text("item_sku").notNull(),

    // Refill cadence in whole days. Eligibility engine compares this
    // against the patient's last fulfillment date for the same SKU.
    cadenceDays: integer("cadence_days").notNull(),

    // Date bounds on the prescription. `validUntil` may be null for
    // open-ended scripts (rare, but legally possible).
    validFrom: date("valid_from").notNull(),
    validUntil: date("valid_until"),

    // Free-form prescriber notes / diagnosis text. Encrypted.
    details: encryptedJson<{
      prescriberName?: string;
      prescriberNpi?: string;
      diagnosis?: string;
      notes?: string;
    }>("details"),

    // Lifecycle. "active" enters the eligibility engine. "expired" /
    // "revoked" do not. We keep history rather than hard-deleting.
    status: text("status", { enum: ["active", "expired", "revoked"] })
      .notNull()
      .default("active"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    // Document attachment metadata. The bytes themselves live in
    // App Storage (GCS) under PRIVATE_OBJECT_DIR, gated by the
    // ACL framework in artifacts/resupply-api/src/lib/objectAcl.ts.
    // We persist only the object path here so download URLs can be
    // re-derived on demand without round-tripping every prescription
    // row through GCS metadata. See migration 0015 for the rationale
    // behind each column individually.
    attachmentObjectKey: text("attachment_object_key"),
    attachmentFilename: varchar("attachment_filename", { length: 255 }),
    attachmentContentType: varchar("attachment_content_type", { length: 120 }),
    attachmentSizeBytes: integer("attachment_size_bytes"),
    attachmentUploadedAt: timestamp("attachment_uploaded_at", {
      withTimezone: true,
    }),
  },
  (t) => ({
    patientIdx: index("prescriptions_patient_idx").on(t.patientId),
    patientSkuIdx: index("prescriptions_patient_sku_idx").on(
      t.patientId,
      t.itemSku,
    ),
    statusIdx: index("prescriptions_status_idx").on(t.status),
  }),
);

export type PrescriptionRow = typeof prescriptions.$inferSelect;
export type InsertPrescriptionRow = typeof prescriptions.$inferInsert;
