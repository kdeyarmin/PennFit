// Hand-rolled fetch wrappers for the physician-fax-outreach endpoints
// shipped in Phase G.6. Used by the patient-detail page's "Fax outreach"
// tab to record + list outreach attempts.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type PhysicianFaxOutreachStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "failed";

export interface PhysicianFaxOutreachRow {
  id: string;
  patientId: string;
  prescriptionId: string | null;
  physicianName: string;
  physicianFaxE164: string;
  status: PhysicianFaxOutreachStatus;
  vendorRef: string | null;
  vendorName: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface ListPhysicianFaxOutreachResponse {
  outreach: PhysicianFaxOutreachRow[];
  providerConfigured: boolean;
}

export async function listPatientPhysicianFaxOutreach(
  patientId: string,
): Promise<ListPhysicianFaxOutreachResponse> {
  const url = `/resupply-api/admin/physician-fax-outreach?patientId=${encodeURIComponent(patientId)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as ListPhysicianFaxOutreachResponse;
}

export interface CreatePhysicianFaxOutreachInput {
  patientId: string;
  prescriptionId?: string | null;
  physicianName: string;
  physicianFaxE164: string;
  coverLetterText: string;
}

export async function createPhysicianFaxOutreach(
  input: CreatePhysicianFaxOutreachInput,
): Promise<{ id: string; status: string; provider: string }> {
  const url = `/resupply-api/admin/physician-fax-outreach`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.text().catch(() => "");
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as { id: string; status: string; provider: string };
}
