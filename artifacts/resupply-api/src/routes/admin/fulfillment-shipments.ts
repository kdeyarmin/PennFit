// fulfillment-shipments.ts — per-order shipment evidence, by hand.
//
// The PacWare shipment import is the bulk path. This is the other half:
// a tenant that does not run PacWare has no ship feed at all, and even a
// tenant that does needs a way to correct one row without re-importing a
// file.
//
// PERMISSION: `orders.create`, the same gate the CSR order flow uses.
// "I put this box on the truck" is a daily CSR action, not a supervisor
// one. `billing.manage` would be wrong — a biller does not know what
// shipped — and `admin.tools.manage` (the PacWare tier) is right for a
// bulk import and too narrow for a per-row correction.
//
// The ship date is clamped exactly as the import clamps it, and for the
// same reason: this date becomes the date of service on an 837P
// (lib/billing/claim-builder.ts:197), so a fat-fingered year would mint a
// claim outside its timely-filing window.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import { FULFILLMENT_CANCELLED } from "@workspace/resupply-domain";

import { closeEpisode } from "../../lib/episodes/close-episode";
import { recordShipmentEvidence } from "../../lib/fulfillments/record-shipment-evidence";
import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { withIdempotency } from "../../middlewares/idempotency";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SHIP_BACKDATE_DAYS = 180;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const markShippedSchema = z
  .object({
    shippedAt: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    deliveredAt: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    trackingNumber: z.string().trim().max(64).optional(),
    carrier: z.string().trim().max(64).optional(),
    pacwareOrderRef: z.string().trim().max(64).optional(),
  })
  .strict();

const cancelSchema = z
  .object({
    reason: z.enum([
      "csr_canceled",
      "duplicate",
      "patient_inactive",
      "coverage_lost",
    ]),
  })
  .strict();

const uuidSchema = z.string().uuid();

/** Midday UTC so a date-only value does not drift across a day boundary
 *  when read back in a US timezone. */
