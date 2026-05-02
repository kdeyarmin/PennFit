// Read helper: surface the most recent PHI attachment sweep audit row
// to the dashboard summary endpoint.
//
// Why a separate module
// ---------------------
// `summary.ts` is a flat handler that runs five COUNT(*) queries for
// the existing KPI tiles. The sweep-status query is a different
// shape: SELECT against `resupply.audit_log` filtered by `action`,
// then a Zod parse over the jsonb metadata. Inlining it would muddy
// the otherwise-uniform handler.
//
// Architecture rules
// ------------------
// Rule 7 (resupply-architecture): use `getDbPool()` from
// `@workspace/resupply-db`, never raw `pg`.
//
// Rule 8: `audit_log` writes must go through
// `@workspace/resupply-audit`. The check script enforces this by
// banning ANY bare `import { auditLog }` from `@workspace/resupply-db`
// outside the helper — even read-only ones — to close two-step alias
// bypasses (`const al = auditLog; .insert(al)`). Read-only callers
// therefore use raw SQL via `pool.query()` instead, exactly as
// `routes/audit/list.ts` does for the audit viewer endpoint. The
// READ itself is allowed; the import is what's banned. See
// `scripts/check-resupply-architecture.sh` Rule 8 + the comment in
// `routes/audit/list.ts` for the full rationale.
//
// Why not a generic "get latest audit row by action" helper in
// `lib/resupply-audit`
// ---------------------------------------------------------------
// One caller today (this dashboard surface). The shape of "latest
// audit row + a typed metadata projection" is also caller-specific
// — every action has a different metadata schema. If a second
// caller appears we'll factor a small `getLatestAuditByAction(action,
// metadataSchema)` helper into the lib then.
//
// PHI hygiene
// -----------
// The sweep audit row by design contains NO object names — only
// counters. We never project metadata fields the worker doesn't
// emit, and the Zod schema is `.strict()` (no passthrough), so even
// a historical row with extra fields gets rejected and we degrade
// to null.
//
// Defensive parse
// ---------------
// If the latest audit row's metadata fails the Zod check (corrupted
// historical row, schema drift, etc.) we degrade to `null` — same
// as "no sweep has ever run". A malformed row should never 500 the
// whole dashboard. The route logs the parse failure at WARN so it's
// visible in operator logs without leaking metadata content.

import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

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
 */
const sweepMetadataSchema = z
  .object({
    objects_scanned: z.number().int().nonnegative(),
    references_loaded: z.number().int().nonnegative(),
    orphans_deleted: z.number().int().nonnegative(),
    // Optional + defaulted to 0 so historical pre-Task#50 audit rows
    // (which predate this counter) still parse cleanly and surface
    // on the dashboard instead of degrading to "no run yet".
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
  /** ISO timestamp of `audit_log.occurred_at` for the most recent row. */
  lastRunAt: string;
  counters: PhiSweepCounters;
}

interface SweepAuditRow {
  occurred_at: Date | string | null;
  metadata: unknown;
}

/**
 * Fetch + project the most recent sweep audit row. Returns null when
 * no row exists OR when the row's metadata fails validation.
 *
 * Implementation note: raw parameterised SQL via the shared pool is
 * the project convention for `audit_log` reads (Rule 8 — see file
 * header). Mirrors `routes/audit/list.ts`.
 */
export async function getLatestPhiSweepStatus(): Promise<PhiSweepStatus | null> {
  const pool = getDbPool();
  const result = await pool.query<SweepAuditRow>(
    `SELECT occurred_at, metadata
       FROM resupply.audit_log
      WHERE action = $1
      ORDER BY occurred_at DESC
      LIMIT 1`,
    [SWEEP_AUDIT_ACTION],
  );

  const row = result.rows[0];
  if (!row) return null;

  const parsed = sweepMetadataSchema.safeParse(row.metadata);
  if (!parsed.success) {
    // Don't log the metadata content — it's counter-only by design,
    // but a corrupted row could contain anything. Keep the log line
    // diagnostic but content-free; SOC can pull the row by id from
    // the audit-log viewer if they need to see what's wrong.
    logger.warn(
      { occurredAt: row.occurred_at },
      "phi-sweep-status: latest audit row metadata failed schema check; surfacing null",
    );
    return null;
  }
  const m = parsed.data;
  // occurred_at is `timestamptz` → comes back as a Date through the
  // pg driver. Coerce to a JS-side ISO string for a stable response
  // shape (matches the spec's `format: date-time`). If the value is
  // missing or unparseable we degrade to null — same defensive
  // posture as a malformed metadata payload (don't 500 the whole
  // dashboard on a single corrupted row).
  const occurredAt = row.occurred_at;
  const dateCandidate =
    occurredAt instanceof Date ? occurredAt : new Date(String(occurredAt ?? ""));
  if (Number.isNaN(dateCandidate.getTime())) {
    logger.warn(
      "phi-sweep-status: latest audit row has missing/invalid occurred_at; surfacing null",
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
