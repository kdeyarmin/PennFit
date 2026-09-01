// Fetch wrapper for /admin/lifecycle-health — the signals that say
// whether the resupply lifecycle is actually working.
//
// Read-only; the route computes and changes nothing.

import { ApiError } from "@workspace/api-client-react/admin";

/**
 * Six states, and four of them are not `ok`.
 *
 * `disabled` and `not_configured` are the pair that matters most here:
 * "this tenant does not do that" and "nobody has set it up, so the true
 * value is unknown" need different responses, and both would look like a
 * healthy zero if the panel collapsed them.
 */
export type SignalStatus =
  | "ok"
  | "warning"
  | "failure"
  | "disabled"
  | "not_configured"
  | "unknown";

export interface LifecycleSignalRow {
  key: string;
  label: string;
  category: string;
  severity: "critical" | "major" | "minor";
  unit: string;
  /** What the number means. Shown verbatim — it is the answer to the
   *  question the row provokes. */
  why: string;
  href: string;
  runbookAnchor: string;

  status: SignalStatus;
  /** null whenever `status` is not ok/warning/failure. Never render as 0. */
  value: number | null;
  /** Pre-formatted server-side so the panel, the email and the Slack
   *  line cannot render one number three different ways. */
  display: string;
  sample: number | null;
  reason: string | null;
  /** A breach held back because the population was too small to judge. */
  withheld: "insufficient_sample" | null;
  /** The read hit its row cap: this value is a FLOOR, not a total. */
  truncated: boolean;
  detail: Record<string, unknown>;

  warnThreshold: number;
  failThreshold: number;
  /** `default_after_invalid_env` means a configured value did not take. */
  thresholdSource: "default" | "env" | "default_after_invalid_env";
  warnEnv: string;
  failEnv: string;

  /** True when this reading came from the last background scan, not now. */
  fromLastScan: boolean;
  lastScanAt: string | null;
  lastScanAgeHours: number | null;

  alertOpen: boolean;
  alertOpenHours: number | null;
  alertPeakStatus: string | null;
  alertNotifyCount: number | null;
}

export interface LifecycleHealthResponse {
  signals: LifecycleSignalRow[];
  refreshedAt: string;
  /** null when the background scan has never reported for this tenant. */
  lastScanAt: string | null;
  lastScanAgeHours: number | null;
  totals: {
    signalCount: number;
    catalogSize: number;
    failure: number;
    warning: number;
    ok: number;
    disabled: number;
    notConfigured: number;
    unknown: number;
    truncated: number;
    openAlerts: number;
  };
  scope: {
    kind: string;
    /** Signals about rows that belong to no tenant, reported elsewhere. */
    platformSignalsElsewhere: string[];
    platformScopeId: string;
  };
}

export async function fetchLifecycleHealth(): Promise<LifecycleHealthResponse> {
  const url = "/resupply-api/admin/lifecycle-health";
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
  return (await res.json()) as LifecycleHealthResponse;
}
