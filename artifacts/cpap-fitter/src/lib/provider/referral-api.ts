// Fetch wrappers for the provider referral portal (/api/provider/referrals/*).
//
// Split from provider-api.ts because referrals are a different product
// surface with their own vocabulary, and one file covering the signing
// queue, RTM, MFA, and referrals would be a grab bag. Shares the same
// transport (`providerJson`) so cookie auth and the CSRF double-submit
// header stay in one place.

import { csrfHeader } from "../csrf";
import { ProviderApiError } from "./provider-api";

async function providerJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const { headers: initHeaders, ...rest } = init;
  const res = await fetch(`/api/provider${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? csrfHeader() : {}),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON body
    }
    throw new ProviderApiError(
      res.status,
      body.error ?? "unknown",
      body.message ?? fallbackMessage(res.status),
    );
  }
  return (await res.json()) as T;
}

function fallbackMessage(status: number): string {
  if (status === 401) return "Please sign in again.";
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "Not found.";
  if (status === 409) return "That can't be done right now.";
  if (status >= 500) return "Something went wrong on our side.";
  return "Request failed.";
}

export type ReferralStatus =
  | "draft"
  | "awaiting_fitting"
  | "fitting_complete"
  | "awaiting_signature"
  | "signed"
  | "submitted"
  | "accepted"
  | "in_progress"
  | "dispensed"
  | "declined"
  | "cancelled";

export type EntryPoint = "remote_link" | "in_office" | "kiosk_qr";

export interface ReferralDestination {
  dmeLinkId: string;
  name: string;
  defaultLocationId: string | null;
}

export interface ReferralSummary {
  id: string;
  orgId: string;
  dmeName: string | null;
  status: ReferralStatus;
  patientName: string;
  patientDob: string | null;
  entryPoint: EntryPoint;
  therapyMode: "pap" | "niv";
  fitSessionId: string | null;
  approvedMaskModelId: string | null;
  unreadForProvider: number;
  unreadForDme: number;
  submittedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
  dispensedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralDetail extends ReferralSummary {
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
  fitting: {
    inviteId: string | null;
    sessionId: string | null;
    sentAt: string | null;
    completedAt: string | null;
  };
  approval: {
    maskModelId: string | null;
    variantId: string | null;
    isOverride: boolean;
    note: string | null;
    approvedAt: string | null;
  };
  signature: { requestId: string | null; signedAt: string | null };
  adherenceUpdatesAuthorized: boolean;
  createdByEmail: string | null;
  acceptedByEmail: string | null;
  events: Array<{
    eventType: string;
    actorKind: string;
    actorEmail: string | null;
    detail: unknown;
    occurredAt: string;
  }>;
  messages: Array<{
    id: string;
    authorKind: "provider" | "staff";
    authorEmail: string | null;
    authorName: string | null;
    body: string;
    createdAt: string;
  }>;
  documents: Array<{
    id: string;
    docType: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    uploadedByKind: "provider" | "staff";
    uploadedByEmail: string | null;
    notes: string | null;
    createdAt: string;
  }>;
}

export interface CreateReferralInput {
  dmeLinkId: string;
  routedToLocationId?: string | null;
  entryPoint?: EntryPoint;
  patient: {
    firstName: string;
    lastName: string;
    dob?: string | null;
    email?: string | null;
    phone?: string | null;
    sex?: "female" | "male" | "other" | "unknown" | null;
  };
  insurance?: {
    payerName?: string | null;
    memberId?: string | null;
    groupNumber?: string | null;
  };
  clinical?: {
    therapyMode?: "pap" | "niv";
    prescribedPressureCmH2O?: number | null;
    diagnosisCode?: string | null;
    clinicalNotes?: string | null;
  };
  adherenceUpdatesAuthorized?: boolean;
}

/** What the fitting engine sent back, once the patient has finished. */
export interface ReferralFitting {
  status: "pending" | "complete";
  session: {
    id: string;
    outcome:
      | "high_confidence"
      | "moderate_confidence"
      | "low_confidence"
      | "contraindicated"
      | "outside_validated_range";
    recommendationConfidence: number | null;
    scanQualityGrade: string | null;
    measurementConfidenceBand: string | null;
    primary: {
      maskId?: string;
      maskSlug?: string;
      name?: string;
      manufacturer?: string;
      interfaceType?: string;
      confidence?: number;
      cushion?: { sizeLabel?: string; variantId?: string } | null;
      frame?: { sizeLabel?: string; variantId?: string } | null;
      reasons?: string[];
      cautions?: string[];
    } | null;
    alternatives: Array<{
      maskId?: string;
      maskSlug?: string;
      name?: string;
      manufacturer?: string;
      interfaceType?: string;
      confidence?: number;
      cushion?: { sizeLabel?: string; variantId?: string } | null;
      rankedBelowBecause?: string | null;
    }>;
    excluded: Array<{ maskName?: string; patientReason?: string }>;
    safetyFlags: string[];
    degraded: boolean;
    rulesEngineVersion: string | null;
    formularyName: string | null;
    formularyVersion: number | null;
    completedAt: string | null;
  } | null;
}

export interface FittingSendResult {
  ok: true;
  entryPoint: EntryPoint;
  /**
   * Always returned. In-office and kiosk NEED it — that is how the
   * provider opens the fitter on a room device or renders the QR code —
   * and for a remote link it lets staff read the URL out when automated
   * delivery failed.
   */
  fittingUrl: string;
  delivered: boolean;
  deliveryReason: string | null;
  expiresAt: string;
}

// ── Calls ────────────────────────────────────────────────────────────

export function getReferralDestinations(): Promise<{
  destinations: ReferralDestination[];
}> {
  return providerJson("/referrals/destinations");
}

export function listReferrals(
  status?: ReferralStatus,
): Promise<{ referrals: ReferralSummary[] }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return providerJson(`/referrals${qs}`);
}

export function getReferral(id: string): Promise<ReferralDetail> {
  return providerJson(`/referrals/${encodeURIComponent(id)}`);
}

export function createReferral(
  input: CreateReferralInput,
): Promise<{ id: string; orgId: string; status: ReferralStatus }> {
  return providerJson("/referrals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateReferral(
  id: string,
  patch: Partial<CreateReferralInput>,
): Promise<{ ok: true }> {
  return providerJson(`/referrals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function sendFitting(
  id: string,
  entryPoint: EntryPoint,
  channel?: "email" | "sms",
): Promise<FittingSendResult> {
  return providerJson(`/referrals/${encodeURIComponent(id)}/fitting`, {
    method: "POST",
    body: JSON.stringify({ entryPoint, ...(channel ? { channel } : {}) }),
  });
}

export function getFitting(id: string): Promise<ReferralFitting> {
  return providerJson(`/referrals/${encodeURIComponent(id)}/fitting`);
}

export function approveMask(
  id: string,
  input: { maskModelId: string; variantId?: string | null; note?: string },
): Promise<{ ok: true; isOverride: boolean; mask: string }> {
  return providerJson(`/referrals/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function requestSignature(
  id: string,
): Promise<{ ok: true; signatureRequestId: string; reused: boolean }> {
  return providerJson(`/referrals/${encodeURIComponent(id)}/signature`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function submitReferral(
  id: string,
): Promise<{ ok: true; status: ReferralStatus }> {
  return providerJson(`/referrals/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function cancelReferral(
  id: string,
  reason?: string,
): Promise<{ ok: true }> {
  return providerJson(`/referrals/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function sendReferralMessage(
  id: string,
  body: string,
): Promise<{ ok: true }> {
  return providerJson(`/referrals/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

// ── Display helpers ──────────────────────────────────────────────────

/**
 * How each status reads to a referring provider.
 *
 * Written from THEIR point of view, not the database's: "With the DME" is
 * what `submitted` means to the person who sent it, and it is a more
 * useful thing to read at a glance than the internal token.
 */
export const REFERRAL_STATUS_LABEL: Record<ReferralStatus, string> = {
  draft: "Draft",
  awaiting_fitting: "Waiting on the patient's fitting",
  fitting_complete: "Fitting done — review the recommendation",
  awaiting_signature: "Waiting on your signature",
  signed: "Signed — ready to send",
  submitted: "With the DME",
  accepted: "Accepted by the DME",
  in_progress: "DME is working it",
  dispensed: "Dispensed",
  declined: "Declined by the DME",
  cancelled: "Withdrawn",
};

/** The one thing the provider should do next, or null when it's not their move. */
export function nextAction(referral: ReferralSummary): string | null {
  switch (referral.status) {
    case "draft":
      return "Send the fitting link";
    case "awaiting_fitting":
      return null;
    case "fitting_complete":
      return "Review and approve a mask";
    case "awaiting_signature":
      return "Sign the referral order";
    case "signed":
      return "Send it to the DME";
    default:
      return null;
  }
}
