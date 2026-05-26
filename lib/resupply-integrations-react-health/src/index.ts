// @workspace/resupply-integrations-react-health — React Health
// (3B Medical iCode Connect) adapter.
//
// Public surface:
//   - createReactHealthAdapter(env?) returns an IntegrationAdapter
//     that calls the partner API when REACT_HEALTH_* env is fully
//     set. When the credentials are absent it reports "unavailable"
//     and serves no data — it never fabricates a snapshot.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

import { readReactHealthConfigOrNull } from "./config";
import { fetchReactHealthSnapshot } from "./client";

export { readReactHealthConfigOrNull } from "./config";
export { fetchReactHealthSnapshot } from "./client";

export function createReactHealthAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  const config = readReactHealthConfigOrNull(env);

  return {
    source: "react_health",
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
      return fetchReactHealthSnapshot(config, input);
    },
  };
}
