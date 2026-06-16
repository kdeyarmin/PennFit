import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  ensureTenantStripeCustomer,
  syncPlatformBillingCatalogToStripe,
  syncTenantStripeSubscription,
} from "../../lib/platform-billing/stripe";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const tenantIdParam = z.object({ id: z.string().uuid() });
const subscriptionBody = z.object({
  planCode: z.string().regex(/^[a-z0-9_]+$/),
  status: z
    .enum(["active", "trialing", "past_due", "canceled"])
    .default("active"),
  customMonthlyPriceCents: z.number().int().min(0).nullable().optional(),
  customOnboardingFeeCents: z.number().int().min(0).nullable().optional(),
  customAllowances: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(2000).optional(),
});
const addonBody = z.object({
  addonCode: z.string().regex(/^[a-z0-9_]+$/),
  quantity: z.number().int().min(0).max(9999),
  customRecurringPriceCents: z.number().int().min(0).nullable().optional(),
  notes: z.string().max(2000).optional(),
});
const usageEventBody = z.object({
  tenantId: z.string().uuid().optional(),
  metricKey: z.string().regex(/^[a-z0-9_.]+$/),
  quantity: z.number().int().min(0).max(1_000_000).default(1),
  source: z.string().max(120).default("manual"),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type RawClient = ReturnType<ReturnType<typeof getOrgScopedClient>["raw"]>;

async function rawClient(): Promise<RawClient | null> {
  const seedOrgId = await resolveSeedOrgId();
  return seedOrgId ? getOrgScopedClient(seedOrgId).raw() : null;
}

async function countTable(
  orgId: string,
  table: string,
  from?: string,
  extra?: (q: any) => any,
): Promise<number> {
  let q: any = getOrgScopedClient(orgId)
    .from(table)
    .select("*", { count: "exact", head: true });
  if (from) q = q.gte("created_at", from);
  if (extra) q = extra(q);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function currentUsage(orgId: string) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const from = monthStart.toISOString();
  const db = getOrgScopedClient(orgId);
  const raw = db.raw().schema("resupply");

  const [
    activePatients,
    seats,
    locations,
    ordersThisMonth,
    activeSubscriptions,
    outboundEvents,
    aiEvents,
    billingEvents,
    faxEvents,
    voiceEvents,
  ] = await Promise.all([
    countTable(orgId, "patients"),
    countTable(orgId, "admin_users", undefined, (q) =>
      q.eq("status", "active"),
    ),
    countTable(orgId, "locations", undefined, (q) => q.eq("status", "active")),
    countTable(orgId, "shop_orders", from),
    countTable(orgId, "shop_subscriptions", undefined, (q) =>
      q.in("status", ["active", "trialing"]),
    ),
    raw
      .from("tenant_usage_events")
      .select("quantity", { count: "exact" })
      .eq("org_id", orgId)
      .eq("metric_key", "outboundMessagesPerMonth")
      .gte("occurred_at", from),
    raw
      .from("tenant_usage_events")
      .select("quantity", { count: "exact" })
      .eq("org_id", orgId)
      .eq("metric_key", "aiTextInteractionsPerMonth")
      .gte("occurred_at", from),
    raw
      .from("tenant_usage_events")
      .select("quantity", { count: "exact" })
      .eq("org_id", orgId)
      .eq("metric_key", "billingTransactionsPerMonth")
      .gte("occurred_at", from),
    raw
      .from("tenant_usage_events")
      .select("quantity", { count: "exact" })
      .eq("org_id", orgId)
      .eq("metric_key", "faxEvents")
      .gte("occurred_at", from),
    raw
      .from("tenant_usage_events")
      .select("quantity", { count: "exact" })
      .eq("org_id", orgId)
      .eq("metric_key", "aiVoiceEvents")
      .gte("occurred_at", from),
  ]);

  function sumRows(result: any): number {
    if (result.error) throw result.error;
    return ((result.data ?? []) as Array<{ quantity: number | null }>).reduce(
      (sum, r) => sum + (r.quantity ?? 0),
      0,
    );
  }

  return {
    month: from.slice(0, 7),
    metrics: {
      activePatients,
      seats,
      locations,
      ordersPerMonth: ordersThisMonth,
      activeSubscriptions,
      outboundMessagesPerMonth: sumRows(outboundEvents),
      aiTextInteractionsPerMonth: sumRows(aiEvents),
      billingTransactionsPerMonth: sumRows(billingEvents),
      faxEvents: sumRows(faxEvents),
      aiVoiceEvents: sumRows(voiceEvents),
    },
  };
}

function mapPlan(row: any) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    monthlyPriceCents: row.monthly_price_cents,
    onboardingFeeCents: row.onboarding_fee_cents,
    isPublic: row.is_public,
    isCustom: row.is_custom,
    sortOrder: row.sort_order,
    allowances: row.allowances ?? {},
    features: row.features ?? [],
    stripeProductId: row.stripe_product_id ?? null,
    stripePriceId: row.stripe_price_id ?? null,
    stripeSyncedAt: row.stripe_synced_at ?? null,
  };
}

