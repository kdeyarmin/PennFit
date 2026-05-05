// Smart-trigger evaluator runner (Phase G.13 — Phase E.2 follow-up).
//
// Lifts the body of POST /admin/smart-triggers/evaluate out of its
// route handler so both the admin "Run now" surface AND the daily
// pg-boss cron job can call the same code path.
//
// The route handler stays in routes/admin/smart-triggers.ts; this
// module is purely the DB + audit pipeline that scans
// patient_therapy_nights, applies the rule library, and inserts new
// trigger events. Pure functions (rule logic) stay in ./index.ts.
//
// Audit posture: every newly-inserted event records a
// `patient.smart_trigger.detected` audit row. The actor is whoever
// invoked us — admin email when called from the route, a fixed
// system-actor identifier ("system:cron:smart-trigger-evaluator")
// when called from the pg-boss worker.

import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patientSmartTriggerEvents,
  patientTherapyNights,
} from "@workspace/resupply-db";

import { logger } from "../logger";
import { evaluateAll } from "./index";

/** Per-evaluator-run cap to keep the response time bounded. This
 *  module reports only the summary counts in `EvaluatorResult`
 *  (`scanned`, `proposed`, `inserted`, `skippedExisting`) and does
 *  not expose a `remaining`/pagination value. Admins may rerun the
 *  evaluator manually to process another capped batch; the cron job
 *  runs daily, so a per-run cap of 200 covers the steady-state
 *  detection load comfortably. */
const PER_RUN_PATIENT_CAP = 200;

export interface EvaluatorActor {
  /** Stamped on every audit row this run produces. Use the admin
   *  email when invoked from a route, "system:cron" when invoked
   *  from pg-boss. */
  adminEmail: string | null;
  adminUserId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface EvaluatorResult {
  scanned: number;
  proposed: number;
  inserted: number;
  skippedExisting: number;
}

export async function runSmartTriggerEvaluator(
  actor: EvaluatorActor,
): Promise<EvaluatorResult> {
  const db = drizzle(getDbPool());

  // Recent therapy-night roster — patients with at least one night
  // in the last 60 days are candidates. Per-patient night history
  // comes inside the loop below.
  const candidates = await db
    .selectDistinct({ patientId: patientTherapyNights.patientId })
    .from(patientTherapyNights)
    .where(
      sql`${patientTherapyNights.nightDate}::timestamptz >= now() - interval '60 days'`,
    )
    .orderBy(asc(patientTherapyNights.patientId))
    .limit(PER_RUN_PATIENT_CAP);

  let scanned = 0;
  let proposed = 0;
  let inserted = 0;
  let skippedExisting = 0;

  for (const c of candidates) {
    scanned++;
    try {
      const nights = await db
        .select({
          date: patientTherapyNights.nightDate,
          usageMinutes: patientTherapyNights.usageMinutes,
          ahi: patientTherapyNights.ahi,
          leakRateLMin: patientTherapyNights.leakRateLMin,
          pressureP95Cmh2o: patientTherapyNights.pressureP95Cmh2o,
        })
        .from(patientTherapyNights)
        .where(eq(patientTherapyNights.patientId, c.patientId))
        .orderBy(asc(patientTherapyNights.nightDate))
        .limit(60);

      const proposals = evaluateAll(
        nights.map((n) => ({
          date: n.date,
          usageMinutes: n.usageMinutes,
          ahi: n.ahi !== null ? Number(n.ahi) : null,
          leakRateLMin: n.leakRateLMin !== null ? Number(n.leakRateLMin) : null,
          pressureP95Cmh2o:
            n.pressureP95Cmh2o !== null ? Number(n.pressureP95Cmh2o) : null,
        })),
      );

      for (const p of proposals) {
        proposed++;
        // The partial-unique index on (patient, kind) WHERE
        // dismissed_at IS NULL ensures we don't double-fire while a
        // prior event is still pending. ON CONFLICT DO NOTHING is
        // the cleanest way to skip silently.
        const result = await db
          .insert(patientSmartTriggerEvents)
          .values({
            patientId: c.patientId,
            kind: p.kind,
            windowStartDate: p.windowStartDate,
            windowEndDate: p.windowEndDate,
          })
          .onConflictDoNothing()
          .returning({ id: patientSmartTriggerEvents.id });

        if (result.length > 0) {
          inserted++;
          await logAudit({
            action: "patient.smart_trigger.detected",
            adminEmail: actor.adminEmail,
            adminUserId: actor.adminUserId,
            targetTable: "patient_smart_trigger_events",
            targetId: result[0]!.id,
            metadata: {
              patient_id: c.patientId,
              kind: p.kind,
              window_start: p.windowStartDate,
              window_end: p.windowEndDate,
            },
            ip: actor.ip,
            userAgent: actor.userAgent,
          }).catch((err) => {
            logger.warn(
              { err },
              "patient.smart_trigger.detected audit write failed",
            );
          });
        } else {
          skippedExisting++;
        }
      }
    } catch (err) {
      // Per-patient error boundary: a single patient failure must not
      // abort the entire batch. pg-boss marks the job failed only when
      // this function throws; swallowing per-patient errors lets the
      // remaining candidates in this run be processed.
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
          patient_id: c.patientId,
        },
        "smart-trigger-evaluator: per-patient error — skipping patient",
      );
    }
  }

  return { scanned, proposed, inserted, skippedExisting };
}
