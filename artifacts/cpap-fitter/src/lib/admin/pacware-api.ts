// Hand-rolled fetch wrappers for the /admin/pacware/* endpoints.
// Same pattern as integrations-status-api.ts.
//
// PacWare is a legacy DME billing system with no API; this surface is a
// CSV file exchange. The patient-roster import POSTs the whole report
// text (the server parses + validates with the shared
// @workspace/resupply-integrations-pacware package), so the UI stays a
// thin file-picker + preview + commit.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export interface PacwareColumn {
  field: string;
  header: string;
  required: boolean;
  description: string;
  aliases: string[];
}

export interface PacwareReport {
  kind: string;
  direction: "import" | "export" | "both";
  label: string;
  description: string;
  columns: PacwareColumn[];
}

export type PacwareAvailability =
  | { status: "configured"; mode: "file_exchange"; outboxConfigured: boolean }
  | { status: "disabled"; reason: string };

export interface PacwareStatus {
  availability: PacwareAvailability;
  reports: PacwareReport[];
  generatedAt: string;
}

export interface PacwareRowError {
  rowIndex: number;
  field?: string;
  message: string;
}

export interface PacwareImportPreview {
  mode: "preview";
  validCount: number;
  errorCount: number;
  totalDataRows: number;
  unmappedHeaders: string[];
  presentFields: string[];
  errors: PacwareRowError[];
}

export interface PacwareImportCommit {
  mode: "commit";
  created: number;
  updated: number;
  unchanged: number;
  validCount: number;
  errorCount: number;
  totalDataRows: number;
  unmappedHeaders: string[];
  errors: PacwareRowError[];
  batchErrors: string[];
}

export type PacwareSyncTarget = "patients" | "resupply-due";

export interface PacwareSyncPreview {
  target: "patient_roster" | "resupply_due";
  status?: string;
  /** Rows the downloaded CSV will contain. */
  count: number;
  /**
   * resupply_due only: due items withheld from the worklist because the
   * patient has no PacWare account number yet (a blank account line
   * can't be keyed into PacWare order entry). Backfill the id on the
   * patient page, then sync again.
   */
  withheldMissingPacwareId?: number;
  sample: Array<Record<string, string | number | null>>;
}

export interface PacwareSettings {
  autoSync: boolean;
  pending: { resupplyDue: number; patients: number };
  generatedAt: string;
}

/** A mappable patient field, for the "import any CSV" column picker. */
export interface PatientImportFieldInfo {
  field: string;
  header: string;
  required: boolean;
  description: string;
}

/** Response of the header-preview endpoint (column labels only — no PHI). */
export interface PacwareHeaderPreview {
  headers: string[];
  suggestedMapping: Record<string, string>;
  fields: PatientImportFieldInfo[];
}

/** Operator-supplied mapping: canonical field -> the source file's header. */
export type PatientColumnMapping = Record<string, string>;

export const getPacwareStatus = () =>
  jsonFetch<PacwareStatus>("/admin/pacware/status");

/**
 * Read just the header row of an arbitrary CSV and get auto-suggested column
 * mappings + the field catalog. Used to map a roster exported from any system
 * (not just a PacWare export) before importing it.
 */
export const previewPacwarePatientHeaders = (csv: string) =>
  jsonFetch<PacwareHeaderPreview>("/admin/pacware/import/patients/headers", {
    method: "POST",
    body: JSON.stringify({ csv }),
  });

export const importPacwarePatients = (
  csv: string,
  mode: "preview" | "commit",
  columnMapping?: PatientColumnMapping,
) =>
  jsonFetch<PacwareImportPreview | PacwareImportCommit>(
    "/admin/pacware/import/patients",
    {
      method: "POST",
      body: JSON.stringify(
        columnMapping ? { csv, mode, columnMapping } : { csv, mode },
      ),
    },
  );

export const getPacwareSyncPreview = (
  target: PacwareSyncTarget,
  status?: string,
) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return jsonFetch<PacwareSyncPreview>(
    `/admin/pacware/sync/${target}/preview${qs}`,
  );
};

export const getPacwareSettings = () =>
  jsonFetch<PacwareSettings>("/admin/pacware/settings");

export const setPacwareAutoSync = (autoSync: boolean) =>
  jsonFetch<{ autoSync: boolean }>("/admin/pacware/settings", {
    method: "PUT",
    body: JSON.stringify({ autoSync }),
  });

export interface BootstrapPrescriptionsPreview {
  mode: "preview";
  eligiblePatients: number;
  linesPerPatient: number;
  prescriptionsToCreate: number;
  lineSkus: string[];
  onlyPacwarePatients: boolean;
}

export interface BootstrapPrescriptionsCommit {
  mode: "commit";
  eligiblePatients: number;
  patientsBootstrapped: number;
  prescriptionsCreated: number;
  episodesOpened: number;
  episodeOpenFailures: number;
  onlyPacwarePatients: boolean;
}

/** Seed standard consumable Rx lines for patients with none yet. */
export const bootstrapResupplyPrescriptions = (
  mode: "preview" | "commit",
  onlyPacwarePatients = true,
) =>
  jsonFetch<BootstrapPrescriptionsPreview | BootstrapPrescriptionsCommit>(
    "/admin/resupply/bootstrap-prescriptions",
    {
      method: "POST",
      body: JSON.stringify({ mode, onlyPacwarePatients }),
    },
  );
