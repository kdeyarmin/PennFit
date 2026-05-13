// Single place where the API process composes the three vendor
// adapters into a registry the route layer can iterate. Read at
// boot but the underlying adapter modules read env at *call* time,
// so a credential rotation between requests is honoured without a
// restart.
//
// Why a module-level cache (vs. constructing per-request):
//   The vendor clients memoise OAuth tokens internally. Re-creating
//   the adapter on every request would defeat that cache and burn
//   a token round-trip per refresh click.

import {
  type IntegrationAdapter,
  type IntegrationSource,
} from "@workspace/resupply-integrations";
import { createAirviewAdapter } from "@workspace/resupply-integrations-airview";
import { createCareOrchestratorAdapter } from "@workspace/resupply-integrations-care-orchestrator";
import { createHealthConnectAdapter } from "@workspace/resupply-integrations-health-connect";
import { createReactHealthAdapter } from "@workspace/resupply-integrations-react-health";

let cached: Map<IntegrationSource, IntegrationAdapter> | null = null;

export function getIntegrationAdapters(
  env: NodeJS.ProcessEnv = process.env,
): Map<IntegrationSource, IntegrationAdapter> {
  if (cached) return cached;
  const m = new Map<IntegrationSource, IntegrationAdapter>();
  m.set("resmed_airview", createAirviewAdapter(env));
  m.set("philips_care", createCareOrchestratorAdapter(env));
  m.set("health_connect", createHealthConnectAdapter(env));
  m.set("react_health", createReactHealthAdapter(env));
  cached = m;
  return m;
}

/** Test-only escape hatch to clear the cache between cases. */
export function __resetIntegrationAdaptersForTests(): void {
  cached = null;
}
