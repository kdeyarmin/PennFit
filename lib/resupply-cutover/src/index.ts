// @workspace/resupply-cutover — the per-tenant cutover workflow for the
// two resupply lifecycle flags (`resupply.due_at_authoritative` and
// `resupply.ship_evidence_required`, migration 0538).
//
// A shared package rather than API-internal code because BOTH the admin
// route and the operator CLI have to reach the same assessment and write
// the same record: an assessment run in a terminal must authorise an
// enable clicked in the console, and the two must not be able to drift
// into disagreeing about what "ready" means.
//
// Depends only on the data layer and the pure domain package. No HTTP,
// no logger, no Express — so it stays importable from a `tsx` script that
// never builds the API.

export {
  CUTOVER_FLAG_KEYS,
  assessDueAtReadiness,
  assessReadiness,
  assessShipEvidenceReadiness,
  readCutoverFlagState,
  type CutoverFlagKey,
  type DueAtReadinessReport,
  type ReadinessBlocker,
  type ReadinessOptions,
  type ReadinessReport,
  type ReadinessStatus,
  type ShipEvidenceReadinessReport,
} from "./readiness";

export {
  READINESS_TTL_DAYS,
  hasFreshReadyAssessment,
  listCutoverRecords,
  readLatestCutoverRecord,
  readLatestCutoverTransition,
  resolveReadinessState,
  writeCutoverRecord,
  type CutoverAction,
  type CutoverReadinessState,
  type CutoverRecord,
  type CutoverRecordInput,
} from "./record";
