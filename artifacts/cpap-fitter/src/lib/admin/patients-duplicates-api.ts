// Hand-rolled fetch wrapper for GET /patients/duplicates (CSR #C1).
//
// Surfaces likely-duplicate patient records (same DOB+last name / phone /
// email) so a CSR can review them. Detection only — read-only.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type DuplicateMatchReason = "dob_lastname" | "phone" | "email";

export interface DuplicateMember {
  patientId: string;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  pacwareId: string | null;
  status: string;
  hasPhone: boolean;
  hasEmail: boolean;
  createdAt: string;
}

export interface DuplicateGroup {
  groupKey: string;
  matchReason: DuplicateMatchReason;
  members: DuplicateMember[];
  memberCount: number;
}

export interface ListPatientDuplicatesResponse {
  groups: DuplicateGroup[];
  groupCount: number;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
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
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const listPatientDuplicates = () =>
  jsonFetch<ListPatientDuplicatesResponse>("/patients/duplicates");

export interface MergePatientsResult {
  ok: true;
  tablesRepointed: number;
  rowsRepointed: number;
}

/**
 * Fold a duplicate patient record into a primary (survivor). Repoints
 * every FK atomically server-side; the duplicate is closed, not deleted.
 */
export const mergePatients = (
  primaryPatientId: string,
  duplicatePatientId: string,
) =>
  jsonFetch<MergePatientsResult>("/patients/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ primaryPatientId, duplicatePatientId }),
  });