function mapAddon(row: any) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description,
    recurringPriceCents: row.recurring_price_cents,
    oneTimeMinCents: row.one_time_min_cents,
    oneTimeMaxCents: row.one_time_max_cents,
    unitLabel: row.unit_label,
    usageMetric: row.usage_metric,
    passThroughNote: row.pass_through_note,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    stripeProductId: row.stripe_product_id ?? null,
    stripePriceId: row.stripe_price_id ?? null,
    stripeSyncedAt: row.stripe_synced_at ?? null,
  };
}

async function catalog(res: Response, raw: RawClient): Promise<void> {
  const [plans, addons] = await Promise.all([
    raw
      .schema("resupply")
      .from("billing_plans")
      .select("*")
      .order("sort_order"),
    raw
      .schema("resupply")
      .from("billing_addons")
      .select("*")
      .order("sort_order"),
  ]);
  if (plans.error || addons.error) {
    logger.error(
      {
        event: "billing_catalog_read_failed",
        err: plans.error ?? addons.error,
      },
      "billing catalog read failed",
    );
    res.status(500).json({ error: "billing_catalog_failed" });
    return;
  }
  res.json({
    plans: (plans.data ?? []).map(mapPlan),
    addons: (addons.data ?? []).map(mapAddon),
  });
}

async function tenantBilling(orgId: string, res: Response): Promise<void> {
  const raw = await rawClient();
  if (!raw) {
    res.status(503).json({ error: "tenant_directory_unavailable" });
    return;
  }
  const [sub, addons, usage] = await Promise.all([
    raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select("*, billing_plans(*)")
      .eq("org_id", orgId)
      .in("status", ["active", "trialing", "past_due"])
      .limit(1)
      .maybeSingle(),
    raw
      .schema("resupply")
      .from("tenant_billing_addons")
      .select("*, billing_addons(*)")
      .eq("org_id", orgId)
      .eq("status", "active"),
    currentUsage(orgId),
  ]);
  if (sub.error || addons.error) {
    logger.error(
      { event: "tenant_billing_read_failed", err: sub.error ?? addons.error },
      "tenant billing read failed",
    );
    res.status(500).json({ error: "tenant_billing_failed" });
    return;
  }
  const subscription = sub.data
    ? {
        id: sub.data.id,
        status: sub.data.status,
        effectiveAt: sub.data.effective_at,
        customMonthlyPriceCents: sub.data.custom_monthly_price_cents,
        customOnboardingFeeCents: sub.data.custom_onboarding_fee_cents,
        customAllowances: sub.data.custom_allowances ?? {},
        notes: sub.data.notes ?? "",
        stripeCustomerId: sub.data.stripe_customer_id ?? null,
        stripeSubscriptionId: sub.data.stripe_subscription_id ?? null,
        stripeStatus: sub.data.stripe_status ?? null,
        stripeLastSyncedAt: sub.data.stripe_last_synced_at ?? null,
        currentPeriodStart: sub.data.current_period_start ?? null,
        currentPeriodEnd: sub.data.current_period_end ?? null,
        lastInvoiceId: sub.data.last_invoice_id ?? null,
        lastInvoiceStatus: sub.data.last_invoice_status ?? null,
        plan: mapPlan(sub.data.billing_plans),
      }
    : null;
  res.json({
    tenantId: orgId,
    subscription,
    addons: (addons.data ?? []).map((a: any) => ({
      id: a.id,
      quantity: a.quantity,
      customRecurringPriceCents: a.custom_recurring_price_cents,
      notes: a.notes ?? "",
      addon: mapAddon(a.billing_addons),
    })),
    usage,
  });
}

router.get(
  "/admin/billing/package",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!req.orgId) {
      res.status(400).json({ error: "tenant_not_resolved" });
      return;
    }
    await tenantBilling(req.orgId, res);
  },
);

