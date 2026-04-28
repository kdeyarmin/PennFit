import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * frequency_rules — global defaults the eligibility engine consults
 * when a patient does NOT have a per-patient cadence/channel override.
 *
 * Why this table exists:
 *   The product asks for "global reminder frequencies for customers
 *   based on their therapy and insurance and how long they've been a
 *   customer". The simplest data shape that supports all three axes
 *   without forcing operators to write code is a small ordered list
 *   of rules, each with a few optional `match_*` predicates plus the
 *   cadence/channel they should apply when matched.
 *
 * Resolution semantics (implemented in
 *   `lib/resupply-domain/src/outreach-plan.ts`):
 *   1. If the patient has a manual override (`cadence_override_days`
 *      / `channel_preference`), that wins outright. Rules are not
 *      evaluated for fields covered by an override.
 *   2. Otherwise, rules are evaluated in (priority asc, created_at asc)
 *      order. The FIRST active rule whose every set predicate matches
 *      is used. Each predicate is independent — a NULL predicate means
 *      "this rule does not constrain on that axis".
 *   3. If no rule matches, fall back to `prescriptions.cadence_days`
 *      and the legacy SMS-then-email channel selection. This keeps
 *      the system safe to deploy with zero rules configured.
 *
 * No PHI on this table. `match_insurance_payer` is the same plaintext
 * payer string stored on `patients.insurance_payer`.
 *
 * `priority` semantics: lower priority = evaluated first. We picked
 * lower-is-higher to match the "rule 1 / rule 2 / ..." mental model
 * operators already use, and to make the default (`100`) easy to
 * insert ahead of (priority 50) or behind (priority 200) without
 * renumbering every existing rule.
 *
 * `match_item_sku_prefix` is a prefix match (not equality) so a single
 * rule can target an entire therapy class (e.g. `MASK-` covers
 * `MASK-NASAL-MED`, `MASK-FULL-LRG`, etc.) without having to enumerate
 * SKUs. Per-SKU rules are still possible — just store the full SKU.
 *
 * `min_tenure_days` / `max_tenure_days` describe the inclusive window
 * `(now - patients.created_at)` must fall in. Either side may be NULL
 * for an open-ended bound.
 */
export const frequencyRules = resupplySchema.table(
  "frequency_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Operator-facing label, e.g. "Mask resupply for Aetna patients
    // (year 1)". Free text; no uniqueness constraint — operators can
    // duplicate names without breaking anything.
    name: text("name").notNull(),

    // Lower = evaluated first. See class comment.
    priority: integer("priority").notNull().default(100),

    // Predicates. Any NULL predicate means the rule is not constrained
    // on that axis.
    matchItemSkuPrefix: text("match_item_sku_prefix"),
    matchInsurancePayer: text("match_insurance_payer"),
    minTenureDays: integer("min_tenure_days"),
    maxTenureDays: integer("max_tenure_days"),

    // The cadence (in days) to apply when the rule matches. Must be
    // positive at the application layer; we don't add a CHECK here so
    // operators can't accidentally lock themselves out via the
    // dashboard if a CHECK were ever miswritten — Zod validation in
    // the API enforces it instead.
    cadenceDays: integer("cadence_days").notNull(),

    // Optional channel default for matching patients. NULL means
    // "this rule doesn't opine on channel; fall back to legacy
    // SMS-then-email". Same enum as `patients.channel_preference`.
    defaultChannel: text("default_channel", {
      enum: ["sms", "email", "voice"],
    }),

    // Active rules are evaluated; inactive rules are skipped but
    // retained so operators can toggle them back on without
    // re-entering all the criteria.
    active: boolean("active").notNull().default(true),

    // Free-text operator notes ("Per Aetna 2026 contract update").
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Active-first index that matches the eligibility-engine query
    // shape: WHERE active = true ORDER BY priority, created_at.
    activePriorityIdx: index("frequency_rules_active_priority_idx").on(
      t.active,
      t.priority,
      t.createdAt,
    ),
  }),
);

export type FrequencyRuleRow = typeof frequencyRules.$inferSelect;
export type InsertFrequencyRuleRow = typeof frequencyRules.$inferInsert;
