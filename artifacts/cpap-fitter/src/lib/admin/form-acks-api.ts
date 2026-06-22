// Form-acknowledgements API wrappers (admin).

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export interface FormAckRow {
  id: string;
  formKind: string;
  formVersion: string;
  signedAt: string;
  signedFromIp: string | null;
  source: "patient_portal" | "csr_recorded" | "paper_scan";
  notes: string | null;
  currentVersion: string | null;
}

export const listPatientFormAcks = (patientId: string) =>
  jsonFetch<{ acknowledgements: FormAckRow[] }>(
    `/admin/patients/${encodeURIComponent(patientId)}/form-acknowledgements`,
  );

export interface FormAckSummaryRow {
  formKind: string;
  title: string;
  currentVersion: string;
  activePatients: number;
  signedCurrent: number;
  signedOld: number;
  neverSigned: number;
  /** Operator-facing compliance caveat (e.g. the ABN is not the official
   *  CMS-R-131); null for forms without one. */
  complianceNote?: string | null;
}

export const getFormAckSummary = () =>
  jsonFetch<{ summary: FormAckSummaryRow[] }>(
    `/admin/form-acknowledgements/summary`,
  );
