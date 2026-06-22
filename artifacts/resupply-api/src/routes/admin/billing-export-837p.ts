// POST /admin/billing/claims/export-837p
//
// Build a standard ASC X12 5010 837P for a set of claims and return it as a
// file DOWNLOAD — the "export the 837P and upload it to the clearinghouse of
// your choice" path, the alternative to one-click Office Ally auto-submission.
//
// Unlike batch-submit-office-ally this does NOT upload anything, records no
// office_ally_submissions row, and changes no claim status. It just serializes
// the same claim content into a clearinghouse-NEUTRAL interchange addressed to
// the caller-supplied receiver (their target clearinghouse's ISA08 id), so the
// file isn't hard-addressed to Office Ally. The operator uploads it wherever
// they like and tracks the submission there.
//
// Body: { claimIds: string[], receiverId?: string, receiverName?: string }
//
// PHI: the response body IS claim data (an 837P). It streams to the authed
// admin who requested it and is never logged; the audit row carries counts
// only. No Idempotency-Key handling here — persisting the body would persist
// PHI — and the response is `no-store`.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import { buildExport837P } from "../../lib/billing/office-ally-batch";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    claimIds: z.array(z.string().uuid()).min(1).max(100),
    // The target clearinghouse's interchange receiver id (ISA08/GS03) and
    // name. Optional — defaults to neutral placeholders the operator can
    // override per clearinghouse.
    receiverId: z.string().trim().min(1).max(15).optional(),
    receiverName: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

router.post(
  "/admin/billing/claims/export-837p",
  requirePermission("billing.manage"),
  adminRateLimit({ name: "billing.export_837p", preset: "bulk" }),
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

    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const result = await buildExport837P({
      orgId,
      claimIds: parsed.data.claimIds,
      receiver: {
        interchangeId: parsed.data.receiverId ?? "RECEIVER",
        organizationName: parsed.data.receiverName ?? "CLEARINGHOUSE",
      },
    });

    if (!result.ok) {
      const status =
        result.kind === "no_claims_matched"
          ? 404
          : result.kind === "some_claims_not_found" ||
              result.kind === "batch_payer_mismatch" ||
              result.kind === "payer_not_configured" ||
              result.kind === "claim_detail_unavailable" ||
              result.kind === "location_billing_mismatch"
            ? 409
            : 400;
      res.status(status).json({ error: result.kind, ...(result.detail ?? {}) });
      return;
    }

    // Counts only — never the payload (PHI).
    await logAudit({
      action: "billing.claim_837p_export",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: null,
      metadata: {
        claim_count: result.claimCount,
        interchange_control_number: result.interchangeControlNumber,
        usage_indicator: result.usageIndicator,
        receiver_id: parsed.data.receiverId ?? "RECEIVER",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "billing.claim_837p_export audit write failed");
    });

    const fileName = `claims-837p-${result.interchangeControlNumber}.txt`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/edi-x12; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.status(200).send(result.payload);
  },
);

export default router;
