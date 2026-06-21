// POST /admin/fulfillments/:fulfillmentId/create-claim
//
// One-click claim creation. Given a fulfillment row, runs the
// claim-builder to assemble a fully-populated draft + inserts:
//   * one insurance_claims row,
//   * N insurance_claim_line_items rows,
//   * one insurance_claim_events row for the 'note' kind so the
//     reconstruction shows "built from fulfillment X by CSR Y".
//
// On success returns the new claim id + the builder's notes (so the
// UI can immediately show the CSR what was auto-resolved vs left
// blank). On a hard prereq failure (fulfillment missing) returns 404.
//
// The build + persist sequence lives in the shared
// `createClaimFromFulfillment` helper (lib/billing) so this route and the
// bulk route (billing-batch-create-claims.ts) can never diverge.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { createClaimFromFulfillment } from "../../lib/billing/create-claim-from-fulfillment";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({ fulfillmentId: z.string().uuid() });

const body = z
  .object({
    dateOfService: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    payerProfileId: z.string().uuid().nullable().optional(),
    /** Free-text note attached to the initial event row. */
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .optional();

router.post(
  "/admin/fulfillments/:fulfillmentId/create-claim",
  // CSRs working the billing queue need this; gate behind the same
  // permission as the other claim writes.
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fulfillments.create_claim", preset: "mutation" }),
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = body.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const billHoldEnabled = await isFeatureEnabled("billing.bill_hold", orgId);
    const result = await createClaimFromFulfillment({
      fulfillmentId: idParsed.data.fulfillmentId,
      orgId,
      actorEmail: req.adminEmail ?? null,
      actorUserId: req.adminUserId ?? null,
      billHoldEnabled,
      dateOfServiceOverride: bodyParsed.data?.dateOfService ?? null,
      payerProfileIdOverride: bodyParsed.data?.payerProfileId ?? null,
      note: bodyParsed.data?.note ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    if (result.status === "fulfillment_not_found") {
      res.status(404).json({ error: "fulfillment_not_found" });
      return;
    }
    if (result.status === "claim_exists") {
      res.status(409).json({
        error: "claim_exists",
        claimId: result.claimId,
        status: result.existingStatus,
        message:
          "This fulfillment already has an open claim. Work that claim instead of creating a duplicate.",
      });
      return;
    }

    const proposed = result.proposed;
    res.status(201).json({
      id: result.claimId,
      patientId: proposed.patientId,
      lineCount: result.lineCount,
      builderNotes: proposed.builderNotes,
      proposed: {
        payerProfileId: proposed.payerProfileId,
        payerName: proposed.payerName,
        diagnosisCodes: proposed.diagnosisCodes,
        renderingProviderId: proposed.renderingProviderId,
        referringProviderId: proposed.referringProviderId,
        priorAuthNumber: proposed.priorAuthNumber,
        lines: proposed.lines.map((l) => ({
          hcpcsCode: l.hcpcsCode,
          modifiers: l.modifiers,
          quantity: l.quantity,
          billedCents: l.billedCents,
          sourceKind: l.sourceKind,
          feeScheduleRowId: l.feeScheduleRowId,
        })),
      },
    });
  },
);

export default router;
