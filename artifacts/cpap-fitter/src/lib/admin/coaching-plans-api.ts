// Hand-rolled fetch wrappers for /admin/coaching-plans.

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
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
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
