// Hand-rolled fetch wrappers for clinical encounter admin endpoints.
// (F3 clinician portal). Append-only: list + create only.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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
