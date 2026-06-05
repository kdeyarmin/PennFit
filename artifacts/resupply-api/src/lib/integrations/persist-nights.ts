// Persist the nights inside an IntegrationSnapshot into the
// canonical patient_therapy_nights table so the compliance scanner +
// patient-facing dashboard see the data. Idempotent via the
// (patient_id, night_date, source) unique index — re-running on
// the same snapshot is a no-op except for any row whose values
// changed (a partner re-scored a night after the fact, etc.).

import type { TherapyNight } from "@workspace/resupply-integrations";
import { type getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface PersistResult {
  inserted: number;
  /** Nights skipped because they had no usage data at all (null
   *  across every numeric column). We don't want "no-data" stub
   *  rows polluting the compliance window. */
  skipped: number;
}

const SOURCES = new Set([
  "resmed_airview",
  "philips_care",
  "react_health",
] as const);

/**
 * Upsert each TherapyNight in `nights` into patient_therapy_nights
 * under (patient_id, night_date, source).
 *
 * `source` must already be one of the enum values the table accepts;
 * the caller is responsible for that. We don't try to fail open here
 * because a wrong-source upsert would create a confusing duplicate
 * row that the unique index can't dedupe.
 */
export async function persistTherapyNights(
  supabase: Supabase,
  patientId: string,
  source: string,
  nights: readonly TherapyNight[],
): Promise<PersistResult> {
  if (!SOURCES.has(source as never)) {
    throw new Error(`persistTherapyNights: unsupported source "${source}"`);
  }
  let inserted = 0;
  let skipped = 0;
  for (const n of nights) {
    const allNull =
      n.usageMinutes == null &&
      n.ahi == null &&
      n.leakRateLMin == null &&
      n.pressureP95Cmh2o == null;
    if (allNull) {
      skipped += 1;
      continue;
    }
    const { error } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .upsert(
        {
          patient_id: patientId,
          night_date: n.nightDate,
          source,
          source_event_id: `${source}:${n.nightDate}`,
          usage_minutes: n.usageMinutes,
          ahi: n.ahi == null ? null : String(n.ahi),
          leak_rate_l_min:
            n.leakRateLMin == null ? null : String(n.leakRateLMin),
          pressure_p95_cmh2o:
            n.pressureP95Cmh2o == null ? null : String(n.pressureP95Cmh2o),
        },
        { onConflict: "patient_id,night_date,source" },
      );
    if (error) throw error;
    inserted += 1;
  }
  return { inserted, skipped };
}
