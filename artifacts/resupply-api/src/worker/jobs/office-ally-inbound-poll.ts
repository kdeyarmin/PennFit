// pg-boss job: poll Office Ally's outbound SFTP directory and
// dispatch inbound files (999 / 277CA / 835) into our local
// processing pipelines.
//
// Cadence
// -------
// Every 15 minutes. Office Ally drops files into the outbound dir
// roughly hourly; 15-minute polling keeps the time-to-reconcile
// under a coffee break while staying well below their fair-use
// threshold.
//
// What the job does
// -----------------
// 1. Resolve the active office_ally clearinghouse_credentials row.
//    If absent (or no SFTP config in env), the job logs and exits 0
//    — dev / preview environments don't need this running.
// 2. Call `listOutboundFiles` to get the remote file roster.
// 3. For each file not already in clearinghouse_inbound_files:
//    a. Download it.
//    b. Compute SHA-256 (the dedupe key) — if a row with that hash
//       already exists, skip with status='skipped'.
//    c. Sniff the EDI header to classify (999 | 277ca | 835 | unknown).
//    d. Insert a clearinghouse_inbound_files row with status='parsed'.
//    e. Dispatch into the right downstream:
//       - 999  → update office_ally_submissions.status based on AK9
//                disposition, persist disposition counts.
//       - 277ca → update office_ally_submissions.status per-claim;
//                  for each rejected claim block, append an
//                  insurance_claim_events 'denied' row.
//       - 835  → insert era_files row, invoke the existing
//                reconcileEra() service, kick off the AI denial
//                analyzer for any newly-denied claims.
//    f. Stamp dispatched_at + dispatch_status='dispatched'.
// 4. Update clearinghouse_credentials.last_polled_at.
//
// Re-entrancy
// -----------
// The SHA-256 unique index on clearinghouse_inbound_files makes the
// job naturally idempotent — a re-run on the same set of remote
// files is a no-op. The 835 reconciler is also idempotent via the
// era_files sha256 unique index (migration 0129).
//
// PHI posture
// -----------
// File contents are NEVER logged. We log counts + control numbers
// only. Per-file errors land in clearinghouse_inbound_files.error_message.

import { createHash } from "node:crypto";

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  classifyEdiPayload,
  downloadFile,
  listOutboundFiles,
  parse277CA,
  parse835,
  parse999,
  type Parsed277CA,
  type Parsed835,
  type Parsed999,
} from "@workspace/resupply-integrations-office-ally";

import { analyzeDenial } from "../../lib/billing/ai-denial-analyzer";
import { reconcileEra } from "../../lib/billing/era-reconciler";
import { resolveClearinghouse } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";

const JOB = "office-ally.inbound-poll";
const CRON = "*/15 * * * *";
const SYSTEM_ACTOR_EMAIL = "system:cron:office-ally-inbound-poll";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface PollStats {
  listed: number;
  downloaded: number;
  skippedDuplicates: number;
  dispatched: number;
  dispatch999: number;
  dispatch277ca: number;
  dispatch835: number;
  dispatchUnknown: number;
  dispatchErrors: number;
  aiAnalysesQueued: number;
}

/**
 * Run the polling job once. Returns stats for the audit / log line.
 * Caller (the pg-boss handler) decides whether to throw on errors;
 * we generally do NOT throw — every per-file error lands as a row
 * in clearinghouse_inbound_files so the operator can triage.
 */
export async function runOfficeAllyInboundPoll(): Promise<PollStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: PollStats = {
    listed: 0,
    downloaded: 0,
    skippedDuplicates: 0,
    dispatched: 0,
    dispatch999: 0,
    dispatch277ca: 0,
    dispatch835: 0,
    dispatchUnknown: 0,
    dispatchErrors: 0,
    aiAnalysesQueued: 0,
  };

  const clearinghouse = await resolveClearinghouse({ supabase });
  if (!clearinghouse.config || !clearinghouse.row) {
    logger.info(
      { source: clearinghouse.source },
      "office-ally.inbound-poll: no clearinghouse configured; skipping run",
    );
    return stats;
  }

  const outboundDir =
    clearinghouse.row.remote_outbound_dir || "outbound";
  const list = await listOutboundFiles(clearinghouse.config, outboundDir);
  if (!list.ok) {
    logger.warn(
      { kind: list.kind, message: list.message },
      "office-ally.inbound-poll: list failed",
    );
    return stats;
  }
  stats.listed = list.files.length;

  for (const remote of list.files) {
    const dispatched = await processRemoteFile(
      supabase,
      clearinghouse.row.id,
      clearinghouse.config,
      remote.remotePath,
      remote.fileName,
      stats,
    );
    if (dispatched) stats.dispatched += 1;
  }

  // Stamp last_polled_at regardless of per-file outcomes.
  await supabase
    .schema("resupply")
    .from("clearinghouse_credentials")
    .update({ last_polled_at: new Date().toISOString() })
    .eq("id", clearinghouse.row.id)
    .then(() => undefined, (err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "office-ally.inbound-poll: last_polled_at update failed (non-fatal)",
      ),
    );

  await logAudit({
    action: "office_ally_inbound_poll.completed",
    adminEmail: SYSTEM_ACTOR_EMAIL,
    adminUserId: null,
    targetTable: "clearinghouse_credentials",
    targetId: clearinghouse.row.id,
    metadata: { ...stats },
    ip: null,
    userAgent: null,
  }).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "office-ally.inbound-poll: audit write failed",
    );
  });

  return stats;
}

