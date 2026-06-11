// /admin/signature-tracking — the unified "what's still out for a
// provider signature?" dashboard + the returned-fax filing hook.
//
// Every document sent out for a provider signature (a prescription
// request, or a signable manual document) registers a row in
// resupply.signature_tracking (migration 0253) with a short tracking
// code that is also printed as a Code 128 barcode on the outgoing PDF.
// This router is the read/clear side of that ledger:
//
//   GET  /admin/signature-tracking
//        Outstanding (default awaiting_signature) items, oldest first,
//        plus a provider/practice rollup for the at-a-glance view. Only
//        documents that have actually been dispatched (sent_count > 0)
//        count as outstanding — a drafted-but-unsent document stays off
//        the queue. Filters: ?status, ?providerId, ?practiceName, ?kind,
//        ?limit.
//
//   GET  /admin/signature-tracking/lookup?code=PFS-XXXX
//        Resolve a scanned / typed barcode to its document so a returned
//        fax can be filed. Normalises case / spacing / a missing prefix.
//
//   POST /admin/signature-tracking/:id/mark-returned
//        The signed copy came back — mark it returned and advance the
//        source document (a prescription packet → status=signed).
//
//   POST /admin/signature-tracking/:id/mark-hand-delivered
//        The document was printed and physically handed to the provider
//        or patient — record a hand_delivery dispatch so it joins the
//        outstanding queue. (Printing alone never counts as sending;
//        this is the explicit operator action for the paper path.)
//
//   POST /admin/signature-tracking/:id/cancel
//        The request is no longer needed — drop it from the queue.
//
// Resend / print-for-hand-delivery are NOT re-implemented here: the
// dashboard links each row back to the source document's existing PDF
// (now barcoded) and send-fax endpoints, keyed by documentKind +
// documentId in the response.
//
// Permissions: reads gated by patients.read, writes by patients.update
// (mirrors prescription-requests / manual-documents). PHI posture: rows
// carry patient/provider snapshot labels; the logger emits ids + codes
// only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  getTrackingById,
  listOutstandingSignatures,
  lookupTrackingByCode,
  markReturnedAndCascade,
  markTrackingCanceled,
  recordTrackingSent,
  type SignatureTrackingRow,
} from "../../lib/signature-tracking/service";
import {
  adminReadRateLimiter,
  adminRateLimit,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();
const idParam = z.object({ id: z.string().uuid() });

// "unsent" is a view, not a stored status: awaiting_signature rows that
// have never been dispatched (sent_count = 0) — the drafts a CSR can
// still send or mark hand-delivered.
const listQuery = z
  .object({
    status: z
      .enum(["awaiting_signature", "unsent", "returned_signed", "canceled"])
      .optional(),
    providerId: z.string().uuid().optional(),
    practiceName: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(["prescription_request", "manual_document"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const lookupQuery = z
  .object({ code: z.string().trim().min(3).max(64) })
  .strict();

/** Path to the source document's (now barcoded) admin PDF preview. */
function documentPdfPath(row: SignatureTrackingRow): string {
  return row.documentKind === "prescription_request"
    ? `/resupply-api/admin/prescription-requests/${row.documentId}/pdf`
    : `/resupply-api/admin/manual-documents/${row.documentId}/pdf`;
}

function projectRow(row: SignatureTrackingRow) {
  return { ...row, documentPdfPath: documentPdfPath(row) };
}

// ── Outstanding dashboard ──────────────────────────────────────────
router.get(
  "/admin/signature-tracking",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { status, ...rest } = parsed.data;
    const result = await listOutstandingSignatures(
      supabase,
      status === "unsent"
        ? { ...rest, status: "awaiting_signature", dispatched: false }
        : { ...rest, status },
    );
    res.json({
      count: result.count,
      byProvider: result.byProvider,
      items: result.rows.map(projectRow),
    });
  },
);

// ── Barcode / code lookup (file a returned fax) ────────────────────
router.get(
  "/admin/signature-tracking/lookup",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = lookupQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const row = await lookupTrackingByCode(supabase, parsed.data.code);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ item: projectRow(row) });
  },
);

// ── Mark returned (signed copy came back) ──────────────────────────
router.post(
  "/admin/signature-tracking/:id/mark-returned",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "signature_tracking.mark_returned",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const row = await getTrackingById(supabase, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status === "returned_signed") {
      res
        .status(200)
        .json({ status: "returned_signed", alreadyReturned: true });
      return;
    }

    // Mark returned and advance the source document (a prescription
    // packet still open is stamped signed so the two views agree).
    await markReturnedAndCascade(supabase, row).catch((err) => {
      logger.warn(
        { err, document_id: row.documentId },
        "signature_tracking.mark_returned cascade failed",
      );
    });

    await logAudit({
      action: "signature_tracking.returned",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "signature_tracking",
      targetId: row.id,
      metadata: {
        document_kind: row.documentKind,
        tracking_code: row.trackingCode,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "signature_tracking.returned audit write failed");
    });

    res.status(200).json({ status: "returned_signed" });
  },
);

// ── Mark hand-delivered (paper went out by hand) ───────────────────
// Records a hand_delivery dispatch via recordTrackingSent (bumps
// sent_count, stamps last_sent_at + channel), which is what moves the
// row onto the outstanding queue. The source document's own lifecycle is
// untouched — prescription packets and manual documents only model
// fax/email sends, and the tracking ledger is the system of record for
// the paper path. Terminal rows 409: a returned/canceled request must be
// re-registered (re-sent) through its source document, not silently
// reopened from the dashboard.
router.post(
  "/admin/signature-tracking/:id/mark-hand-delivered",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "signature_tracking.mark_hand_delivered",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const row = await getTrackingById(supabase, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status !== "awaiting_signature") {
      res.status(409).json({ error: "not_awaiting", status: row.status });
      return;
    }

    await recordTrackingSent(
      supabase,
      row.documentKind,
      row.documentId,
      "hand_delivery",
    );

    await logAudit({
      action: "signature_tracking.hand_delivered",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "signature_tracking",
      targetId: row.id,
      metadata: {
        document_kind: row.documentKind,
        tracking_code: row.trackingCode,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "signature_tracking.hand_delivered audit write failed",
      );
    });

    res.status(200).json({
      status: "awaiting_signature",
      deliveryChannel: "hand_delivery",
    });
  },
);

// ── Cancel (drop from the queue) ───────────────────────────────────
router.post(
  "/admin/signature-tracking/:id/cancel",
  requirePermission("patients.update"),
  adminRateLimit({ name: "signature_tracking.cancel", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const row = await getTrackingById(supabase, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await markTrackingCanceled(supabase, row.documentKind, row.documentId);

    await logAudit({
      action: "signature_tracking.canceled",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "signature_tracking",
      targetId: row.id,
      metadata: {
        document_kind: row.documentKind,
        tracking_code: row.trackingCode,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "signature_tracking.canceled audit write failed");
    });

    res.status(200).json({ status: "canceled" });
  },
);

export default router;
