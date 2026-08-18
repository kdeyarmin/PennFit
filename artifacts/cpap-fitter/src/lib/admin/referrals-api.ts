// Client for /admin/provider-referrals/* — the DME's inbound referral
// queue. The path is `provider-referrals` because `/admin/referrals` is
// already taken by the referral-source CRM and attribution routes; see the
// header of routes/admin/referrals.ts.

import { adminJsonFetch } from "../admin-json-fetch";

export type ReferralStatus =
  | "submitted"
  | "accepted"
  | "in_progress"
  | "dispensed"
  | "declined"
  | "cancelled";

export interface InboundReferral {
  id: string;
  status: ReferralStatus;
  patientName: string;
  patientDob: string | null;
  entryPoint: "remote_link" | "in_office" | "kiosk_qr";
  therapyMode: "pap" | "niv";
  fitSessionId: string | null;
  approvedMaskModelId: string | null;
  unreadForDme: number;
  submittedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
  dispensedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboundReferralDetail extends InboundReferral {
  patient: {
    firstName: string;
    lastName: string;
    dob: string | null;
    email: string | null;
    phone: string | null;
    sex: string | null;
    address: unknown;
    chartId: string | null;
  };
  insurance: {
    payerName: string | null;
    memberId: string | null;
    groupNumber: string | null;
  };
  clinical: {
    therapyMode: "pap" | "niv";
    prescribedPressureCmH2O: number | null;
    diagnosisCode: string | null;
    notes: string | null;
  };
  approval: {
    maskModelId: string | null;
    variantId: string | null;
    isOverride: boolean;
    note: string | null;
    approvedAt: string | null;
    /** Resolved server-side — ids alone are not pickable. */
    maskName: string | null;
    interfaceType: string | null;
    sizeLabel: string | null;
  };
  signature: { requestId: string | null; signedAt: string | null };
  createdByEmail: string | null;
  acceptedByEmail: string | null;
  events: Array<{
    eventType: string;
    actorKind: string;
    actorEmail: string | null;
    occurredAt: string;
  }>;
  messages: Array<{
    id: string;
    authorKind: "provider" | "staff";
    authorEmail: string | null;
    body: string;
    createdAt: string;
  }>;
  documents: Array<{
    id: string;
    docType: string;
    fileName: string;
    sizeBytes: number;
    uploadedByKind: "provider" | "staff";
    createdAt: string;
  }>;
}

export interface ProviderLink {
  id: string;
  providerId: string;
  status: "active" | "suspended" | "revoked";
  displayName: string | null;
  defaultLocationId: string | null;
  invitedByEmail: string | null;
  invitedAt: string;
  revokedAt: string | null;
  notes: string | null;
}

export function fetchInboundReferrals(filters: {
  status?: ReferralStatus;
  open?: boolean;
}): Promise<{ referrals: InboundReferral[] }> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.open) params.set("open", "true");
  const qs = params.toString();
  return adminJsonFetch(`/admin/provider-referrals${qs ? `?${qs}` : ""}`);
}

export function fetchInboundReferral(
  id: string,
): Promise<InboundReferralDetail> {
  return adminJsonFetch(`/admin/provider-referrals/${encodeURIComponent(id)}`);
}

export function acceptReferral(
  id: string,
  input: { patientId?: string | null; note?: string } = {},
): Promise<{ ok: true; status: string }> {
  return adminJsonFetch(
    `/admin/provider-referrals/${encodeURIComponent(id)}/accept`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function declineReferral(
  id: string,
  reason: string,
): Promise<{ ok: true; status: string }> {
  return adminJsonFetch(
    `/admin/provider-referrals/${encodeURIComponent(id)}/decline`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    },
  );
}

export function setReferralStatus(
  id: string,
  status: "in_progress" | "dispensed",
): Promise<{ ok: true; status: string }> {
  return adminJsonFetch(
    `/admin/provider-referrals/${encodeURIComponent(id)}/status`,
    {
      method: "POST",
      body: JSON.stringify({ status }),
    },
  );
}

export function replyToReferral(
  id: string,
  body: string,
): Promise<{ ok: true }> {
  return adminJsonFetch(
    `/admin/provider-referrals/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  );
}

/**
 * Authorize a referring provider to send referrals to this organization.
 *
 * Without this there is no way to create the FIRST link, and since
 * referral creation requires an active one, every provider's destination
 * picker would be permanently empty on a fresh tenant.
 */
export function createProviderLink(input: {
  providerId: string;
  displayName?: string | null;
  defaultLocationId?: string | null;
  notes?: string | null;
}): Promise<{ ok: true }> {
  return adminJsonFetch("/admin/provider-referrals/providers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchProviderLinks(): Promise<{ links: ProviderLink[] }> {
  return adminJsonFetch("/admin/provider-referrals/providers");
}

/**
 * Where the browser fetches a referral attachment's bytes from.
 *
 * A plain URL rather than a fetch wrapper: the response is a file
 * download, so it goes on an `<a href>` and rides the same session
 * cookie the rest of the console uses.
 */
export function inboundDocumentUrl(
  referralId: string,
  documentId: string,
): string {
  return `/resupply-api/admin/provider-referrals/${encodeURIComponent(referralId)}/documents/${encodeURIComponent(documentId)}/content`;
}

export function updateProviderLink(
  id: string,
  patch: { status?: "active" | "suspended" | "revoked" },
): Promise<{ ok: true }> {
  return adminJsonFetch(
    `/admin/provider-referrals/providers/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

/** How each status reads to DME staff — from the receiver's point of view. */
export const INBOUND_STATUS_LABEL: Record<ReferralStatus, string> = {
  submitted: "New — needs a decision",
  accepted: "Accepted",
  in_progress: "In progress",
  dispensed: "Dispensed",
  declined: "Declined",
  cancelled: "Withdrawn by the provider",
};
