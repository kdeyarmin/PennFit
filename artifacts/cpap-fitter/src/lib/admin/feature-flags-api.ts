// Hand-rolled fetch wrappers for /admin/feature-flags — backs the
// admin Control Center.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  category: string;
  updatedByEmail: string | null;
  updatedAt: string;
}

// Flags whose disable has immediate revenue / clinical impact. The
// Control Center wraps the toggle in a "type the flag key to
// confirm" modal when an admin tries to disable one of these.
// Re-enabling (off → on) never needs a confirmation — the worst
// case there is "feature unexpectedly resumes", which is the
// recoverable direction.
//
// Categories used by the confirmation flow:
//   * storefront.checkout — blocks every NEW cash-pay order. Existing
//     carts persist; in-flight checkouts that already redirected to
//     Stripe still complete. But a flipped switch means zero new
//     revenue from the storefront until it's flipped back.
//   * voice.agent — hangs up every inbound voice call with a 503
//     TwiML response. Patients who depend on the voice agent for
//     after-hours triage lose that channel entirely.
//
// Adding a flag here is an editorial decision, not a security one —
// the confirmation modal is a UX guardrail, not an authorization
// gate (the existing `admin.tools.manage` permission still applies).
export const HIGH_RISK_FLAG_KEYS: readonly string[] = [
  "storefront.checkout",
  "voice.agent",
] as const;

export function isHighRiskFlag(key: string): boolean {
  return HIGH_RISK_FLAG_KEYS.includes(key);
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

export interface FeatureFlagActivity {
  occurredAt: string;
  operatorEmail: string | null;
  key: string;
  from: boolean;
  to: boolean;
}

export const listFeatureFlags = () =>
  jsonFetch<{ flags: FeatureFlag[] }>("/admin/feature-flags");

export const listFeatureFlagActivity = (limit = 20) =>
  jsonFetch<{ activity: FeatureFlagActivity[] }>(
    `/admin/feature-flags/activity?limit=${encodeURIComponent(String(limit))}`,
  );

export const toggleFeatureFlag = (key: string, enabled: boolean) =>
  jsonFetch<{ flag: FeatureFlag }>(
    `/admin/feature-flags/${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
