// @workspace/resupply-integrations-care-orchestrator — Philips
// Respironics Care Orchestrator adapter. Same shape as the AirView
// adapter; see ./client.ts for the wire-format mapping.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

import { readCareOrchestratorConfigOrNull } from "./config";
import { fetchCareOrchestratorSnapshot } from "./client";

export { readCareOrchestratorConfigOrNull } from "./config";
export { fetchCareOrchestratorSnapshot } from "./client";

export function createCareOrchestratorAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  const config = readCareOrchestratorConfigOrNull(env);

  return {
    source: "philips_care",
    availability() {
      if (!config) {
        return { status: "unavailable", reason: "not_configured" };
      }
      return { status: "configured" };
    },
    async fetchSnapshot(
      input: FetchSnapshotInput,
    ): Promise<FetchSnapshotResult> {
      if (!config) {
        return { ok: false, error: "unavailable" };
      }
      return fetchCareOrchestratorSnapshot(config, input);
    },
  };
}
