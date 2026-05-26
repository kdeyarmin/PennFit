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
// Health Connect is always available to accept ingests. The
// fetchSnapshot interface always returns `not_found`: the API route
// reads the most recent persisted snapshot directly from the DB
// (this adapter is kept free of pg/db imports per the architecture
// rule), so the route falls back to its own read without throwing.
// The adapter never fabricates data.

import type {
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationAdapter,
} from "@workspace/resupply-integrations";

export {
  healthConnectIngestEnvelopeSchema,
  type HealthConnectIngestEnvelope,
} from "./envelope";

export function createHealthConnectAdapter(
  _env: NodeJS.ProcessEnv = process.env,
): IntegrationAdapter {
  return {
    source: "health_connect",
    availability() {
      // We accept patient-push ingest at all times; the route layer
      // returns 'not_found' when no push has arrived for a patient.
      return { status: "configured" };
    },
    async fetchSnapshot(
      _input: FetchSnapshotInput,
    ): Promise<FetchSnapshotResult> {
      // The API route reads the most recent persisted snapshot
      // directly from the DB. Returning not_found lets it fall back
      // without throwing.
      return { ok: false, error: "not_found" };
    },
  };
}
