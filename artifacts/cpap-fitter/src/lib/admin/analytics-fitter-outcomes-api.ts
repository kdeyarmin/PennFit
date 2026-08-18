// Fetch wrapper for /admin/analytics/fitter-outcomes — how well the mask
// fitter is actually doing: refit rate, whether clinicians accept the
// engine's recommendation, scan quality, and the confidence mix.
//
// Every rate is `number | null`. Null means "no denominator yet", NOT
// zero — the UI must render those differently or an empty dashboard
// reads as a perfect score.

import { adminJsonFetch } from "../admin-json-fetch";

export type FitEntryPoint =
  | "remote_link"
  | "in_office"
  | "kiosk_qr"
  | "refit_campaign";

export type FitSessionOutcome =
  | "high_confidence"
  | "moderate_confidence"
  | "low_confidence"
  | "contraindicated"
  | "outside_validated_range";

export type ScanQualityGrade = "good" | "marginal" | "poor";

export interface MaskRefitRate {
  maskId: string;
  maskLabel: string | null;
  outcomes: number;
  good: number;
  leaking: number;
  uncomfortable: number;
  refitRate: number;
}

export interface FitterOutcomesReport {
  sessions: {
    total: number;
    byEntryPoint: Record<FitEntryPoint, number>;
    byOutcome: Record<FitSessionOutcome, number>;
    outcomeUnknown: number;
    byScanQuality: Record<ScanQualityGrade, number>;
    scanQualityUnknown: number;
    degraded: number;
    highConfidenceRate: number | null;
  };
  acceptance: {
    decided: number;
    accepted: number;
    overridden: number;
    acceptanceRate: number | null;
    undecided: number;
    topOverrideReasons: Array<{ reason: string; count: number }>;
  };
  refit: {
    responses: number;
    good: number;
    leaking: number;
    uncomfortable: number;
    refitRate: number | null;
    byMask: MaskRefitRate[];
    belowSampleFloor: number;
    unattributed: number;
  };
  dispensing: {
    dispensed: number;
    dispenseRate: number | null;
    medianHoursToReview: number | null;
  };
}

export interface FitterOutcomesResponse {
  window: { days: number; since: string };
  /** True when the row cap was hit — the rates below are then computed
   *  over a partial period and must be labelled as such. */
  truncated: { sessions: boolean; outcomes: boolean };
  report: FitterOutcomesReport;
}

export function fetchFitterOutcomes(
  days = 90,
): Promise<FitterOutcomesResponse> {
  return adminJsonFetch(
    `/admin/analytics/fitter-outcomes?days=${encodeURIComponent(String(days))}`,
  );
}
