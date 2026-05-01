// auth.email_tokens — single-use tokens delivered via email for
// signup verification, password reset, and email-change flows.
//
// We persist `sha256(token)` only; the raw token lives only in the
// outbound email + the browser URL. Tokens are short-lived
// (default 24h for signup_verify, 1h for password_reset). Setting
// `consumed_at` is what marks a token used — we never DELETE so
// the audit trail is preserved.

import { sql } from "drizzle-orm";
import { customType, index, text, timestamp } from "drizzle-orm/pg-core";

import { authSchema } from "./_schema";
import { authUsers } from "./users";

const byteaType = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export type EmailTokenPurpose =
  | "signup_verify"
  | "password_reset"
  | "email_change";

export const authEmailTokens = authSchema.table(
  "email_tokens",
  {
    /** sha256(rawToken). Primary key — duplicates would mean a
     * collision in our random-bytes generator, which is fail-fast. */
    tokenHash: byteaType("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userPurposeIdx: index("auth_email_tokens_user_purpose_idx").on(
      t.userId,
      t.purpose,
    ),
  }),
);

export type AuthEmailTokenRow = typeof authEmailTokens.$inferSelect;
export type InsertAuthEmailTokenRow = typeof authEmailTokens.$inferInsert;
