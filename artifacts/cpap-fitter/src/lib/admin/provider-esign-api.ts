// Hand-rolled fetch wrapper for /admin/provider-portal/* — the
// employee console for the provider e-signature portal. Same pattern as
// providers-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

const BASE = "/resupply-api/admin/provider-portal";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `${BASE}${path}`;
  const { headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(method !== "GET" ? csrfHeader() : {}),
      ...(headers ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON body
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return jsonFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

// ── Accounts ──────────────────────────────────────────────────────

export interface ProviderAccount {
  id: string;
  providerId: string;
  email: string;
  status: "invited" | "active" | "disabled";
  mfaEnrolled: boolean;
  lastLoginAt: string | null;
  invitedByEmail: string | null;
  createdAt: string;
  providerName: string | null;
  providerNpi: string | null;
  practiceName: string | null;
}

export const listProviderAccounts = () =>
  jsonFetch<{ accounts: ProviderAccount[] }>("/accounts");

export const inviteProviderAccount = (body: {
  providerId: string;
  email?: string;
}) =>
  post<{ ok: true; email: string; emailSent: boolean; inviteLink: string }>(
    "/accounts/invite",
    body,
  );

export const disableProviderAccount = (id: string) =>
  post<{ ok: true }>(`/accounts/${encodeURIComponent(id)}/disable`);

export const enableProviderAccount = (id: string) =>
  post<{ ok: true; status: string }>(
    `/accounts/${encodeURIComponent(id)}/enable`,
  );

// ── Signature requests ────────────────────────────────────────────

export type SubjectType =
  | "prescription"
  | "prescription_packet"
  | "order"
  | "claim"
  | "cmn"
  | "dwo"
  | "swo"
  | "document";

export interface SignatureRequest {
  id: string;
  providerId: string;
  providerName: string | null;
  providerNpi: string | null;
  subjectType: SubjectType;
  subjectId: string | null;
  title: string;
  patientName: string | null;
  status: "pending" | "signed" | "declined" | "void" | "expired";
  createdAt: string;
  signedAt: string | null;
  expiresAt: string | null;
  readyToPrintAt: string | null;
  returnedSignedAt: string | null;
  attachedToChartAt: string | null;
  releasedAt: string | null;
  releaseKind: "claim" | "item" | null;
}

export const listSignatureRequests = (params: {
  status?: string;
  providerId?: string;
}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.providerId) qs.set("providerId", params.providerId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return jsonFetch<{ requests: SignatureRequest[] }>(
    `/signature-requests${suffix}`,
  );
};

export const createSignatureRequest = (body: {
  providerId: string;
  subjectType: SubjectType;
  subjectId?: string;
  title: string;
  patientId?: string;
  patientName?: string;
  detail?: Record<string, unknown>;
  expiresAt?: string;
}) => post<{ ok: true; id: string }>("/signature-requests", body);

export const voidSignatureRequest = (id: string) =>
  post<{ ok: true }>(`/signature-requests/${encodeURIComponent(id)}/void`);

export const markReadyToPrint = (id: string) =>
  post<{ ok: true }>(
    `/signature-requests/${encodeURIComponent(id)}/ready-to-print`,
  );

export const markReturnedSigned = (id: string) =>
  post<{ ok: true }>(
    `/signature-requests/${encodeURIComponent(id)}/returned-signed`,
  );

export const markAttachedToChart = (id: string) =>
  post<{ ok: true }>(
    `/signature-requests/${encodeURIComponent(id)}/attach-to-chart`,
  );

export const releaseSignatureRequest = (
  id: string,
  body: { releaseKind: "claim" | "item"; note?: string },
) =>
  post<{ ok: true }>(
    `/signature-requests/${encodeURIComponent(id)}/release`,
    body,
  );

export const remindSignatureRequest = (id: string) =>
  post<{ ok: true; emailSent: boolean }>(
    `/signature-requests/${encodeURIComponent(id)}/remind`,
  );

/** Direct URLs for the streamed PDFs (open in a new tab). */
export const certificatePdfUrl = (id: string) =>
  `${BASE}/signature-requests/${encodeURIComponent(id)}/certificate.pdf`;
export const providerSignatureLogUrl = (providerId: string) =>
  `${BASE}/providers/${encodeURIComponent(providerId)}/signature-log.pdf`;
