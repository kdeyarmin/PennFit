// Hand-rolled fetch wrappers for /admin/feature-flags — backs the
// admin Control Center.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  category: string;
  /**
   * Whether the API build serving this response can actually toggle the
   * flag. The PATCH route validates the key against a compile-time
   * allow-list, so a flag seeded by a newer migration than the running
   * build LISTS here but 404s (`unknown_flag`) on toggle. The server
   * computes this; the Control Center disables the switch and explains
   * when it's false. Optional on the wire so an older API (mid-deploy)
   * that omits the field is treated as manageable — the historical
   * default, where every listed flag was assumed toggleable.
   */
  manageable?: boolean;
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
//   * storefront.checkout — RETIRED patient cash-pay flag. Kept in the
//     high-risk list so an accidental enable still requires typing the
//     key; enabling it does not restore a charge path.
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

// One change a preset would make (or made) to a flag's enabled state.
export interface PresetChange {
  key: string;
  from: boolean;
  to: boolean;
}

export interface ApplyPresetResult {
  // The billing plan whose recommended bundle was applied / previewed.
  planCode: string;
  dryRun: boolean;
  // Manageable flags considered, and how many the preset would enable.
  total: number;
  enabledCount: number;
  // The flags whose state differs from the recommended bundle.
  changes: PresetChange[];
}

/**
 * Apply (or, with `dryRun`, preview) the recommended feature-flag bundle for
 * the tenant's current billing plan. The dry run returns the exact diff so
 * the UI can confirm before writing. A tenant with no active plan gets a 409
 * `no_plan_preset` (surfaced by the caller as "pick a plan first").
 */
export const applyFeatureFlagPreset = (dryRun: boolean) =>
  jsonFetch<ApplyPresetResult>("/admin/feature-flags/apply-preset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
