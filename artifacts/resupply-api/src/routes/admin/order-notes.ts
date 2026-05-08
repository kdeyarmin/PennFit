// /admin/shop/orders/:orderId/notes — internal CSR-authored notes
// attached to a specific shop order.
//
//   GET  /admin/shop/orders/:orderId/notes  — list (newest first)
//   POST /admin/shop/orders/:orderId/notes  — append
//
// Mirrors /admin/shop/customers/:userId/notes (Phase 10, see
// `customer-notes.ts`) — same audit posture, same structural-only
// envelope, same append-only policy. The only differences are the
// FK target (shop_orders) and the audit verb
// (`shop_order.note.create`) so reviewers can grep cleanly.
//
// Why a separate note family from shop_customer_notes:
//   * Notes about delivery escalations, address corrections, refund
//     rationale belong WITH the order so they survive even when the
//     same customer has many orders.
//   * The CSR working a fulfillment issue wants the note tied to
//     the artifact they're triaging, not to the person.
//
// PHI / log posture: the body may contain anything the CSR types.
// The audit row records the order_id + body_length only — never
// the body content itself.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// `orderId` is the shop_orders.id (text-typed UUID per migration 0001).
// Validate it as a canonical UUID so this route stays consistent with
// the existing shop-orders admin routes.
const orderIdParam = z
  .string()
  .trim()
  .uuid();

const bodySchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Note body cannot be empty.")
      .max(4000, "Note body must be 4000 characters or fewer."),
  })
  .strict();

router.get(
  "/admin/shop/orders/:orderId/notes",
  requireAdmin,
  async (req, res) => {
    const parsed = orderIdParam.safeParse(req.params.orderId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orderId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    // Pre-check: order must exist. Same rationale as the customer
    // notes route — distinguish "no notes" (200 + empty array) from
    // "no order" (404).
    const { data: order } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id")
      .eq("id", orderId)
      .limit(1)
      .maybeSingle();
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("shop_order_notes")
      .select("id, body, author_email, author_user_id, created_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    // Safe log. NO note bodies; just the count + admin who looked.
    req.log?.info(
      {
        orderId,
        count: rows?.length ?? 0,
        adminEmail: req.adminEmail,
      },
      "admin.shop.order.notes.list",
    );

    res.json({
      notes: (rows ?? []).map((r) => ({
        id: r.id,
        body: r.body ?? "",
        authorEmail: r.author_email,
        authorUserId: r.author_user_id,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/admin/shop/orders/:orderId/notes",
  requireAdmin,
  async (req, res) => {
    const idCheck = orderIdParam.safeParse(req.params.orderId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const orderId = idCheck.data;

    const bodyParsed = bodySchema.safeParse(req.body);
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
    const { body } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Pre-check the order to map the FK violation to a clean 404.
    const { data: order } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id")
      .eq("id", orderId)
      .limit(1)
      .maybeSingle();
    if (!order) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("shop_order_notes")
      .insert({
        order_id: orderId,
        body,
        author_email: req.adminEmail ?? "<unknown>",
        author_user_id: req.adminUserId ?? null,
      })
      .select("id, created_at")
      .single();
    if (insErr) throw insErr;

    // Audit. Structural metadata only — same policy as the
    // shop_customer.note.create envelope.
    await logAudit({
      action: "shop_order.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_order_notes",
      targetId: inserted.id,
      metadata: { order_id: orderId, body_length: body.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_order.note.create audit write failed");
    });

    res.status(201).json({
      id: inserted.id,
      createdAt: inserted.created_at,
    });
  },
);

export default router;
