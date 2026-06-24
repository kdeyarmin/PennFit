// Hand-rolled fetch wrappers for the provider e-signature portal data
// + MFA routes (/api/provider/*). Cookie-authenticated (the provider
// session set by /api/provider/auth); state-changing calls carry the
// X-PF-CSRF double-submit header.

import { csrfHeader } from "../csrf";

export class ProviderApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProviderApiError";
    this.status = status;
    this.code = code;
  }
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const { headers: initHeaders, ...rest } = init;
  const res = await fetch(`/api/provider${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      Accept: "application/json",
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
      body.message ?? defaultMessage(res.status),
    );
  }
  return (await res.json()) as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return "Please sign in again.";
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "Not found.";
  if (status === 409) return "That action can't be completed right now.";
  if (status >= 500) return "Something went wrong on our side.";
  return "Request failed.";
}

// ── Identity ──────────────────────────────────────────────────────

export interface ProviderMe {
  account: {
    id: string;
    email: string;
    status: "invited" | "active" | "disabled";
    mfaEnrolled: boolean;
  };
  provider: {
    id: string;
    npi: string | null;
    legalName: string | null;
    practiceName: string | null;
  } | null;
  pendingCount: number;
}

export const getProviderMe = () => jsonFetch<ProviderMe>("/me");

// ── Queue ─────────────────────────────────────────────────────────

export interface QueueItem {
  id: string;
  subjectType: string;
  subjectLabel: string;
  subjectId: string | null;
  title: string;
  patientName: string | null;
  detail: Record<string, unknown>;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  signedAt: string | null;
}

export const getProviderQueue = (status: string) =>
  jsonFetch<{ requests: QueueItem[] }>(
    `/queue?status=${encodeURIComponent(status)}`,
  );

export interface QueueDetail extends QueueItem {
  signerName: string | null;
  declineReason: string | null;
}

export const getProviderQueueItem = (id: string) =>
  jsonFetch<QueueDetail>(`/queue/${encodeURIComponent(id)}`);

/**
 * The ids of the documents that are still awaiting signature — i.e. the
 * ones eligible for the "select all / batch sign" control. Signed/declined
 * rows are excluded (you can't re-sign them). Pure; unit-tested.
 */
export function pendingQueueIds(
  requests: readonly { id: string; status: string }[],
): string[] {
  return requests.filter((r) => r.status === "pending").map((r) => r.id);
}

/**
 * True when every pending document is already selected (and there's at
 * least one) — drives the "Select all" ↔ "Clear selection" toggle label
 * and the header checkbox state.
 */
export function allPendingSelected(
  pendingIds: readonly string[],
  checked: ReadonlySet<string>,
): boolean {
  return pendingIds.length > 0 && pendingIds.every((id) => checked.has(id));
}

export const signProviderDocument = (
  id: string,
  body: {
    consentEsign: true;
    signerName: string;
    signerTitle?: string;
    /** Optional drawn signature (PNG data URL). */
    signatureImage?: string | null;
  },
) =>
  jsonFetch<{ ok: true; status: string; signedAt: string }>(
    `/queue/${encodeURIComponent(id)}/sign`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

/** Sign several selected documents in one submit. Each is still signed
 *  individually server-side (own row update + hash-chain event);
 *  ineligible documents come back in `skipped` with a reason. */
export const signProviderDocumentsBatch = (body: {
  ids: string[];
  consentEsign: true;
  signerName: string;
  signerTitle?: string;
  signatureImage?: string | null;
}) =>
  jsonFetch<{
    ok: true;
    signed: string[];
    skipped: Array<{ id: string; reason: string }>;
  }>("/queue/sign-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const declineProviderDocument = (id: string, reason?: string) =>
  jsonFetch<{ ok: true; status: string }>(
    `/queue/${encodeURIComponent(id)}/decline`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );

// ── RTM (remote therapeutic monitoring) — "my patients" ───────────

/** One row in the provider's patient roster. */
export interface RtmRosterPatient {
  patientId: string;
  patientName: string;
  status: string;
  /** Earliest therapy-night date (therapy start / setup), or null. */
  setupDate: string | null;
  hasData: boolean;
  lastNightDate: string | null;
  /** Whole days since the most recent reported night, or null. */
  staleDays: number | null;
  avgUsageHours: number | null;
  compliantNights: number;
  nightsWithData: number;
  complianceRatePct: number | null;
  /** Coarse CMS compliance flag over the recent window. */
  cmsCompliant: boolean;
}

export const getProviderRtmRoster = (days?: number) =>
  jsonFetch<{ windowDays: number; patients: RtmRosterPatient[] }>(
    `/patients${days ? `?days=${days}` : ""}`,
  );

/**
 * Client-side roster search: case-insensitive substring match on the
 * patient's name. A blank/whitespace query returns the list unchanged.
 * Pure (no `Date`, no fetch) so it's unit-tested directly and reused by
 * the "My patients" page filter box. The roster is already fully loaded
 * (server caps it at 200), so filtering in-memory avoids a round-trip.
 */
export function filterRosterPatients<T extends { patientName: string }>(
  patients: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...patients];
  return patients.filter((p) => p.patientName.toLowerCase().includes(needle));
}

export interface RtmCmsWindow {
  startDate: string;
  endDate: string;
  compliantNights: number;
  ratioPct: number;
  averageUsageHours: number | null;
}

export interface RtmPatientDetail {
  patientId: string;
  patientName: string;
  setupDate: string | null;
  snapshot: {
    hasData: boolean;
    windowDays: number;
    nightsWithData: number;
    windowStartDate: string | null;
    windowEndDate: string | null;
    lastNightDate: string | null;
    staleDays: number | null;
    avgUsageHours: number | null;
    avgAhi: number | null;
    avgLeakLMin: number | null;
    compliantNights: number;
    complianceRatePct: number | null;
  };
  cms: {
    qualifies: boolean;
    horizonComplete: boolean;
    window: RtmCmsWindow | null;
  } | null;
}

export const getProviderRtmPatient = (id: string, days?: number) =>
  jsonFetch<RtmPatientDetail>(
    `/patients/${encodeURIComponent(id)}${days ? `?days=${days}` : ""}`,
  );

/** URL to the patient's adherence attestation PDF — opened directly in a
 *  new tab (the cookie session authenticates the GET). */
export const providerAttestationPdfUrl = (id: string) =>
  `/api/provider/patients/${encodeURIComponent(id)}/attestation.pdf`;

// ── MFA enrollment ────────────────────────────────────────────────

export interface ProviderMfaStatus {
  enrolled: boolean;
  inProgressEnrollment: boolean;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  recoveryCodesRemaining: number;
  mustEnroll: boolean;
}

export const getProviderMfaStatus = () =>
  jsonFetch<ProviderMfaStatus>("/mfa/status");

export interface ProviderMfaBegin {
  secretBase32: string;
  otpauthUri: string;
  issuer: string;
  label: string;
}

export const beginProviderMfa = () =>
  jsonFetch<ProviderMfaBegin>("/mfa/enroll/begin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

export const verifyProviderMfa = (code: string) =>
  jsonFetch<{ ok: true; enrolled: true; recoveryCodes?: string[] }>(
    "/mfa/enroll/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
  );
