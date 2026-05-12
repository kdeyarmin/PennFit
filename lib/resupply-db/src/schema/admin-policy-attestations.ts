import { sql } from "drizzle-orm";
import {
  index,
  inet,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accreditationPolicies } from "./accreditation-policies";
import { adminUsers } from "./admin-users";
import { resupplySchema } from "./_schema";

/**
 * admin_policy_attestations — record of "staff member X read and
 * acknowledged policy version Y on date Z."
 *
 * The compliance binder a surveyor wants reduces to a CSV of this
 * table joined with admin_users + accreditation_policies. The row
 * shape is built to make that join cheap and the audit story
 * watertight.
 *
 * Posture
 * -------
 *   * (staff_user_id, policy_id) is UNIQUE — a single staff member
 *     can attest a SPECIFIC version of a policy exactly once.
 *     Re-acknowledging requires the policy author to bump the
 *     version (which inserts a new accreditation_policies row),
 *     which is what we want — "you attested v1 of HIPAA NPP, but
 *     the live version is v2; please re-read and attest."
 *
 *   * No DELETE in normal flow. The catalog policy can be retired
 *     (retired_at set on accreditation_policies) but the
 *     attestation rows persist for the standard 6-year HIPAA
 *     retention window.
 *
 *   * `attested_at` is when the staff member clicked the
 *     attestation button (timestamp captured server-side, never
 *     client-supplied — important for audit integrity).
 *
 *   * `signature_method` is the mechanism used. Today it's always
 *     "click_through" but the column lets us add "wet_signature"
 *     or "e_signature" later without a migration.
 *
 *   * `acknowledged_text` is a verbatim snapshot of the
 *     acknowledgement statement the staff member saw. Surveyors
 *     specifically ask "what did the person agree to?" — without
 *     this we'd have to point at the SPA code as it existed on
 *     that date, which doesn't fly. The text is bounded (no DoS-
 *     by-uploaded-body) and stored once per attestation.
 *
 *   * `ip` is captured for the same forensic reason as the MFA
 *     recovery-code "used_ip" — answering "did this person attest
 *     from a machine they own?" when an attestation is later
 *     disputed.
 *
 * FK posture
 * ----------
 * staff_user_id REFERENCES admin_users with NO CASCADE. If an
 * admin row is ever deleted, we keep their attestation history
 * (joined later as "staff gone"). The application layer treats an
 * orphaned row as "staff member <id> attested but their roster
 * entry has since been removed."
 *
 * policy_id REFERENCES accreditation_policies WITH RESTRICT —
 * deletion of a policy row is refused entirely; retire it via
 * retired_at instead.
 */
export const adminPolicyAttestations = resupplySchema.table(
  "admin_policy_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => adminUsers.id),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => accreditationPolicies.id, { onDelete: "restrict" }),

    attestedAt: timestamp("attested_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    signatureMethod: text("signature_method")
      .notNull()
      .default("click_through"),
    acknowledgedText: text("acknowledged_text").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    staffPolicyUnique: uniqueIndex(
      "admin_policy_attestations_staff_policy_unique",
    ).on(t.staffUserId, t.policyId),
    // "Who has not yet attested policy P?" — index by policy_id
    // so the roster query is a fast left join.
    policyIdx: index("admin_policy_attestations_policy_idx").on(t.policyId),
    // "What does this staff member still owe?" — index by
    // staff_user_id for the per-user pending query.
    staffIdx: index("admin_policy_attestations_staff_idx").on(t.staffUserId),
  }),
);

export type AdminPolicyAttestationRow =
  typeof adminPolicyAttestations.$inferSelect;
export type InsertAdminPolicyAttestationRow =
  typeof adminPolicyAttestations.$inferInsert;
