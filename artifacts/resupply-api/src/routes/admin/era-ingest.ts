// /admin/billing/era-ingest — upload + auto-reconcile a payer 835.
//
//   POST /admin/billing/era-ingest    body: { fileName, payload }
//
// On success: returns the ReconciliationSummary plus the new
// era_files row id. The 835 body is NOT persisted — only its SHA-256
// + parser summary — to keep PHI out of the DB. CSRs can replay the
// reconcile by re-uploading the original file; the file_sha256
// unique index prevents double-apply.

import { createHash } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { parse835 } from "@workspace/resupply-integrations-office-ally";

import { reconcileEra } from "../../lib/billing/era-reconciler";
import { resolvePayerProfileForEra } from "../../lib/billing/era-payer-resolver";
import { logger } from "../../lib/logger";
import { publishEvent } from "../../lib/webhooks/publisher";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    fileName: z.string().trim().min(1).max(160),
    /** Raw EDI text. We cap at 4 MB — well above the ~50 KB a typical
     *  ERA carries — so a corrupted file can't blow up the JSON
     *  parser. */
    payload: z
      .string()
      .min(50)
      .max(4 * 1024 * 1024),
    /** Optional manual link to an Office Ally submission row when the
     *  payer didn't echo our identifier back. */
    matchedSubmissionId: z.string().uuid().nullable().optional(),
  })
  .strict();

