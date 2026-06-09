// CSV exporters for the PennFit -> PacWare direction.
//
// Each exporter emits the canonical headers declared in reports.ts (so
// the patient_roster export round-trips with the importer) and runs every
// cell through the formula-injection-safe encoder in csv.ts.
//
// These builders are pure: they take already-shaped records and return a
// string. The route layer owns the DB read + audit; it must keep cell
// values out of the logger (the rows are PHI).

import { toCsv } from "./csv";
import { getPacwareReportSpec, type PacwareReportSpec } from "./reports";

/** Shape the patient_roster exporter accepts (all optional except the id/name). */
export interface PacwarePatientExportRecord {
  pacwareId: string;
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  phoneE164?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  insurancePayer?: string | null;
}

/** Shape the resupply_due exporter accepts. */
export interface PacwareResupplyDueRecord {
  pacwareId: string;
  legalLastName: string;
  legalFirstName: string;
  itemSku: string;
  quantity: number;
  dueDate: string;
  episodeStatus: string;
  insurancePayer?: string | null;
  episodeId: string;
}

/** Build the patient-roster CSV (import-compatible headers). */
export function buildPacwarePatientCsv(
  records: readonly PacwarePatientExportRecord[],
): string {
  return buildFromSpec(
    getPacwareReportSpec("patient_roster"),
    records as readonly unknown[] as readonly Record<string, unknown>[],
  );
}

/** Build the resupply-due CSV for PacWare order entry. */
export function buildPacwareResupplyDueCsv(
  records: readonly PacwareResupplyDueRecord[],
): string {
  return buildFromSpec(
    getPacwareReportSpec("resupply_due"),
    records as readonly unknown[] as readonly Record<string, unknown>[],
  );
}

function buildFromSpec(
  spec: PacwareReportSpec,
  records: readonly Record<string, unknown>[],
): string {
  const header = spec.columns.map((c) => c.header);
  const rows = records.map((rec) =>
    spec.columns.map((c) => rec[c.field] ?? ""),
  );
  return toCsv(header, rows);
}
