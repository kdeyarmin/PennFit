// Single place where the API process composes the vendor adapters into
// a registry the route layer + nightly sync iterate.
//
// Built FRESH on each call (no boot cache). The therapy adapters capture
// their config in the factory closure (createXAdapter reads the env it's
// handed once), so a boot-cached Map would freeze credentials at process
// start — a partner credential added or rotated afterward would be
// ignored until a restart, silently contradicting the documented
// "rotation honoured without a restart" invariant (CLAUDE.md → Integrations
// layer). Reconstructing per call reads the current process.env so
// rotation takes effect immediately.
//
// This is cheap and does NOT defeat the OAuth-token cache: the vendor
// clients memoise tokens at MODULE scope keyed by a config fingerprint
// (see e.g. resupply-integrations-airview/src/client.ts `cachedToken`),
// so re-creating the lightweight adapter object reuses the live token —
// and a rotated credential correctly yields a new fingerprint → new token.

import {
  type IntegrationAdapter,
  type IntegrationSource,
} from "@workspace/resupply-integrations";
import { createAirviewAdapter } from "@workspace/resupply-integrations-airview";
import { createCareOrchestratorAdapter } from "@workspace/resupply-integrations-care-orchestrator";
import { createReactHealthAdapter } from "@workspace/resupply-integrations-react-health";

import { getEffectiveEnv } from "../app-config/store";

export function getIntegrationAdapters(
  env: NodeJS.ProcessEnv = process.env,
): Map<IntegrationSource, IntegrationAdapter> {
  const m = new Map<IntegrationSource, IntegrationAdapter>();
  m.set("resmed_airview", createAirviewAdapter(env));
  m.set("philips_care", createCareOrchestratorAdapter(env));
  m.set("react_health", createReactHealthAdapter(env));
  return m;
}

/**
 * Same as getIntegrationAdapters, but first overlays any super-admin
 * System Configuration values (resupply.app_config) on top of
 * process.env via getEffectiveEnv(). This is what makes therapy-cloud
 * credentials entered in /admin/system/configuration take effect LIVE:
 * the registry is rebuilt per call, so the next sync/refresh sees the
 * rotated credential without a restart. Fail-soft — if the overlay
 * can't be read, getEffectiveEnv returns process.env unchanged and the
 * adapters build exactly as before.
 *
 * Prefer this in async contexts (route handlers, the nightly sync job).
 * The synchronous getIntegrationAdapters(env) above stays for callers
 * that already hold an env and for unit tests.
 */
export async function getIntegrationAdaptersWithDbOverrides(): Promise<
  Map<IntegrationSource, IntegrationAdapter>
> {
  const env = await getEffectiveEnv();
  return getIntegrationAdapters(env);
}

/**
 * Test-only escape hatch. Adapters are no longer boot-cached, so there is
 * nothing to reset; retained as a no-op for back-compat with existing
 * callers.
 */
export function __resetIntegrationAdaptersForTests(): void {
  // intentionally empty — registry is constructed per call now.
}
