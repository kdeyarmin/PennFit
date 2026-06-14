// Fetch wrappers for /admin/asset-recovery — the CPAP-machine recovery
// worklist. `cases.read` to list; create/update need `cases.manage`
// (enforced server-side). The route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type AssetRecoveryStatus =
  | "identified"
  | "outreach"
  | "label_sent"
  | "in_transit"
  | "received"
  | "redeployed"
  | "closed_unrecovered";

export type AssetRecoveryReason =
  | "discontinued"
  | "non_compliant"
  | "deceased"
  | "upgraded"
  | "insurance_change"
  | "other";

export const ASSET_RECOVERY_STATUS_OPTIONS: {
  value: AssetRecoveryStatus;
  label: string;
}[] = [
  { value: "identified", label: "Identified" },
  { value: "outreach", label: "Outreach" },
  { value: "label_sent", label: "Label sent" },
  { value: "in_transit", label: "In transit" },
  { value: "received", label: "Received" },
  { value: "redeployed", label: "Redeployed" },
  { value: "closed_unrecovered", label: "Closed — unrecovered" },
];

export const ASSET_RECOVERY_REASON_OPTIONS: {
  value: AssetRecoveryReason;
  label: string;
}[] = [
  { value: "discontinued", label: "Discontinued therapy" },
  { value: "non_compliant", label: "Non-compliant" },
  { value: "deceased", label: "Deceased" },
  { value: "upgraded", label: "Upgraded device" },
  { value: "insurance_change", label: "Insurance change" },
  { value: "other", label: "Other" },
];

export interface AssetRecoveryCase {
  id: string;
  patientId: string | null;
  patientLabel: string | null;
  deviceLabel: string | null;
  deviceSerial: string | null;
  status: AssetRecoveryStatus;
  reason: AssetRecoveryReason;
  trackingNumber: string | null;
  returnLabelUrl: string | null;
  notes: string | null;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetRecoveryListResponse {
  cases: AssetRecoveryCase[];
  counts: Record<string, number>;
}

export interface CreateAssetRecoveryInput {
  patientId?: string;
  patientLabel?: string;
  deviceLabel?: string;
  deviceSerial?: string;
  reason?: AssetRecoveryReason;
  notes?: string;
}

export interface UpdateAssetRecoveryInput {
  status?: AssetRecoveryStatus;
  reason?: AssetRecoveryReason;
  deviceLabel?: string;
  deviceSerial?: string;
  trackingNumber?: string;
  returnLabelUrl?: string;
  notes?: string;
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

export async function listAssetRecoveryCases(
  status?: AssetRecoveryStatus,
): Promise<AssetRecoveryListResponse> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const url = `/resupply-api/admin/asset-recovery${qs}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as AssetRecoveryListResponse;
}

export async function createAssetRecoveryCase(
  input: CreateAssetRecoveryInput,
): Promise<{ case: AssetRecoveryCase }> {
  const url = "/resupply-api/admin/asset-recovery";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { case: AssetRecoveryCase };
}

export async function updateAssetRecoveryCase(
  id: string,
  patch: UpdateAssetRecoveryInput,
): Promise<{ case: AssetRecoveryCase }> {
  const url = `/resupply-api/admin/asset-recovery/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await err(res, "PATCH", url);
  return (await res.json()) as { case: AssetRecoveryCase };
}
