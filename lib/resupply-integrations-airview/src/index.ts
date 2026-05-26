// @workspace/resupply-integrations-airview — ResMed AirView adapter.
//
// Public surface:
//   - createAirviewAdapter(env?) returns an IntegrationAdapter that
//     calls the partner API when AIRVIEW_* env is fully set. When the
//     credentials are absent it reports "unavailable" and serves no
//     data — it never fabricates a snapshot.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

import { readAirviewConfigOrNull } from "./config";
import { fetchAirviewSnapshot } from "./client";

export { readAirviewConfigOrNull } from "./config";
export { fetchAirviewSnapshot } from "./client";

export function createAirviewAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  const config = readAirviewConfigOrNull(env);

  return {
    source: "resmed_airview",
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
      return fetchAirviewSnapshot(config, input);
    },
  };
}
