import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { prescriptions } from "./prescriptions";
import { providers } from "./providers";
import { resupplySchema } from "./_schema";

/**
 * inbound_faxes — durable record of every fax our Twilio number
 * receives, plus a triage state machine for the CSR team.
 *
 * Why this table exists
 * ---------------------
 * The DME industry runs on fax. Sleep studies arrive as faxed PDFs.
 * Rx renewals come back as faxes from physician offices. Chart notes
 * follow via fax. Until now /fax/inbound was a one-line audit stub
 * that ACK'd Twilio and forgot the fax existed — by the time the CSR
 * wanted the document, Twilio had already auto-purged the media
 * (~365 days retention with no notice).
 *
 * This table holds:
 *   1. The fax metadata — Twilio FaxSid, From / To, page count,
 *      received_at — for audit and idempotency.
 *   2. A pointer at the GCS-stored fax bytes so the CSR can view the
 *      PDF whenever, not just within Twilio's retention window.
 *   3. The CSR triage state — who has the fax queued, what it was
 *      attached to (patient + provider + prescription), and the
 *      notes the CSR added during processing.
 *
 * Status state machine
 * --------------------
 *   * `new`      — Twilio just delivered it. No CSR has looked at it.
 *   * `triaged`  — A CSR opened it but hasn't yet decided where it
 *                  belongs. (Reserved status — the SPA may transition
 *                  through this when the CSR opens the document for
 *                  the first time.)
 *   * `attached` — Linked to at least a patient. attached_patient_id
 *                  is required; attached_provider_id and
 *                  attached_prescription_id are optional.
 *   * `archived` — Not actionable (spam, wrong number, junk fax,
 *                  duplicate). Kept on file for audit; never
 *                  hard-deleted.
 *
 * Allowed transitions:
 *   new -> triaged | attached | archived
 *   triaged -> attached | archived | new (CSR un-claims)
 *   attached -> archived (recategorize as junk)
 *   archived -> new (un-archive on accident)
 *
 * PHI posture
 * -----------
 * `from_e164` is the caller's fax number — PHI when tied to a
 * physician office (same posture as physician_fax_outreach.fax_number).
 * Never logged in the application log; audit metadata records the
 * twilio_fax_sid only, never the From.
 *
 * The fax bytes (PDF / TIFF) almost always carry PHI — sleep study
 * results, signed prescriptions, chart notes. They land in GCS under
 * the same private ACL as patient_documents; the `media_object_key`
 * is just a pointer.
 */
export const inboundFaxes = resupplySchema.table(
  "inbound_faxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Twilio's unique identifier for this inbound fax. Used both for
    // idempotency (Twilio retries on non-2xx) and as the audit
    // correlation key.
    twilioFaxSid: varchar("twilio_fax_sid", { length: 64 }).notNull(),

    fromE164: varchar("from_e164", { length: 16 }),
    /** Our Twilio fax number that received this. Not PHI on its own. */
    toE164: varchar("to_e164", { length: 16 }),

    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    numPages: integer("num_pages"),

    // GCS object key for the downloaded fax. Null until the
    // background download succeeds (Twilio webhook ACKs in <15s,
    // download happens after).
    mediaObjectKey: text("media_object_key"),
    mediaContentType: varchar("media_content_type", { length: 120 }),
    mediaSizeBytes: integer("media_size_bytes"),

    status: text("status", {
      enum: ["new", "triaged", "attached", "archived"],
    })
      .notNull()
      .default("new"),

    // Triage results — populated when a CSR attaches the fax to its
    // clinical destination. Each is independently optional, but the
    // status='attached' transition enforces attached_patient_id !=
    // null at the API layer (Postgres doesn't enforce conditional
    // NOT NULL; the route's PATCH validates it).
    attachedPatientId: uuid("attached_patient_id").references(
      () => patients.id,
      { onDelete: "set null" },
    ),
    attachedProviderId: uuid("attached_provider_id").references(
      () => providers.id,
      { onDelete: "set null" },
    ),
    attachedPrescriptionId: uuid("attached_prescription_id").references(
      () => prescriptions.id,
      { onDelete: "set null" },
    ),
    /** Free-text CSR-facing category for the fax. We don't constrain
     *  to an enum — common values are "sleep_study", "prescription",
     *  "chart_note", "eob", "rx_renewal_response", "other" — but
     *  letting CSRs add new categories is more important than
     *  schema-enforced taxonomy. The admin UI offers the common set
     *  as a dropdown and a "Custom" textbox. */
    attachedDocumentType: varchar("attached_document_type", { length: 64 }),

    assignedAdminUserId: uuid("assigned_admin_user_id"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    triagedByUserId: uuid("triaged_by_user_id"),

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
    twilioFaxSidUnique: uniqueIndex("inbound_faxes_twilio_fax_sid_unique").on(
      t.twilioFaxSid,
    ),
    // Status + received_at lookup pattern matches the queue UI:
    // status='new' ORDER BY received_at ASC for the triage queue;
    // status='attached' filtered by attached_patient_id for the
    // patient-detail surface.
    statusReceivedAtIdx: index("inbound_faxes_status_received_at_idx").on(
      t.status,
      t.receivedAt,
    ),
    attachedPatientIdx: index("inbound_faxes_attached_patient_idx").on(
      t.attachedPatientId,
    ),
    pagesNonNegative: check(
      "inbound_faxes_pages_non_negative",
      sql`${t.numPages} IS NULL OR ${t.numPages} >= 0`,
    ),
    sizeNonNegative: check(
      "inbound_faxes_size_non_negative",
      sql`${t.mediaSizeBytes} IS NULL OR ${t.mediaSizeBytes} >= 0`,
    ),
  }),
);

export type InboundFaxRow = typeof inboundFaxes.$inferSelect;
export type InsertInboundFaxRow = typeof inboundFaxes.$inferInsert;
export type InboundFaxStatus = NonNullable<InboundFaxRow["status"]>;
