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

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, shopOrderNotes, shopOrders } from "@workspace/resupply-db";

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
    const db = drizzle(getDbPool());

    // Pre-check: order must exist. Same rationale as the customer
    // notes route — distinguish "no notes" (200 + empty array) from
    // "no order" (404).
    const exists = await db
      .select({ id: shopOrders.id })
      .from(shopOrders)
      .where(eq(shopOrders.id, orderId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    const rows = await db
      .select({
        id: shopOrderNotes.id,
        body: shopOrderNotes.body,
        authorEmail: shopOrderNotes.authorEmail,
        authorUserId: shopOrderNotes.authorUserId,
        createdAt: shopOrderNotes.createdAt,
      })
      .from(shopOrderNotes)
      .where(eq(shopOrderNotes.orderId, orderId))
      .orderBy(desc(shopOrderNotes.createdAt))
      .limit(50);

    // Safe log. NO note bodies; just the count + admin who looked.
    req.log?.info(
      {
        orderId,
        count: rows.length,
        adminEmail: req.adminEmail,
      },
      "admin.shop.order.notes.list",
    );

    res.json({
      notes: rows.map((r) => ({
        id: r.id,
        body: r.body ?? "",
        authorEmail: r.authorEmail,
        authorUserId: r.authorUserId,
        createdAt: r.createdAt.toISOString(),
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

    const db = drizzle(getDbPool());

    // Pre-check the order to map the FK violation to a clean 404.
    const exists = await db
      .select({ id: shopOrders.id })
      .from(shopOrders)
      .where(eq(shopOrders.id, orderId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    const inserted = await db
      .insert(shopOrderNotes)
      .values({
        orderId,
        body,
        authorEmail: req.adminEmail ?? "<unknown>",
        authorUserId: req.adminUserId ?? null,
      })
      .returning({
        id: shopOrderNotes.id,
        createdAt: shopOrderNotes.createdAt,
      });
    const row = inserted[0];
    if (!row) {
      throw new Error("INSERT returned no rows");
    }

    // Audit. Structural metadata only — same policy as the
    // shop_customer.note.create envelope.
    await logAudit({
      action: "shop_order.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_order_notes",
      targetId: row.id,
      metadata: { order_id: orderId, body_length: body.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_order.note.create audit write failed");
    });

    res.status(201).json({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
    });
  },
);

export default router;
