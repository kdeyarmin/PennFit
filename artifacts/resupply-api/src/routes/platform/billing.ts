import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getOrgScopedClient,
  resolveSeedOrgId,
  type ResupplyTable,
} from "@workspace/resupply-db";

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
  // Allows the camelCase console metric keys (e.g. aiTextInteractionsPerMonth)
  // as well as snake_case — matches the widened DB CHECK (migration 0367).
  metricKey: z.string().regex(/^[A-Za-z0-9_.]+$/),
  quantity: z.number().int().min(0).max(1_000_000).default(1),
  source: z.string().max(120).default("manual"),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type RawClient = ReturnType<ReturnType<typeof getOrgScopedClient>["raw"]>;

/** Equality / membership filters applied on top of a count query.
 *  Passing filter specs as data (rather than a builder callback) keeps
 *  `countTable` free of an explicitly-`any` builder parameter. */
interface CountFilters {
  eq?: Array<[column: string, value: string]>;
  in?: Array<[column: string, values: string[]]>;
}

/** Billing-plan catalog row, narrowed to the fields the API surfaces.
 *  Billing tables aren't in the generated Database types, so rows arrive
 *  untyped from the service-role client. */
interface BillingPlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number | null;
  onboarding_fee_cents: number | null;
  is_public: boolean | null;
  is_custom: boolean | null;
  sort_order: number | null;
  allowances: Record<string, unknown> | null;
  features: string[] | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_synced_at: string | null;
}

interface BillingAddonRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  recurring_price_cents: number | null;
  one_time_min_cents: number | null;
  one_time_max_cents: number | null;
  unit_label: string | null;
  usage_metric: string | null;
  pass_through_note: string | null;
  is_active: boolean | null;
  sort_order: number | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_synced_at: string | null;
}

interface TenantAddonRow {
  id: string;
  org_id: string;
  quantity: number;
  custom_recurring_price_cents: number | null;
  notes: string | null;
  billing_addons: BillingAddonRow;
}

interface TenantSubscriptionRow {
  id: string;
  org_id: string;
  status: string;
  effective_at: string;
  custom_monthly_price_cents: number | null;
  custom_onboarding_fee_cents: number | null;
  custom_allowances: Record<string, unknown> | null;
  notes: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  stripe_last_synced_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  last_invoice_id: string | null;
  last_invoice_status: string | null;
  billing_plans: BillingPlanRow;
}

interface TenantUsageSnapshotRow {
  org_id: string;
  active_patients: number | null;
  seats: number | null;
  locations: number | null;
  orders_per_month: number | null;
  active_subscriptions: number | null;
  outbound_messages_per_month: number | null;
  ai_text_interactions_per_month: number | null;
  billing_transactions_per_month: number | null;
  fax_events: number | null;
  ai_voice_events: number | null;
}

interface OrgDirectoryRow {
  id: string;
  slug: string;
  name: string | null;
  storefront_name: string | null;
  status: string;
  fax_from_number: string | null;
  fax_provisioned_at: string | null;
}

async function rawClient(): Promise<RawClient | null> {
  const seedOrgId = await resolveSeedOrgId();
  return seedOrgId ? getOrgScopedClient(seedOrgId).raw() : null;
}

