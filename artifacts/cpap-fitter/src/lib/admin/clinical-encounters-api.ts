// Hand-rolled fetch wrappers for clinical encounter admin endpoints.
// (F3 clinician portal). Append-only: list + create only.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type EncounterType =
  | "mask_fit"
  | "troubleshoot"
  | "setup_education"
  | "adherence_intervention"
  | "phone"
  | "other";

export interface ClinicalEncounter {
  id: string;
  encounterType: EncounterType;
  reason: string | null;
  assessment: string | null;
  intervention: string | null;
  plan: string | null;
  followUpAt: string | null;
  note: string | null;
  linkedAlertId: string | null;
  linkedEpisodeId: string | null;
  authorEmail: string;
  createdAt: string;
}

export interface CreateEncounterBody {
  encounterType: EncounterType;
  reason?: string;
  assessment?: string;
  intervention?: string;
  plan?: string;
  followUpAt?: string;
  note?: string;
  linkedAlertId?: string;
  linkedEpisodeId?: string;
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

export const getClinicalEncounters = (patientId: string) =>
  jsonFetch<{ encounters: ClinicalEncounter[] }>(
    "/admin/patients/clinical-encounters/query",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId }),
    },
  );

export const createClinicalEncounter = (
  patientId: string,
  body: CreateEncounterBody,
) =>
  jsonFetch<{ id: string; createdAt: string }>(
    `/admin/patients/${encodeURIComponent(patientId)}/clinical-encounters`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
