import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * bulk_campaigns — one-off and scheduled bulk-email sends to a
 * resolved patient or customer audience.
 *
 * Why this table exists
 * ---------------------
 * The supplier already has the plumbing for individual outbound
 * messages (SendGrid via lib/resupply-email, Twilio via
 * lib/resupply-telecom, plus the unified message_templates
 * library). What was missing was the AUDIENCE concept: "send the
 * Philips-recall notice to every active Medicare patient on a
 * DreamStation 2", or "send the new-mask announcement to every
 * cash-pay customer who opted into marketing". Without a queryable
 * campaign record, those sends would have to live in a CSR's
 * spreadsheet + manual fan-out.
 *
 * What this table represents
 * --------------------------
 * One row per planned bulk send. The audience is RESOLVED at
 * campaign-create time (snapshotted into bulk_campaign_recipients)
 * rather than at send time so:
 *   1. The CSR sees the audience size before they commit.
 *   2. A newly-onboarded patient mid-send doesn't accidentally
 *      receive a "welcome" email when the campaign was about an
 *      older cohort.
 *   3. Sent counts and recipient lists are auditable after the
 *      fact even if the underlying audience shifts.
 *
 * Lifecycle (Phase A — staging only)
 * -----------------------------------
 *   * draft    — audience resolved + recipients persisted; no
 *                sending has occurred. CSR can review or cancel.
 *   * cancelled — CSR aborted before sending. Phase A terminal.
 *   * sending  — Phase B will set this when the worker starts.
 *   * sent     — Phase B terminal: every recipient was processed.
 *   * paused   — Phase B optional: worker is paused mid-send.
 *
 * This Phase-A sprint persists the schema but only the
 * draft/cancelled transitions are exposed via the API. The
 * worker-side transitions (sending → sent / paused) ship in a
 * follow-up so the send rate-limiting + Twilio-quota story can be
 * designed without holding up the staging surface.
 *
 * Channel
 * -------
 * Email-only in this sprint. SMS bulk-sends carry separate Twilio
 * quota and 10DLC compliance concerns that need their own design
 * pass; adding the column shape now keeps the future change
 * additive (just expand the enum). Same applies to push.
 *
 * Audience kinds
 * --------------
 *   * all_active_shop_customers — every shop_customers row where the
 *     customer has not opted out of marketing email.
 *   * all_active_patients       — every patients row with
 *     status='active'.
 *   * by_patient_payer          — patients filtered by
 *     insurance_payer exact match (free-text — the audience
 *     builder uses the same string CSRs already enter).
 *   * manual_list               — explicit list of recipient ids
 *     supplied by the CSR. Phase B will add CSV upload; in Phase
 *     A the API accepts a JSON array.
 *
 * Category
 * --------
 * Selects which Communication Preferences flag governs the
 * recipient's opt-in:
 *   * marketing — checks `emailMarketing`.
 *   * service   — checks `emailResupplyReminders` (covers operational
 *                 messages CSRs send to active patients/customers).
 *   * compliance — recall notices, mandatory regulatory
 *                  communications. Bypasses opt-out (HIPAA /
 *                  manufacturer recall obligations override
 *                  marketing preferences). CSR creating the
 *                  campaign attests that the content meets the
 *                  threshold; we log the attestation on the row.
 *
 * PHI posture
 * -----------
 * The campaign row itself is NOT PHI (no patient binding, just
 * category + counts). bulk_campaign_recipients rows ARE PHI
 * (each binds a campaign to a specific patient/customer). Audit
 * envelopes record campaign id + counts; recipient detail is only
 * visible via the admin-gated detail endpoint.
 */
export const bulkCampaigns = resupplySchema.table(
  "bulk_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** CSR-facing label. */
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),

    audienceKind: text("audience_kind", {
      enum: [
        "all_active_shop_customers",
        "all_active_patients",
        "by_patient_payer",
        "manual_list",
      ],
    }).notNull(),
    /** Required only when audience_kind = by_patient_payer. */
    audiencePayer: varchar("audience_payer", { length: 120 }),

    channel: text("channel", { enum: ["email"] })
      .notNull()
      .default("email"),

    category: text("category", {
      enum: ["marketing", "service", "compliance"],
    }).notNull(),
    /** Free-text CSR attestation when category='compliance' that
     *  bypasses marketing opt-outs ("FDA Class II recall — Philips
     *  DreamStation foam"). Required at the API layer when
     *  category='compliance'. */
    complianceAttestation: text("compliance_attestation"),

    /** template_key from resupply.message_templates. The send-side
     *  worker (Phase B) renders it per recipient. */
    templateKey: varchar("template_key", { length: 120 }).notNull(),

    /** Hard ceiling on per-minute send rate the Phase-B worker uses.
     *  Captured here so a CSR can adjust per campaign (a Philips
     *  recall might warrant 600/min; a marketing announcement
     *  should sit at 120/min). Validated 1..3600 at the API. */
    throttlePerMinute: integer("throttle_per_minute").notNull().default(120),

    status: text("status", {
      enum: ["draft", "sending", "sent", "paused", "cancelled"],
    })
      .notNull()
      .default("draft"),

    /** Phase A persists draft + cancelled. Phase B sets the rest. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    createdByUserId: uuid("created_by_user_id"),
    cancelledByUserId: uuid("cancelled_by_user_id"),

    // Materialized counters — set at draft creation (when
    // recipients are persisted) and updated by the send-side
    // worker. Persisted as columns rather than COUNT(*) views so
    // the list page can sort/filter on them cheaply.
    totalRecipients: integer("total_recipients").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    statusCreatedIdx: index("bulk_campaigns_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    throttleRange: check(
      "bulk_campaigns_throttle_range",
      sql`${t.throttlePerMinute} >= 1 AND ${t.throttlePerMinute} <= 3600`,
    ),
    countsNonNegative: check(
      "bulk_campaigns_counts_non_negative",
      sql`${t.totalRecipients} >= 0 AND ${t.suppressedCount} >= 0 AND ${t.sentCount} >= 0 AND ${t.failedCount} >= 0`,
    ),
  }),
);

export type BulkCampaignRow = typeof bulkCampaigns.$inferSelect;
export type InsertBulkCampaignRow = typeof bulkCampaigns.$inferInsert;
export type BulkCampaignStatus = NonNullable<BulkCampaignRow["status"]>;
export type BulkCampaignAudienceKind = NonNullable<
  BulkCampaignRow["audienceKind"]
>;
export type BulkCampaignCategory = NonNullable<BulkCampaignRow["category"]>;
