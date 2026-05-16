// /admin/shop/products/:productId/compatibility — admin CRUD for
// the product-to-machine compatibility map (Phase B.3 / feature
// #11). Customer-side reads at routes/shop/product-compatibility.ts.
//
//   POST   /admin/shop/products/:productId/compatibility
//          — add a (manufacturer, model?) entry
//   DELETE /admin/shop/products/:productId/compatibility/:entryId
//          — remove an entry
//
// We keep the admin surface intentionally small — POST + DELETE
// only, no PATCH. A misclassified compatibility row is two clicks
// (delete + re-create) which beats a confused PATCH semantics
// where "changing the model" might mean "this isn't the same row
// anymore" anyway.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const productIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

const entryIdParam = z.string().uuid();

const addEntryBody = z
  .object({
    machineManufacturer: z.string().trim().min(1).max(120),
    machineModel: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .nullable()
      .transform((v) => (v && v.length > 0 ? v : null)),
    notes: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/products/:productId/compatibility",
  // Catalog mapping — `admin.tools.manage` matches the rest of
  // the cash-pay catalog admin surface (stock counts, thresholds,
  // back-in-stock dispatch).
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const idParsed = productIdParam.safeParse(req.params.productId);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const productId = idParsed.data;

    const bodyParsed = addEntryBody.safeParse(req.body);
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
    const { machineManufacturer, machineModel, notes } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_product_compatibility")
      .insert({
        product_id: productId,
        machine_manufacturer: machineManufacturer,
        machine_model: machineModel ?? null,
        notes: notes ?? null,
      })
      .select("id")
      .single();
    if (error) {
      // Unique-violation on (product, mfr, model) → 409 with a
      // friendly message instead of bubbling the constraint name.
      if (error.code === "23505") {
        res.status(409).json({
          error: "already_exists",
          message:
            "That product is already marked compatible with this machine.",
        });
        return;
      }
      throw error;
    }

    await logAudit({
      action: "shop_product_compatibility.add",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_product_compatibility",
      targetId: row.id,
      metadata: {
        product_id: productId,
        machine_manufacturer: machineManufacturer,
        // machine_model is part of the compatibility identity — log it too,
        // it's not PHI (machine model is a public catalog fact).
        machine_model: machineModel ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_product_compatibility.add audit write failed");
    });

    res.status(201).json({ id: row.id });
  },
);

router.delete(
  "/admin/shop/products/:productId/compatibility/:entryId",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const idParsed = productIdParam.safeParse(req.params.productId);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const productId = idParsed.data;

    const entryParsed = entryIdParam.safeParse(req.params.entryId);
    if (!entryParsed.success) {
      res.status(400).json({ error: "invalid_entry_id" });
      return;
    }
    const entryId = entryParsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: rowErr } = await supabase
      .schema("resupply")
      .from("shop_product_compatibility")
      .select("id, product_id, machine_manufacturer, machine_model")
      .eq("id", entryId)
      .limit(1)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row || row.product_id !== productId) {
      // Defense-in-depth: the URL contract is "this entry belongs
      // to this product". A mismatch could be a CSR clicking a
      // stale tab; either way we 404 rather than expose the row.
      res.status(404).json({ error: "compatibility_entry_not_found" });
      return;
    }

    const { error: delErr } = await supabase
      .schema("resupply")
      .from("shop_product_compatibility")
      .delete()
      .eq("id", entryId)
      .eq("product_id", productId);
    if (delErr) throw delErr;

    await logAudit({
      action: "shop_product_compatibility.remove",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_product_compatibility",
      targetId: entryId,
      metadata: {
        product_id: productId,
        manufacturer: row.machine_manufacturer,
        model: row.machine_model,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "shop_product_compatibility.remove audit write failed",
      );
    });

    res.json({ id: entryId, deleted: true });
  },
);

export default router;