router.post(
  "/admin/billing/era-ingest",
  requireAdminOnly,
  adminRateLimit({ name: "billing.era_ingest", preset: "sensitive" }),
  async (req, res) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { fileName, payload, matchedSubmissionId } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    // Dedupe by SHA-256. Office Ally redelivers files on retry; an
    // operator may also re-upload the same file accidentally.
    //
    // 'partial' files are deliberately EXEMPT from the dedupe: the
    // header contract ("CSRs can replay the reconcile by re-uploading
    // the original file") was unkeepable when ANY existing row 409'd —
    // a transient DB error mid-reconcile left the file 'partial' with
    // its unmatched claims permanently unappliable. The reconciler is
    // now per-claim idempotent (insurance_claim_events marker keyed on
    // claim_id + check number), so re-running a partial file only
    // applies the claim blocks that were missed; we reuse the existing
    // era_files row rather than inserting (unique sha index).
    const sha256 = createHash("sha256").update(payload, "utf8").digest("hex");
    const { data: existing, error: existingErr } = await supabase
      .schema("resupply")
      .from("era_files")
      .select("id, status")
      .eq("file_sha256", sha256)
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing && existing.status !== "partial") {
      res.status(409).json({
        error: "duplicate",
        message: "an ERA file with this content has already been ingested",
        eraFileId: existing.id,
        status: existing.status,
      });
      return;
    }

    let parsedEra;
    try {
      parsedEra = parse835(payload);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "era_ingest: parse failed",
      );
      res.status(400).json({
        error: "parse_failed",
        message: "the uploaded file could not be parsed as a 5010 835",
      });
      return;
    }

    // Phase 16 (mig 0143) — resolve the payer profile from the 835's
    // payer identifier so the ingest dashboard can show "ERA from
    // Highmark" and the reconciler can later apply payer-specific
    // denial-code mappings. Resolution failure is non-fatal: we still
    // ingest with payer_profile_id=NULL and surface it as "unknown
    // payer — update the catalog".
    const resolvedPayer = await resolvePayerProfileForEra(
      { payerId: parsedEra.payerId, payerName: parsedEra.payerName },
      { supabase },
    );
    if (!resolvedPayer) {
      logger.info(
        {
          event: "era_ingest.unknown_payer",
          payer_id: parsedEra.payerId,
          payer_name: parsedEra.payerName,
        },
        "era_ingest: 835 payer not found in catalog",
      );
    }

    // Persist the file row up front in 'partial' state; we promote to
    // 'processed' after the reconciler returns. A replay of a
    // 'partial' file reuses its existing row (see the dedupe above).
    let eraFileId: string;
    if (existing) {
      eraFileId = existing.id;
      const { error: refreshErr } = await supabase
        .schema("resupply")
        .from("era_files")
        .update({
          file_name: fileName,
          matched_submission_id: matchedSubmissionId ?? null,
          payer_profile_id: resolvedPayer?.payerProfileId ?? null,
          ingested_by_email: req.adminEmail ?? "unknown",
        })
        .eq("id", existing.id);
      if (refreshErr) throw refreshErr;
    } else {
      const { data: row, error: insertErr } = await supabase
        .schema("resupply")
        .from("era_files")
        .insert({
          file_name: fileName,
          file_sha256: sha256,
          file_size_bytes: Buffer.byteLength(payload, "utf8"),
          payer_check_number: parsedEra.checkOrEftNumber,
          payer_paid_date: parsedEra.paymentDate,
          total_paid_cents: parsedEra.totalPaidCents,
          claims_paid_count: 0,
          claims_denied_count: 0,
          lines_processed_count: 0,
          matched_submission_id: matchedSubmissionId ?? null,
          payer_profile_id: resolvedPayer?.payerProfileId ?? null,
          status: "partial",
          ingested_by_email: req.adminEmail ?? "unknown",
        })
        .select("id")
        .single();
      if (insertErr) throw insertErr;
      eraFileId = row.id;
    }

    const summary = await reconcileEra(parsedEra, {
      actorEmail: `system:era_ingest:${req.adminEmail ?? "unknown"}`,
      fileName,
      checkOrEftNumber: parsedEra.checkOrEftNumber,
    });

    // Update with the parser+reconciler counts and promote status.
    const allMatched = summary.unmatchedClaims === 0;
    const finalStatus = allMatched ? "processed" : "partial";
    const { error: eraUpdateErr } = await supabase
      .schema("resupply")
      .from("era_files")
      .update({
        claims_paid_count: summary.paidClaims,
        claims_denied_count: summary.deniedClaims,
        lines_processed_count: summary.linesUpdated,
        status: finalStatus,
        rejection_reason: allMatched
          ? null
          : `${summary.unmatchedClaims} claim block(s) had no local match`,
      })
      .eq("id", eraFileId);
    if (eraUpdateErr) throw eraUpdateErr;

    await logAudit({
      action: "era_file.ingest",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "era_files",
      targetId: eraFileId,
      metadata: {
        file_name: fileName,
        payer_check_number: parsedEra.checkOrEftNumber,
        total_paid_cents: parsedEra.totalPaidCents,
        claims_paid: summary.paidClaims,
        claims_denied: summary.deniedClaims,
        claims_unmatched: summary.unmatchedClaims,
        lines_updated: summary.linesUpdated,
        status: finalStatus,
        payer_profile_id: resolvedPayer?.payerProfileId ?? null,
        payer_match_reason: resolvedPayer?.matchReason ?? "no_match",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "era_file.ingest audit write failed");
    });
    void publishEvent({
      eventType: "era.ingested",
      payload: {
        era_file_id: eraFileId,
        file_name: fileName,
        total_paid_cents: parsedEra.totalPaidCents,
        claims_paid: summary.paidClaims,
        claims_denied: summary.deniedClaims,
        lines_updated: summary.linesUpdated,
      },
    });

    res.status(201).json({
      eraFileId,
      status: finalStatus,
      summary,
    });
  },
);

// ── LIST ────────────────────────────────────────────────────────────
router.get("/admin/billing/era-files", requireAdminOnly, async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("era_files")
    .select(
      "id, file_name, file_sha256, file_size_bytes, payer_check_number, payer_paid_date, total_paid_cents, claims_paid_count, claims_denied_count, lines_processed_count, matched_submission_id, payer_profile_id, status, rejection_reason, ingested_by_email, ingested_at",
    )
    .order("ingested_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  res.json({
    eraFiles: (data ?? []).map((r) => ({
      id: r.id,
      fileName: r.file_name,
      fileSha256: r.file_sha256,
      fileSizeBytes: r.file_size_bytes,
      payerCheckNumber: r.payer_check_number,
      payerPaidDate: r.payer_paid_date,
      totalPaidCents: r.total_paid_cents,
      claimsPaidCount: r.claims_paid_count,
      claimsDeniedCount: r.claims_denied_count,
      linesProcessedCount: r.lines_processed_count,
      matchedSubmissionId: r.matched_submission_id,
      payerProfileId: r.payer_profile_id,
      status: r.status,
      rejectionReason: r.rejection_reason,
      ingestedByEmail: r.ingested_by_email,
      ingestedAt: r.ingested_at,
    })),
  });
});

export default router;
