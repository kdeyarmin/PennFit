// pg-boss job: nightly sweep that FLAGS patient_documents rows
// whose retention horizon has passed (and that aren't on legal
// hold). The actual byte destruction is human-triggered via
// /admin/patient-documents/:id/destroy — surveyors and counsel
// both want a human step in the destruction path.
//
// Why this exists:
//   HIPAA Privacy Rule §164.530(j)(2) sets a 6-year minimum
//   retention for documents covered by the standard. PennFit
//   never destroyed patient documents automatically; the table
//   grew until manually pruned. Surveyors flag the absence of a
//   documented retention process as a Tier-2 deficiency.
//
// What this job does:
//   1. Backfill: for rows with retention_until_at IS NULL, compute
//      the horizon from document_type + created_at and write it.
//      This is a one-shot for legacy rows; new rows get the column
//      populated at upload time (separate route change).
//   2. Flag: for rows where retention_until_at <= now() AND
//      retention_marked_at IS NULL AND legal_hold = false AND
//      destroyed_at IS NULL, stamp retention_marked_at = now().
//
//   The flagged rows show up in /admin/patient-documents/retention
//   for a CSR/compliance officer to review and either toggle legal
//   hold or trigger destruction.
//
// Safety:
//   Legal-hold rows are NEVER touched, even for the backfill — we
//   refuse to retroactively pin a retention horizon on a row that
//   counsel has flagged. Destroyed rows are also skipped (no
//   point re-marking).
//
// Scheduling: 03:11 UTC (off-peak; well after the idempotency
// prune at 02:07 and before the smart-trigger evaluator at 03:23).

import type PgBoss from "pg-boss";

import { logAuditBestEffort } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { computeRetentionUntilAt } from "../../lib/patient-documents/retention";

const SWEEP_JOB = "patient-documents.retention-sweep";
const SWEEP_CRON = "11 3 * * *";
const BACKFILL_BATCH_SIZE = 500;

interface SweepStats {
  backfilled: number;
  flagged: number;
}

/** Exported for test injection. Runs one sweep cycle and returns
 *  the counts so a test can assert behavior without scheduling. */
export async function runRetentionSweep(): Promise<SweepStats> {
  const supabase = getSupabaseServiceRoleClient();

  // ── 1. Backfill retention_until_at for legacy rows ──────────────
  // We process in batches so a deploy on a 100k-row table doesn't
  // hold a transaction open for minutes. Each iteration handles
  // BACKFILL_BATCH_SIZE rows; we stop when the page returns empty.
  let backfilled = 0;
  while (true) {
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, document_type, created_at")
      .is("retention_until_at", null)
      .eq("legal_hold", false)
      .is("destroyed_at", null)
      .limit(BACKFILL_BATCH_SIZE);
    if (error) throw error;
    const batch = rows ?? [];
    if (batch.length === 0) break;

    // PostgREST has no bulk UPDATE with per-row computed value;
    // we issue one update per row. The volume is bounded (the
    // backfill runs at most once-ish per row, and once every row
    // has the column populated the loop's first SELECT returns
    // empty on subsequent nights).
    for (const row of batch) {
      const until = computeRetentionUntilAt({
        createdAt: new Date(row.created_at),
        documentType: row.document_type,
      });
      const { error: updErr } = await supabase
        .schema("resupply")
        .from("patient_documents")
        .update({ retention_until_at: until.toISOString() })
        .eq("id", row.id);
      if (updErr) throw updErr;
      backfilled += 1;
    }
    // Avoid an unbounded loop if the table is huge — cap one
    // night's backfill at 5k rows; the next night picks up where
    // we left off. The page-empties check above usually wins
    // first, but this is a defensive cap.
    if (backfilled >= 5_000) break;
  }

  // ── 2. Flag rows past their retention horizon ───────────────────
  //
  // PostgREST .select() on an UPDATE returns at most ~1000 rows by
  // default. The previous shape did a single unbounded UPDATE +
  // .select(); on busy tenants that flipped tens of thousands of
  // rows, the audit-row loop below only wrote for the first ~1000
  // returned — leaving the rest with `retention_marked_at` set but
  // NO HIPAA-mandated audit trail. To keep the UPDATE and the
  // per-row audit perfectly aligned, we first SELECT the next
  // bounded batch of eligible ids, then UPDATE-by-id. The next tick
  // picks up whatever this tick didn't reach.
  const FLAG_BATCH_SIZE = 500;
  const nowIso = new Date().toISOString();
  const { data: eligible, error: eligibleErr } = await supabase
    .schema("resupply")
    .from("patient_documents")
    .select("id, patient_id, document_type, size_bytes, retention_until_at")
    .lte("retention_until_at", nowIso)
    .is("retention_marked_at", null)
    .is("destroyed_at", null)
    .eq("legal_hold", false)
    .order("retention_until_at", { ascending: true })
    .limit(FLAG_BATCH_SIZE);
  if (eligibleErr) throw eligibleErr;
  const eligibleList = eligible ?? [];
  let flaggedList: typeof eligibleList = [];
  if (eligibleList.length > 0) {
    const { data: flaggedRows, error: flagErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .update({ retention_marked_at: nowIso })
      .in(
        "id",
        eligibleList.map((r) => r.id),
      )
      .is("retention_marked_at", null)
      .is("destroyed_at", null)
      .eq("legal_hold", false)
      .select("id, patient_id, document_type, size_bytes, retention_until_at");
    if (flagErr) throw flagErr;
    flaggedList = flaggedRows ?? [];
  }
  const flagged = flaggedList.length;

  // ── 3. Per-document audit row ───────────────────────────────────
  // Surveyors and counsel want a queryable per-document destruction
  // trail. The `retention_marked_at` column above is the persistent
  // record on the document row itself, but it's not searchable by
  // action; a dedicated `audit_log` entry per flag lets compliance
  // reporting run as a single SELECT.
  //
  // `logAuditBestEffort` swallows DB errors (the sweep already
  // succeeded by this point — the marker is the durable record). A
  // run of audit-write failures will show up via the onWriteFailure
  // callback so an operator can investigate; a single transient
  // failure is acceptable noise.
  for (const row of flaggedList) {
    await logAuditBestEffort(
      {
        action: "patient_documents.retention.flagged",
        adminEmail: "system:cron:patient-documents-retention-sweep",
        adminUserId: null,
        targetTable: "patient_documents",
        targetId: row.id,
        metadata: {
          patient_id: row.patient_id,
          document_type: row.document_type,
          size_bytes: row.size_bytes,
          retention_until_at: row.retention_until_at,
        },
      },
      {
        contextLabel: "patient_documents_retention_sweep",
        onWriteFailure: (failure) => {
          logger.warn(
            failure,
            "patient-documents.retention-sweep: audit write failed",
          );
        },
      },
    );
  }

  return { backfilled, flagged };
}

export async function registerPatientDocumentsRetentionSweepJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(SWEEP_JOB);

  await boss.work(SWEEP_JOB, async () => {
    try {
      const stats = await runRetentionSweep();
      logger.info(
        {
          event: "patient-documents.retention-sweep.completed",
          ...stats,
        },
        "patient-documents.retention-sweep: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "patient-documents.retention-sweep: failed",
      );
      throw err;
    }
  });

  await boss.schedule(SWEEP_JOB, SWEEP_CRON);
  logger.info(
    { cron: SWEEP_CRON },
    "patient-documents.retention-sweep scheduled",
  );
}
