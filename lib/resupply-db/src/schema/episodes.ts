import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { prescriptions } from "./prescriptions";
import { resupplySchema } from "./_schema";

/**
 * Episodes — one resupply attempt for one patient + prescription pair.
 *
 * The eligibility engine creates an episode when a prescription becomes
 * due. The episode then walks through stages — `outreach_pending` →
 * `awaiting_response` → `confirmed` (or `declined` / `expired`) — and is
 * finally `fulfilled` when the order ships. Conversations and
 * fulfillments both reference an episode.
 *
 * Why this is its own table (and not just a status on prescriptions):
 *   - One prescription can produce many episodes over time (one per
 *     refill cycle). The episode is the unit of operator workflow.
 *   - It carries scheduling state (`dueAt`, `expiresAt`) that is
 *     independent of the prescription itself.
 *   - It is the join point for messaging history and fulfillment
 *     records — see `conversations.episodeId` and `fulfillments.episodeId`.
 *
 * `metadata` is plaintext jsonb (not encrypted) — it holds operational
 * notes the engine tracks, e.g. attempt counters or last-channel-tried.
 * Anything PHI-bearing about the patient lives on `patients`, not here.
 */
export const episodes = resupplySchema.table(
  "episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    prescriptionId: uuid("prescription_id")
      .notNull()
      .references(() => prescriptions.id, { onDelete: "cascade" }),

    status: text("status", {
      enum: [
        "outreach_pending",
        "awaiting_response",
        "confirmed",
        "declined",
        "expired",
        "fulfilled",
        "canceled",
      ],
    })
      .notNull()
      .default("outreach_pending"),

    // When the eligibility engine decided this episode is due. Drives
    // the worker queue ("send outreach for everything where dueAt <= now").
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // Optional hard deadline; episodes past this auto-`expired` by the
    // sweeper job.
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    // Operational scratch space — last channel attempted, attempt
    // counters, etc. Not PHI.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientIdx: index("episodes_patient_idx").on(t.patientId),
    prescriptionIdx: index("episodes_prescription_idx").on(t.prescriptionId),
    statusIdx: index("episodes_status_idx").on(t.status),
    dueAtIdx: index("episodes_due_at_idx").on(t.dueAt),
  }),
);

export type EpisodeRow = typeof episodes.$inferSelect;
export type InsertEpisodeRow = typeof episodes.$inferInsert;
