// Form-acknowledgements API wrappers (admin).

import { ApiError } from "@workspace/api-client-react/admin";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
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
}

export const getFormAckSummary = () =>
  jsonFetch<{ summary: FormAckSummaryRow[] }>(
    `/admin/form-acknowledgements/summary`,
  );
