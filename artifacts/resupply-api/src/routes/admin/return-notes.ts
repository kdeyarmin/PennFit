// /admin/shop/returns/:returnId/notes — internal CSR-authored notes
// attached to a specific shop return.
//
//   GET  /admin/shop/returns/:returnId/notes  — list (newest first)
//   POST /admin/shop/returns/:returnId/notes  — append
//
// Mirrors /admin/shop/orders/:orderId/notes (Phase 14) — same audit
// posture, same structural-only envelope, same append-only policy.
// The only differences are the FK target (shop_returns) and the
// audit verb (`shop_return.note.create`) so reviewers can grep
// cleanly.
//
// PHI / log posture: the body may contain anything the CSR types
// (decision rationale, vendor response, replacement choice). The
// audit row records the return_id + body_length only — never the
// body content itself.

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  shopReturnNotes,
  shopReturns,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// `returnId` is the shop_returns.id (text-typed UUID per migration
// 0016). Canonical UUID string stored as text.
const returnIdParam = z
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
  "/admin/shop/returns/:returnId/notes",
  requireAdmin,
  async (req, res) => {
    const parsed = returnIdParam.safeParse(req.params.returnId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_return_id" });
      return;
    }
    const returnId = parsed.data;
    const db = drizzle(getDbPool());

    const exists = await db
      .select({ id: shopReturns.id })
      .from(shopReturns)
      .where(eq(shopReturns.id, returnId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "return_not_found" });
      return;
    }

    const rows = await db
      .select({
        id: shopReturnNotes.id,
        body: shopReturnNotes.body,
        authorEmail: shopReturnNotes.authorEmail,
        authorUserId: shopReturnNotes.authorUserId,
        createdAt: shopReturnNotes.createdAt,
      })
      .from(shopReturnNotes)
      .where(eq(shopReturnNotes.returnId, returnId))
      .orderBy(desc(shopReturnNotes.createdAt))
      .limit(50);

    req.log?.info(
      {
        returnId,
        count: rows.length,
        adminEmail: req.adminEmail,
      },
      "admin.shop.return.notes.list",
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
  "/admin/shop/returns/:returnId/notes",
  requireAdmin,
  async (req, res) => {
    const idCheck = returnIdParam.safeParse(req.params.returnId);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_return_id" });
      return;
    }
    const returnId = idCheck.data;

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

    const exists = await db
      .select({ id: shopReturns.id })
      .from(shopReturns)
      .where(eq(shopReturns.id, returnId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "return_not_found" });
      return;
    }

    const inserted = await db
      .insert(shopReturnNotes)
      .values({
        returnId,
        body,
        authorEmail: req.adminEmail ?? "<unknown>",
        authorUserId: req.adminUserId ?? null,
      })
      .returning({
        id: shopReturnNotes.id,
        createdAt: shopReturnNotes.createdAt,
      });
    const row = inserted[0];
    if (!row) {
      throw new Error("INSERT returned no rows");
    }

    await logAudit({
      action: "shop_return.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_return_notes",
      targetId: row.id,
      metadata: { return_id: returnId, body_length: body.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_return.note.create audit write failed");
    });

    res.status(201).json({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
    });
  },
);

export default router;
