// Hand-rolled fetch wrapper for /admin/mfa/*.

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

export const getMfaStatus = () => jsonFetch<MfaStatus>("/admin/mfa/status");

export const beginEnrollMfa = () =>
  jsonFetch<BeginEnrollResponse>("/admin/mfa/enroll/begin", {
    method: "POST",
  });

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
