// Fetch wrapper for /admin/analytics/rt-outcomes (RT #24) — per-RT
// outcome rollups from the F3 clinical_encounters log. Counts only; the
// route returns no patient ids or clinical text. clinical.read-gated.

import { ApiError } from "@workspace/api-client-react/admin";

export const RT_ENCOUNTER_TYPES = [
  "mask_fit",
  "troubleshoot",
  "setup_education",
  "adherence_intervention",
  "phone",
  "other",
] as const;
export type RtEncounterType = (typeof RT_ENCOUNTER_TYPES)[number];

export interface RtOutcomeRow {
  authorEmail: string;
  authorUserId: string | null;
  encountersTotal: number;
  patientsManaged: number;
  followUpsCommitted: number;
  interventions: number;
  byType: Record<RtEncounterType, number>;
  lastActiveAt: string | null;
}

export interface RtOutcomesReport {
  windowDays: number;
  rows: RtOutcomeRow[];
  totals: {
    encounters: number;
    rts: number;
    patientsManaged: number;
    followUpsCommitted: number;
    interventions: number;
  };
}

export async function fetchRtOutcomes(
  windowDays: number,
): Promise<RtOutcomesReport> {
  const url = `/resupply-api/admin/analytics/rt-outcomes?windowDays=${encodeURIComponent(
    String(windowDays),
  )}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as RtOutcomesReport;
}
