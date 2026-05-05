// Hand-rolled fetch wrappers for the physician-fax-outreach endpoints
// shipped in Phase G.6. Used by the patient-detail page's "Fax outreach"
// tab to record + list outreach attempts.

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
  const res = await fetch(
    `/resupply-api/admin/physician-fax-outreach?patientId=${encodeURIComponent(patientId)}`,
    { headers: { Accept: "application/json" }, credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load fax outreach (${res.status})`);
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
  const res = await fetch(`/resupply-api/admin/physician-fax-outreach`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to record fax outreach (${res.status}): ${text}`);
  }
  return (await res.json()) as { id: string; status: string; provider: string };
}
