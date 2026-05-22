// /admin/shop/inventory/reconciliations/* — monthly inventory
// reconciliation workflow.
//
// Flow:
//   POST   /admin/shop/inventory/reconciliations         — start a draft
//   GET    /admin/shop/inventory/reconciliations         — list history
//   GET    /admin/shop/inventory/reconciliations/:id     — header + lines
//   POST   /admin/shop/inventory/reconciliations/:id/submit
//                                                        — submit with counts
//
// Why a workflow table (vs ad-hoc stock edits): a monthly count is a
// compliance artifact (DME accreditation, surveyor evidence) — the
// fact that an admin counted the shelf on a given date and what the
// variance was needs to survive future stock edits. The existing
// PATCH /admin/shop/products/:id/stock endpoint is the right surface
// for one-off adjustments; reconciliation is the periodic, batched
// "everything at once with a paper trail" surface.
//
// Stripe-as-truth: live stock_count + low_stock_threshold continue to
// live in Stripe metadata (see lib/stripe/products-meta.ts). At submit
// time we read the catalog fresh, snapshot system_count per line, and
// optionally write the new counted_qty back to Stripe so the catalog
// reflects the physical count.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  projectProduct,
  type ShopProductView,
} from "../../lib/stripe/products-meta";

const router: IRouter = Router();

// Fetch every active shop product, projected through the same gate
// the public storefront uses. Returns null when Stripe is not
// configured so the caller can respond with 503. Pages through
// `starting_after` with a hard cap of 10 pages (1000 products) as
// defense-in-depth — mirrors the pattern in
// `routes/admin/shop-back-in-stock.ts`.
async function listShopProductsForReconciliation(): Promise<
  ShopProductView[] | null
> {
  const config = readStripeConfigOrNull();
  if (!config) return null;
  const stripe = getStripeClient(config);
  const all: ShopProductView[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ["data.default_price"],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const p of list.data) {
      const projected = projectProduct(p);
      if (projected) all.push(projected);
    }
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1]!.id;
  }
  return all;
}

// Period label: "2026-05" is the canonical form; we accept anything
// 2-60 chars to allow ad-hoc strings like "Q2 spot-check" without
// over-constraining the operator. The header is informational — we
// don't drive any queries off the value.
const periodLabelSchema = z
  .string()
  .trim()
  .min(2, "Period label must be at least 2 characters.")
  .max(60, "Period label must be 60 characters or fewer.");

