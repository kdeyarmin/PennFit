// Form-acknowledgements API wrappers (admin).

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
