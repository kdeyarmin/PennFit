// Decide whether a tenant landing on the dashboard should be sent to the
// guided setup checklist (Pattern E from the domain workflow review —
// onboarding was opt-in and silently skippable).
//
// Kept as a pure function so the (deliberately conservative) policy is unit
// tested: redirect ONLY a brand-new tenant that has done zero required steps
// and hasn't already been redirected this session — so an established or
// mid-setup tenant is never bounced, and nobody is ever trapped in a loop.

import type { TenantSetupResponse } from "@/lib/admin/tenant-setup-api";

export function shouldRedirectToSetup(
  summary: TenantSetupResponse["summary"] | undefined,
  alreadyRedirected: boolean,
): boolean {
  if (!summary) return false; // status not loaded yet
  if (alreadyRedirected) return false; // already nudged this session
  if (summary.allRequiredDone) return false; // established tenant
  return summary.requiredDone === 0; // brand-new: nothing configured yet
}
