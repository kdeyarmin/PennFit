// Hand-rolled fetch wrapper for /admin/mfa/*.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export interface MfaDevice {
  id: string;
  label: string | null;
  verifiedAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface MfaStatus {
  enrolled: boolean;
  inProgressEnrollment: boolean;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
  /** Unspent backup-code count. 0 when not enrolled. */
  recoveryCodesRemaining: number;
  /** Phase D — admin-side MFA enforcement. "required" gates further
   *  admin nav until the caller enrolls; "off" keeps enrollment
   *  optional. */
  enforcementMode: "off" | "required";
  /** True when enforcement is "required" AND the caller hasn't
   *  enrolled. SPA reads this to force-redirect to /admin/security. */
  mustEnroll: boolean;
  /** Multi-device list (migration 0091). Each row is one enrolled
   *  authenticator the admin has activated. */
  devices: MfaDevice[];
}

export interface VerifyEnrollResponse {
  ok: true;
  enrolled: true;
  /**
   * Display-form recovery codes ("ABCD-EFGH"). Returned ONLY on the
   * first successful verify (enrollment completion); absent on
   * subsequent verifies. The SPA MUST show these to the user
   * exactly once — they're never re-issued through any read API.
   */
  recoveryCodes?: string[];
}

export interface BeginEnrollResponse {
  secretBase32: string;
  otpauthUri: string;
  issuer: string;
  label: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(url, {
    ...restInit,
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const getMfaStatus = () => jsonFetch<MfaStatus>("/admin/mfa/status");

export const beginEnrollMfa = (deviceLabel?: string) =>
  jsonFetch<BeginEnrollResponse>("/admin/mfa/enroll/begin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(deviceLabel ? { deviceLabel } : {}),
  });

export const disableMfaDevice = (deviceId: string, code: string) =>
  jsonFetch<{ ok: true }>(
    `/admin/mfa/devices/${encodeURIComponent(deviceId)}/disable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
  );

export const verifyEnrollMfa = (code: string) =>
  jsonFetch<VerifyEnrollResponse>("/admin/mfa/enroll/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

export const disableMfa = (code: string) =>
  jsonFetch<{ ok: true; enrolled: false }>("/admin/mfa/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

export const regenerateRecoveryCodes = (code: string) =>
  jsonFetch<{ ok: true; recoveryCodes: string[] }>(
    "/admin/mfa/recovery-codes/regenerate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
  );
