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

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

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
  // Read-only — list of CSR notes on this return. `returns.read`.
  requirePermission("returns.read"),
  async (req, res) => {
    const parsed = returnIdParam.safeParse(req.params.returnId);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_return_id" });
      return;
    }
    const returnId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: ret } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .select("id")
      .eq("id", returnId)
      .limit(1)
      .maybeSingle();
    if (!ret) {
      res.status(404).json({ error: "return_not_found" });
      return;
    }

    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("shop_return_notes")
      .select("id, body, author_email, author_user_id, created_at")
      .eq("return_id", returnId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    req.log?.info(
      {
        returnId,
        count: rows?.length ?? 0,
        adminEmail: req.adminEmail,
      },
      "admin.shop.return.notes.list",
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
  "/admin/shop/returns/:returnId/notes",
  // Append-only — CSR notes attached to the return. `returns.manage`.
  requirePermission("returns.manage"),
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

    const supabase = getSupabaseServiceRoleClient();

    const { data: ret } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .select("id")
      .eq("id", returnId)
      .limit(1)
      .maybeSingle();
    if (!ret) {
      res.status(404).json({ error: "return_not_found" });
      return;
    }

    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("shop_return_notes")
      .insert({
        return_id: returnId,
        body,
        author_email: req.adminEmail ?? "<unknown>",
        author_user_id: req.adminUserId ?? null,
      })
      .select("id, created_at")
      .single();
    if (insErr) throw insErr;

    await logAudit({
      action: "shop_return.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_return_notes",
      targetId: inserted.id,
      metadata: { return_id: returnId, body_length: body.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_return.note.create audit write failed");
    });

    res.status(201).json({
      id: inserted.id,
      createdAt: inserted.created_at,
    });
  },
);

export default router;