async function countTable(
  orgId: string,
  table: ResupplyTable,
  from?: string,
  filters?: CountFilters,
): Promise<number> {
  // The org-scoped facade's query builder is typed `any` at the source
  // (org-scoped-client.ts), so `q` is inferred as `any` here — there is
  // no explicit `any` annotation to flag.
  let q = getOrgScopedClient(orgId)
    .from(table)
    .select("*", { count: "exact", head: true });
  if (from) q = q.gte("created_at", from);
  for (const [column, value] of filters?.eq ?? []) q = q.eq(column, value);
  for (const [column, values] of filters?.in ?? []) q = q.in(column, values);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function currentUsage(orgId: string) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const from = monthStart.toISOString();
  const monthDate = from.slice(0, 10); // 'YYYY-MM-01' — the rollup `month` key
  const db = getOrgScopedClient(orgId);
  const raw = db.raw().schema("resupply");

  const [
    activePatients,
    seats,
    locations,
    ordersThisMonth,
    activeSubscriptions,
    rollups,
  ] = await Promise.all([
    countTable(orgId, "patients"),
    countTable(orgId, "admin_users", undefined, {
      eq: [["status", "active"]],
    }),
    countTable(orgId, "locations", undefined, {
      eq: [["is_active", "true"]],
    }),
    countTable(orgId, "shop_orders", from),
    countTable(orgId, "shop_subscriptions", undefined, {
      in: [["status", ["active", "trialing"]]],
    }),
    // Event-based metrics read from the monthly rollup — one row per
    // (org, month, metric_key), maintained by increment_tenant_usage_rollup
    // (migration 0367). At most a handful of rows per org/month, so no
    // page-cap/aggregation hazard.
    raw
      .from("tenant_usage_monthly_rollups")
      .select("metric_key, quantity")
      .eq("org_id", orgId)
      .eq("month", monthDate),
  ]);

  if (rollups.error) throw rollups.error;
  const usageByMetric = new Map<string, number>();
  for (const r of (rollups.data ?? []) as Array<{
    metric_key: string;
    quantity: number | null;
  }>) {
    usageByMetric.set(r.metric_key, r.quantity ?? 0);
  }
  const metered = (key: string): number => usageByMetric.get(key) ?? 0;

  return {
    month: from.slice(0, 7),
    metrics: {
      activePatients,
      seats,
      locations,
      ordersPerMonth: ordersThisMonth,
      activeSubscriptions,
      outboundMessagesPerMonth: metered("outboundMessagesPerMonth"),
      aiTextInteractionsPerMonth: metered("aiTextInteractionsPerMonth"),
      billingTransactionsPerMonth: metered("billingTransactionsPerMonth"),
      faxEvents: metered("faxEvents"),
      aiVoiceEvents: metered("aiVoiceEvents"),
    },
  };
}

