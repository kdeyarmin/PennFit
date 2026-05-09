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

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

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
  const supabase = getSupabaseServiceRoleClient();

  // Recent therapy-night roster — patients with at least one night
  // in the last 60 days are candidates. PostgREST has no
  // selectDistinct + no `now() - interval`, so we compute the cutoff
  // JS-side and de-dupe via a Set. Per-patient night history comes
  // inside the loop below.
  const cutoffIso = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const { data: recentRows, error: candidatesErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("patient_id")
    .gte("night_date", cutoffIso)
    .order("patient_id", { ascending: true });
  if (candidatesErr) throw candidatesErr;
  const candidateSet = new Set<string>();
  for (const r of recentRows ?? []) {
    if (r.patient_id) candidateSet.add(r.patient_id);
    if (candidateSet.size >= PER_RUN_PATIENT_CAP) break;
  }
  const candidates = Array.from(candidateSet).map((patientId) => ({
    patientId,
  }));

  let scanned = 0;
  let proposed = 0;
  let inserted = 0;
  let skippedExisting = 0;

  for (const c of candidates) {
    scanned++;
    try {
      const { data: nightRows, error: nightsErr } = await supabase
        .schema("resupply")
        .from("patient_therapy_nights")
        .select(
          "night_date, usage_minutes, ahi, leak_rate_l_min, pressure_p95_cmh2o",
        )
        .eq("patient_id", c.patientId)
        .order("night_date", { ascending: true })
        .limit(60);
      if (nightsErr) throw nightsErr;
      const nights = nightRows ?? [];

      const proposals = evaluateAll(
        nights.map((n) => ({
          date: n.night_date,
          usageMinutes: n.usage_minutes,
          // PostgREST returns numeric columns as strings (preserves
          // precision). Convert to Number for the evaluator.
          ahi: n.ahi !== null ? Number(n.ahi) : null,
          leakRateLMin: n.leak_rate_l_min !== null ? Number(n.leak_rate_l_min) : null,
          pressureP95Cmh2o:
            n.pressure_p95_cmh2o !== null ? Number(n.pressure_p95_cmh2o) : null,
        })),
      );

      for (const p of proposals) {
        proposed++;
        // The partial-unique index on (patient, kind) WHERE
        // dismissed_at IS NULL ensures we don't double-fire while a
        // prior event is still pending. PostgREST has no DO NOTHING,
        // so we INSERT and treat 23505 as the "skipped existing"
        // path.
        const { data: insertedRow, error: insertErr } = await supabase
          .schema("resupply")
          .from("patient_smart_trigger_events")
          .insert({
            patient_id: c.patientId,
            kind: p.kind,
            window_start_date: p.windowStartDate,
            window_end_date: p.windowEndDate,
          })
          .select("id")
          .limit(1)
          .maybeSingle();

        if (insertErr) {
          if ((insertErr as { code?: string }).code === "23505") {
            skippedExisting++;
            continue;
          }
          throw insertErr;
        }

        if (insertedRow) {
          inserted++;
          await logAudit({
            action: "patient.smart_trigger.detected",
            adminEmail: actor.adminEmail,
            adminUserId: actor.adminUserId,
            targetTable: "patient_smart_trigger_events",
            targetId: insertedRow.id,
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
