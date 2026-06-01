// Fetch wrappers for CMN/DIF structured forms (Biller #29).
// patients.read to view; create/patch need patients.update; worklist +
// catalog are reports.read (all enforced server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface CmnQuestion {
  key: string;
  label: string;
}
export interface CmnFormDef {
  formType: string;
  label: string;
  hcpcsCodes: string[];
  requiredKeys: string[];
  questions: CmnQuestion[];
}

export interface CmnValidation {
  ready: boolean;
  missing: string[];
  unknownForm: boolean;
}

export interface CmnDocument {
  id: string;
  patient_id: string;
  claim_id: string | null;
  form_type: string;
  hcpcs_code: string;
  status: "draft" | "completed" | "on_file" | "voided";
  answers: Record<string, unknown> | null;
  physician_name: string | null;
  physician_npi: string | null;
  length_of_need_months: number | null;
  created_at: string;
  validation: CmnValidation;
}

export interface CmnWorklistItem {
  id: string;
  patientId: string;
  formType: string;
  hcpcsCode: string;
  createdAt: string;
  ready: boolean;
  missingCount: number;
}

async function err(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return new ApiError(res, data, { method, url });
}

export async function getCmnCatalog(): Promise<{ forms: CmnFormDef[] }> {
  const url = "/resupply-api/admin/billing/cmn-catalog";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { forms: CmnFormDef[] };
}

export async function getPatientCmns(
  patientId: string,
): Promise<{ documents: CmnDocument[] }> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(
    patientId,
  )}/cmn-documents`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as { documents: CmnDocument[] };
}

export async function createCmn(
  patientId: string,
  body: { formType: string; hcpcsCode: string },
): Promise<{ id: string }> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(
    patientId,
  )}/cmn-documents`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { id: string };
}

export async function patchCmn(
  cmnId: string,
  body: {
    status?: "draft" | "completed" | "on_file" | "voided";
    answers?: Record<string, unknown>;
  },
): Promise<{ ok?: boolean; error?: string; missing?: string[] }> {
  const url = `/resupply-api/admin/cmn-documents/${encodeURIComponent(cmnId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    missing?: string[];
  } | null;
  // 409 incomplete is a normal, surfaced outcome (not a thrown error).
  if (res.status === 409 && data) return data;
  if (!res.ok) throw new ApiError(res, data, { method: "PATCH", url });
  return data ?? { ok: true };
}

export async function getCmnWorklist(): Promise<{
  items: CmnWorklistItem[];
  count: number;
  readyToComplete: number;
}> {
  const url = "/resupply-api/admin/billing/cmn-worklist";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as {
    items: CmnWorklistItem[];
    count: number;
    readyToComplete: number;
  };
}
