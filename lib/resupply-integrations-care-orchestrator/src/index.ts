// @workspace/resupply-integrations-care-orchestrator — Philips
// Respironics Care Orchestrator adapter. Same shape as the AirView
// adapter; see ./client.ts for the wire-format mapping.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

import {
  isCareOrchestratorStubMode,
  readCareOrchestratorConfigOrNull,
} from "./config";
import { buildCareOrchestratorStubSnapshot } from "./stub";
import { fetchCareOrchestratorSnapshot } from "./client";

export {
  readCareOrchestratorConfigOrNull,
  isCareOrchestratorStubMode,
} from "./config";
export { buildCareOrchestratorStubSnapshot } from "./stub";
export { fetchCareOrchestratorSnapshot } from "./client";

export function createCareOrchestratorAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  const config = readCareOrchestratorConfigOrNull(env);
  const stub = config === null;
  const stubReason: "no_credentials" | "stub_mode" =
    isCareOrchestratorStubMode(env) ? "stub_mode" : "no_credentials";

  return {
    source: "philips_care",
    availability() {
      if (stub) return { status: "stub", reason: stubReason };
      return { status: "configured" };
    },
    async fetchSnapshot(
      input: FetchSnapshotInput,
    ): Promise<FetchSnapshotResult> {
      if (stub || !config) {
        return {
          ok: true,
          snapshot: buildCareOrchestratorStubSnapshot(
            input.partnerPatientId,
            input.windowDays ?? 30,
          ),
        };
      }
      return fetchCareOrchestratorSnapshot(config, input);
    },
  };
}
