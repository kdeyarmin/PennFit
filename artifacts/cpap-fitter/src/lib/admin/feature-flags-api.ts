// Hand-rolled fetch wrappers for /admin/feature-flags — backs the
// admin Control Center.

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
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
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

export const listFeatureFlags = () =>
  jsonFetch<{ flags: FeatureFlag[] }>("/admin/feature-flags");

export const toggleFeatureFlag = (key: string, enabled: boolean) =>
  jsonFetch<{ flag: FeatureFlag }>(
    `/admin/feature-flags/${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
