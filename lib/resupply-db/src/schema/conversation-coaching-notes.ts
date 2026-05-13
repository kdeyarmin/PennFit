import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { resupplySchema } from "./_schema";

/**
 * conversation_coaching_notes — supervisor-side coaching feedback
 * left on a CSR's conversations.
 *
 * Tier 1 J of the original plan ("Quality monitoring / coaching
 * surface"). A supervisor reviews a closed conversation and leaves
 * a note for the CSR who handled it; the CSR sees their notes
 * aggregated on their profile page.
 *
 * Posture
 * -------
 *   * Notes are SUPERVISOR-AUTHORED. CSRs can't add notes to their
 *     own conversations. Enforced application-side via the route's
 *     requirePermission gate.
 *   * `target_user_id` is the CSR being coached — typically the
 *     conversation's last assignee, but the supervisor specifies
 *     it explicitly (a conversation can pass through multiple
 *     hands and the supervisor knows which one earned the
 *     feedback).
 *   * `kind` distinguishes praise / suggestion / concern so the
 *     CSR aggregation can group sensibly.
 *   * No DELETE in normal flow — coaching is part of the
 *     employment record. Edits via PATCH are allowed for
 *     supervisors to clarify, with an updated_at trail.
 */
export const conversationCoachingNotes = resupplySchema.table(
  "conversation_coaching_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The CSR being coached. Soft FK to admin_users so a CSR
     *  departure preserves the historical record. */
    targetUserId: text("target_user_id").notNull(),
    /** Supervisor who wrote the note. Soft FK; same rationale. */
    authorUserId: text("author_user_id").notNull(),

    kind: varchar("kind", { length: 16 }).notNull().default("suggestion"),
    body: text("body").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    conversationIdx: index("conversation_coaching_notes_conv_idx").on(
      t.conversationId,
    ),
    targetIdx: index("conversation_coaching_notes_target_idx").on(
      t.targetUserId,
    ),
    kindEnum: check(
      "conversation_coaching_notes_kind_enum",
      sql`${t.kind} IN ('praise','suggestion','concern')`,
    ),
  }),
);

export type ConversationCoachingNoteRow =
  typeof conversationCoachingNotes.$inferSelect;
export type InsertConversationCoachingNoteRow =
  typeof conversationCoachingNotes.$inferInsert;
