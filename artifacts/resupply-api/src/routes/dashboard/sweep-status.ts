// Read helper: surface the most recent PHI attachment sweep run to
// the dashboard summary endpoint.
//
// Why a separate module
// ---------------------
// `summary.ts` is a flat handler that runs five COUNT(*) queries for
// the existing KPI tiles. The sweep-status query is a different
// shape: SELECT against `resupply.worker_run_summary` filtered by
// `worker_kind`, then a Zod parse over the jsonb counters. Inlining
// it would muddy the otherwise-uniform handler.
//
// Source history
// --------------
// This read used to hit `resupply.audit_log` filtered by
// `action='prescription.attachment.sweep'`. Migration 0156 retired
// the HIPAA tamper-evident chain and `@workspace/resupply-audit`
// became a no-op stub, so new sweep runs stopped landing audit rows
// and the dashboard tile went stale (then was disabled to a hard
// `null` to avoid a false signal). Migration 0162 introduced
// `resupply.worker_run_summary` as the durable replacement: the
// sweep worker writes one row per run, and this reader hits the
// newest row for `worker_kind='prescription_attachment_sweep'`.
//
// PHI hygiene
// -----------
// The sweep summary row by design contains NO object names — only
// counters. We never project counter fields the worker doesn't
// emit, and the Zod schema is `.strict()` (no passthrough), so even
// a historical row with extra fields gets rejected and we degrade
// to null.
//
// Defensive parse
// ---------------
// If the latest row's counters fail the Zod check (corrupted
// historical row, schema drift, etc.) we degrade to `null` — same
// as "no sweep has ever run". A malformed row should never 500 the
// whole dashboard. The route logs the parse failure at WARN so it's
// visible in operator logs without leaking counter content.

import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

/** Action string the worker writes for the legacy (no-op) audit row.
 *  Kept exported so historical SOC tooling / tests can still
 *  reference the canonical action name even though the live read
 *  path now hits `worker_run_summary` (see `SWEEP_WORKER_KIND`). */
export const SWEEP_AUDIT_ACTION = "prescription.attachment.sweep";

/** Worker-kind key written to `worker_run_summary` by the sweep job.
 *  Must stay in lockstep with the INSERT in
 *  `artifacts/resupply-api/src/worker/jobs/prescription-attachment-sweep.ts`. */
export const SWEEP_WORKER_KIND = "prescription_attachment_sweep";

/**
 * Snake_case worker counters → camelCase API field names. Source-of-
 * truth for field meanings is the `Counters semantics` block in the
 * worker file.
 *
 * Kept exported so callers (and historical tests) can still reference
 * the canonical schema shape.
 */
export const sweepMetadataSchema = z
  .object({
    objects_scanned: z.number().int().nonnegative(),
    references_loaded: z.number().int().nonnegative(),
    orphans_deleted: z.number().int().nonnegative(),
    // Optional + defaulted to 0 so historical rows that predate this
    // counter still parse cleanly and surface on the dashboard
    // instead of degrading to "no run yet".
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
 * Fetch + project the most recent sweep run. Returns null when no
 * row exists OR when the counters payload fails validation.
 *
 * Implementation note: read goes through the Supabase JS client
 * against `resupply.worker_run_summary` (see Source history above).
 */
export async function getLatestPhiSweepStatus(): Promise<PhiSweepStatus | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("worker_run_summary")
    .select("completed_at, counters")
    .eq("worker_kind", SWEEP_WORKER_KIND)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn({ err: error }, "phi-sweep-status: query failed; surfacing null");
    return null;
  }
  if (!row) return null;

  const parsed = sweepMetadataSchema.safeParse(row.counters);
  if (!parsed.success) {
    // Don't log the counters content — it's counter-only by design,
    // but a corrupted row could contain anything. Keep the log line
    // diagnostic but content-free; SOC can pull the row by id from
    // worker_run_summary if they need to see what's wrong.
    logger.warn(
      { completedAt: row.completed_at },
      "phi-sweep-status: latest worker_run_summary counters failed schema check; surfacing null",
    );
    return null;
  }
  const m = parsed.data;
  // completed_at comes back from PostgREST as an ISO string. If the
  // value is missing or unparseable we degrade to null — same
  // defensive posture as a malformed counters payload (don't 500 the
  // whole dashboard on a single corrupted row).
  const dateCandidate = new Date(row.completed_at ?? "");
  if (Number.isNaN(dateCandidate.getTime())) {
    logger.warn(
      "phi-sweep-status: latest row has missing/invalid completed_at; surfacing null",
    );
    return null;
  }
  const lastRunAt = dateCandidate.toISOString();
  return {
    lastRunAt,
    counters: {
      objectsScanned: m.objects_scanned,
      referencesLoaded: m.references_loaded,
      orphansDeleted: m.orphans_deleted,
      bytesReclaimed: m.bytes_reclaimed,
      orphansTooYoung: m.orphans_too_young,
      orphansNoTimeCreated: m.orphans_no_time_created,
      deleteErrors: m.delete_errors,
      delete404Idempotent: m.delete_404_idempotent,
      recheckSaved: m.recheck_saved,
      nonAttachmentSkipped: m.non_attachment_skipped,
    },
  };
}
