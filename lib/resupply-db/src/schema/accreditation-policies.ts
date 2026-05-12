import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * accreditation_policies — the catalog of policies / procedures /
 * standards admins must attest to as part of DMEPOS accreditation
 * (ACHC / BOC / TJC) and HIPAA program upkeep.
 *
 * Why a row per (policy, version)
 * --------------------------------
 * Surveyors ask "show me the version of the HIPAA NPP your team
 * acknowledged on 2025-04-01." If we mutate a single row in place
 * the answer is fragile — was the body the same then? With one row
 * per (policy_key, version) we preserve every historical version
 * and the attestation rows below reference the SPECIFIC version
 * the admin signed.
 *
 * `policy_key` is the stable identifier ("hipaa_npp",
 * "infection_control_v2") and `version` (a sortable string like
 * "1", "2", "2024-01") is the version. The unique constraint on
 * (policy_key, version) guarantees one row per pair.
 *
 * `active_at` / `retired_at` give a lifecycle:
 *   * NULL active_at  → draft (visible to admins managing the
 *                        catalog; NOT yet pushed for attestation)
 *   * NOT NULL, NULL retired_at → live, all staff must attest
 *   * NOT NULL retired_at      → superseded, attestations preserved
 *                                for audit but no new ones expected
 *
 * `category` is a free-form bucket (operations / clinical / hipaa
 * / hr / safety) used by the admin UI to group the catalog.
 *
 * `body_url` points at the canonical PDF / text — either a private
 * GCS-stored doc or an external URL. We deliberately do NOT store
 * the policy body inline; long-form text bloats every read of the
 * catalog and the binder export references the URL.
 */
export const accreditationPolicies = resupplySchema.table(
  "accreditation_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable identifier; never changes across versions. Matches
     *  /^[a-z0-9_]{1,64}$/. */
    policyKey: varchar("policy_key", { length: 64 }).notNull(),
    /** Free-form version label; sorted lexicographically in the
     *  UI. Examples: "1", "2", "2024-Q1". */
    version: varchar("version", { length: 32 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    summary: text("summary"),
    /** Canonical policy text/PDF location. Optional in case the
     *  policy is short enough to live in `summary`. */
    bodyUrl: text("body_url"),
    category: varchar("category", { length: 32 }).notNull(),

    activeAt: timestamp("active_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),

    /** Stamped at creation; we keep it even though created_at is
     *  also present so the UI can show "added by Jane Smith on
     *  2025-04-02" without an extra join. */
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    policyKeyVersionUnique: uniqueIndex(
      "accreditation_policies_key_version_unique",
    ).on(t.policyKey, t.version),
    // Common query: "live policies that all staff must attest to"
    // — filtered active_at NOT NULL, retired_at NULL.
    activeRetiredIdx: index(
      "accreditation_policies_active_retired_idx",
    ).on(t.activeAt, t.retiredAt),
    categoryIdx: index("accreditation_policies_category_idx").on(t.category),
    // Lightweight policy_key shape check to keep imports clean.
    policyKeyShape: check(
      "accreditation_policies_policy_key_shape",
      sql`${t.policyKey} ~ '^[a-z0-9_]{1,64}$'`,
    ),
  }),
);

export type AccreditationPolicyRow =
  typeof accreditationPolicies.$inferSelect;
export type InsertAccreditationPolicyRow =
  typeof accreditationPolicies.$inferInsert;
