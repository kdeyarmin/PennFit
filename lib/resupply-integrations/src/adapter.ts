// Adapter contract every vendor package implements. Kept in the
// unified package so the API layer can import a single interface
// type and switch on `source`.

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
  | { ok: true; snapshot: IntegrationSnapshot }
  | { ok: false; error: AdapterError };

export type AdapterError =
  | "auth_failed"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "unknown_error";

export interface IntegrationAdapter {
  readonly source: IntegrationSource;
  /** Reports whether the adapter is configured for live calls or stubbed. */
  availability(): AdapterAvailability;
  /** Fetch one patient snapshot. Errors are normalised to AdapterError. */
  fetchSnapshot(input: FetchSnapshotInput): Promise<FetchSnapshotResult>;
}
