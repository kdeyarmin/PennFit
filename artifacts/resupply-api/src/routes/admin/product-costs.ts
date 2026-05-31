// /admin/product-costs — operator-managed unit cost (COGS) per shop SKU.
//
//   GET /admin/product-costs        — list current costs (by SKU)
//   PUT /admin/product-costs/:sku   — upsert the cost for one SKU
//
// Backs the cost-capture foundation (migration 0186). The figures here
// are the source the per-transaction snapshot columns are stamped from,
// and feed every owner-facing margin surface via the pure
// computeMargin / aggregateMargin helpers in @workspace/resupply-domain.
//
// Access posture: cost / COGS / margin is owner-and-management data, so
// reads gate on `cost.read` and writes on `cost.write` — both held by
// the admin effective bucket (supervisor + compliance_officer) and
// super_admin, and explicitly OFF the front-line customer_service_rep
// bucket.
//
// Log / audit posture: unlike the note routes (whose bodies are PHI and
// are redacted), a unit cost is NOT PHI, so the audit envelope records
// the sku + cents for a clean money trail.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Shop SKUs are short uppercase-dashed identifiers (MASK, CUSHION,
// FILTER-DISP, …). Permissive but bounded; rejects whitespace/control
// chars so a fat-fingered path doesn't reach the DB.
const skuParam = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "SKU contains unsupported characters.");

const upsertSchema = z
  .object({
    // Landed unit cost (COGS), integer cents. Upper bound is a sanity
    // guard against a dollars-vs-cents fat-finger ($1,000,000.00 cap).
    unitCostCents: z
      .number()
      .int("Unit cost must be a whole number of cents.")
      .min(0, "Unit cost cannot be negative.")
      .max(100_000_000, "Unit cost is implausibly large."),
    currency: z.string().trim().length(3).optional(),
    costSource: z.enum(["manual", "invoice", "catalog", "estimate"]).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

router.get(
  "/admin/product-costs",
  requirePermission("cost.read"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("product_costs")
      .select(
        "sku, unit_cost_cents, currency, cost_source, effective_from, notes, updated_at",
      )
      .order("sku", { ascending: true })
      .limit(1000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    // Safe log: count + who looked. No PHI here (cost is not PHI), but
    // we keep list logs to counts for consistency with the other admin
    // list routes.
    req.log?.info(
      { count: rows?.length ?? 0, adminEmail: req.adminEmail },
      "admin.product_costs.list",
    );

    res.json({
      costs: (rows ?? []).map((r) => ({
        sku: r.sku,
        unitCostCents: r.unit_cost_cents,
        currency: r.currency,
        costSource: r.cost_source,
        effectiveFrom: r.effective_from,
        notes: r.notes,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.put(
  "/admin/product-costs/:sku",
  requirePermission("cost.write"),
  adminRateLimit({ name: "product_costs.upsert", preset: "mutation" }),
  async (req, res) => {
    const skuCheck = skuParam.safeParse(req.params.sku);
    if (!skuCheck.success) {
      res.status(400).json({ error: "invalid_sku" });
      return;
    }
    const sku = skuCheck.data;

    const parsed = upsertSchema.safeParse(req.body);
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
    const { unitCostCents, currency, costSource, notes } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const resolvedSource = costSource ?? "manual";
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("product_costs")
      .upsert(
        {
          sku,
          unit_cost_cents: unitCostCents,
          currency: (currency ?? "usd").toLowerCase(),
          cost_source: resolvedSource,
          notes: notes ?? null,
          effective_from: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "sku" },
      )
      .select(
        "sku, unit_cost_cents, currency, cost_source, effective_from, updated_at",
      )
      .single();
    if (error) {
      res.status(500).json({ error: "upsert_failed", message: error.message });
      return;
    }

    // Cost is not PHI — safe to record the figure in the audit envelope.
    await logAudit({
      action: "product_cost.upsert",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "product_costs",
      targetId: sku,
      metadata: {
        sku,
        unit_cost_cents: unitCostCents,
        cost_source: resolvedSource,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "product_cost.upsert audit write failed");
    });

    res.status(200).json({
      sku: row.sku,
      unitCostCents: row.unit_cost_cents,
      currency: row.currency,
      costSource: row.cost_source,
      effectiveFrom: row.effective_from,
      updatedAt: row.updated_at,
    });
  },
);

export default router;
