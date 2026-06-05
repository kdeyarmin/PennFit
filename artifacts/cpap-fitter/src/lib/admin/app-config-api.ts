// Hand-rolled fetch wrappers for /admin/system/config — backs the
// super-admin System Configuration page. Same pattern as
// feature-flags-api.ts / integrations-status-api.ts.
//
// The server never returns secret plaintext: `hint` is a masked last-4
// for secrets and the actual value for non-secret config. Saving is
// write-only — the UI never reads a secret back.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type AppConfigApplyMode = "live" | "restart";

export interface AppConfigSettingView {
  key: string;
  label: string;
  description: string;
  category: string;
  secret: boolean;
  applyMode: AppConfigApplyMode;
  /** Optional input format hint from the catalog. */
  placeholder: string | null;
  /** Whether an effective value exists (from DB or the environment). */
  configured: boolean;
  /** Where the effective value comes from — DB wins over env. */
  source: "db" | "env" | "unset";
  /** True when the matching env var is also set (may be shadowed by db). */
  envProvided: boolean;
  /** Masked last-4 for secrets; the actual value for non-secret config; null when unset. */
  hint: string | null;
  /** Soft format check: true = matches, false = looks unexpected, null = no rule/unset. */
  formatValid: boolean | null;
  /** Expected-shape hint when a rule exists (e.g. "starts with sk-"). */
  formatHint: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
}

export interface AppConfigCategory {
  category: string;
  settings: AppConfigSettingView[];
}

/** One Twilio webhook URL the operator pastes into the Twilio Console. */
export interface TwilioWebhookEndpoint {
  id: string;
  label: string;
  description: string;
  /** Full absolute URL (public base + fixed route path). */
  url: string;
}

/**
 * Read-only Twilio webhook reference, derived server-side from the
 * editable "Public webhook base URL" (RESUPPLY_VOICE_PUBLIC_BASE_URL).
 */
export interface TwilioWebhooksView {
  /** Resolved public origin, or null when no base URL is configured yet. */
  baseUrl: string | null;
  /** Where the resolved base URL came from. */
  baseUrlSource: "db" | "env" | "railway" | "unset";
  /** The catalog key the operator edits to change the base URL. */
  baseUrlKey: string;
  /** Full webhook URLs (empty when baseUrl is null). */
  endpoints: TwilioWebhookEndpoint[];
}

export interface SystemConfigResponse {
  categories: AppConfigCategory[];
  overlayDisabled: boolean;
  /** Optional for resilience against older API shapes. */
  twilioWebhooks?: TwilioWebhooksView;
}

export interface AppConfigActivity {
  occurredAt: string;
  operatorEmail: string | null;
  key: string;
  label: string;
  category: string;
  action: string;
  hadPrevious: boolean;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(headers ?? {}),
    },
    ...rest,
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

export const getSystemConfig = () =>
  jsonFetch<SystemConfigResponse>("/admin/system/config");

export const getSystemConfigActivity = (limit = 20) =>
  jsonFetch<{ activity: AppConfigActivity[] }>(
    `/admin/system/config/activity?limit=${encodeURIComponent(String(limit))}`,
  );

export const setConfigValue = (key: string, value: string) =>
  jsonFetch<{ setting: AppConfigSettingView }>(
    `/admin/system/config/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );

export const clearConfigValue = (key: string) =>
  jsonFetch<{ setting: AppConfigSettingView; removed: boolean }>(
    `/admin/system/config/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
