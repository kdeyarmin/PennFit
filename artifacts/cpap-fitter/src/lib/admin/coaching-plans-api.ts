// Hand-rolled fetch wrappers for /admin/coaching-plans.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type CoachingStatus =
  | "open"
  | "outreach_made"
  | "improving"
  | "escalated"
  | "resolved"
  | "abandoned";

export interface CoachingPlan {
  id: string;
  patientId: string;
  sourceAlertId: string | null;
  openedByUserId: string | null;
  status: CoachingStatus;
  targetCompliancePct: number;
  latestCompliancePct: string | null;
  targetDate: string | null;
  latestOutreachAt: string | null;
  resolutionNote: string | null;
  openedAt: string;
  closedAt: string | null;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    ...restInit,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const listCoachingPlans = (includeClosed = false) =>
  jsonFetch<{ plans: CoachingPlan[] }>(
    `/admin/coaching-plans${includeClosed ? "?include=closed" : ""}`,
  );

export const createCoachingPlan = (body: {
  patientId: string;
  sourceAlertId?: string | null;
  targetCompliancePct?: number;
  targetDate?: string | null;
}) =>
  jsonFetch<{ id: string }>("/admin/coaching-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const patchCoachingPlan = (
  id: string,
  body: {
    status?: CoachingStatus;
    targetCompliancePct?: number;
    targetDate?: string | null;
    latestCompliancePct?: number | null;
    latestOutreachAt?: string | null;
    resolutionNote?: string | null;
  },
) =>
  jsonFetch<{ ok: true }>(`/admin/coaching-plans/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
