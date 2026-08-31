// Adapter contract every vendor package implements. Kept in the
// unified package so the API layer can import a single interface
// type and switch on `source`.

import type { AdapterError } from "./errors";
import type {
  AdapterAvailability,
  IntegrationSnapshot,
  IntegrationSource,
} from "./types";

export interface FetchSnapshotInput {
  /** The vendor-side patient identifier from patient_therapy_links.partner_patient_id. */
  partnerPatientId: string;
  /** Optional bound on how many nights of therapy data to pull (default 30). */
  windowDays?: number;
}

export type FetchSnapshotResult =
  | {
      ok: true;
      snapshot: IntegrationSnapshot;
      /**
       * Sub-resources the vendor did not return, when the primary
       * patient fetch succeeded but a secondary call did not.
       *
       * A snapshot missing its compliance summary because that one
       * endpoint 403'd is NOT the same as a patient with no compliance
       * data, and reporting them identically is how a half-working
       * connector looks healthy for months. Absent or empty means the
       * fetch was complete.
       */
      partial?: Array<{
        resource: "settings" | "compliance" | "nights" | "supplies";
        error: AdapterError;
      }>;
    }
  | { ok: false; error: AdapterError };

// The failure vocabulary lives in ./errors.ts, which also owns the
// class each one belongs to (configuration / transient / no_data) and
// the remedy an operator should read. Re-exported here so the historical
// `import { AdapterError } from "./adapter"` keeps working.
export type { AdapterError } from "./errors";

export interface IntegrationAdapter {
  readonly source: IntegrationSource;
  /** Reports whether the adapter is configured for live calls or stubbed. */
  availability(): AdapterAvailability;
  /** Fetch one patient snapshot. Errors are normalised to AdapterError. */
  fetchSnapshot(input: FetchSnapshotInput): Promise<FetchSnapshotResult>;
}
