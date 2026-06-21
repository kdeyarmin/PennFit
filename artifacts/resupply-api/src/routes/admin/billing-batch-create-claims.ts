// POST /admin/billing/fulfillments/batch-create-claims
//
// Bulk version of POST /admin/fulfillments/:id/create-claim. Given a list of
// fulfillment ids, creates one draft claim per fulfillment, reusing the SAME
// `createClaimFromFulfillment` core as the single route (so the two paths
// can't diverge). Per-item isolation: one fulfillment failing — missing,
// already-claimed, or an unexpected DB error — never aborts the batch; each
// id gets its own result row. Always returns 200 with the per-id outcome
// list + a roll-up summary so the worklist UI can report "12 created, 2
// already billed, 1 needs attention" after a single click.
//
// This converts the read-only "fulfillments to bill" worklist into a
// one-click batch, which is the throughput/faster-cash lever: clean claims
// stop aging in the queue waiting for a CSR to click "create claim" N times.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { createClaimFromFulfillment } from "../../lib/billing/create-claim-from-fulfillment";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    fulfillmentIds: z.array(z.string().uuid()).min(1).max(100),
    /** Optional shared date-of-service override applied to every claim. */
    dateOfService: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

type BatchItemStatus =
  | "created"
  | "claim_exists"
  | "fulfillment_not_found"
  | "error";

interface BatchItemResult {
  fulfillmentId: string;
  status: BatchItemStatus;
  claimId?: string | null;
  existingStatus?: string | null;
  lineCount?: number;
}

router.post(
  "/admin/billing/fulfillments/batch-create-claims",
  // Same gate as the single create-claim route.
  requirePermission("conversations.manage"),
  adminRateLimit({
    name: "fulfillments.batch_create_claims",
    preset: "mutation",
  }),
  async (req, res) => {
    const parsed = body.safeParse(req.body ?? {});
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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    // De-dupe the input — a double-add in the UI shouldn't issue two creates
    // for one fulfillment (the per-fulfillment open-claim unique index also
    // guards, but skipping the wasted round-trip keeps the result list clean).
    const uniqueIds = Array.from(new Set(parsed.data.fulfillmentIds));

    // Resolve the bill-hold flag ONCE for the whole batch rather than
    // per item.
    const billHoldEnabled = await isFeatureEnabled("billing.bill_hold", orgId);

    const results: BatchItemResult[] = [];
    for (const fulfillmentId of uniqueIds) {
      try {
        const r = await createClaimFromFulfillment({
          fulfillmentId,
          orgId,
          actorEmail: req.adminEmail ?? null,
          actorUserId: req.adminUserId ?? null,
          billHoldEnabled,
          dateOfServiceOverride: parsed.data.dateOfService ?? null,
          note: parsed.data.note ?? null,
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
        if (r.status === "created") {
          results.push({
            fulfillmentId,
            status: "created",
            claimId: r.claimId,
            lineCount: r.lineCount,
          });
        } else if (r.status === "claim_exists") {
          results.push({
            fulfillmentId,
            status: "claim_exists",
            claimId: r.claimId,
            existingStatus: r.existingStatus,
          });
        } else {
          results.push({ fulfillmentId, status: "fulfillment_not_found" });
        }
      } catch (err) {
        // Per-item isolation: an unexpected DB error on one fulfillment is
        // logged + recorded but must not abort the rest of the batch.
        logger.warn(
          { err, fulfillmentId },
          "batch-create-claims: item failed (isolated)",
        );
        results.push({ fulfillmentId, status: "error" });
      }
    }

    const summary = {
      requested: uniqueIds.length,
      created: results.filter((r) => r.status === "created").length,
      claimExists: results.filter((r) => r.status === "claim_exists").length,
      notFound: results.filter((r) => r.status === "fulfillment_not_found")
        .length,
      errored: results.filter((r) => r.status === "error").length,
    };

    res.status(200).json({ summary, results });
  },
);

export default router;
