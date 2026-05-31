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
import { createHealthConnectAdapter } from "@workspace/resupply-integrations-health-connect";
import { createReactHealthAdapter } from "@workspace/resupply-integrations-react-health";

export function getIntegrationAdapters(
  env: NodeJS.ProcessEnv = process.env,
): Map<IntegrationSource, IntegrationAdapter> {
  const m = new Map<IntegrationSource, IntegrationAdapter>();
  m.set("resmed_airview", createAirviewAdapter(env));
  m.set("philips_care", createCareOrchestratorAdapter(env));
  m.set("health_connect", createHealthConnectAdapter(env));
  m.set("react_health", createReactHealthAdapter(env));
  return m;
}

/**
 * Test-only escape hatch. Adapters are no longer boot-cached, so there is
 * nothing to reset; retained as a no-op for back-compat with existing
 * callers.
 */
export function __resetIntegrationAdaptersForTests(): void {
  // intentionally empty — registry is constructed per call now.
}
