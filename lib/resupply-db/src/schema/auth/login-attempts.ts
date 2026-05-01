// auth.login_attempts — append-only log of every sign-in attempt.
// Drives both rate limiting (per email + per IP, see
// `lib/resupply-auth/rate-limit.ts` in Stage 2) and the post-incident
// "did anyone successfully sign in as alice@example.com between
// these two timestamps?" investigation question.
//
// We deliberately log even the email of *failed* attempts so
// rate-limiting by email (the standard way of stopping credential
// stuffing) actually works. The trade-off is that an attacker who
// already has read access to this table can enumerate which
// addresses people TRIED — but they could already do that with read
// access to `auth.users`. We never log password bytes or hashes.

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  index,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { authSchema } from "./_schema";

const inetType = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

export const authLoginAttempts = authSchema.table(
  "login_attempts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    emailLower: text("email_lower").notNull(),
    ip: inetType("ip"),
    success: boolean("success").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    emailIdx: index("auth_login_attempts_email_idx").on(
      t.emailLower,
      t.attemptedAt,
    ),
    ipIdx: index("auth_login_attempts_ip_idx").on(t.ip, t.attemptedAt),
  }),
);

export type AuthLoginAttemptRow = typeof authLoginAttempts.$inferSelect;
export type InsertAuthLoginAttemptRow = typeof authLoginAttempts.$inferInsert;
