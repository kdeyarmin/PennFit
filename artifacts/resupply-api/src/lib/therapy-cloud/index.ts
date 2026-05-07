// Therapy-cloud partner adapter interface (Phase E.1 / feature #18).
//
// Production deployment will populate this with one or more concrete
// adapters once we have a partner agreement (BAA + API access) with
// ResMed AirView, Philips Care Orchestrator, or both. Until then,
// the registry below contains only stub adapters that report
// `configured: false` so every consumer (the sync endpoint, the
// data-driven trigger evaluator) returns a clean 503 instead of
// crashing.
//
// Why an interface + registry rather than direct `if (provider ===
// "resmed_airview") ...` checks across the codebase:
//   * Both partners eventually need the SAME shape of nightly data
//     (usage + AHI + leak), and the dispatcher / dashboard read code
//     should not care which cloud the row originated from.
//   * The test surface is the interface; we can stub it in unit
//     tests without spinning up real partner sandboxes.
//   * Adding Philips Care later is one new adapter file + one
//     registry entry, no scattered branching.

import type { TherapyCloudSource } from "@workspace/resupply-db";

/** Patient identifier on the partner's side. Different partners
 *  use different schemes (numeric for ResMed, GUID for Philips);
 *  the row stores it as a string. */
export type PartnerPatientId = string;

export interface TherapyNightImport {
  /** YYYY-MM-DD in the patient's local TZ. */
  nightDate: string;
  sourceEventId: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
  pressureP95Cmh2o: number | null;
}

export interface FetchNightsResult {
  nights: TherapyNightImport[];
  /** Whether more pages are available — drives a follow-up call
   *  with `since = lastNightDate` if the partner paginates. */
  hasMore: boolean;
}

export interface TherapyCloudAdapter {
  source: TherapyCloudSource;
  /** True only when the env vars / OAuth tokens this adapter needs
   *  are present. False = sync endpoint returns 503. */
  configured: boolean;
  /**
   * Fetch nightly rollups for one patient. `since` is inclusive; a
   * caller passing the last imported night_date will get duplicates
   * which the upsert in the sync endpoint deduplicates by
   * (patient_id, night_date, source).
   */
  fetchNights(input: {
    partnerPatientId: PartnerPatientId;
    sinceDate: string;
    limit: number;
  }): Promise<FetchNightsResult>;
}

/**
 * Stub for the ResMed AirView adapter. Returns `configured: false`
 * until a deployer plugs a real implementation in. Calling
 * `fetchNights()` throws — the sync endpoint shouldn't reach this
 * branch when `configured: false`, but the throw is a safety net.
 */
export const resmedAirviewAdapterStub: TherapyCloudAdapter = {
  source: "resmed_airview",
  configured: Boolean(process.env.RESMED_AIRVIEW_OAUTH_TOKEN),
  fetchNights: async () => {
    throw new Error(
      "ResMed AirView adapter is not implemented. Wire up a real " +
        "client + replace this stub before enabling RESMED_AIRVIEW_OAUTH_TOKEN.",
    );
  },
};

/**
 * Stub for the Philips Care Orchestrator adapter. Same posture as
 * the ResMed stub — present for shape parity; rewires when a real
 * partner agreement lands.
 */
export const philipsCareAdapterStub: TherapyCloudAdapter = {
  source: "philips_care",
  configured: Boolean(process.env.PHILIPS_CARE_OAUTH_TOKEN),
  fetchNights: async () => {
    throw new Error(
      "Philips Care adapter is not implemented. Wire up a real client + " +
        "replace this stub before enabling PHILIPS_CARE_OAUTH_TOKEN.",
    );
  },
};

/** Adapter registry keyed by source. The sync endpoint looks up
 *  here. Tests stub the registry by replacing entries.
 *  `health_connect` is patient-push and lives under
 *  `resupply-integrations-health-connect` — not part of this
 *  provider-pull registry. `manual` is admin-uploaded and has no
 *  adapter at all. */
export const ADAPTERS: Record<
  Exclude<TherapyCloudSource, "manual" | "health_connect">,
  TherapyCloudAdapter
> = {
  resmed_airview: resmedAirviewAdapterStub,
  philips_care: philipsCareAdapterStub,
};

export function adapterFor(
  source: Exclude<TherapyCloudSource, "manual" | "health_connect">,
): TherapyCloudAdapter {
  return ADAPTERS[source];
}
