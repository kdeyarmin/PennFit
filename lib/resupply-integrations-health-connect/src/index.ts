// @workspace/resupply-integrations-health-connect — patient-side
// data feed adapter.
//
// Unlike AirView and Care Orchestrator (provider-pull integrations
// against partner clouds), Health Connect is a patient-push surface:
//   - The patient's mobile app reads steps/sleep/heart-rate from
//     Android Health Connect (or another wearable provider) and
//     POSTs a JSON envelope to /resupply-api/health-connect/ingest.
//   - The most recent envelope per (patient, source) is what we
//     surface here. There is no outbound HTTP from this adapter.
//
// The fetchSnapshot interface is satisfied by reading from a small
// in-memory cache populated by the ingest endpoint. In stub mode,
// it returns a fixed sample so the admin UI tab renders end-to-end
// without a paired mobile app.
//
// Why an in-memory cache instead of always going to the DB:
//   - Keeps the adapter package free of pg/db imports (architecture
//     rule: only the API layer talks to Postgres).
//   - The API route is the one that persists snapshots into
//     `patient_integration_snapshots`; this adapter only owns the
//     transient "if we've seen a push since last persist, return
//     it" path. For now stub mode is the only branch wired.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

import { buildHealthConnectStubSnapshot } from "./stub";

export { buildHealthConnectStubSnapshot } from "./stub";
export {
  healthConnectIngestEnvelopeSchema,
  type HealthConnectIngestEnvelope,
} from "./envelope";

export function isHealthConnectStubMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Default to stub: the live path is always patient-push, so
  // "no env => no live data yet" is the correct posture.
  return env.HEALTH_CONNECT_STUB !== "0";
}

export function createHealthConnectAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  const stub = isHealthConnectStubMode(env);
  return {
    source: "health_connect",
    availability() {
      if (stub) {
        return { status: "stub", reason: "stub_mode" };
      }
      // Live mode = "we accept ingest, but no push has arrived for
      // this patient yet." Treated as configured; the route layer
      // returns 'not_found' if no row exists.
      return { status: "configured" };
    },
    async fetchSnapshot(
      input: FetchSnapshotInput,
    ): Promise<FetchSnapshotResult> {
      if (stub) {
        return {
          ok: true,
          snapshot: buildHealthConnectStubSnapshot(
            input.partnerPatientId,
            input.windowDays ?? 30,
          ),
        };
      }
      // Live mode: the API route reads the most recent persisted
      // snapshot directly from the DB. Adapter returns not_found so
      // the route can fall back without throwing.
      return { ok: false, error: "not_found" };
    },
  };
}
