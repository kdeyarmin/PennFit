// Typed fetch wrappers for a tenant's own outbound email From identity
// (/admin/organization/email-settings).
//
// A DME tenant can send patient email from its OWN From address; otherwise
// mail uses the platform default. Backed by organizations.from_email /
// from_name (migration 0360). The GET also returns a live SendGrid
// domain-authentication status so an unauthenticated (spam-bound) sender
// is surfaced before it's used.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

export type DomainAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface DomainAuth {
  status: DomainAuthStatus;
  detail: string;
  matchedDomain?: string;
}

export interface EmailSettings {
  /** The tenant's From address, or null (platform default applies). */
  fromEmail: string | null;
  /** The tenant's From display name, or null. */
  fromName: string | null;
  /** The platform default From address used when fromEmail is null. */
  platformDefaultEmail: string;
  /** The platform default From name used when fromName is null. */
  platformDefaultName: string;
  /** Live SendGrid domain-auth status for the configured fromEmail. */
  domainAuth: DomainAuth;
}

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

async function sendJSON<T>(
  method: "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
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

export const fetchEmailSettings = () =>
  getJSON<EmailSettings>("/admin/organization/email-settings");

/**
 * Set/clear the tenant's From identity. Only the keys you pass change;
 * `null` clears that field back to the platform default. Note: a From NAME
 * alone has no effect — the server only switches off the platform default
 * when a From ADDRESS is set.
 */
export const updateEmailSettings = (patch: {
  fromEmail?: string | null;
  fromName?: string | null;
}) =>
  sendJSON<EmailSettings>("PATCH", "/admin/organization/email-settings", patch);