const startBodySchema = z
  .object({
    periodLabel: periodLabelSchema,
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

const idParamSchema = z.string().uuid();

const lineSchema = z
  .object({
    productId: z
      .string()
      .trim()
      .startsWith("prod_", "productId must be a Stripe product id"),
    countedQty: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const submitBodySchema = z
  .object({
    lines: z.array(lineSchema).min(1).max(500),
    applyToStripe: z.boolean(),
  })
  .strict();

// POST /admin/shop/inventory/reconciliations — start a draft.
router.post(
  "/admin/shop/inventory/reconciliations",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "inventory_reconciliation.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = startBodySchema.safeParse(req.body);
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
    const { periodLabel, notes } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("inventory_reconciliations")
      .insert({
        period_label: periodLabel,
        status: "draft",
        started_by_email: req.adminEmail ?? "<unknown>",
        started_by_user_id: req.adminUserId ?? null,
        notes: notes ?? null,
      })
      .select("id, started_at")
      .single();
    if (insErr) {
      logger.error(
        { err: insErr },
        "inventory_reconciliation.create insert failed",
      );
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    await logAudit({
      action: "inventory_reconciliation.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "inventory_reconciliations",
      targetId: inserted.id,
      metadata: { period_label: periodLabel },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "inventory_reconciliation.create audit write failed",
      );
    });

    res.status(201).json({
      id: inserted.id,
      startedAt: inserted.started_at,
    });
  },
);

// GET /admin/shop/inventory/reconciliations — list history (newest first).
router.get(
  "/admin/shop/inventory/reconciliations",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("inventory_reconciliations")
      .select(
        "id, period_label, status, started_by_email, started_at, submitted_at, total_lines, total_variance_units, applied_to_stripe",
      )
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    res.json({
      reconciliations: (rows ?? []).map((r) => ({
        id: r.id,
        periodLabel: r.period_label,
        status: r.status,
        startedByEmail: r.started_by_email,
        startedAt: r.started_at,
        submittedAt: r.submitted_at,
        totalLines: r.total_lines,
        totalVarianceUnits: r.total_variance_units,
        appliedToStripe: r.applied_to_stripe,
      })),
    });
  },
);

// GET /admin/shop/inventory/reconciliations/:id — header + lines.
//
// When the reconciliation is still in `draft`, we also attach the
// current Stripe catalog as `currentProducts` so the edit page can
// render a row per SKU with the live system_count. For submitted
// reconciliations we return only the persisted lines (the catalog
// at submit time, not what Stripe shows now).
router.get(
  "/admin/shop/inventory/reconciliations/:id",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: header, error: headerErr } = await supabase
      .schema("resupply")
      .from("inventory_reconciliations")
      .select(
        "id, period_label, status, started_by_email, started_by_user_id, started_at, submitted_at, notes, total_lines, total_variance_units, applied_to_stripe",
      )
      .eq("id", id)
      .maybeSingle();
    if (headerErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: headerErr.message });
      return;
    }
    if (!header) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: lines, error: linesErr } = await supabase
      .schema("resupply")
      .from("inventory_reconciliation_lines")
      .select(
        "id, product_id, product_name, system_count, counted_qty, variance, applied, created_at",
      )
      .eq("reconciliation_id", id)
      .order("product_name", { ascending: true });
    if (linesErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: linesErr.message });
      return;
    }

    // For drafts, fetch the live catalog so the UI can render the
    // count-entry grid without a separate round-trip. We don't
    // surface a Stripe outage as a 503 here — the operator still
    // benefits from seeing the header; the grid renders an
    // "inventory snapshot unavailable" banner client-side.
    let currentProducts: Array<{
      productId: string;
      name: string;
      category: string;
      systemCount: number | null;
      lowStockThreshold: number | null;
    }> | null = null;
    if (header.status === "draft") {
      try {
        const products = await listShopProductsForReconciliation();
        if (products) {
          currentProducts = products.map((p) => ({
            productId: p.id,
            name: p.name,
            category: p.category,
            systemCount: p.stockCount,
            lowStockThreshold: p.lowStockThreshold,
          }));
        }
      } catch (err) {
        logger.warn(
          { err },
          "inventory_reconciliation: live catalog fetch failed",
        );
      }
    }

    res.json({
      reconciliation: {
        id: header.id,
        periodLabel: header.period_label,
        status: header.status,
        startedByEmail: header.started_by_email,
        startedByUserId: header.started_by_user_id,
        startedAt: header.started_at,
        submittedAt: header.submitted_at,
        notes: header.notes,
        totalLines: header.total_lines,
        totalVarianceUnits: header.total_variance_units,
        appliedToStripe: header.applied_to_stripe,
      },
      lines: (lines ?? []).map((l) => ({
        id: l.id,
        productId: l.product_id,
        productName: l.product_name,
        systemCount: l.system_count,
        countedQty: l.counted_qty,
        variance: l.variance,
        applied: l.applied,
        createdAt: l.created_at,
      })),
      currentProducts,
    });
  },
);

