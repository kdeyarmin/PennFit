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

/** Defensive per-run patient cap. The daily cron evaluates EVERY active
 *  patient (the recent-night roster is paged in full below), so this is
 *  a safety bound against pathological roster growth, not a steady-state
 *  limiter. If it is ever exceeded the overflow is logged loudly so the
 *  un-evaluated patients are visible and a rotating cursor can be added.
 *  (The prior value of 200 silently starved everyone past the first 200
 *  patient_ids once the roster grew.) */
const MAX_PATIENTS_PER_RUN = 5000;

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
  const cutoffIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  // Page the FULL recent-night roster. PostgREST caps a single response
  // (~1000 rows); the prior single ordered-by-patient_id query truncated
  // there, so once recent nights exceeded that cap only the
  // alphabetically-lowest patient_ids were ever seen and every other
  // patient was NEVER evaluated. De-dupe patient_ids across pages.
  const PAGE_SIZE = 1000;
  const candidateSet = new Set<string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: candidatesErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("patient_id")
      .gte("night_date", cutoffIso)
      .order("patient_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (candidatesErr) throw candidatesErr;
    if (!page || page.length === 0) break;
    for (const r of page) {
      if (r.patient_id) candidateSet.add(r.patient_id);
    }
    if (page.length < PAGE_SIZE) break;
  }

  // Daily off-peak cron: evaluate every active patient. Only fall back
  // to the cap on a pathologically large roster — and log it so the
  // overflow (which would silently go un-evaluated) is visible.
  const allCandidateIds = Array.from(candidateSet);
  if (allCandidateIds.length > MAX_PATIENTS_PER_RUN) {
    logger.warn(
      {
        event: "smart_triggers.evaluate.roster_overflow",
        rosterSize: allCandidateIds.length,
        cap: MAX_PATIENTS_PER_RUN,
      },
      "smart-triggers.evaluate: roster exceeds per-run cap — overflow patients not evaluated this run; add a rotating cursor",
    );
  }
  const candidates = allCandidateIds
    .slice(0, MAX_PATIENTS_PER_RUN)
    .map((patientId) => ({ patientId }));

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
          leakRateLMin:
            n.leak_rate_l_min !== null ? Number(n.leak_rate_l_min) : null,
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
