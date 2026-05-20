// /admin/shop/customers/:customerId/membership — manage cash-pay tier.
//
// Stripe Subscriptions handles the actual billing; this route just
// patches the membership_tier + renewal stamp + subscription id on
// the shop_customers row. The storefront-facing checkout flow that
// creates the Stripe subscription lands in a follow-up — for now
// CSRs can manually subscribe a customer who calls in.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type CustomerRow = Database["resupply"]["Tables"]["shop_customers"]["Row"];
type Tier = NonNullable<CustomerRow["membership_tier"]>;
const TIER_VALUES = [
  "payg",
  "monthly_unlimited",
  "quarterly_unlimited",
] as const satisfies readonly Tier[];

const body = z
  .object({
    tier: z.enum(TIER_VALUES),
    startedAt: z.string().datetime().nullable().optional(),
    renewsAt: z.string().datetime().nullable().optional(),
    stripeSubscriptionId: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

const params = z.object({ customerId: z.string().uuid() });

router.patch(
  "/admin/shop/customers/:customerId/membership",
  requireAdmin,
  adminRateLimit({
    name: "shop_customers.membership_tier",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["shop_customers"]["Update"] = {
      membership_tier: b.tier,
      membership_started_at:
        b.startedAt ?? (b.tier !== "payg" ? new Date().toISOString() : null),
      membership_renews_at: b.renewsAt ?? null,
      membership_stripe_subscription_id: b.stripeSubscriptionId ?? null,
    };
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .update(update)
      .eq("customer_id", idParsed.data.customerId);
    if (error) throw error;
    await logAudit({
      action: "shop_customer.membership_set",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_customers",
      targetId: idParsed.data.customerId,
      metadata: { tier: b.tier, stripe_sub: b.stripeSubscriptionId ?? null },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop_customer.membership_set audit write failed");
    });
    res.json({ ok: true });
  },
);

router.get(
  "/admin/shop/customers/:customerId/membership",
  requireAdmin,
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select(
        "customer_id, membership_tier, membership_started_at, membership_renews_at, membership_stripe_subscription_id",
      )
      .eq("customer_id", idParsed.data.customerId)
      .limit(1)
      .maybeSingle();
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ membership: data });
  },
);

export default router;
