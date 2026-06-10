// POST /admin/office-ally/upload-ack
//
// Manual ack-file ingestion path — for the days the auto-poller
// can't reach OA's outbound directory (SFTP outage, expired key,
// OA archived the file before our 15-min cron caught it) or when
// OA support emails an ack file out-of-band ("here's the 277CA we
// generated yesterday, fyi").
//
// Body: { content: string, fileName?: string }
//   - content is the raw EDI text (pure ASCII; fits in JSON).
//   - fileName is optional metadata for the audit trail.
//
// The route:
//   1. Classifies the content via the same classifyEdiPayload() the
//      poller uses (sniffs the ST segment).
//   2. SHA256s the content; rejects with 409 when we've already
//      ingested an identical file (idempotent re-upload safe).
//   3. Inserts a clearinghouse_inbound_files row marked with
//      remote_path='manual:<adminEmail>:<isoTime>' so the audit list
//      shows where it came from.
//   4. Calls the appropriate dispatcher (999 / 277CA / 277 / 835 / 271)
//      reused from the poll-worker module, which updates the matched
//      office_ally_submissions row + per-claim events.
//
// Permission: requireAdminOnly. The PHI surface area on inbound EDI
// is meaningful — these files contain claim numbers, payer EOB
// detail, and (for 271) eligibility responses — so manual upload is
// gated tighter than the read-only inbound-files list.

import { createHash } from "node:crypto";

import express, { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { classifyEdiPayload } from "@workspace/resupply-integrations-office-ally";

import { resolveClearinghouse } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";
import {
  dispatch271,
  dispatch277,
  dispatch277ca,
  dispatch835,
  dispatch999,
} from "../../worker/jobs/office-ally-inbound-poll";

const router: IRouter = Router();

// 5MB cap — a typical 837P is well under 100KB; a large 835 batch
// rarely exceeds 1MB. 5MB leaves headroom while shutting down an
// accidental "I pasted the wrong gigabyte log" mistake.
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

const body = z
  .object({
    content: z
      .string()
      .min(20, "EDI content too short to be a valid X12 envelope")
      .max(MAX_CONTENT_BYTES, "EDI content exceeds 5MB cap"),
    fileName: z.string().trim().max(160).optional(),
  })
  .strict();

// Per-route JSON parser sized to the EDI cap above. The global
// express.json() at app.ts:200 caps at 100KB, which 413s any real
// 835 batch (~hundreds of KB to ~1MB) and most 271 batches before
// the route handler ever sees the request. Override here so the
// zod-level 5MB cap is the actual size gate.
const uploadAckJsonParser = express.json({ limit: "5mb" });

router.post(
  "/admin/office-ally/upload-ack",
  uploadAckJsonParser,
  requireAdminOnly,
  adminRateLimit({
    name: "office_ally.upload_ack",
    preset: "sensitive",
  }),
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
    const { content, fileName: rawFileName } = parsed.data;
    const fileName = rawFileName || `manual-${Date.now()}.txt`;

    const kind = classifyEdiPayload(content);
    if (kind === "unknown") {
      res.status(400).json({
        error: "unrecognized_edi",
        message:
          "content does not start with an ISA segment or has no ST*999/277/835/271 inside the first 4KB",
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    // We need a clearinghouse to attach the file to. Resolve the
    // active OA config; bail if there's nothing configured (the
    // schema requires clearinghouse_id NOT NULL on inbound files).
    const resolved = await resolveClearinghouse();
    if (!resolved.row) {
      res.status(409).json({
        error: "no_clearinghouse_configured",
        message:
          "manual ack upload requires an active clearinghouse_credentials row; configure one first",
      });
      return;
    }

    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

    // Duplicate guard — same content already ingested. We DON'T re-
    // dispatch; instead return the existing row so the admin sees
    // "already processed".
    const { data: existing } = await supabase
      .schema("resupply")
      .from("clearinghouse_inbound_files")
      .select("id, file_kind, dispatch_status, applied_to_submission_id")
      .eq("clearinghouse_id", resolved.row.id)
      .eq("file_sha256", sha256)
      .limit(1)
      .maybeSingle();
    if (existing) {
      res.status(409).json({
        error: "duplicate_content",
        message:
          "this exact EDI content has already been ingested for this clearinghouse",
        existingInboundFileId: existing.id,
        existingFileKind: existing.file_kind,
        existingDispatchStatus: existing.dispatch_status,
      });
      return;
    }

    const adminEmail = req.adminEmail ?? "unknown";
    const remotePath = `manual:${adminEmail}:${new Date().toISOString()}`;

    const { data: row, error: insertErr } = await supabase
      .schema("resupply")
      .from("clearinghouse_inbound_files")
      .insert({
        clearinghouse_id: resolved.row.id,
        remote_path: remotePath,
        file_name: fileName,
        file_sha256: sha256,
        file_size_bytes: Buffer.byteLength(content, "utf8"),
        file_kind: kind,
        dispatch_status: "parsed",
      })
      .select("id")
      .single();
    if (insertErr || !row) {
      logger.warn({ err: insertErr }, "office-ally.upload-ack: insert failed");
      res.status(500).json({ error: "persist_failed" });
      return;
    }

    // Dispatch by kind. All four dispatchers are idempotent against
    // their target row (999/277CA UPDATE by control number; 835
    // dedupes by file_sha256; 271 dedupes by trace reference).
    try {
      switch (kind) {
        case "999":
          await dispatch999(supabase, row.id, content);
          break;
        case "277ca":
          await dispatch277ca(supabase, row.id, content);
          break;
        case "277":
          await dispatch277(supabase, row.id, content);
          break;
        case "835":
          await dispatch835(supabase, row.id, fileName, content);
          break;
        case "271":
          await dispatch271(supabase, row.id, content);
          break;
      }
      const { error: dispatchedErr } = await supabase
        .schema("resupply")
        .from("clearinghouse_inbound_files")
        .update({
          dispatch_status: "dispatched",
          dispatched_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (dispatchedErr) {
        logger.warn(
          { err: dispatchedErr.message, inboundFileId: row.id },
          "office-ally.upload-ack: dispatched stamp failed (non-fatal)",
        );
      }
    } catch (err) {
      logger.warn(
        { err, inboundFileId: row.id, kind },
        "office-ally.upload-ack: dispatch failed",
      );
      const { error: failStampErr } = await supabase
        .schema("resupply")
        .from("clearinghouse_inbound_files")
        .update({
          dispatch_status: "dispatch_failed",
          error_message:
            err instanceof Error ? err.message.slice(0, 2000) : String(err),
          dispatched_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (failStampErr) {
        logger.error(
          { err: failStampErr.message, inboundFileId: row.id },
          "office-ally.upload-ack: dispatch_failed stamp also failed",
        );
      }
      res.status(500).json({
        error: "dispatch_failed",
        inboundFileId: row.id,
        kind,
        message: err instanceof Error ? err.message : "unknown",
      });
      return;
    }

    await logAudit({
      action: "office_ally.manual_ack_upload",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "clearinghouse_inbound_files",
      targetId: row.id,
      metadata: {
        file_kind: kind,
        file_name: fileName,
        file_size_bytes: Buffer.byteLength(content, "utf8"),
        clearinghouse_id: resolved.row.id,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "office_ally.manual_ack_upload audit write failed");
    });

    res.status(201).json({
      ok: true,
      inboundFileId: row.id,
      fileKind: kind,
      fileSizeBytes: Buffer.byteLength(content, "utf8"),
    });
  },
);

export default router;
