// @workspace/resupply-integrations-pacware — file-exchange contract for
// the PacWare HME/DME billing system.
//
// PacWare is a legacy Windows client-server billing package (acquired by
// Brightree) with no network API, so the integration is a CSV file
// exchange: ingest reports exported from PacWare, emit files shaped for
// PacWare's import screens. See docs/integrations/pacware.md.
//
// This package is PURE (only depends on `zod`): no `pg`, no
// @workspace/resupply-db, no vendor SDK, no `node:`-only imports — so it
// imports cleanly into both the API (Node) and the admin SPA (bundler).
// Persistence + audit live in the route layer.

export {
  PACWARE_REPORT_KINDS,
  type PacwareReportKind,
  type PacwareDirection,
  type PacwareColumnSpec,
  type PacwareReportSpec,
  getPacwareReportSpec,
  listPacwareReportSpecs,
  buildHeaderFieldMap,
} from "./reports";

export {
  parseCsv,
  toCsv,
  safeCsvCell,
  normalizeHeader,
  stripCsvFormulaGuard,
  computeShipmentFileHash,
} from "./csv";

export {
  pacwarePatientRowSchema,
  type PacwarePatientRow,
  type PacwareRowError,
  type PacwareParseResult,
  parsePacwarePatientCsv,
  pacwareShipmentRowSchema,
  type PacwareShipmentRow,
  parsePacwareShipmentCsv,
  type PatientColumnMapping,
  type PatientImportFieldInfo,
  type PatientCsvHeaderPreview,
  parsePatientCsvWithMapping,
  patientImportFields,
  previewPatientCsvHeaders,
  normalizeDateToIso,
  normalizePhoneToE164,
} from "./parse";

export {
  type ShipmentMatchStrategy,
  type ShipmentCandidateFulfillment,
  type ShipmentMatchResult,
  type MatchShipmentRowsOptions,
  matchShipmentRows,
} from "./shipment-match";

export {
  SHIPMENT_DISPOSITIONS,
  COMMITTABLE_DISPOSITIONS,
  DEFAULT_MAX_BACKDATE_DAYS,
  type ShipmentDisposition,
  type ClassifiedShipmentRow,
  type ClassifyShipmentRowsInput,
  type ShipmentDispositionCounts,
  classifyShipmentRows,
  countDispositions,
  buildShipmentDispositionCsv,
} from "./shipment-classify";

export {
  type PacwarePatientExportRecord,
  type PacwareResupplyDueRecord,
  buildPacwarePatientCsv,
  buildPacwareResupplyDueCsv,
} from "./export";

export {
  type PacwareConfig,
  type PacwareAvailability,
  readPacwareConfig,
  pacwareAvailability,
} from "./availability";
