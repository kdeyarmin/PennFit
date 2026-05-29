// API client for /admin/(patients/:id)/prescription-requests —
// pre-populated faxable Rx packets.

export type PrescriptionRequestStatus =
  | "draft"
  | "sent_fax"
  | "delivered"
  | "signed"
  | "expired"
  | "void"
  | "failed";

export type PrescriptionDeviceClass =
  | "cpap"
  | "auto_cpap"
  | "bipap"
  | "bipap_st"
  | "asv";

export interface PrescriptionRequestHcpcsLine {
  hcpcs: string;
  description: string;
  quantity: number;
  cadenceDays?: number | null;
  modifiers?: string[];
}

export interface PrescriptionRequestSettings {
  deviceClass: PrescriptionDeviceClass;
  pressureCmh2o?: number | null;
  pressureMinCmh2o?: number | null;
  pressureMaxCmh2o?: number | null;
  ipapCmh2o?: number | null;
  epapCmh2o?: number | null;
  rampMinutes?: number | null;
  rampStartCmh2o?: number | null;
  humidifierSetting?: number | null;
  heatedTube?: boolean;
  backupRateBpm?: number | null;
}

export interface PrescriptionRequestListItem {
  id: string;
  providerId: string | null;
  status: PrescriptionRequestStatus;
  returnFaxE164: string | null;
  sentToFaxE164: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  signedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface PrescriptionRequestDetail extends PrescriptionRequestListItem {
  patientId: string;
  sourcePrescriptionId: string | null;
  hcpcsLines: PrescriptionRequestHcpcsLine[];
  icd10Codes: string[];
  settings: PrescriptionRequestSettings | null;
  lengthOfNeedMonths: number;
  returnEmail: string | null;
  clinicalNotes: string | null;
  validThrough: string | null;
  vendorRef: string | null;
  vendorName: string | null;
  signedObjectKey: string | null;
  createdByEmail: string;
  updatedAt: string;
}

export interface CreatePrescriptionRequestRequest {
  providerId: string;
  sourcePrescriptionId?: string;
  hcpcsLines: PrescriptionRequestHcpcsLine[];
  icd10Codes: string[];
  settings?: PrescriptionRequestSettings | null;
  lengthOfNeedMonths?: number;
  returnFaxE164?: string | null;
  returnEmail?: string | null;
  clinicalNotes?: string | null;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
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

export async function listPatientPrescriptionRequests(
  patientId: string,
): Promise<{ packets: PrescriptionRequestListItem[] }> {
  return jsonFetch(
    `/admin/patients/${encodeURIComponent(patientId)}/prescription-requests`,
  );
}

export async function getPrescriptionRequest(
  id: string,
): Promise<PrescriptionRequestDetail> {
  return jsonFetch(`/admin/prescription-requests/${encodeURIComponent(id)}`);
}

export async function createPrescriptionRequest(
  patientId: string,
  body: CreatePrescriptionRequestRequest,
): Promise<{ id: string }> {
  return jsonFetch(
    `/admin/patients/${encodeURIComponent(patientId)}/prescription-requests`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function sendPrescriptionFax(
  id: string,
): Promise<{ status: "sent_fax"; vendorRef: string }> {
  return jsonFetch(
    `/admin/prescription-requests/${encodeURIComponent(id)}/send-fax`,
    { method: "POST" },
  );
}

export async function markPrescriptionSigned(
  id: string,
  signedObjectKey?: string | null,
): Promise<{ status: "signed" }> {
  return jsonFetch(
    `/admin/prescription-requests/${encodeURIComponent(id)}/mark-signed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        signedObjectKey !== undefined ? { signedObjectKey } : {},
      ),
    },
  );
}

export async function voidPrescriptionRequest(
  id: string,
): Promise<{ status: "void" }> {
  return jsonFetch(
    `/admin/prescription-requests/${encodeURIComponent(id)}/void`,
    { method: "POST" },
  );
}

export function prescriptionRequestPdfUrl(id: string): string {
  return `/resupply-api/admin/prescription-requests/${encodeURIComponent(id)}/pdf`;
}
