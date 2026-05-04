// /admin/shop/customers/:userId/notes — internal CSR-authored
// notes attached to a shop customer.
//
//   GET  /admin/shop/customers/:userId/notes  — list (newest first)
//   POST /admin/shop/customers/:userId/notes  — append
//
// Mirrors `routes/patients/notes-{list,create}.ts` for the shop side.
// See `lib/resupply-db/src/schema/shop-customer-notes.ts` for the
// table policy (append-only, no PATCH/DELETE in v1, internal-only).
//
// Why a separate route family from /admin/shop/customers/:userId
// (the customer-360 detail endpoint): notes are their own write
// surface with their own audit verb (`shop_customer.note.create`)
// and their own load cadence (the dashboard renders them in a
// dedicated panel, not tucked inside the heavy customer detail
// fetch). Splitting keeps each surface narrow.
//
// PHI / log posture (mirrors patient notes): the note body is
// stored as plaintext text and may contain whatever the CSR wrote.
// The audit row records the customer_id + body_length only — never
// the body itself.

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  shopCustomerNotes,
  shopCustomers,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// `userId` is the shop_customers.customer_id (sourced from
// auth.users.id). Same regex as the existing customer detail route
// (`routes/admin/customers.ts:userIdParam`) — opaque, alphanumeric
// + `_` + `-`.
const userIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

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
  "/admin/shop/customers/:userId/notes",
  requireAdmin,
  async (req, res) => {
    const parsed = userIdParam.safeParse(req.params.userId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = parsed.data;
    const db = drizzle(getDbPool());

    // Pre-check: customer must exist. We could rely on the FK to
    // surface a 23503 on insert (POST), but for GET we want to
    // distinguish "no notes" (200 + empty array) from "no
    // customer" (404).
    const exists = await db
      .select({ id: shopCustomers.customerId })
      .from(shopCustomers)
      .where(eq(shopCustomers.customerId, userId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "customer_not_found" });
      return;
    }

    const rows = await db
      .select({
        id: shopCustomerNotes.id,
        body: shopCustomerNotes.body,
        authorEmail: shopCustomerNotes.authorEmail,
        authorUserId: shopCustomerNotes.authorUserId,
        createdAt: shopCustomerNotes.createdAt,
      })
      .from(shopCustomerNotes)
      .where(eq(shopCustomerNotes.customerId, userId))
      .orderBy(desc(shopCustomerNotes.createdAt))
      .limit(50);

    // Audit. Structural metadata only — body content is never emitted.
    await logAudit({
      action: "shop_customer.notes.list",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_customer_notes",
      targetId: userId,
      metadata: { customer_id: userId, count: rows.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_customer.notes.list audit write failed");
    });

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
  "/admin/shop/customers/:userId/notes",
  requireAdmin,
  async (req, res) => {
    const idCheck = userIdParam.safeParse(req.params.userId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const userId = idCheck.data;

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

    // Pre-check the customer to map the FK violation to a clean 404.
    const exists = await db
      .select({ id: shopCustomers.customerId })
      .from(shopCustomers)
      .where(eq(shopCustomers.customerId, userId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "customer_not_found" });
      return;
    }

    const inserted = await db
      .insert(shopCustomerNotes)
      .values({
        customerId: userId,
        body,
        authorEmail: req.adminEmail ?? "<unknown>",
        authorUserId: req.adminUserId ?? null,
      })
      .returning({
        id: shopCustomerNotes.id,
        createdAt: shopCustomerNotes.createdAt,
      });
    const row = inserted[0];
    if (!row) {
      throw new Error("INSERT returned no rows");
    }

    // Audit. Structural metadata only — `body_length` lets reviewers
    // spot suspiciously long pastes (paste-attack from a clipboard,
    // accidental dump of an email body) without exposing contents.
    await logAudit({
      action: "shop_customer.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_customer_notes",
      targetId: row.id,
      metadata: { customer_id: userId, body_length: body.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_customer.note.create audit write failed");
    });

    res.status(201).json({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
    });
  },
);

export default router;
