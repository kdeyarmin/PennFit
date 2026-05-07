// @workspace/resupply-integrations-airview — ResMed AirView adapter.
//
// Public surface:
//   - createAirviewAdapter(env?) returns an IntegrationAdapter that
//     either calls the partner API (when AIRVIEW_* env is fully set
//     and AIRVIEW_STUB!=1) or returns deterministic stub data.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

import { isAirviewStubMode, readAirviewConfigOrNull } from "./config";
import { buildAirviewStubSnapshot } from "./stub";
import { fetchAirviewSnapshot } from "./client";

export { readAirviewConfigOrNull, isAirviewStubMode } from "./config";
export { buildAirviewStubSnapshot } from "./stub";
export { fetchAirviewSnapshot } from "./client";

export function createAirviewAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  const config = readAirviewConfigOrNull(env);
  const stub = config === null;
  const stubReason: "no_credentials" | "stub_mode" = isAirviewStubMode(env)
    ? "stub_mode"
    : "no_credentials";

  return {
    source: "resmed_airview",
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
          snapshot: buildAirviewStubSnapshot(
            input.partnerPatientId,
            input.windowDays ?? 30,
          ),
        };
      }
      return fetchAirviewSnapshot(config, input);
    },
  };
}
