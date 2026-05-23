// Single-patient variant of runSmartTriggerEvaluator. Called from
// the integration-refresh path so a freshly imported night of
// therapy data can fire a same-second trigger detection rather than
// waiting for the daily cron sweep.
//
// Same rules + audit envelope as the full evaluator; isolated here
// so the existing batch runner stays untouched.

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { evaluateAll } from "./index";

export interface PatientEvalActor {
  adminEmail: string | null;
  adminUserId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface PatientEvalResult {
  proposed: number;
  inserted: number;
  skippedExisting: number;
}

/**
 * Evaluate recent therapy nights for a patient, create smart-trigger proposals, insert detected trigger events, and record audit entries for successful inserts.
 *
 * @param patientId - The ID of the patient to evaluate
 * @param actor - Audit actor information (may include `adminEmail`, `adminUserId`, `ip`, and `userAgent`)
 * @returns An object with counters: `proposed` (proposals processed), `inserted` (new rows inserted), and `skippedExisting` (proposals skipped due to existing records)
 * @throws The underlying database error when fetching nights or when an insert fails for reasons other than a unique-violation (Postgres code `23505`)
 */
export async function evaluatePatientSmartTriggers(
  patientId: string,
  actor: PatientEvalActor,
): Promise<PatientEvalResult> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: nightRows, error: nightsErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select(
      "night_date, usage_minutes, ahi, leak_rate_l_min, pressure_p95_cmh2o",
    )
    .eq("patient_id", patientId)
    .order("night_date", { ascending: false })
    .limit(60);
  if (nightsErr) throw nightsErr;
  const nights = nightRows ?? [];

  const proposals = evaluateAll(
    nights.map((n) => ({
      date: n.night_date,
      usageMinutes: n.usage_minutes,
      ahi: n.ahi !== null ? Number(n.ahi) : null,
      leakRateLMin: n.leak_rate_l_min !== null ? Number(n.leak_rate_l_min) : null,
      pressureP95Cmh2o:
        n.pressure_p95_cmh2o !== null ? Number(n.pressure_p95_cmh2o) : null,
    })),
  );

  let proposed = 0;
  let inserted = 0;
  let skippedExisting = 0;
  for (const p of proposals) {
    proposed += 1;
    const { data: insertedRow, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .insert({
        patient_id: patientId,
        kind: p.kind,
        window_start_date: p.windowStartDate,
        window_end_date: p.windowEndDate,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertErr) {
      if ((insertErr as { code?: string }).code === "23505") {
        skippedExisting += 1;
        continue;
      }
      throw insertErr;
    }
    if (insertedRow) {
      inserted += 1;
      await logAudit({
        action: "patient.smart_trigger.detected",
        adminEmail: actor.adminEmail,
        adminUserId: actor.adminUserId,
        targetTable: "patient_smart_trigger_events",
        targetId: insertedRow.id,
        metadata: {
          patient_id: patientId,
          kind: p.kind,
          window_start: p.windowStartDate,
          window_end: p.windowEndDate,
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      }).catch((err) => {
        logger.warn(
          { err },
          "patient.smart_trigger.detected audit (per-patient) failed",
        );
      });
    }
  }

  return { proposed, inserted, skippedExisting };
}
