// @workspace/resupply-integrations-react-health — React Health
// (3B Medical iCode Connect) adapter.
//
// Public surface:
//   - createReactHealthAdapter(env?) returns an IntegrationAdapter
//     that either calls the partner API (when REACT_HEALTH_* env is
//     fully set and REACT_HEALTH_STUB!=1) or returns deterministic
//     stub data.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

import {
  isReactHealthStubMode,
  readReactHealthConfigOrNull,
} from "./config";
import { buildReactHealthStubSnapshot } from "./stub";
import { fetchReactHealthSnapshot } from "./client";

export {
  readReactHealthConfigOrNull,
  isReactHealthStubMode,
} from "./config";
export { buildReactHealthStubSnapshot } from "./stub";
export { fetchReactHealthSnapshot } from "./client";

export function createReactHealthAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  const config = readReactHealthConfigOrNull(env);
  const stub = config === null;
  const stubReason: "no_credentials" | "stub_mode" = isReactHealthStubMode(env)
    ? "stub_mode"
    : "no_credentials";

  return {
    source: "react_health",
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
          snapshot: buildReactHealthStubSnapshot(
            input.partnerPatientId,
            input.windowDays ?? 30,
          ),
        };
      }
      return fetchReactHealthSnapshot(config, input);
    },
  };
}
