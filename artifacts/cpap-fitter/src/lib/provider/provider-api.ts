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

export const signProviderDocument = (
  id: string,
  body: { consentEsign: true; signerName: string; signerTitle?: string },
) =>
  jsonFetch<{ ok: true; status: string; signedAt: string }>(
    `/queue/${encodeURIComponent(id)}/sign`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const declineProviderDocument = (id: string, reason?: string) =>
  jsonFetch<{ ok: true; status: string }>(
    `/queue/${encodeURIComponent(id)}/decline`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );

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
