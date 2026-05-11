// Hand-rolled fetch wrapper for /admin/mfa/*.

export interface MfaStatus {
  enrolled: boolean;
  inProgressEnrollment: boolean;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
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
  jsonFetch<{ ok: true; enrolled: true }>("/admin/mfa/enroll/verify", {
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
