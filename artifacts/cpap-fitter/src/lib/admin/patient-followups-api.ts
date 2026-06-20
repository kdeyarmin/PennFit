// Hand-rolled fetch wrappers for the patient followups endpoints
// (Phase 19). Mirrors customer-followups-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface AdminPatientFollowup {
  id: string;
  body: string;
  dueAt: string;
  completedAt: string | null;
  completedByEmail: string | null;
  createdByEmail: string;
  createdAt: string;
}

export interface AdminPatientFollowupsListResponse {
  followups: AdminPatientFollowup[];
}

export interface CreateAdminPatientFollowupResponse {
  id: string;
  dueAt: string;
  createdAt: string;
}

export interface CompleteAdminPatientFollowupResponse {
  id: string;
  completedAt: string | null;
}

export interface ReopenAdminPatientFollowupResponse {
  id: string;
  completedAt: string | null;
}

export class AdminPatientFollowupsNotFoundError extends Error {
  constructor() {
    super("Patient or followup not found.");
  }
}

export async function listAdminPatientFollowups(
  patientId: string,
  options: { includeCompleted?: boolean } = {},
): Promise<AdminPatientFollowupsListResponse> {
  const qs = options.includeCompleted ? "?include=completed" : "";
  const res = await fetch(
    `/resupply-api/patients/${encodeURIComponent(patientId)}/followups${qs}`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) {
    throw new AdminPatientFollowupsNotFoundError();
  }
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "GET", url: res.url });
  }
  return (await res.json()) as AdminPatientFollowupsListResponse;
}

export async function createAdminPatientFollowup(
  patientId: string,
  body: string,
  dueAt: Date,
): Promise<CreateAdminPatientFollowupResponse> {
  const res = await fetch(
    `/resupply-api/patients/${encodeURIComponent(patientId)}/followups`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...csrfHeader(),
      },
      body: JSON.stringify({ body, dueAt: dueAt.toISOString() }),
    },
  );
  if (res.status === 404) {
    throw new AdminPatientFollowupsNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res, text || null, { method: "POST", url: res.url });
  }
  return (await res.json()) as CreateAdminPatientFollowupResponse;
}

export async function completeAdminPatientFollowup(
  patientId: string,
  followupId: string,
): Promise<CompleteAdminPatientFollowupResponse> {
  const res = await fetch(
    `/resupply-api/patients/${encodeURIComponent(patientId)}/followups/${encodeURIComponent(followupId)}/complete`,
    {
      method: "PATCH",
      headers: { Accept: "application/json", ...csrfHeader() },
    },
  );
  if (res.status === 404) {
    throw new AdminPatientFollowupsNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res, text || null, { method: "PATCH", url: res.url });
  }
  return (await res.json()) as CompleteAdminPatientFollowupResponse;
}

export async function reopenAdminPatientFollowup(
  patientId: string,
  followupId: string,
): Promise<ReopenAdminPatientFollowupResponse> {
  const res = await fetch(
    `/resupply-api/patients/${encodeURIComponent(patientId)}/followups/${encodeURIComponent(followupId)}/reopen`,
    {
      method: "PATCH",
      headers: { Accept: "application/json", ...csrfHeader() },
    },
  );
  if (res.status === 404) {
    throw new AdminPatientFollowupsNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res, text || null, { method: "PATCH", url: res.url });
  }
  return (await res.json()) as ReopenAdminPatientFollowupResponse;
}
