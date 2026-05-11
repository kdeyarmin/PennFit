import { sql } from "drizzle-orm";
import {
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { bulkCampaigns } from "./bulk-campaigns";
import { resupplySchema } from "./_schema";

/**
 * bulk_campaign_recipients — one row per individual the audience
 * resolver produced for a bulk_campaigns row.
 *
 * Why this isn't a runtime join
 * -----------------------------
 * The audience could be computed at send-time, but freezing it at
 * create-time gives the CSR three things they need:
 *
 *   1. A static "the audience is this big and these are the
 *      people" preview before they commit.
 *   2. A correct send count even if a patient is added to the
 *      cohort an hour after the campaign was queued.
 *   3. An immutable list to audit against — "show me every
 *      Medicare patient we contacted about the recall on May 11"
 *      stays answerable years later regardless of how the
 *      patients table evolved.
 *
 * Recipient kinds
 * ---------------
 *   * patient        — recipient_id is a resupply.patients.id
 *   * shop_customer  — recipient_id is a resupply.shop_customers.id
 *
 * Per-recipient status
 * --------------------
 * Phase A only writes pending or suppressed. The send worker in
 * Phase B advances the others.
 *
 *   * pending     — queued, will be picked up by the send worker
 *   * suppressed  — opted-out, missing contact info, or otherwise
 *                   skipped at audience-resolve time. suppression_
 *                   reason captures why.
 *   * sending     — worker has claimed this row
 *   * sent        — vendor accepted the send
 *   * failed      — vendor rejected; error captures why
 *
 * PHI posture
 * -----------
 * Every row binds a campaign to a person. Audit envelopes refer
 * to the row by id only; the email/phone the worker uses to send
 * lives on the row but never appears in the application log.
 */
export const bulkCampaignRecipients = resupplySchema.table(
  "bulk_campaign_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => bulkCampaigns.id, { onDelete: "cascade" }),

    recipientKind: text("recipient_kind", {
      enum: ["patient", "shop_customer"],
    }).notNull(),
    /** Soft FK — we deliberately don't cascade so a patient
     *  deletion (rare) doesn't erase the audit history of every
     *  campaign they were in. The application layer treats a row
     *  whose recipient_id no longer resolves as 'recipient gone'
     *  and refuses to re-send. */
    recipientId: uuid("recipient_id").notNull(),

    /** Frozen contact info at audience-resolve time. Storing it on
     *  the row means the worker doesn't need to re-fetch (and the
     *  audit log captures the address we actually used even if it
     *  later changes). */
    recipientEmail: varchar("recipient_email", { length: 320 }),

    status: text("status", {
      enum: ["pending", "suppressed", "sending", "sent", "failed"],
    })
      .notNull()
      .default("pending"),

    /** Set only when status='suppressed'. Possible values are
     *  documented in lib/bulk-campaigns/resolve-audience.ts. */
    suppressionReason: varchar("suppression_reason", { length: 80 }),

    /** Phase-B worker-side fields. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    vendorMessageId: varchar("vendor_message_id", { length: 200 }),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    campaignIdx: index("bulk_campaign_recipients_campaign_idx").on(
      t.campaignId,
    ),
    // Lookup pattern: drain pending recipients for a given
    // campaign. Index on (campaign_id, status) so the worker can
    // limit + skiplocked through pending rows efficiently.
    campaignStatusIdx: index(
      "bulk_campaign_recipients_campaign_status_idx",
    ).on(t.campaignId, t.status),
    // Dedupe — a given recipient can appear at most once per
    // campaign. Prevents the audience resolver from accidentally
    // double-emailing if a recipient happens to match multiple
    // audience predicates in a future composite-audience kind.
    campaignRecipientUnique: uniqueIndex(
      "bulk_campaign_recipients_campaign_recipient_unique",
    ).on(t.campaignId, t.recipientKind, t.recipientId),
  }),
);

export type BulkCampaignRecipientRow =
  typeof bulkCampaignRecipients.$inferSelect;
export type InsertBulkCampaignRecipientRow =
  typeof bulkCampaignRecipients.$inferInsert;
export type BulkCampaignRecipientStatus = NonNullable<
  BulkCampaignRecipientRow["status"]
>;
export type BulkCampaignRecipientKind = NonNullable<
  BulkCampaignRecipientRow["recipientKind"]
>;