router.post(
  "/admin/billing/usage-events",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!req.orgId) {
      res.status(400).json({ error: "tenant_not_resolved" });
      return;
    }
    const parsed = usageEventBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_usage_event",
        details: parsed.error.flatten(),
      });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await raw
      .schema("resupply")
      .from("tenant_usage_events")
      .insert({
        org_id: req.orgId,
        metric_key: parsed.data.metricKey,
        quantity: parsed.data.quantity,
        source: parsed.data.source,
        occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
        metadata: parsed.data.metadata ?? {},
      })
      .select("id")
      .single();
    if (error) {
      res.status(500).json({ error: "usage_event_failed" });
      return;
    }
    res.status(201).json({ id: data.id });
  },
);

router.get(
  "/platform/billing/catalog",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    await catalog(res, raw);
  },
);

router.get(
  "/platform/billing/tenants",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data: orgs, error } = await raw
      .schema("resupply")
      .from("organizations")
      .select("id, slug, name, storefront_name, status")
      .order("created_at");
    if (error) {
      res.status(500).json({ error: "tenant_list_failed" });
      return;
    }
    const tenants = await Promise.all(
      (orgs ?? []).map(async (o: any) => {
        const capture: any = {
          body: undefined,
          statusCode: 200,
          status(code: number) {
            this.statusCode = code;
            return this;
          },
          json(body: unknown) {
            this.body = body;
            return this;
          },
        };
        await tenantBilling(o.id, capture as Response);
        return {
          id: o.id,
          slug: o.slug,
          name: o.name,
          storefrontName: o.storefront_name,
          status: o.status,
          billing: capture.body,
        };
      }),
    );
    res.json({ tenants });
  },
);

