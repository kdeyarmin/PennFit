// Fetch wrappers for /admin/business-targets (Owner #8 — goal / target
// tracking with F2 pace-to-goal). The route returns camelCase.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type GoalPaceStatus = "ahead" | "on_track" | "behind" | "unknown";
export type MetricUnit = "count" | "cents" | "ratio" | "pct" | "days";

export interface GoalPace {
  daysInPeriod: number;
  daysElapsed: number;
  actualToDate: number;
  expectedToDate: number | null;
  paceRatio: number | null;
  attainmentRatio: number | null;
  projectedValue: number | null;
  status: GoalPaceStatus;
}

export interface BusinessTarget {
  id: string;
  metricKey: string;
  period: string;
  targetValue: number;
  unit: MetricUnit;
  notes: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  /** Pace-to-goal from metrics_daily, or null when the period/metric
   *  can't be resolved to a window. */
  pace: GoalPace | null;
}

export interface UpsertTargetBody {
  metricKey: string;
  period: string;
  targetValue: number;
  unit?: MetricUnit;
  notes?: string;
}

const BASE = "/resupply-api/admin/business-targets";

export async function listBusinessTargets(
  period?: string,
): Promise<{ targets: BusinessTarget[] }> {
  const url = period ? `${BASE}?period=${encodeURIComponent(period)}` : BASE;
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
  return (await res.json()) as { targets: BusinessTarget[] };
}

export async function upsertBusinessTarget(
  body: UpsertTargetBody,
): Promise<BusinessTarget> {
  const res = await fetch(BASE, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "PUT", url: BASE });
  }
  return (await res.json()) as BusinessTarget;
}
