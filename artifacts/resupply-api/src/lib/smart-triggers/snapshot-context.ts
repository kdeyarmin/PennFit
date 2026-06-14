// Bridges the cached vendor snapshots (patient_integration_snapshots)
// into the EvaluationContext the rule library consumes.
//
// Only the device's configured MAX pressure is read today — the
// pressure-pegging rule (evaluatePressureAtMax) compares each night's
// P95 pressure against this ceiling. Everything else the rules need
// already lives in patient_therapy_nights.
//
// PHI posture: pressureMaxCmh2o is a numeric device setting, not a
// patient identifier — same posture as the nightly therapy numbers.

import { type getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;

/**
 * Pull `settings.pressureMaxCmh2o` out of a stored IntegrationSnapshot
 * payload (jsonb), tolerating the partial / unknown shapes that real
 * vendor data produces. Returns a positive finite number or null.
 */
export function readDeviceMaxPressure(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const settings = (payload as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as { pressureMaxCmh2o?: unknown }).pressureMaxCmh2o;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Latest known device max pressure for ONE patient across all of their
 * vendor snapshots (a patient can be linked to more than one cloud).
 * Newest fetched_at with a usable value wins. Best-effort: any read
 * error or missing data yields null so the caller still evaluates every
 * non-pressure rule.
 */
export async function fetchDeviceMaxPressure(
  supabase: Supabase,
  patientId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_integration_snapshots")
    .select("payload, fetched_at")
    .eq("patient_id", patientId)
    .order("fetched_at", { ascending: false })
    .limit(10);
  if (error || !data) return null;
  for (const row of data) {
    const max = readDeviceMaxPressure((row as { payload?: unknown }).payload);
    if (max != null) return max;
  }
  return null;
}

/**
 * Batch variant for the nightly evaluator: one paged scan of
 * patient_integration_snapshots builds a patient_id → max-pressure map
 * so the per-patient loop doesn't issue a round-trip each. Newest
 * fetched_at with a usable value wins per patient.
 */
export async function fetchDeviceMaxPressureMap(
  supabase: Supabase,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // Track the winning fetched_at per patient so a later page can't
  // overwrite a newer value with an older one.
  const bestAt = new Map<string, string>();
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select("patient_id, payload, fetched_at")
      .order("patient_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) {
      const r = row as {
        patient_id?: string | null;
        payload?: unknown;
        fetched_at?: string | null;
      };
      if (!r.patient_id) continue;
      const max = readDeviceMaxPressure(r.payload);
      if (max == null) continue;
      const at = r.fetched_at ?? "";
      const prevAt = bestAt.get(r.patient_id);
      if (prevAt === undefined || at > prevAt) {
        out.set(r.patient_id, max);
        bestAt.set(r.patient_id, at);
      }
    }
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}
