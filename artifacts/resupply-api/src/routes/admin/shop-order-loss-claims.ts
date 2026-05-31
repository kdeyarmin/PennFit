// /admin/shop/orders/:orderId/loss-claims — lost-shipment lifecycle.
//
//   GET   /admin/shop/orders/:orderId/loss-claims    — claims for one order
//   POST  /admin/shop/orders/:orderId/loss-claims    — open new claim
//   PATCH /admin/shop/loss-claims/:id                — state moves +
//                                                       carrier-claim-number +
//                                                       resolution-note

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type ClaimStatus =
  | "open"
  | "carrier_filed"
  | "resolved_refunded"
  | "resolved_reshipped"
  | "closed_unresolved";

const TERMINAL = new Set<ClaimStatus>([
  "resolved_refunded",
  "resolved_reshipped",
  "closed_unresolved",
]);

function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  if (TERMINAL.has(from)) return false;
  if (from === "open") {
    return (
      to === "carrier_filed" ||
      to === "resolved_refunded" ||
      to === "resolved_reshipped" ||
      to === "closed_unresolved"
    );
  }
  return TERMINAL.has(to);
}

router.get(
  "/admin/shop/orders/:orderId/loss-claims",
  requirePermission("returns.read"),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("shop_order_loss_claims")
      .select(
        "id, order_id, opened_by_user_id, status, carrier_claim_number, resolution_note, opened_at, carrier_filed_at, resolved_at, created_at, updated_at",
      )
      .eq("order_id", idParse.data)
      .order("opened_at", { ascending: false });
    if (error) throw error;
    res.json({
      claims: (data ?? []).map((r) => ({
        id: r.id,
        orderId: r.order_id,
        openedByUserId: r.opened_by_user_id,
        status: r.status,
        carrierClaimNumber: r.carrier_claim_number,
        resolutionNote: r.resolution_note,
        openedAt: r.opened_at,
        carrierFiledAt: r.carrier_filed_at,
        resolvedAt: r.resolved_at,
      })),
    });
  },
);

const createBody = z
  .object({
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

router.post(
  "/admin/shop/orders/:orderId/loss-claims",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "loss_claims.open", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_order_loss_claims")
      .insert({
        order_id: idParse.data,
        opened_by_user_id: req.adminUserId ?? null,
        status: "open",
        resolution_note: parsed.data.note ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "shop.order.loss_claim.opened",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_order_loss_claims",
      targetId: row.id,
      metadata: { order_id: idParse.data },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "loss_claim.opened audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

const patchBody = z
  .object({
    status: z
      .enum([
        "open",
        "carrier_filed",
        "resolved_refunded",
        "resolved_reshipped",
        "closed_unresolved",
      ])
      .optional(),
    carrierClaimNumber: z.string().trim().min(1).max(64).nullable().optional(),
    resolutionNote: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.patch(
  "/admin/shop/loss-claims/:id",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "loss_claims.update", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: prior, error: priorErr } = await supabase
      .schema("resupply")
      .from("shop_order_loss_claims")
      .select("id, status, order_id")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (priorErr) throw priorErr;
    if (!prior) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const update: {
      status?: ClaimStatus;
      carrier_claim_number?: string | null;
      resolution_note?: string | null;
      carrier_filed_at?: string;
      resolved_at?: string;
      updated_at: string;
    } = { updated_at: new Date().toISOString() };
    if (parsed.data.status) {
      if (!canTransition(prior.status as ClaimStatus, parsed.data.status)) {
        res.status(409).json({
          error: "illegal_transition",
          message: `Cannot move ${prior.status.replace(/_/g, " ")} → ${parsed.data.status.replace(/_/g, " ")}.`,
        });
        return;
      }
      update.status = parsed.data.status;
      if (parsed.data.status === "carrier_filed") {
        update.carrier_filed_at = new Date().toISOString();
      }
      if (TERMINAL.has(parsed.data.status)) {
        update.resolved_at = new Date().toISOString();
      }
    }
    if (parsed.data.carrierClaimNumber !== undefined) {
      update.carrier_claim_number = parsed.data.carrierClaimNumber;
    }
    if (parsed.data.resolutionNote !== undefined) {
      update.resolution_note = parsed.data.resolutionNote;
    }
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("shop_order_loss_claims")
      .update(update)
      .eq("id", idParse.data);
    if (updErr) throw updErr;
    if (parsed.data.status && parsed.data.status !== prior.status) {
      await logAudit({
        action: "shop.order.loss_claim.transitioned",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "shop_order_loss_claims",
        targetId: idParse.data,
        metadata: {
          order_id: prior.order_id,
          from: prior.status,
          to: parsed.data.status,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "loss_claim.transitioned audit failed");
      });
    }
    res.json({ ok: true });
  },
);

export default router;
