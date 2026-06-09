// Fetch wrappers for the claim signed-paperwork ledger + bill hold (0253).
// reports.read for the worklist; patients.read to list a claim's paperwork;
// patients.update for the mutations (all enforced server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type RequirementType =
  | "prescription"
  | "swo"
  | "cmn"
  | "dwo"
  | "aob"
  | "abn"
  | "proof_of_delivery"
  | "medical_records"
  | "face_to_face"
  | "sleep_study"
  | "agreement"
  | "other";

export type RequirementStatus =
  | "outstanding"
  | "satisfied"
  | "waived"
  | "voided";

export interface PaperworkRequirement {
  id: string;
  claim_id: string | null;
  patient_id: string;
  requirement_type: RequirementType;
  label: string;
  status: RequirementStatus;
  required: boolean;
  expected_return_fax_e164: string | null;
  reminder_count: number;
  last_reminded_at: string | null;
  satisfied_at: string | null;
  satisfied_via: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaperworkSummary {
  held: boolean;
  outstanding: string[];
  requirements: PaperworkRequirement[];
}

export interface BillHoldWorklistItem {
  claimId: string;
  patientId: string;
  patientName: string;
  payerName: string;
  dateOfService: string | null;
  totalBilledCents: number;
  heldSince: string | null;
  reason: string | null;
  outstanding: { label: string; requirementType: string }[];
}

export interface BillHoldWorklist {
  items: BillHoldWorklistItem[];
  count: number;
  totalHeldCents: number;
}

async function err(
  res: Response,
  method: string,
  url: string,
): Promise<ApiError> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return new ApiError(res, data, { method, url });
}

export async function getBillHoldWorklist(): Promise<BillHoldWorklist> {
  const url = "/resupply-api/admin/billing/bill-hold-worklist";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as BillHoldWorklist;
}

export async function getClaimPaperwork(
  claimId: string,
): Promise<PaperworkSummary> {
  const url = `/resupply-api/admin/claims/${encodeURIComponent(claimId)}/paperwork`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as PaperworkSummary;
}

export async function satisfyRequirement(
  requirementId: string,
  body: {
    via?: "upload" | "esign" | "portal" | "mail" | "manual";
    note?: string;
  } = {},
): Promise<unknown> {
  const url = `/resupply-api/admin/claim-paperwork/${encodeURIComponent(
    requirementId,
  )}/satisfy`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return res.json();
}

export async function waiveRequirement(
  requirementId: string,
  waivedReason: string,
): Promise<unknown> {
  const url = `/resupply-api/admin/claim-paperwork/${encodeURIComponent(
    requirementId,
  )}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify({ status: "waived", waivedReason }),
  });
  if (!res.ok) throw await err(res, "PATCH", url);
  return res.json();
}

export async function remindRequirement(
  requirementId: string,
): Promise<unknown> {
  const url = `/resupply-api/admin/claim-paperwork/${encodeURIComponent(
    requirementId,
  )}/remind`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) throw await err(res, "POST", url);
  return res.json();
}
