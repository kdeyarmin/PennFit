// Hand-rolled fetch wrappers for the per-patient alert-message
// overrides admin endpoints. Patient-keyed sister to
// message-template-overrides-api.ts.

import { csrfHeader } from "../csrf";

export type AlertChannel = "email" | "sms" | "voice";

export interface AlertMessageOverride {
  id: string;
  patientId: string;
  alertKey: string;
  channel: AlertChannel;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** Error carrying the API's disallowed/allowed token lists for a
 *  variable-allowlist rejection, so the UI can render them inline. */
export class AlertOverrideError extends Error {
  readonly status: number;
  readonly disallowed?: string[];
  readonly allowed?: string[];
  constructor(
    message: string,
    status: number,
    disallowed?: string[],
    allowed?: string[],
  ) {
    super(message);
    this.name = "AlertOverrideError";
    this.status = status;
    this.disallowed = disallowed;
    this.allowed = allowed;
  }
}

function base(patientId: string): string {
  return `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/alert-message-overrides`;
}

async function readError(res: Response): Promise<never> {
  const json = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    offending?: string[];
    allowed?: string[];
  } | null;
  throw new AlertOverrideError(
    json?.message ?? json?.error ?? `Request failed (${res.status})`,
    res.status,
    json?.offending,
    json?.allowed,
  );
}

export async function listAlertOverrides(
  patientId: string,
): Promise<{ overrides: AlertMessageOverride[] }> {
  const res = await fetch(base(patientId), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { overrides: AlertMessageOverride[] };
}

export interface CreateAlertOverrideBody {
  alertKey: string;
  channel: AlertChannel;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  isActive?: boolean;
  note: string;
}

export async function createAlertOverride(
  patientId: string,
  body: CreateAlertOverrideBody,
): Promise<{ override: AlertMessageOverride }> {
  const res = await fetch(base(patientId), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { override: AlertMessageOverride };
}

export interface PatchAlertOverrideBody {
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  isActive?: boolean;
  note?: string;
}

export async function patchAlertOverride(
  patientId: string,
  id: string,
  body: PatchAlertOverrideBody,
): Promise<{ override: AlertMessageOverride }> {
  const res = await fetch(`${base(patientId)}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { override: AlertMessageOverride };
}

export async function deactivateAlertOverride(
  patientId: string,
  id: string,
): Promise<{ override: AlertMessageOverride }> {
  const res = await fetch(`${base(patientId)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { override: AlertMessageOverride };
}
