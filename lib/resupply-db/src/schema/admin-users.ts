// admin_users — DB-backed roster of admins / CSRs. See migration 0020.
//
// `auth_user_id` is the identity link to the in-house `auth.users`
// table; it is populated for every active admin / CSR row.

import { sql } from "drizzle-orm";
import { index, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export type AdminRole = "admin" | "agent";
export type AdminStatus = "pending" | "active" | "revoked";

export const adminUsers = resupplySchema.table(
  "admin_users",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    emailLower: text("email_lower").notNull().unique(),
    /**
     * Link to `auth.users(id)`. Populated by the team page on
     * invite and by the bootstrap-admin CLI; null only for
     * legacy pre-cutover rows.
     */
    authUserId: text("auth_user_id"),
    role: text("role").notNull().default("agent"),
    status: text("status").notNull().default("pending"),
    displayName: text("display_name"),
    notes: text("notes"),
    invitedBy: text("invited_by"),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    statusIdx: index("admin_users_status_idx").on(t.status),
  }),
);

export type AdminUserRow = typeof adminUsers.$inferSelect;
export type InsertAdminUserRow = typeof adminUsers.$inferInsert;