async function processRemoteFile(
  supabase: SupabaseClient,
  clearinghouseId: string,
  config: NonNullable<Awaited<ReturnType<typeof resolveClearinghouse>>["config"]>,
  remotePath: string,
  fileName: string,
  stats: PollStats,
): Promise<boolean> {
  // 1. Cheap dedupe by remote_path BEFORE downloading.
  const { data: existing } = await supabase
    .schema("resupply")
    .from("clearinghouse_inbound_files")
    .select("id, dispatch_status")
    .eq("clearinghouse_id", clearinghouseId)
    .eq("remote_path", remotePath)
    .limit(1)
    .maybeSingle();
  if (existing) {
    stats.skippedDuplicates += 1;
    return false;
  }

  // 2. Download.
  const download = await downloadFile(config, remotePath);
  if (!download.ok) {
    logger.warn(
      {
        remotePath,
        kind: download.kind,
        message: download.message,
      },
      "office-ally.inbound-poll: download failed",
    );
    return false;
  }
  stats.downloaded += 1;

  // 3. SHA-256 dedupe across remote paths (file redelivery may
  //    arrive at a different path).
  const sha256 = createHash("sha256").update(download.content, "utf8").digest("hex");
  const { data: sameContent } = await supabase
    .schema("resupply")
    .from("clearinghouse_inbound_files")
    .select("id")
    .eq("clearinghouse_id", clearinghouseId)
    .eq("file_sha256", sha256)
    .limit(1)
    .maybeSingle();
  if (sameContent) {
    // Persist a skipped row so the audit shows the redelivery without
    // re-processing.
    await supabase
      .schema("resupply")
      .from("clearinghouse_inbound_files")
      .insert({
        clearinghouse_id: clearinghouseId,
        remote_path: remotePath,
        file_name: fileName,
        file_sha256: `${sha256}::${Date.now()}`, // make unique on (clearinghouse_id, file_sha256)
        file_size_bytes: download.fileSizeBytes,
        file_kind: "unknown",
        dispatch_status: "skipped",
        error_message: `Redelivery of already-processed sha256 ${sha256}`,
      })
      .then(() => undefined, () => undefined);
    stats.skippedDuplicates += 1;
    return false;
  }

  // 4. Classify + persist.
  const kind = classifyEdiPayload(download.content);
  const { data: row } = await supabase
    .schema("resupply")
    .from("clearinghouse_inbound_files")
    .insert({
      clearinghouse_id: clearinghouseId,
      remote_path: remotePath,
      file_name: fileName,
      file_sha256: sha256,
      file_size_bytes: download.fileSizeBytes,
      file_kind: kind,
      dispatch_status: "parsed",
    })
    .select("id")
    .single();
  if (!row) {
    logger.warn(
      { remotePath },
      "office-ally.inbound-poll: insert clearinghouse_inbound_files failed",
    );
    return false;
  }

  // 5. Dispatch by kind.
  try {
    switch (kind) {
      case "999":
        await dispatch999(supabase, row.id, download.content);
        stats.dispatch999 += 1;
        break;
      case "277ca":
        await dispatch277ca(supabase, row.id, download.content);
        stats.dispatch277ca += 1;
        break;
      case "835": {
        const queued = await dispatch835(
          supabase,
          row.id,
          fileName,
          download.content,
        );
        stats.dispatch835 += 1;
        stats.aiAnalysesQueued += queued;
        break;
      }
      default:
        stats.dispatchUnknown += 1;
        await supabase
          .schema("resupply")
          .from("clearinghouse_inbound_files")
          .update({
            dispatch_status: "skipped",
            error_message: "Unknown EDI file kind",
            dispatched_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        return false;
    }
    await supabase
      .schema("resupply")
      .from("clearinghouse_inbound_files")
      .update({
        dispatch_status: "dispatched",
        dispatched_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return true;
  } catch (err) {
    stats.dispatchErrors += 1;
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        remotePath,
        kind,
      },
      "office-ally.inbound-poll: dispatch failed",
    );
    await supabase
      .schema("resupply")
      .from("clearinghouse_inbound_files")
      .update({
        dispatch_status: "dispatch_failed",
        error_message:
          err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000),
      })
      .eq("id", row.id);
    return false;
  }
}

async function dispatch999(
  supabase: SupabaseClient,
  inboundFileId: string,
  content: string,
): Promise<void> {
  const parsed = parse999(content);
  // Update the matching office_ally_submissions row by control number.
  if (parsed.groupControlNumber) {
    const newStatus =
      parsed.disposition === "A"
        ? "accepted_999"
        : parsed.disposition === "R" || parsed.disposition === "E"
          ? "rejected_999"
          : "uploaded";
    const { data: submission } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("id")
      .eq("gs_control_number", parsed.groupControlNumber)
      .limit(1)
      .maybeSingle();
    if (submission) {
      await supabase
        .schema("resupply")
        .from("office_ally_submissions")
        .update({
          status: newStatus,
          ack_999_file_name: `inbound:${inboundFileId.slice(0, 8)}`,
          ack_999_received_at: new Date().toISOString(),
          rejection_reason:
            parsed.errors.length > 0
              ? parsed.errors
                  .slice(0, 5)
                  .map(
                    (e) =>
                      `${e.segmentId ?? "?"}/${e.errorCode ?? "?"} ${e.errorText ?? ""}`.trim(),
                  )
                  .join("; ")
                  .slice(0, 2000)
              : null,
        })
        .eq("id", submission.id);
      await supabase
        .schema("resupply")
        .from("clearinghouse_inbound_files")
        .update({
          applied_to_submission_id: submission.id,
          parse_summary_json: summarise999(parsed) as unknown as Json,
        })
        .eq("id", inboundFileId);
    }
  }
}

async function dispatch277ca(
  supabase: SupabaseClient,
  inboundFileId: string,
  content: string,
): Promise<void> {
  const parsed = parse277CA(content);
  // Walk each claim block; match by traceNumber (which we put on
  // CLM01 == insurance_claims.id) and update status.
  for (const block of parsed.claims) {
    if (!block.traceNumber) continue;
    const { data: claim } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, office_ally_submission_id, status")
      .eq("id", block.traceNumber)
      .limit(1)
      .maybeSingle();
    if (!claim) continue;
    // Capture the payer-assigned ref number on the claim.
    const update: Database["resupply"]["Tables"]["insurance_claims"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (block.payerClaimRef) update.claim_number = block.payerClaimRef;
    await supabase
      .schema("resupply")
      .from("insurance_claims")
      .update(update)
      .eq("id", claim.id);
    // Append an event for the audit trail.
    await supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .insert({
        claim_id: claim.id,
        event_type: block.outcome === "rejected" ? "denied" : "note",
        payer_ref: block.payerClaimRef,
        note: `277CA ${block.outcome}: ${block.statusMessages.slice(0, 3).join("; ")}`.slice(
          0,
          4000,
        ),
        actor_email: SYSTEM_ACTOR_EMAIL,
      });
    // Roll-up onto the office_ally_submissions row.
    if (claim.office_ally_submission_id) {
      const newStatus =
        block.outcome === "rejected" ? "rejected_277ca" : "accepted_277ca";
      await supabase
        .schema("resupply")
        .from("office_ally_submissions")
        .update({
          status: newStatus,
          ack_277ca_file_name: `inbound:${inboundFileId.slice(0, 8)}`,
          ack_277ca_received_at: new Date().toISOString(),
        })
        .eq("id", claim.office_ally_submission_id);
      await supabase
        .schema("resupply")
        .from("clearinghouse_inbound_files")
        .update({
          applied_to_submission_id: claim.office_ally_submission_id,
          parse_summary_json: summarise277(parsed) as unknown as Json,
        })
        .eq("id", inboundFileId);
    }
  }
}

async function dispatch835(
  supabase: SupabaseClient,
  inboundFileId: string,
  fileName: string,
  content: string,
): Promise<number> {
  const parsed = parse835(content);
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  // Persist the era_files row (dedupe is on era_files.file_sha256
  // unique index from 0129).
  const { data: existingEra } = await supabase
    .schema("resupply")
    .from("era_files")
    .select("id, status")
    .eq("file_sha256", sha256)
    .limit(1)
    .maybeSingle();
  let eraFileId = existingEra?.id;
  if (!eraFileId) {
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("era_files")
      .insert({
        file_name: fileName,
        file_sha256: sha256,
        file_size_bytes: Buffer.byteLength(content, "utf8"),
        payer_check_number: parsed.checkOrEftNumber,
        payer_paid_date: parsed.paymentDate,
        total_paid_cents: parsed.totalPaidCents,
        claims_paid_count: 0,
        claims_denied_count: 0,
        lines_processed_count: 0,
        matched_submission_id: null,
        status: "partial",
        ingested_by_email: SYSTEM_ACTOR_EMAIL,
      })
      .select("id")
      .single();
    if (error) throw error;
    eraFileId = row.id;
  }

  const summary = await reconcileEra(parsed, {
    actorEmail: SYSTEM_ACTOR_EMAIL,
    fileName,
    checkOrEftNumber: parsed.checkOrEftNumber,
  });

  const finalStatus = summary.unmatchedClaims === 0 ? "processed" : "partial";
  await supabase
    .schema("resupply")
    .from("era_files")
    .update({
      claims_paid_count: summary.paidClaims,
      claims_denied_count: summary.deniedClaims,
      lines_processed_count: summary.linesUpdated,
      status: finalStatus,
      rejection_reason:
        summary.unmatchedClaims === 0
          ? null
          : `${summary.unmatchedClaims} claim block(s) had no local match`,
    })
    .eq("id", eraFileId);

  await supabase
    .schema("resupply")
    .from("clearinghouse_inbound_files")
    .update({
      applied_to_era_file_id: eraFileId,
      parse_summary_json: summarise835(parsed) as unknown as Json,
    })
    .eq("id", inboundFileId);

  // Kick off the AI denial analyzer for each newly-denied claim.
  // Fire-and-forget so a slow OpenAI call doesn't stall the worker
  // tick; the analyzer is itself non-throwing.
  let queued = 0;
  for (const outcome of summary.outcomes) {
    if (!outcome.matched || outcome.newStatus !== "denied") continue;
    // Resolve the claim id for the analyzer; we have the patient
    // control number which IS the claim id (CLM01 echo).
    const claimId = outcome.patientControlNumber;
    queued += 1;
    void runDenialAnalysisQuietly(supabase, claimId, eraFileId);
  }
  return queued;
}

async function runDenialAnalysisQuietly(
  supabase: SupabaseClient,
  claimId: string,
  eraFileId: string,
): Promise<void> {
  try {
    const output = await analyzeDenial({ claimId, eraFileId });
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("claim_denial_analyses")
      .insert({
        claim_id: claimId,
        era_file_id: eraFileId,
        model: "gpt-4o-mini",
        prompt_version: "denial-1.0",
        confidence: output.confidence,
        root_cause_summary: output.rootCauseSummary,
        recommendation: output.recommendation,
        analysis_json: {
          mappedCodes: output.mappedCodes,
          fixSteps: output.fixSteps,
          appealLetterSketch: output.appealLetterSketch,
          droppedPatches: output.droppedPatches,
        } as unknown as Json,
        suggested_patches_json: output.suggestedPatches as unknown as Json,
        can_auto_resubmit: output.canAutoResubmit,
        review_status: output.errorMessage ? "errored" : "pending",
        latency_ms: output.latencyMs,
        prompt_tokens: output.promptTokens,
        completion_tokens: output.completionTokens,
        error_message: output.errorMessage,
      })
      .select("id")
      .single();
    if (error) throw error;
    if (row) {
      await supabase
        .schema("resupply")
        .from("insurance_claims")
        .update({
          latest_denial_analysis_id: row.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimId);
    }
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        claimId,
      },
      "office-ally.inbound-poll: AI denial analysis failed (non-fatal)",
    );
  }
}

function summarise999(p: Parsed999): Record<string, unknown> {
  return {
    disposition: p.disposition,
    groupControlNumber: p.groupControlNumber,
    transactionsReceived: p.transactionsReceived,
    transactionsAccepted: p.transactionsAccepted,
    errorCount: p.errors.length,
  };
}

function summarise277(p: Parsed277CA): Record<string, unknown> {
  return {
    claimCount: p.claims.length,
    acceptedCount: p.claims.filter((c) => c.outcome === "accepted").length,
    rejectedCount: p.claims.filter((c) => c.outcome === "rejected").length,
    pendedCount: p.claims.filter((c) => c.outcome === "pended").length,
  };
}

function summarise835(p: Parsed835): Record<string, unknown> {
  return {
    totalPaidCents: p.totalPaidCents,
    checkOrEftNumber: p.checkOrEftNumber,
    paymentDate: p.paymentDate,
    claimCount: p.claims.length,
    paidCount: p.claims.filter((c) => c.isPaid).length,
    deniedCount: p.claims.filter((c) => c.isDenied).length,
  };
}

export async function registerOfficeAllyInboundPollJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(JOB);
  await boss.work(JOB, async () => {
    try {
      const stats = await runOfficeAllyInboundPoll();
      logger.info(
        { event: "office-ally.inbound-poll.completed", ...stats },
        "office-ally.inbound-poll: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "office-ally.inbound-poll: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB, CRON);
  logger.info({ cron: CRON }, "office-ally.inbound-poll scheduled");
}
