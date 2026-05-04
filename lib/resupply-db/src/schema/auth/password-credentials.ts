// auth.password_credentials — argon2id-hashed passwords. Split from
// auth.users so future DB roles can read users without ever being
// able to read password material.
//
// `password_hash` is the encoded argon2id string ("$argon2id$v=19$...")
// emitted by the `argon2` library — it includes the algorithm,
// version, parameters, salt, and hash. Re-hash on login if the
// embedded params drift below the current target.

import { sql } from "drizzle-orm";
import { boolean, text, timestamp } from "drizzle-orm/pg-core";

import { authSchema } from "./_schema";
import { authUsers } from "./users";

export const authPasswordCredentials = authSchema.table(
  "password_credentials",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    /** Algorithm tag for forward-compat ("argon2id-v1" today). */
    algo: text("algo").notNull().default("argon2id-v1"),
    /**
     * If true, the user is forced through /reset-password on their
     * next sign-in. Used for staff invited via the team page before
     * they've chosen their own password.
     */
    mustChange: boolean("must_change").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
);

export type AuthPasswordCredentialRow =
  typeof authPasswordCredentials.$inferSelect;
export type InsertAuthPasswordCredentialRow =
  typeof authPasswordCredentials.$inferInsert;
