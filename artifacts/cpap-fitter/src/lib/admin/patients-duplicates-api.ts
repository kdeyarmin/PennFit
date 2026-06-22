// Hand-rolled fetch wrapper for GET /patients/duplicates (CSR #C1).
//
// Surfaces likely-duplicate patient records (same DOB+last name / phone /
// email) so a CSR can review them. Detection only — read-only.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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
