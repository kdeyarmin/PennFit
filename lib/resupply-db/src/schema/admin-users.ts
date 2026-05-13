// admin_users — DB-backed roster of admins / CSRs. See migration 0020.
//
// `auth_user_id` is the identity link to the in-house `auth.users`
// table; it is populated for every active admin / CSR row.
//
// Role catalog (extended in migration 0086 — Granular RBAC Phase A):
//   * admin              — superuser; full surface
//   * supervisor         — CSR team lead; can approve returns,
//                          export audit, read all team work
//   * csr                — frontline customer service
//   * fitter             — clinical fit specialist
//   * fulfillment        — warehouse / shipping
//   * compliance_officer — accreditation + Medicare attestation work
//   * agent              — legacy "everything-CSR" role; kept for
//                          backwards-compat. New invites should pick
//                          a specific role.
//
// The permissions catalog (role → perms) lives in code, not DB —
// see lib/resupply-auth/src/rbac.ts.

import { sql } from "drizzle-orm";
import { check, index, jsonb, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export type AdminRole =
  | "admin"
  | "supervisor"
  | "csr"
  | "fitter"
  | "fulfillment"
  | "compliance_officer"
  | "agent";
export type AdminStatus = "pending" | "active" | "revoked";

const ADMIN_ROLE_VALUES = [
  "admin",
  "supervisor",
  "csr",
  "fitter",
  "fulfillment",
  "compliance_officer",
  "agent",
] as const;

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
    role: text("role", { enum: ADMIN_ROLE_VALUES }).notNull().default("agent"),
    status: text("status", { enum: ["pending", "active", "revoked"] }).notNull().default("pending"),
    displayName: text("display_name"),
    notes: text("notes"),
    /**
     * Skill tags used by /admin/conversations/:id/assignee-suggestions
     * to rank candidate assignees. Example values: "spanish",
     * "clinical", "billing_basics", "mask_fit", "hardware_setup".
     * Curated by admins via PATCH /admin/team/:id/skills. Default
     * empty array — pre-existing admins are eligible for routing
     * against ANY required skill (their absence on this list means
     * "we don't have evidence they specialize in X," not "they
     * can't help with X").
     */
    skills: jsonb("skills")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
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
    statusEnum: check(
      "admin_users_status_enum",
      sql`${t.status} IN ('pending','active','revoked')`,
    ),
    roleEnum: check(
      "admin_users_role_enum",
      sql`${t.role} IN ('admin','supervisor','csr','fitter','fulfillment','compliance_officer','agent')`,
    ),
  }),
);

export type AdminUserRow = typeof adminUsers.$inferSelect;
export type InsertAdminUserRow = typeof adminUsers.$inferInsert;
