// auth.users — the canonical identity row for every signed-in user
// (staff or customer). See migration 0022_in_house_auth.sql.

import { sql } from "drizzle-orm";
import { check, index, text, timestamp } from "drizzle-orm/pg-core";

import { authSchema } from "./_schema";

export type AuthRole = "customer" | "agent" | "admin";
export type AuthUserStatus = "active" | "invited" | "locked" | "revoked";

export const authUsers = authSchema.table(
  "users",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /** Lowercased, trimmed email. UNIQUE — one user per address. */
    emailLower: text("email_lower").notNull().unique(),
    /** Display name shown in dashboards; nullable for customers who haven't set one. */
    displayName: text("display_name"),
    /** customer | agent | admin. Authoritative; env allow-lists only seed first login. */
    role: text("role", { enum: ["customer", "agent", "admin"] }).notNull().default("customer"),
    /** active | invited | locked | revoked. */
    status: text("status", { enum: ["active", "invited", "locked", "revoked"] }).notNull().default("invited"),
    /** Set when a verification token has been consumed. NULL = unverified. */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    roleIdx: index("auth_users_role_idx").on(t.role),
    statusIdx: index("auth_users_status_idx").on(t.status),
    statusEnum: check(
      "auth_users_status_enum",
      sql`${t.status} IN ('active','invited','locked','revoked')`,
    ),
    roleEnum: check(
      "auth_users_role_enum",
      sql`${t.role} IN ('customer','agent','admin')`,
    ),
  }),
);

export type AuthUserRow = typeof authUsers.$inferSelect;
export type InsertAuthUserRow = typeof authUsers.$inferInsert;