function atMiddayUtc(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00.000Z`);
}

function shipDateProblem(shippedAt: Date, now: Date): string | null {
  if (!Number.isFinite(shippedAt.getTime())) return "not a real date";
  if (shippedAt.getTime() - now.getTime() > DAY_MS) {
    return "that ship date is in the future";
  }
  if (now.getTime() - shippedAt.getTime() > MAX_SHIP_BACKDATE_DAYS * DAY_MS) {
    return `that ship date is more than ${MAX_SHIP_BACKDATE_DAYS} days old. Recording it would date this patient's claim that far back, which can miss the payer's filing deadline.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /admin/fulfillments/:fulfillmentId/mark-shipped
// ---------------------------------------------------------------------------
router.post(
  "/admin/fulfillments/:fulfillmentId/mark-shipped",
  adminWriteRateLimiter,
  requirePermission("orders.create"),
  withIdempotency("POST /admin/fulfillments/:id/mark-shipped"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const id = uuidSchema.safeParse(req.params.fulfillmentId);
    if (!id.success) {
      res.status(400).json({ error: "invalid_fulfillment_id" });
      return;
    }

    const parsed = markShippedSchema.safeParse(req.body);
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

    const shippedAt = atMiddayUtc(parsed.data.shippedAt);
    const problem = shipDateProblem(shippedAt, new Date());
    if (problem) {
      res.status(400).json({ error: "invalid_ship_date", message: problem });
      return;
    }

    const deliveredAt = parsed.data.deliveredAt
      ? atMiddayUtc(parsed.data.deliveredAt)
      : null;
    if (deliveredAt && deliveredAt.getTime() < shippedAt.getTime()) {
      res.status(400).json({
        error: "invalid_delivery_date",
        message: "the delivery date is before the ship date",
      });
      return;
    }

    let outcome;
    try {
      outcome = await recordShipmentEvidence({
        orgId,
        fulfillmentId: id.data,
        shippedAt,
        deliveredAt,
        source: "admin_manual",
        pacwareOrderRef: parsed.data.pacwareOrderRef ?? null,
        trackingNumber: parsed.data.trackingNumber ?? null,
        carrier: parsed.data.carrier ?? null,
      });
    } catch (err) {
      logger.error(
        {
          event: "fulfillment.mark_shipped_failed",
          fulfillmentId: id.data,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "mark-shipped: write failed",
      );
      res.status(503).json({ error: "write_failed" });
      return;
    }

    if (outcome.status === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (outcome.status === "not_shippable") {
      res.status(409).json({
        error: "not_shippable",
        message: "that order was cancelled, so it cannot be marked shipped.",
      });
      return;
    }

    await logAudit({
      action: "fulfillment.marked_shipped",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fulfillments",
      targetId: id.data,
      metadata: {
        // Structural only — no tracking number (a carrier lookup key tied
        // to a patient's address) and no patient id.
        source: "admin_manual",
        ship_date: parsed.data.shippedAt,
        outcome: outcome.status,
        episode_closed: outcome.episodeClosed,
        next_cycle_opened: outcome.nextEpisodeCreated,
        next_cycle_reanchored: outcome.reanchored,
      },
    });

    res.status(200).json({
      status: outcome.status,
      episodeClosed: outcome.episodeClosed,
      nextEpisodeId: outcome.nextEpisodeId,
      nextEpisodeCreated: outcome.nextEpisodeCreated,
      reanchored: outcome.reanchored,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /admin/fulfillments/:fulfillmentId/cancel
//
// Cancelling a queued line is the other half of closing the loop: without
// it, an order PacWare voided sits `queued` forever, blocks the next cycle
// (the grace sweep would eventually "assume" it shipped), and counts as an
// open dispense against the patient's entitlement.
//
// Writes FULFILLMENT_CANCELLED — the double-L spelling. Every cadence
// filter in the app excludes `"cancelled"`; a single-L write would slip
// past them and be counted as a real dispense, silently suppressing this
// patient's next reminder.
// ---------------------------------------------------------------------------
router.post(
  "/admin/fulfillments/:fulfillmentId/cancel",
  adminWriteRateLimiter,
  requirePermission("orders.create"),
  withIdempotency("POST /admin/fulfillments/:id/cancel"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const id = uuidSchema.safeParse(req.params.fulfillmentId);
    if (!id.success) {
      res.status(400).json({ error: "invalid_fulfillment_id" });
      return;
    }

    const parsed = cancelSchema.safeParse(req.body);
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

    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();

    const { data: row, error: readErr } = await supabase
      .from("fulfillments")
      .select("id, episode_id, shipped_at, status")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle();
    if (readErr) {
      res.status(503).json({ error: "read_failed" });
      return;
    }
    const fulfillment = row as {
      episode_id: string | null;
      shipped_at: string | null;
      status: string | null;
    } | null;
    if (!fulfillment) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // A shipped order is a fact about the world; cancelling it would erase
    // the date of service a claim may already have been built on.
    if (fulfillment.shipped_at) {
      res.status(409).json({
        error: "already_shipped",
        message:
          "that order has already shipped. Cancel it in PacWare and process a return instead.",
      });
      return;
    }

    const { error: updErr } = await supabase
      .from("fulfillments")
      .update({ status: FULFILLMENT_CANCELLED, updated_at: nowIso })
      .eq("id", id.data)
      .is("shipped_at", null);
    if (updErr) {
      res.status(503).json({ error: "write_failed" });
      return;
    }

    // Close the episode too, or the ladder keeps waiting on an order that
    // is never coming.
    let episodeClosed = false;
    if (fulfillment.episode_id) {
      try {
        const closed = await closeEpisode({
          orgId,
          episodeId: fulfillment.episode_id,
          status: "canceled",
          reason: parsed.data.reason,
          allowFromConfirmed: true,
        });
        episodeClosed = closed.closed;
      } catch (err) {
        logger.warn(
          {
            event: "fulfillment.cancel_episode_close_failed",
            fulfillmentId: id.data,
            errName: err instanceof Error ? err.name : "unknown",
          },
          "fulfillment cancel: episode close-out failed",
        );
      }
    }

    await logAudit({
      action: "fulfillment.canceled",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "fulfillments",
      targetId: id.data,
      metadata: { reason: parsed.data.reason, episode_closed: episodeClosed },
    });

    res.status(200).json({ status: "cancelled", episodeClosed });
  },
);

export default router;
