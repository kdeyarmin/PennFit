import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { csrComplianceAlerts } from "./csr-compliance-alerts";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_coaching_plans — structured outreach plan for a patient
 * whose CPAP adherence has slipped. Layers a workflow on top of
 * csr_compliance_alerts (which is just a flat open/snoozed/resolved
 * flag today).
 *
 * Why a separate table
 * --------------------
 *   * Alerts are point-in-time signals; a plan is the ongoing
 *     work the team is doing about it. A single alert can
 *     spawn / be re-opened by multiple plans across months.
 *   * Surveyors ask "what did you DO when this patient's
 *     adherence dropped?" — the alert can answer "we flagged
 *     it"; the plan answers "we called on day 3, escalated to
 *     the sleep MD on day 14, resolved on day 30 at 78%."
 *
 * State machine
 * -------------
 *   open                 — plan created; no outreach yet.
 *   outreach_made        — CSR called/messaged. latestOutreachAt
 *                          stamped.
 *   improving            — patient's recent adherence trending
 *                          up past the floor. Plan stays open
 *                          until target_date or resolved.
 *   escalated            — needs clinical attention; supervisor
 *                          / sleep MD loop in.
 *   resolved             — terminal: hit target_compliance_pct
 *                          (or "good enough" by CSR call).
 *   abandoned            — terminal: patient unreachable / opted
 *                          out / lost to follow-up.
 *
 * Transitions worth pinning (enforced application-side, not DB):
 *   open → outreach_made
 *   outreach_made → improving | escalated
 *   improving | escalated → resolved | abandoned
 *   any non-terminal → escalated  (always allowed)
 *
 * Linked alert
 * ------------
 * `source_alert_id` is the csr_compliance_alerts row that kicked
 * the plan off, if any. SOFT FK (no constraint) so an alert
 * cleanup doesn't cascade into the plan history.
 */
export const patientCoachingPlans = resupplySchema.table(
  "patient_coaching_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    /** Soft FK — see preamble. */
    sourceAlertId: uuid("source_alert_id"),
    openedByUserId: text("opened_by_user_id"),

    status: varchar("status", { length: 32 }).notNull().default("open"),
    /** Plan goal: minimum adherence percentage we're driving toward.
     *  e.g. 70 = Medicare's 70% threshold. */
    targetCompliancePct: integer("target_compliance_pct").notNull().default(70),
    /** Most recent adherence % observed; updated by the worker when
     *  patient_therapy_nights flow in. Helps the plan list show
     *  "trending toward target" without recomputing on read. */
    latestCompliancePct: numeric("latest_compliance_pct", {
      precision: 5,
      scale: 2,
    }),
    /** Optional target date — "we want this resolved by Apr 30."
     *  When null, the plan has no deadline. */
    targetDate: timestamp("target_date", { withTimezone: true }),

    latestOutreachAt: timestamp("latest_outreach_at", { withTimezone: true }),
    /** Free-text resolution note; bounded length. Captured when the
     *  plan goes terminal so surveyors see the "what did we do"
     *  paragraph. */
    resolutionNote: text("resolution_note"),

    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    patientIdx: index("patient_coaching_plans_patient_idx").on(t.patientId),
    // Hot-path: "open plans I should triage" — sorted oldest first.
    openIdx: index("patient_coaching_plans_open_idx")
      .on(t.openedAt)
      .where(sql`${t.closedAt} IS NULL`),
    statusEnum: check(
      "patient_coaching_plans_status_enum",
      sql`${t.status} IN ('open','outreach_made','improving','escalated','resolved','abandoned')`,
    ),
    pctRange: check(
      "patient_coaching_plans_pct_range",
      sql`${t.targetCompliancePct} >= 0 AND ${t.targetCompliancePct} <= 100`,
    ),
  }),
);

// Reference the import so linter doesn't strip; documents the
// soft-FK linkage.
void csrComplianceAlerts;

export type PatientCoachingPlanRow =
  typeof patientCoachingPlans.$inferSelect;
export type InsertPatientCoachingPlanRow =
  typeof patientCoachingPlans.$inferInsert;
