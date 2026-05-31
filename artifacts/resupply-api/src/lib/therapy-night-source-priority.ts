// Single source of truth for therapy-night source priority.
//
// `patient_therapy_nights` has UNIQUE(patient_id, night_date, source),
// so the same night can arrive from several feeds. When that happens
// the lowest-rank feed wins: device clouds first, then the patient-app
// push (Health Connect), then the React Health pull, then manual entry.
//
// Every surface that dedupes nights (the patient-facing therapy
// summary, the provider-facing therapy-usage report, …) MUST share this
// table so they never disagree on which feed represents a given night.
// Previously each callsite kept its own copy and they had already
// drifted — `react_health` was ranked above `manual` in one and missing
// (so it lost to everything) in another.
export const THERAPY_NIGHT_SOURCE_PRIORITY: Record<string, number> = {
  resmed_airview: 0,
  philips_care: 1,
  health_connect: 2,
  react_health: 3,
  manual: 4,
};

/** Rank for a source string; unknown / unexpected feeds sort last so a
 *  known feed always wins a contested night. */
export function therapyNightSourceRank(source: string): number {
  return THERAPY_NIGHT_SOURCE_PRIORITY[source] ?? 99;
}