// POST /admin/shop/inventory/reconciliations/:id/submit — finalise
// counts and (optionally) apply variances to Stripe.
//
// Idempotency: a second submit on the same id 409s. The lines table
// has a unique (reconciliation_id, product_id) constraint that
// double-protects against client retries, but the status check is
// the user-facing guard.
router.post(
  "/admin/shop/inventory/reconciliations/:id/submit",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "inventory_reconciliation.submit",
    preset: "mutation",
  }),
  async (req, res) => {
    const idParsed = idParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const bodyParsed = submitBodySchema.safeParse(req.body);
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
    const id = idParsed.data;
    const { lines, applyToStripe } = bodyParsed.data;

    // Reject duplicate productIds inside one submit. The DB unique
    // constraint would also catch it, but failing fast yields a
    // clean error rather than a partial insert + 500.
    const seen = new Set<string>();
    for (const line of lines) {
      if (seen.has(line.productId)) {
        res.status(400).json({
          error: "duplicate_product_in_lines",
          productId: line.productId,
        });
        return;
      }
      seen.add(line.productId);
    }

    const supabase = getSupabaseServiceRoleClient();

    const { data: header, error: headerErr } = await supabase
      .schema("resupply")
      .from("inventory_reconciliations")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();
    if (headerErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: headerErr.message });
      return;
    }
    if (!header) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (header.status !== "draft") {
      res.status(409).json({ error: "already_submitted" });
      return;
    }

    // Fetch live Stripe catalog so each line records the
    // system_count at submit time (the operator counted now;
    // record what the system thought now).
    const config = readStripeConfigOrNull();
    if (!config) {
      // Without Stripe we can't compute system_count or apply
      // variances. Refuse cleanly so the UI can render the
      // "Stripe not configured" banner.
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const stripe = getStripeClient(config);
    let catalog: ShopProductView[];
    try {
      const products = await listShopProductsForReconciliation();
      catalog = products ?? [];
    } catch (err) {
      logger.warn(
        { err },
        "inventory_reconciliation.submit: catalog fetch failed",
      );
      res.status(502).json({ error: "stripe_list_failed" });
      return;
    }
    const catalogById = new Map(catalog.map((p) => [p.id, p]));

    // Build line rows. Variance = counted - system. When system is
    // null (untracked), variance = counted (everything counted is
    // "discovered" relative to the system's "nothing tracked").
    type LineInsert = {
      reconciliation_id: string;
      product_id: string;
      product_name: string;
      system_count: number | null;
      counted_qty: number;
      variance: number;
      applied: boolean;
    };
    const lineInserts: LineInsert[] = [];
    const stripeApplyTargets: Array<{
      productId: string;
      newStockCount: number;
    }> = [];

    for (const line of lines) {
      const projected = catalogById.get(line.productId);
      if (!projected) {
        // Skip silently — the SKU was archived or removed from the
        // catalog after the operator opened the page. The metadata
        // we record (skippedCount in audit) lets ops spot this
        // happening repeatedly without polluting the user-visible
        // response with row-level errors.
        continue;
      }
      const systemCount = projected.stockCount;
      const variance =
        systemCount === null ? line.countedQty : line.countedQty - systemCount;
      lineInserts.push({
        reconciliation_id: id,
        product_id: line.productId,
        product_name: projected.name,
        system_count: systemCount,
        counted_qty: line.countedQty,
        variance,
        applied: false,
      });
      // Only apply when there's actually a delta to write. Avoids
      // a no-op Stripe round-trip when counted == system.
      if (applyToStripe && variance !== 0) {
        stripeApplyTargets.push({
          productId: line.productId,
          newStockCount: line.countedQty,
        });
      }
    }

    if (lineInserts.length === 0) {
      res.status(400).json({ error: "no_valid_lines" });
      return;
    }

    const totalVarianceUnits = lineInserts.reduce(
      (acc, l) => acc + Math.abs(l.variance),
      0,
    );

    // Atomic DB write FIRST (migration 0143). The function takes a row
    // lock on the header (eliminating concurrent-submit lost updates),
    // inserts every line with applied=false, and flips status →
    // 'submitted' in one transaction. Stripe writes happen AFTER this
    // succeeds, so a loser of the row-lock race returns 409 BEFORE
    // mutating Stripe — no split-brain between the reconciliation
    // record and the live catalog. The trade-off: per-line `applied`
    // flags are stamped in a follow-up UPDATE once we know which
    // Stripe writes succeeded.
    const rpcLines = lineInserts.map((l) => ({
      product_id: l.product_id,
      product_name: l.product_name,
      // jsonb stringification of null comes through as JSON null,
      // which the function's NULLIF(... '')::integer turns into NULL.
      system_count: l.system_count,
      counted_qty: l.counted_qty,
      variance: l.variance,
      applied: false,
    }));
    const { data: rpcData, error: rpcErr } = await supabase
      .schema("resupply")
      .rpc("submit_inventory_reconciliation", {
        p_id: id,
        p_lines: rpcLines,
        p_applied_to_stripe: applyToStripe,
        p_total_variance_units: totalVarianceUnits,
      });
    if (rpcErr) {
      logger.error(
        { err: rpcErr },
        "inventory_reconciliation.submit: rpc failed",
      );
      res
        .status(500)
        .json({ error: "submit_rpc_failed", message: rpcErr.message });
      return;
    }
    // The function returns a JSON object — Supabase passes it through
    // unchanged. Cast through unknown so TS doesn't complain about
    // the dynamic shape.
    const rpc = rpcData as unknown as
      | { ok: true; total_lines: number; total_variance_units: number }
      | { ok: false; error: "not_found" | "already_submitted" | "duplicate_line" };
    if (!rpc.ok) {
      if (rpc.error === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (rpc.error === "already_submitted") {
        res.status(409).json({ error: "already_submitted" });
        return;
      }
      // duplicate_line — the route already filters duplicates before
      // calling the RPC, so this only fires when the same SKU appears
      // twice inside the input (defense in depth) or a partial earlier
      // submit left lines behind. Surface as 400 so the client can
      // retry without polluting the 500 channel.
      res.status(400).json({ error: rpc.error });
      return;
    }

    // RPC succeeded — we own the submitted row. Now safely mutate
    // Stripe and stamp per-line `applied` flags for whatever reached
    // the catalog. Failures are intentionally non-fatal here: the
    // reconciliation IS submitted; per-line `applied=false` accurately
    // records that this SKU didn't make it to Stripe.
    const appliedProductIds = new Set<string>();
    if (applyToStripe) {
      for (const target of stripeApplyTargets) {
        try {
          await stripe.products.update(target.productId, {
            metadata: { stock_count: String(target.newStockCount) },
          });
          appliedProductIds.add(target.productId);
        } catch (err) {
          logger.warn(
            { productId: target.productId, err },
            "inventory_reconciliation.submit: stripe update failed for SKU",
          );
        }
      }
    }
    if (appliedProductIds.size > 0) {
      const { error: applyErr } = await supabase
        .schema("resupply")
        .from("inventory_reconciliation_lines")
        .update({ applied: true })
        .eq("reconciliation_id", id)
        .in("product_id", Array.from(appliedProductIds));
      if (applyErr) {
        // The reconciliation header is durably submitted; only the
        // applied=true stamps are missing. Log and continue — the
        // operator sees success and the per-line flags can be
        // reconciled later from the audit envelope if needed.
        logger.warn(
          { err: applyErr },
          "inventory_reconciliation.submit: applied-flag update failed",
        );
      }
    }

    await logAudit({
      action: "inventory_reconciliation.submit",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "inventory_reconciliations",
      targetId: id,
      metadata: {
        total_lines: lineInserts.length,
        total_variance_units: totalVarianceUnits,
        applied_to_stripe: applyToStripe,
        skipped_lines: lines.length - lineInserts.length,
        stripe_apply_failures: applyToStripe
          ? stripeApplyTargets.length - appliedProductIds.size
          : 0,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "inventory_reconciliation.submit audit write failed",
      );
    });

    res.json({
      id,
      totalLines: lineInserts.length,
      totalVarianceUnits,
      appliedToStripe: applyToStripe,
      stripeApplyFailures: applyToStripe
        ? stripeApplyTargets.length - appliedProductIds.size
        : 0,
    });
  },
);

export default router;
