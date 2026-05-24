// Read helper: surface the most recent PHI attachment sweep audit row
// to the dashboard summary endpoint.
//
// Status: dead reader. The `resupply.audit_log` table was dropped
// with the wider audit-chain cleanup, so there is no longer any
// "latest sweep audit row" to fetch. The worker's
// `prescription-attachment-sweep` job still runs, but its summary
// no longer lands anywhere queryable. The helper still exists for
// wire compatibility (the dashboard summary response keeps the
// `prescriptionAttachmentSweep` field), but it now short-circuits
// to `null` without issuing a query. If/when a replacement event
// log is introduced for sweep summaries, swap the read path back
// in here.
//
// PHI hygiene: by design, sweep audit rows only ever held
// counters — no object names or patient identifiers — so removing
// the read path does not change the PHI posture of the dashboard.

import { z } from "zod";

/** Action string the worker writes for a sweep summary row. Must
 *  stay in lockstep with the `logAudit({ action: ... })` call in
 *  `artifacts/resupply-api/src/worker/jobs/prescription-attachment-sweep.ts`
 *  (note: distinct from `SWEEP_JOB` in that file, which is the
 *  pg-boss queue name and uses the plural `prescriptions.`). */
export const SWEEP_AUDIT_ACTION = "prescription.attachment.sweep";

/**
 * Snake_case worker counters → camelCase API field names. Source-of-
 * truth for field meanings is the `Counters semantics` block in the
 * worker file.
 *
 * Kept exported so callers (and historical tests) can still reference
 * the canonical schema shape even though the read path is dormant.
 */
export const sweepMetadataSchema = z
  .object({
    objects_scanned: z.number().int().nonnegative(),
    references_loaded: z.number().int().nonnegative(),
    orphans_deleted: z.number().int().nonnegative(),
    bytes_reclaimed: z.number().int().nonnegative().optional().default(0),
    orphans_too_young: z.number().int().nonnegative(),
    orphans_no_time_created: z.number().int().nonnegative(),
    delete_errors: z.number().int().nonnegative(),
    delete_404_idempotent: z.number().int().nonnegative(),
    recheck_saved: z.number().int().nonnegative(),
    non_attachment_skipped: z.number().int().nonnegative(),
  })
  .strict();

/** Public response shape (camelCase). Mirrors the OpenAPI
 *  `PhiSweepCounters` schema. */
export interface PhiSweepCounters {
  objectsScanned: number;
  referencesLoaded: number;
  orphansDeleted: number;
  /** Sum of GCS-reported byte sizes for objects deleted this run. */
  bytesReclaimed: number;
  orphansTooYoung: number;
  orphansNoTimeCreated: number;
  deleteErrors: number;
  delete404Idempotent: number;
  recheckSaved: number;
  nonAttachmentSkipped: number;
}

export interface PhiSweepStatus {
  /** ISO timestamp of the most recent sweep summary. */
  lastRunAt: string;
  counters: PhiSweepCounters;
}

/**
 * Returns the latest sweep status, or `null` when no status is
 * available.
 *
 * Current implementation: always returns `null`. The historical
 * source (`resupply.audit_log`) was dropped; until a replacement
 * event log is wired in, callers must treat `null` as "no longer
 * tracked". The dashboard already renders the `null` case as a
 * neutral "no recent sweep" state, so no UI change is required.
 */
export async function getLatestPhiSweepStatus(): Promise<PhiSweepStatus | null> {
  return null;
}
