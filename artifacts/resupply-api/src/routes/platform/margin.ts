// GET /resupply-api/platform/margin?days=30 — fleet gross-margin rollup.
//
// Aggregate STOREFRONT product gross margin across every tenant: revenue,
// known cost (from the point-in-time `shop_order_items.unit_cost_cents`
// snapshot), margin, and the uncosted-revenue blind spot — folded through
// the same tested margin core (@workspace/resupply-domain) the per-tenant
// "Margin & COGS" dashboard uses. Gated by `requirePlatformAdmin`.
//
// Scope note: this is PRODUCT COGS only. Infrastructure/vendor spend
// (AI, telephony, email) is NOT instrumented anywhere in the system, so it
// is deliberately absent rather than estimated. Aggregates + dollar
// rollups only — no patient PHI crosses this surface (same posture as
// /platform/analytics).

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  aggregateMargin,
  type MarginAggregate,
  type MarginInput,
} from "@workspace/resupply-domain";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

// Per-tenant line cap (mirrors the admin margin route) so a high-volume
// tenant can't time the rollup out; the margin then reflects "the most
// recent N costed lines", an acceptable degradation for a trend figure.
const ITEM_CAP = 5000;

interface OrgRow {
  id: string;
  slug: string;
  name: string | null;
  status: string;
}

async function tenantMargin(
  orgId: string,
  cutoffIso: string,
): Promise<MarginAggregate> {
  try {
    const { data, error } = await getOrgScopedClient(orgId)
      .from("shop_order_items")
      .select("quantity, unit_amount_cents, unit_cost_cents")
      .gte("paid_at", cutoffIso)
      .limit(ITEM_CAP);
    if (error) throw error;
    const lines: MarginInput[] = (
      (data ?? []) as Array<Record<string, unknown>>
    ).map((r) => {
      const quantity =
        typeof r.quantity === "number" && r.quantity > 0 ? r.quantity : 1;
      const unitAmount =
        typeof r.unit_amount_cents === "number" ? r.unit_amount_cents : 0;
      return {
        revenueCents: unitAmount * quantity,
        unitCostCents:
          typeof r.unit_cost_cents === "number" ? r.unit_cost_cents : null,
        quantity,
      };
    });
    return aggregateMargin(lines);
  } catch (err) {
    // Degrade a failing tenant to an empty (zero) rollup rather than
    // failing the whole fleet view — same posture as the analytics fan-out.
    logger.warn(
      { event: "platform_margin_tenant_failed", err, orgId },
      "platform margin: per-tenant fold failed; degrading to empty",
    );
    return aggregateMargin([]);
  }
}

// Sum the additive fields of a per-tenant rollup into the fleet total.
// `marginRatio` is intentionally NOT summed — it's recomputed once at the
// end over the fleet's costed revenue (a ratio of sums, not a sum of
// ratios).
function addInto(into: MarginAggregate, x: MarginAggregate): void {
  into.lineCount += x.lineCount;
  into.revenueCents += x.revenueCents;
  into.costedRevenueCents += x.costedRevenueCents;
  into.uncostedRevenueCents += x.uncostedRevenueCents;
  into.costCents += x.costCents;
  into.marginCents += x.marginCents;
  into.linesWithKnownCost += x.linesWithKnownCost;
  into.linesWithUnknownCost += x.linesWithUnknownCost;
  into.lossLineCount += x.lossLineCount;
  into.negativeMarginRevenueCents += x.negativeMarginRevenueCents;
}

router.get(
  "/platform/margin",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();

    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data: orgs, error } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id, slug, name, status")
      .order("created_at", { ascending: true });
    if (error) {
      logger.error(
        { event: "platform_margin_dir_failed", err: error },
        "platform margin: tenant directory query failed",
      );
      res.status(500).json({ error: "margin_failed" });
      return;
    }

    const fleet = aggregateMargin([]);
    const tenants = await Promise.all(
      ((orgs ?? []) as OrgRow[]).map(async (o) => {
        const agg = await tenantMargin(o.id, cutoffIso);
        addInto(fleet, agg);
        return {
          id: o.id,
          slug: o.slug,
          name: o.name,
          status: o.status,
          ...agg,
        };
      }),
    );
    fleet.marginRatio =
      fleet.costedRevenueCents > 0
        ? fleet.marginCents / fleet.costedRevenueCents
        : null;

    res.json({
      windowDays: days,
      generatedAt: new Date().toISOString(),
      fleet,
      tenants,
    });
  },
);

export default router;
