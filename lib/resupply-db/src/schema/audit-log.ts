import { sql } from "drizzle-orm";
import { index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * Append-only audit log for the resupply product. Every PHI read or
 * mutation by an admin (and every system action that touches PHI)
 * writes one row here.
 *
 * Why we deliberately do NOT have a foreign key on `targetId`:
 *   - The audit log must outlive the rows it points to. If a patient is
 *     hard-deleted (PHI purge), the audit history remains so we can
 *     answer "who saw this row before it went away" — which is the
 *     entire point of having an audit log.
 *   - That means `targetTable` + `targetId` are an opaque pointer, not
 *     a relational join.
 *
 * `metadata` is plaintext jsonb for the action context (filters used in
 * a list query, fields changed in an update). It is documented as MUST
 * NOT contain PHI; reviewers and the architecture check should keep it
 * that way. PHI-bearing context belongs in the row itself, not here.
 */
export const auditLog = resupplySchema.table(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Who. adminEmail is denormalised from the auth provider so the audit row
    // remains readable if the auth user is later deleted.
    adminEmail: text("operator_email"),
    adminUserId: text("operator_user_id"),

    // What. Action is a free-form verb namespaced like
    // "patient.view" / "episode.confirm" / "fulfillment.upload_csv".
    action: text("action").notNull(),

    // Which row. Opaque pointer — see note above.
    targetTable: text("target_table"),
    targetId: uuid("target_id"),

    // Context (plaintext, NEVER PHI). Filters, before/after deltas of
    // non-PHI fields, request id, etc.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),

    // Request envelope.
    ip: text("ip"),
    userAgent: text("user_agent"),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    occurredAtIdx: index("audit_log_occurred_at_idx").on(t.occurredAt),
    adminIdx: index("audit_log_operator_idx").on(t.adminEmail),
    actionIdx: index("audit_log_action_idx").on(t.action),
    targetIdx: index("audit_log_target_idx").on(t.targetTable, t.targetId),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type InsertAuditLogRow = typeof auditLog.$inferInsert;