router.put(
  "/platform/billing/tenants/:id/subscription",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const param = tenantIdParam.safeParse(req.params);
    const body = subscriptionBody.safeParse(req.body);
    if (!param.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    if (!body.success) {
      res
        .status(400)
        .json({ error: "invalid_subscription", details: body.error.flatten() });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data: plan, error: planErr } = await raw
      .schema("resupply")
      .from("billing_plans")
      .select("id, code")
      .eq("code", body.data.planCode)
      .maybeSingle();
    if (planErr || !plan) {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    const { error: cancelErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .update({
        status: "canceled",
        updated_at: new Date().toISOString(),
        updated_by_email: req.platformAdminEmail ?? null,
      })
      .eq("org_id", param.data.id)
      .in("status", ["active", "trialing", "past_due"]);
    if (cancelErr) {
      res.status(500).json({ error: "subscription_update_failed" });
      return;
    }
    const { error: insErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .insert({
        org_id: param.data.id,
        plan_id: plan.id,
        status: body.data.status,
        custom_monthly_price_cents: body.data.customMonthlyPriceCents ?? null,
        custom_onboarding_fee_cents: body.data.customOnboardingFeeCents ?? null,
        custom_allowances: body.data.customAllowances ?? {},
        notes: body.data.notes ?? "",
        updated_by_email: req.platformAdminEmail ?? null,
      });
    if (insErr) {
      res.status(500).json({ error: "subscription_update_failed" });
      return;
    }
    await logAudit({
      action: "platform.billing.subscription.updated",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "tenant_billing_subscriptions",
      targetId: param.data.id,
      metadata: { planCode: body.data.planCode },
      ip: null,
      userAgent: null,
    }).catch(() => undefined);
    await tenantBilling(param.data.id, res);
  },
);

router.put(
  "/platform/billing/tenants/:id/addons",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const param = tenantIdParam.safeParse(req.params);
    const body = addonBody.safeParse(req.body);
    if (!param.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    if (!body.success) {
      res
        .status(400)
        .json({ error: "invalid_addon", details: body.error.flatten() });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data: addon, error: addonErr } = await raw
      .schema("resupply")
      .from("billing_addons")
      .select("id, code")
      .eq("code", body.data.addonCode)
      .maybeSingle();
    if (addonErr || !addon) {
      res.status(404).json({ error: "addon_not_found" });
      return;
    }
    if (body.data.quantity === 0) {
      const { error: cancelErr } = await raw
        .schema("resupply")
        .from("tenant_billing_addons")
        .update({
          status: "canceled",
          quantity: 0,
          updated_at: new Date().toISOString(),
          updated_by_email: req.platformAdminEmail ?? null,
        })
        .eq("org_id", param.data.id)
        .eq("addon_id", addon.id)
        .eq("status", "active");
      if (cancelErr) {
        res.status(500).json({ error: "addon_update_failed" });
        return;
      }
    } else {
      const { data: existing, error: readErr } = await raw
        .schema("resupply")
        .from("tenant_billing_addons")
        .select("id")
        .eq("org_id", param.data.id)
        .eq("addon_id", addon.id)
        .eq("status", "active")
        .maybeSingle();
      if (readErr) {
        res.status(500).json({ error: "addon_update_failed" });
        return;
      }
      const payload = {
        quantity: body.data.quantity,
        status: "active",
        custom_recurring_price_cents:
          body.data.customRecurringPriceCents ?? null,
        notes: body.data.notes ?? "",
        updated_by_email: req.platformAdminEmail ?? null,
        updated_at: new Date().toISOString(),
      };
      const write = existing
        ? await raw
            .schema("resupply")
            .from("tenant_billing_addons")
            .update(payload)
            .eq("id", existing.id)
        : await raw
            .schema("resupply")
            .from("tenant_billing_addons")
            .insert({ ...payload, org_id: param.data.id, addon_id: addon.id });
      if (write.error) {
        res.status(500).json({ error: "addon_update_failed" });
        return;
      }
    }
    await logAudit({
      action: "platform.billing.addon.updated",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "tenant_billing_addons",
      targetId: param.data.id,
      metadata: {
        addonCode: body.data.addonCode,
        quantity: body.data.quantity,
      },
      ip: null,
      userAgent: null,
    }).catch(() => undefined);
    await tenantBilling(param.data.id, res);
  },
);

router.post(
  "/platform/billing/catalog/stripe/sync",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    try {
      const result = await syncPlatformBillingCatalogToStripe();
      if (!result.stripeConfigured) {
        res.status(503).json({ error: "stripe_not_configured" });
        return;
      }
      await logAudit({
        action: "platform.billing.stripe.catalog.synced",
        adminEmail: req.platformAdminEmail ?? "platform-admin",
        adminUserId: req.platformAdminUserId ?? null,
        targetTable: "billing_plans",
        targetId: "catalog",
        metadata: result.catalog ?? {},
        ip: null,
        userAgent: null,
      }).catch(() => undefined);
      res.json(result);
    } catch (err) {
      logger.error(
        { event: "platform_billing_stripe_catalog_sync_failed", err },
        "platform billing Stripe catalog sync failed",
      );
      res.status(500).json({ error: "stripe_catalog_sync_failed" });
    }
  },
);

router.post(
  "/platform/billing/tenants/:id/stripe/customer",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const param = tenantIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    try {
      const result = await ensureTenantStripeCustomer({
        orgId: param.data.id,
        adminEmail: req.platformAdminEmail ?? null,
      });
      if (!result.stripeConfigured) {
        res.status(503).json({ error: "stripe_not_configured" });
        return;
      }
      await tenantBilling(param.data.id, res);
    } catch (err) {
      logger.error(
        { event: "platform_billing_stripe_customer_failed", err },
        "platform billing Stripe customer failed",
      );
      res.status(500).json({ error: "stripe_customer_failed" });
    }
  },
);

router.post(
  "/platform/billing/tenants/:id/stripe/subscription",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const param = tenantIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    try {
      const result = await syncTenantStripeSubscription({
        orgId: param.data.id,
        adminEmail: req.platformAdminEmail ?? null,
      });
      if (!result.stripeConfigured) {
        res.status(503).json({ error: "stripe_not_configured" });
        return;
      }
      await tenantBilling(param.data.id, res);
    } catch (err) {
      logger.error(
        { event: "platform_billing_stripe_subscription_failed", err },
        "platform billing Stripe subscription sync failed",
      );
      res.status(500).json({ error: "stripe_subscription_failed" });
    }
  },
);

router.post(
  "/platform/billing/usage-events",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = usageEventBody
      .required({ tenantId: true })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_usage_event",
        details: parsed.error.flatten(),
      });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await raw
      .schema("resupply")
      .from("tenant_usage_events")
      .insert({
        org_id: parsed.data.tenantId,
        metric_key: parsed.data.metricKey,
        quantity: parsed.data.quantity,
        source: parsed.data.source,
        occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
        metadata: parsed.data.metadata ?? {},
      })
      .select("id")
      .single();
    if (error) {
      res.status(500).json({ error: "usage_event_failed" });
      return;
    }
    res.status(201).json({ id: data.id });
  },
);

export default router;