function mapPlan(row: BillingPlanRow) {
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

function mapAddon(row: BillingAddonRow) {
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
    addons: ((addons.data ?? []) as TenantAddonRow[]).map((a) => ({
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
    // Mirror the event into the monthly rollup that currentUsage() reads,
    // so an operator-entered datapoint shows up in the billing console.
    await raw.schema("resupply").rpc("increment_tenant_usage_rollup", {
      p_org_id: req.orgId,
      p_metric_key: parsed.data.metricKey,
      p_quantity: parsed.data.quantity,
      p_occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
    });
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
      .select(
        "id, slug, name, storefront_name, status, fax_from_number, fax_provisioned_at",
      )
      .order("created_at");
    if (error) {
      res.status(500).json({ error: "tenant_list_failed" });
      return;
    }
    const orgRows = (orgs ?? []) as OrgDirectoryRow[];
    if (orgRows.length === 0) {
      res.json({ tenants: [] });
      return;
    }
    const orgIds = orgRows.map((o) => o.id);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const usageMonth = monthStart.toISOString().slice(0, 7);
    const [subs, addons, usage] = await Promise.all([
      raw
        .schema("resupply")
        .from("tenant_billing_subscriptions")
        .select("*, billing_plans(*)")
        .in("org_id", orgIds)
        .in("status", ["active", "trialing", "past_due"]),
      raw
        .schema("resupply")
        .from("tenant_billing_addons")
        .select("*, billing_addons(*)")
        .in("org_id", orgIds)
        .eq("status", "active"),
      raw.rpc("platform_tenant_usage_snapshot" as never, {
        p_month_start: monthStart.toISOString(),
      } as never),
    ]);
    if (subs.error || addons.error || usage.error) {
      logger.error(
        {
          event: "tenant_billing_list_read_failed",
          err: subs.error ?? addons.error ?? usage.error,
        },
        "tenant billing list read failed",
      );
      res.status(500).json({ error: "tenant_billing_failed" });
      return;
    }
    const subscriptionByOrg = new Map<string, TenantSubscriptionRow>();
    for (const s of (subs.data ?? []) as TenantSubscriptionRow[]) {
      if (!subscriptionByOrg.has(s.org_id)) subscriptionByOrg.set(s.org_id, s);
    }
    const addonsByOrg = new Map<string, TenantAddonRow[]>();
    for (const a of (addons.data ?? []) as TenantAddonRow[]) {
      const rows = addonsByOrg.get(a.org_id);
      if (rows) rows.push(a);
      else addonsByOrg.set(a.org_id, [a]);
    }
    const usageByOrg = new Map<string, TenantUsageSnapshotRow>();
    for (const row of (usage.data ?? []) as TenantUsageSnapshotRow[]) {
      usageByOrg.set(row.org_id, row);
    }
    const tenants = orgRows.map((o) => {
      const sub = subscriptionByOrg.get(o.id);
      const addonRows = addonsByOrg.get(o.id) ?? [];
      const usageRow = usageByOrg.get(o.id);
      return {
        id: o.id,
        slug: o.slug,
        name: o.name,
        storefrontName: o.storefront_name,
        status: o.status,
        faxNumber: o.fax_from_number,
        faxProvisionedAt: o.fax_provisioned_at,
        billing: {
          tenantId: o.id,
          subscription: sub
            ? {
                id: sub.id,
                status: sub.status,
                effectiveAt: sub.effective_at,
                customMonthlyPriceCents: sub.custom_monthly_price_cents,
                customOnboardingFeeCents: sub.custom_onboarding_fee_cents,
                customAllowances: sub.custom_allowances ?? {},
                notes: sub.notes ?? "",
                stripeCustomerId: sub.stripe_customer_id ?? null,
                stripeSubscriptionId: sub.stripe_subscription_id ?? null,
                stripeStatus: sub.stripe_status ?? null,
                stripeLastSyncedAt: sub.stripe_last_synced_at ?? null,
                currentPeriodStart: sub.current_period_start ?? null,
                currentPeriodEnd: sub.current_period_end ?? null,
                lastInvoiceId: sub.last_invoice_id ?? null,
                lastInvoiceStatus: sub.last_invoice_status ?? null,
                plan: mapPlan(sub.billing_plans),
              }
            : null,
          addons: addonRows.map((a) => ({
            id: a.id,
            quantity: a.quantity,
            customRecurringPriceCents: a.custom_recurring_price_cents,
            notes: a.notes ?? "",
            addon: mapAddon(a.billing_addons),
          })),
          usage: {
            month: usageMonth,
            metrics: {
              activePatients: usageRow?.active_patients ?? 0,
              seats: usageRow?.seats ?? 0,
              locations: usageRow?.locations ?? 0,
              ordersPerMonth: usageRow?.orders_per_month ?? 0,
              activeSubscriptions: usageRow?.active_subscriptions ?? 0,
              outboundMessagesPerMonth:
                usageRow?.outbound_messages_per_month ?? 0,
              aiTextInteractionsPerMonth:
                usageRow?.ai_text_interactions_per_month ?? 0,
              billingTransactionsPerMonth:
                usageRow?.billing_transactions_per_month ?? 0,
              faxEvents: usageRow?.fax_events ?? 0,
              aiVoiceEvents: usageRow?.ai_voice_events ?? 0,
            },
          },
        },
      };
    });
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
    // Mirror the event into the monthly rollup that currentUsage() reads.
    await raw.schema("resupply").rpc("increment_tenant_usage_rollup", {
      p_org_id: parsed.data.tenantId,
      p_metric_key: parsed.data.metricKey,
      p_quantity: parsed.data.quantity,
      p_occurred_at: parsed.data.occurredAt ?? new Date().toISOString(),
    });
    res.status(201).json({ id: data.id });
  },
);

export default router;
