import { sql } from "drizzle-orm";
import {
  index,
  inet,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { adminUsers } from "./admin-users";
import { resupplySchema } from "./_schema";

/**
 * admin_mfa_recovery_codes — single-use backup codes that an admin
 * can type in place of a TOTP code when they've lost their phone.
 *
 * Without these the only break-glass option is "another admin
 * deletes the row from admin_mfa_secrets" — painful operationally
 * and audit-noisy. Recovery codes are the standard pattern (GitHub,
 * Google, AWS) and surveyors recognize them.
 *
 * Posture
 * -------
 * Codes are generated server-side at enrollment-verify time, shown
 * to the admin ONCE (rendered in the browser, never logged, never
 * emailed), and stored here as SHA-256 hashes. The plain text never
 * lands in any audit log or DB row.
 *
 * Each row is single-use: `used_at` flips from NULL → timestamp on
 * first acceptance and that row is then dead. We keep used rows
 * around (rather than deleting) so an auditor can see "12 codes
 * generated 2025-04-01, 3 used (2025-05-02, 2025-06-14, 2025-08-01)."
 *
 * We deliberately do NOT enforce a per-batch identifier in this
 * sprint — regenerate is deferred. If/when regenerate ships, it
 * will simply hard-delete the unused rows for that staff_user_id
 * and insert a fresh batch. The presence of `created_at` lets us
 * answer "which batch is currently live."
 *
 * `used_ip` is the inet address that consumed the code, captured
 * for the same forensic reason we hash User-Agent on sessions —
 * answering "did this admin actually use a recovery code from a
 * machine they own, or did an attacker?"
 */
export const adminMfaRecoveryCodes = resupplySchema.table(
  "admin_mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),

    /** SHA-256 hex of the normalized code (uppercase, no separators).
     *  Plain text never lives in the database — same posture as
     *  password hashes. */
    codeHash: text("code_hash").notNull(),

    /** NULL while the code is still spendable. Set on first use; the
     *  row becomes dead at that point. */
    usedAt: timestamp("used_at", { withTimezone: true }),

    /** IP that consumed the code (forensic only). NULL until used. */
    usedIp: inet("used_ip"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Recovery codes live in batches; the staff_user_id index lets
    // sign-in scan only the rows for the calling admin (small, but
    // still smaller than full-table).
    staffUserIdx: index("admin_mfa_recovery_codes_staff_user_idx").on(
      t.staffUserId,
    ),
    // Hash is globally unique by construction (40 bits per code +
    // SHA-256). The unique constraint defends against a poorly-seeded
    // RNG generating a duplicate (would crash insert rather than
    // silently issue two admins the same recovery code) and lets
    // the verify path look up by hash directly without scanning.
    codeHashUnique: uniqueIndex(
      "admin_mfa_recovery_codes_code_hash_unique",
    ).on(t.codeHash),
  }),
);

export type AdminMfaRecoveryCodeRow =
  typeof adminMfaRecoveryCodes.$inferSelect;
export type InsertAdminMfaRecoveryCodeRow =
  typeof adminMfaRecoveryCodes.$inferInsert;
