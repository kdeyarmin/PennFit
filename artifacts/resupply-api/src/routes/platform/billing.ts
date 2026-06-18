import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getOrgScopedClient,
  resolveSeedOrgId,
  type ResupplyTable,
} from "@workspace/resupply-db";

import {
  computeBillingPreview,
  type BillingPreview,
} from "../../lib/billing-preview";
import {
  summarizeFleetBilling,
  type FleetBillingTenant,
} from "../../lib/fleet-billing";
import { logger } from "../../lib/logger";
import {
  ensureTenantStripeCustomer,
  PlatformBillingAccountChangedError,
  syncPlatformBillingCatalogToStripe,
  syncTenantStripeSubscription,
} from "../../lib/platform-billing/stripe";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";
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
// Tenant self-service plan selection: a tenant owner picks one of the
// public, non-custom plans for their own org. Selection is gated on the
// plan's flags — a plan must be is_public AND NOT is_custom. Plans flagged
// is_custom (e.g. Enterprise) carry negotiated pricing/allowances and must
// be assigned by a platform admin via
// PUT /platform/billing/tenants/:id/subscription.
const selectPlanBody = z.object({
  planCode: z.string().regex(/^[a-z0-9_]+$/),
});
// Tenant self-service add-on selection. A tenant owner sets the quantity
// of a recurring add-on for their own org (quantity 0 removes it). Custom
// pricing is platform-admin-only and is intentionally NOT accepted here —
// tenants pay the catalog rate. One-time/project add-ons (no recurring
// price) are not self-selectable; they stay platform-admin-assigned.
const selectAddonBody = z.object({
  addonCode: z.string().regex(/^[a-z0-9_]+$/),
  quantity: z.number().int().min(0).max(9999),
});
// Proration / cost-preview request. The UI sends the SAME change it is
// about to confirm — a plan switch or an add-on quantity — and gets back a
// deterministic estimate (new monthly total, change vs. today, prorated
// amount for the rest of the period). Discriminated on `kind`.
const previewBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    planCode: z.string().regex(/^[a-z0-9_]+$/),
  }),
  z.object({
    kind: z.literal("addon"),
    addonCode: z.string().regex(/^[a-z0-9_]+$/),
    quantity: z.number().int().min(0).max(9999),
  }),
]);

// Catalog edits (platform super-admin). These change the BASE plan/addon
// pricing + presentation that every tenant account and the public
// marketing page read from, and that the Stripe catalog sync mints prices
// from. Every field is optional so the UI can PATCH-style send only what
// changed; an explicit `null` clears a nullable column.
const catalogCodeParam = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/),
});
const planEditBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    monthlyPriceCents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .nullable()
      .optional(),
    onboardingFeeCents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .nullable()
      .optional(),
    allowances: z.record(z.string(), z.number().int().min(0)).optional(),
    features: z.array(z.string().max(200)).max(60).optional(),
    isPublic: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
const addonEditBody = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
    category: z.string().max(80).optional(),
    recurringPriceCents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .nullable()
      .optional(),
    oneTimeMinCents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .nullable()
      .optional(),
    oneTimeMaxCents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .nullable()
      .optional(),
    unitLabel: z.string().max(80).nullable().optional(),
    usageMetric: z.string().max(80).nullable().optional(),
    passThroughNote: z.string().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

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

// Best-effort push of the catalog to Stripe after a price edit. Fail-soft:
// Stripe being unconfigured or erroring must never fail the catalog edit —
// the DB is the source of truth for tenant accounts and the marketing page,
// and an operator can always re-run the explicit "Sync catalog to Stripe"
// action. (Editing the price clears the stale immutable Stripe price id, so
// this sync mints a fresh price at the new amount.)
async function resyncCatalogToStripe(): Promise<void> {
  try {
    await syncPlatformBillingCatalogToStripe();
  } catch (err) {
    logger.error(
      { event: "platform_billing_catalog_edit_stripe_resync_failed", err },
      "platform billing catalog edit Stripe resync failed (non-fatal)",
    );
  }
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

/** Read + map the full catalog, or null on a DB error (already logged). */
async function loadCatalog(
  raw: RawClient,
): Promise<{ plans: unknown[]; addons: unknown[] } | null> {
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
    return null;
  }
  return {
    plans: (plans.data ?? []).map(mapPlan),
    addons: (addons.data ?? []).map(mapAddon),
  };
}

async function catalog(res: Response, raw: RawClient): Promise<void> {
  const data = await loadCatalog(raw);
  if (!data) {
    res.status(500).json({ error: "billing_catalog_failed" });
    return;
  }
  res.json(data);
}

const ACTIVE_SUB_STATUSES = ["active", "trialing", "past_due"];

/** How many tenants currently bill the OLD price for this plan and so
 *  would change on a re-sync: on this plan, no per-tenant custom price,
 *  and an existing Stripe subscription. */
async function countTenantsAffectedByPlan(
  raw: RawClient,
  planId: string,
): Promise<number> {
  const { count, error } = await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("plan_id", planId)
    .in("status", ACTIVE_SUB_STATUSES)
    .is("custom_monthly_price_cents", null)
    .not("stripe_subscription_id", "is", null);
  if (error) return 0;
  return count ?? 0;
}

/** How many tenants bill the OLD price for this add-on: have it active with
 *  no per-tenant custom price, on an org with a live Stripe subscription. */
async function countTenantsAffectedByAddon(
  raw: RawClient,
  addonId: string,
): Promise<number> {
  const { data, error } = await raw
    .schema("resupply")
    .from("tenant_billing_addons")
    .select("org_id")
    .eq("addon_id", addonId)
    .eq("status", "active")
    .is("custom_recurring_price_cents", null);
  if (error) return 0;
  const orgIds = Array.from(
    new Set(((data ?? []) as Array<{ org_id: string }>).map((r) => r.org_id)),
  );
  if (orgIds.length === 0) return 0;
  const { count, error: subErr } = await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .select("id", { count: "exact", head: true })
    .in("org_id", orgIds)
    .in("status", ACTIVE_SUB_STATUSES)
    .not("stripe_subscription_id", "is", null);
  if (subErr) return 0;
  return count ?? 0;
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

/**
 * Append a tenant-billing change to the activity feed the super-admin portal
 * reads (tenant_billing_events, migration 0386). Best-effort and value-free
 * of PHI: a failure here must never fail the billing mutation, so it mirrors
 * writeConfigEvent's swallow-and-log posture. logAudit() is a no-op stub
 * (migration 0156), so this is the only readable record of who changed what.
 */
async function recordBillingEvent(
  raw: RawClient,
  event: {
    orgId: string;
    action: string;
    actor: "tenant" | "platform";
    operatorEmail: string | null;
    summary: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await raw
      .schema("resupply")
      .from("tenant_billing_events")
      .insert({
        org_id: event.orgId,
        action: event.action,
        actor: event.actor,
        operator_email: event.operatorEmail,
        summary: event.summary,
        metadata: event.metadata,
      });
    if (error) throw error;
  } catch (err) {
    logger.warn(
      {
        event: "tenant_billing_event_insert_failed",
        action: event.action,
        err,
      },
      "tenant_billing_events insert failed (platform activity panel will miss this change)",
    );
  }
}

/** A tenant's recurring monthly cost, decomposed for the preview math. */
interface RecurringState {
  planMonthlyCents: number;
  addonsTotalCents: number;
  /** addon code → its current active quantity + unit price (cents/mo). */
  addonByCode: Map<string, { quantity: number; unitCents: number }>;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

/** Read a tenant's current recurring monthly cost (plan + active add-ons)
 *  plus its billing-period window, for the cost-preview endpoints. */
async function loadRecurringState(
  raw: RawClient,
  orgId: string,
): Promise<RecurringState> {
  const [sub, addons] = await Promise.all([
    raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select(
        "custom_monthly_price_cents, current_period_start, current_period_end, billing_plans(monthly_price_cents)",
      )
      .eq("org_id", orgId)
      .in("status", ["active", "trialing", "past_due"])
      .limit(1)
      .maybeSingle(),
    raw
      .schema("resupply")
      .from("tenant_billing_addons")
      .select(
        "quantity, custom_recurring_price_cents, billing_addons(code, recurring_price_cents)",
      )
      .eq("org_id", orgId)
      .eq("status", "active"),
  ]);
  if (sub.error) throw sub.error;
  if (addons.error) throw addons.error;

  const subRow = sub.data as {
    custom_monthly_price_cents: number | null;
    current_period_start: string | null;
    current_period_end: string | null;
    billing_plans: { monthly_price_cents: number | null } | null;
  } | null;
  const planMonthlyCents =
    subRow?.custom_monthly_price_cents ??
    subRow?.billing_plans?.monthly_price_cents ??
    0;

  const addonByCode = new Map<
    string,
    { quantity: number; unitCents: number }
  >();
  let addonsTotalCents = 0;
  for (const a of (addons.data ?? []) as unknown as Array<{
    quantity: number | null;
    custom_recurring_price_cents: number | null;
    billing_addons: {
      code: string;
      recurring_price_cents: number | null;
    } | null;
  }>) {
    const code = a.billing_addons?.code;
    if (!code) continue;
    const quantity = a.quantity ?? 0;
    const unitCents =
      a.custom_recurring_price_cents ??
      a.billing_addons?.recurring_price_cents ??
      0;
    addonByCode.set(code, { quantity, unitCents });
    addonsTotalCents += unitCents * Math.max(0, quantity);
  }

  return {
    planMonthlyCents,
    addonsTotalCents,
    addonByCode,
    currentPeriodStart: subRow?.current_period_start ?? null,
    currentPeriodEnd: subRow?.current_period_end ?? null,
  };
}

/** Shape returned to the SPA's confirm step. */
interface BillingPreviewResponse extends BillingPreview {
  /** Human-readable description of the change being previewed. */
  changeLabel: string;
}

/** Compute the cost/proration preview for a pending plan or add-on change.
 *  Returns null with an error code the route maps to a 404. */
async function buildBillingPreview(
  raw: RawClient,
  orgId: string,
  change: z.infer<typeof previewBody>,
): Promise<
  | { ok: true; preview: BillingPreviewResponse }
  | { ok: false; error: "plan_not_found" | "addon_not_found" }
> {
  const state = await loadRecurringState(raw, orgId);
  const currentMonthlyCents = state.planMonthlyCents + state.addonsTotalCents;

  let newMonthlyCents: number;
  let changeLabel: string;

  if (change.kind === "plan") {
    const { data: plan, error } = await raw
      .schema("resupply")
      .from("billing_plans")
      .select("name, monthly_price_cents")
      .eq("code", change.planCode)
      .maybeSingle();
    if (error || !plan) return { ok: false, error: "plan_not_found" };
    const newPlanMonthly = (plan.monthly_price_cents as number | null) ?? 0;
    // A plan switch keeps the existing add-ons; only the plan line changes.
    newMonthlyCents = newPlanMonthly + state.addonsTotalCents;
    changeLabel = `Switch to ${plan.name as string}`;
  } else {
    const { data: addon, error } = await raw
      .schema("resupply")
      .from("billing_addons")
      .select("name, recurring_price_cents")
      .eq("code", change.addonCode)
      .maybeSingle();
    if (error || !addon) return { ok: false, error: "addon_not_found" };
    const existing = state.addonByCode.get(change.addonCode);
    const catalogUnit = (addon.recurring_price_cents as number | null) ?? 0;
    // The current line bills at whatever unit is on the subscription today —
    // which may be a platform-set custom price.
    const currentUnit = existing?.unitCents ?? catalogUnit;
    // The new line bills at the CATALOG rate: both UI save paths driven by
    // this preview clear any custom price (tenant self-service writes
    // custom_recurring_price_cents=null; the platform add-on editor sends no
    // custom price), so the projected total must use catalog pricing or it
    // would mis-state what the save actually charges.
    const currentContribution = (existing?.quantity ?? 0) * currentUnit;
    const newContribution = change.quantity * catalogUnit;
    newMonthlyCents =
      currentMonthlyCents - currentContribution + newContribution;
    changeLabel =
      change.quantity === 0
        ? `Remove ${addon.name as string}`
        : `Set ${addon.name as string} ×${change.quantity}`;
  }

  const preview = computeBillingPreview({
    currentMonthlyCents,
    newMonthlyCents,
    currentPeriodStart: state.currentPeriodStart,
    currentPeriodEnd: state.currentPeriodEnd,
  });
  return { ok: true, preview: { ...preview, changeLabel } };
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

// ── GET /admin/billing/plans ────────────────────────────────────────
// Tenant-facing plan catalog: the public plans a tenant owner can choose
// between. Each plan carries `isCustom` so the SPA can render custom /
// Enterprise tiers as a "contact us" state (not self-selectable) while
// still showing them in the comparison.
router.get(
  "/admin/billing/plans",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await raw
      .schema("resupply")
      .from("billing_plans")
      .select("*")
      // Public plans are self-selectable; custom plans (e.g. Enterprise,
      // seeded is_public=false) are surfaced too so the UI can render them
      // as a non-selectable "Contact us" tier alongside the public plans.
      .or("is_public.eq.true,is_custom.eq.true")
      .order("sort_order");
    if (error) {
      logger.error(
        { event: "tenant_billing_plans_read_failed", err: error },
        "tenant billing plans read failed",
      );
      res.status(500).json({ error: "billing_plans_failed" });
      return;
    }
    res.json({ plans: ((data ?? []) as BillingPlanRow[]).map(mapPlan) });
  },
);

// ── POST /admin/billing/subscription ────────────────────────────────
// Tenant self-service plan selection. The owner picks one of the public,
// non-custom plans; we record it on tenant_billing_subscriptions (the
// same table the super-admin portal reads), then sync the change to
// Stripe (customer + subscription) so billing reflects the choice. Stripe
// sync is best-effort — when the platform-billing Stripe account is not
// configured (dev/preview), the selection is still recorded and the route
// returns 200 so deploys without Stripe keys don't break.
router.post(
  "/admin/billing/subscription",
  adminWriteRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res): Promise<void> => {
    if (!req.orgId) {
      res.status(400).json({ error: "tenant_not_resolved" });
      return;
    }
    const body = selectPlanBody.safeParse(req.body);
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
      .select("id, code, is_public, is_custom")
      .eq("code", body.data.planCode)
      .maybeSingle();
    if (planErr || !plan) {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    // Guard: a tenant may only self-select a public, non-custom plan.
    // Custom/Enterprise tiers require platform-admin assignment.
    if (!plan.is_public || plan.is_custom) {
      res.status(403).json({ error: "plan_not_self_selectable" });
      return;
    }
    // Carry the existing Stripe identity forward when switching plans. The
    // new active row must keep the prior stripe_customer_id /
    // stripe_subscription_id / stripe_account_ref so the subsequent
    // syncTenantStripeSubscription() UPDATES the existing Stripe
    // subscription (swapping its line items to the new plan) instead of
    // creating a second one — leaving the old subscription billing would
    // double-charge the tenant.
    const { data: prior, error: priorErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select(
        "stripe_customer_id, stripe_subscription_id, stripe_account_ref, stripe_status, current_period_start, current_period_end, last_invoice_id, last_invoice_status",
      )
      .eq("org_id", req.orgId)
      .in("status", ["active", "trialing", "past_due"])
      .limit(1)
      .maybeSingle();
    if (priorErr) {
      res.status(500).json({ error: "subscription_update_failed" });
      return;
    }
    const { error: cancelErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .update({
        status: "canceled",
        updated_at: new Date().toISOString(),
        updated_by_email: req.adminEmail ?? null,
        // MOVE the Stripe linkage off the canceled row onto the new active
        // row below. tenant_billing_subscriptions has a partial UNIQUE index
        // on stripe_subscription_id (migration 0363), so the same id can
        // live on only one row — leaving it here would make the carry-forward
        // insert violate the index and fail the plan change.
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_account_ref: null,
        stripe_status: null,
        current_period_start: null,
        current_period_end: null,
        last_invoice_id: null,
        last_invoice_status: null,
      })
      .eq("org_id", req.orgId)
      .in("status", ["active", "trialing", "past_due"]);
    if (cancelErr) {
      res.status(500).json({ error: "subscription_update_failed" });
      return;
    }
    const { error: insErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .insert({
        org_id: req.orgId,
        plan_id: plan.id,
        status: "active",
        notes: "",
        updated_by_email: req.adminEmail ?? null,
        // Preserve the live Stripe linkage from the plan being replaced.
        stripe_customer_id: prior?.stripe_customer_id ?? null,
        stripe_subscription_id: prior?.stripe_subscription_id ?? null,
        stripe_account_ref: prior?.stripe_account_ref ?? null,
        stripe_status: prior?.stripe_status ?? null,
        current_period_start: prior?.current_period_start ?? null,
        current_period_end: prior?.current_period_end ?? null,
        last_invoice_id: prior?.last_invoice_id ?? null,
        last_invoice_status: prior?.last_invoice_status ?? null,
      });
    if (insErr) {
      res.status(500).json({ error: "subscription_update_failed" });
      return;
    }
    await logAudit({
      action: "tenant.billing.subscription.selected",
      adminEmail: req.adminEmail ?? "tenant-admin",
      adminUserId: req.adminUserId ?? null,
      targetTable: "tenant_billing_subscriptions",
      targetId: req.orgId,
      metadata: { planCode: body.data.planCode },
      ip: null,
      userAgent: null,
    }).catch(() => undefined);
    await recordBillingEvent(raw, {
      orgId: req.orgId,
      action: "subscription.selected",
      actor: "tenant",
      operatorEmail: req.adminEmail ?? null,
      summary: `Selected the ${plan.code} plan`,
      metadata: { planCode: body.data.planCode },
    });
    // Best-effort Stripe sync — record the choice regardless of whether
    // the platform-billing Stripe account is configured.
    try {
      const customer = await ensureTenantStripeCustomer({
        orgId: req.orgId,
        adminEmail: req.adminEmail ?? null,
      });
      if (customer.stripeConfigured) {
        await syncTenantStripeSubscription({
          orgId: req.orgId,
          adminEmail: req.adminEmail ?? null,
        });
      }
    } catch (err) {
      // The plan change is already persisted, so Stripe-sync failures must
      // NOT turn into an error response — that would tell the client the
      // selection failed when the tenant is already on the new plan, and
      // invite retries that pile up canceled rows. Every sync failure
      // (including a platform-billing account mismatch, which an operator
      // resolves from the platform portal) is logged best-effort and the
      // recorded selection is returned with 200.
      logger.error(
        {
          event: "tenant_billing_self_select_stripe_failed",
          accountChanged: err instanceof PlatformBillingAccountChangedError,
          err,
        },
        "tenant self-select Stripe sync failed",
      );
    }
    await tenantBilling(req.orgId, res);
  },
);

// ── GET /admin/billing/addons ───────────────────────────────────────
// Tenant-facing add-on catalog: the active add-ons a tenant owner can
// add to their plan. Each carries recurring vs one-time pricing so the
// SPA can render recurring add-ons with a quantity stepper and surface
// one-time/project add-ons (no recurring price) as a "Contact us" tier.
router.get(
  "/admin/billing/addons",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await raw
      .schema("resupply")
      .from("billing_addons")
      .select("*")
      .eq("is_active", true)
      .order("sort_order");
    if (error) {
      logger.error(
        { event: "tenant_billing_addons_read_failed", err: error },
        "tenant billing addons read failed",
      );
      res.status(500).json({ error: "billing_addons_failed" });
      return;
    }
    res.json({ addons: ((data ?? []) as BillingAddonRow[]).map(mapAddon) });
  },
);

// ── PUT /admin/billing/addons ───────────────────────────────────────
// Tenant self-service add-on selection. The owner sets the quantity of a
// recurring add-on on their own org (quantity 0 removes it), then we sync
// the change to Stripe so the subscription's line items reflect it. Same
// owner gate, catalog-rate-only, and best-effort-Stripe posture as the
// plan-selection route. One-time/project add-ons are not self-selectable.
router.put(
  "/admin/billing/addons",
  adminWriteRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res): Promise<void> => {
    if (!req.orgId) {
      res.status(400).json({ error: "tenant_not_resolved" });
      return;
    }
    const body = selectAddonBody.safeParse(req.body);
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
      .select("id, code, is_active, recurring_price_cents")
      .eq("code", body.data.addonCode)
      .maybeSingle();
    if (addonErr || !addon) {
      res.status(404).json({ error: "addon_not_found" });
      return;
    }
    // Guard: only active, recurring add-ons are tenant-self-selectable.
    // One-time/project add-ons (no recurring price) carry scoped pricing
    // and stay platform-admin-assigned.
    if (!addon.is_active || addon.recurring_price_cents == null) {
      res.status(403).json({ error: "addon_not_self_selectable" });
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
          updated_by_email: req.adminEmail ?? null,
        })
        .eq("org_id", req.orgId)
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
        .eq("org_id", req.orgId)
        .eq("addon_id", addon.id)
        .eq("status", "active")
        .maybeSingle();
      if (readErr) {
        res.status(500).json({ error: "addon_update_failed" });
        return;
      }
      // Tenants pay the catalog rate — never accept a custom price here.
      const payload = {
        quantity: body.data.quantity,
        status: "active",
        custom_recurring_price_cents: null,
        updated_by_email: req.adminEmail ?? null,
        updated_at: new Date().toISOString(),
      };
      let write = existing
        ? await raw
            .schema("resupply")
            .from("tenant_billing_addons")
            .update(payload)
            .eq("id", existing.id)
        : await raw
            .schema("resupply")
            .from("tenant_billing_addons")
            .insert({ ...payload, org_id: req.orgId, addon_id: addon.id });
      // Race fallback: the read-then-insert path can lose to a concurrent
      // request (double-click/retry) and trip the partial unique index on
      // (org_id, addon_id) WHERE status='active' (migration 0362). Treat
      // that 23505 as idempotent — update the row the winner just created
      // rather than 500 the loser.
      if (write.error && !existing && write.error.code === "23505") {
        write = await raw
          .schema("resupply")
          .from("tenant_billing_addons")
          .update(payload)
          .eq("org_id", req.orgId)
          .eq("addon_id", addon.id)
          .eq("status", "active");
      }
      if (write.error) {
        res.status(500).json({ error: "addon_update_failed" });
        return;
      }
    }
    await logAudit({
      action: "tenant.billing.addon.updated",
      adminEmail: req.adminEmail ?? "tenant-admin",
      adminUserId: req.adminUserId ?? null,
      targetTable: "tenant_billing_addons",
      targetId: req.orgId,
      metadata: {
        addonCode: body.data.addonCode,
        quantity: body.data.quantity,
      },
      ip: null,
      userAgent: null,
    }).catch(() => undefined);
    await recordBillingEvent(raw, {
      orgId: req.orgId,
      action: "addon.updated",
      actor: "tenant",
      operatorEmail: req.adminEmail ?? null,
      summary:
        body.data.quantity === 0
          ? `Removed the ${addon.code} add-on`
          : `Set the ${addon.code} add-on to ×${body.data.quantity}`,
      metadata: {
        addonCode: body.data.addonCode,
        quantity: body.data.quantity,
      },
    });
    // Best-effort Stripe sync — mirror the plan-selection route. A sync
    // failure is logged but never fails the request (the add-on change is
    // already recorded), so deploys without platform-billing Stripe keys
    // still work.
    try {
      const customer = await ensureTenantStripeCustomer({
        orgId: req.orgId,
        adminEmail: req.adminEmail ?? null,
      });
      if (customer.stripeConfigured) {
        await syncTenantStripeSubscription({
          orgId: req.orgId,
          adminEmail: req.adminEmail ?? null,
        });
      }
    } catch (err) {
      logger.error(
        {
          event: "tenant_billing_addon_self_select_stripe_failed",
          accountChanged: err instanceof PlatformBillingAccountChangedError,
          err,
        },
        "tenant self-select add-on Stripe sync failed",
      );
    }
    await tenantBilling(req.orgId, res);
  },
);

// ── POST /admin/billing/preview ─────────────────────────────────────
// Cost / proration preview for the tenant self-service confirm step. The
// owner sees the new monthly total, the change vs. today, and the prorated
// amount for the rest of the current period BEFORE committing the change.
// Read-only — records nothing and touches no Stripe state.
router.post(
  "/admin/billing/preview",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!req.orgId) {
      res.status(400).json({ error: "tenant_not_resolved" });
      return;
    }
    const body = previewBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "invalid_preview", details: body.error.flatten() });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    try {
      const result = await buildBillingPreview(raw, req.orgId, body.data);
      if (!result.ok) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result.preview);
    } catch (err) {
      logger.error(
        { event: "tenant_billing_preview_failed", err },
        "tenant billing preview failed",
      );
      res.status(500).json({ error: "billing_preview_failed" });
    }
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

// ── PUT /platform/billing/catalog/plans/:code ───────────────────────
// Edit a subscription plan's BASE pricing + presentation. This is the
// catalog row every tenant account and the public marketing page read
// from, and the source the Stripe catalog sync mints prices from — so an
// edit here populates all three. When the monthly price actually changes
// we clear the stored (immutable) Stripe price id so the follow-up sync
// mints a fresh Stripe price at the new amount (the product id is reused),
// then best-effort re-sync the catalog to Stripe. A Stripe hiccup never
// fails the edit: the DB is the source of truth for tenant accounts + the
// marketing page.
router.put(
  "/platform/billing/catalog/plans/:code",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const param = catalogCodeParam.safeParse(req.params);
    const body = planEditBody.safeParse(req.body);
    if (!param.success) {
      res.status(400).json({ error: "invalid_code" });
      return;
    }
    if (!body.success) {
      res
        .status(400)
        .json({ error: "invalid_plan", details: body.error.flatten() });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data: existing, error: exErr } = await raw
      .schema("resupply")
      .from("billing_plans")
      .select("*")
      .eq("code", param.data.code)
      .maybeSingle();
    if (exErr || !existing) {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    const b = body.data;
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (b.name !== undefined) patch.name = b.name;
    if (b.description !== undefined) patch.description = b.description;
    if (b.monthlyPriceCents !== undefined)
      patch.monthly_price_cents = b.monthlyPriceCents;
    if (b.onboardingFeeCents !== undefined)
      patch.onboarding_fee_cents = b.onboardingFeeCents;
    if (b.allowances !== undefined) patch.allowances = b.allowances;
    if (b.features !== undefined) patch.features = b.features;
    if (b.isPublic !== undefined) patch.is_public = b.isPublic;
    if (b.sortOrder !== undefined) patch.sort_order = b.sortOrder;

    const priceChanged =
      b.monthlyPriceCents !== undefined &&
      (b.monthlyPriceCents ?? null) !== (existing.monthly_price_cents ?? null);
    if (priceChanged) {
      patch.stripe_price_id = null;
      patch.stripe_synced_at = null;
    }

    const { error: updErr } = await raw
      .schema("resupply")
      .from("billing_plans")
      .update(patch)
      .eq("id", existing.id);
    if (updErr) {
      res.status(500).json({ error: "plan_update_failed" });
      return;
    }
    await logAudit({
      action: "platform.billing.catalog.plan.updated",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "billing_plans",
      targetId: existing.id,
      metadata: { code: param.data.code, priceChanged },
      ip: null,
      userAgent: null,
    }).catch(() => undefined);
    // When the price changed: re-mint the catalog Stripe price, and report
    // how many tenants still bill the old amount so the UI can offer a
    // deliberate re-sync (we never auto-reprice live tenant subscriptions).
    const affectedTenants = priceChanged
      ? await countTenantsAffectedByPlan(raw, existing.id)
      : 0;
    if (priceChanged) await resyncCatalogToStripe();
    const data = await loadCatalog(raw);
    if (!data) {
      res.status(500).json({ error: "billing_catalog_failed" });
      return;
    }
    res.json({ ...data, affectedTenants });
  },
);

// ── PUT /platform/billing/catalog/addons/:code ──────────────────────
// Edit an add-on's BASE pricing + presentation (recurring or one-time).
// Same populate-everywhere + Stripe-reprice posture as the plan edit
// above; the immutable Stripe price is reminted only when the recurring
// price actually changes.
router.put(
  "/platform/billing/catalog/addons/:code",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const param = catalogCodeParam.safeParse(req.params);
    const body = addonEditBody.safeParse(req.body);
    if (!param.success) {
      res.status(400).json({ error: "invalid_code" });
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
    const { data: existing, error: exErr } = await raw
      .schema("resupply")
      .from("billing_addons")
      .select("*")
      .eq("code", param.data.code)
      .maybeSingle();
    if (exErr || !existing) {
      res.status(404).json({ error: "addon_not_found" });
      return;
    }
    const b = body.data;
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (b.name !== undefined) patch.name = b.name;
    if (b.description !== undefined) patch.description = b.description;
    if (b.category !== undefined) patch.category = b.category;
    if (b.recurringPriceCents !== undefined)
      patch.recurring_price_cents = b.recurringPriceCents;
    if (b.oneTimeMinCents !== undefined)
      patch.one_time_min_cents = b.oneTimeMinCents;
    if (b.oneTimeMaxCents !== undefined)
      patch.one_time_max_cents = b.oneTimeMaxCents;
    if (b.unitLabel !== undefined) patch.unit_label = b.unitLabel;
    if (b.usageMetric !== undefined) patch.usage_metric = b.usageMetric;
    if (b.passThroughNote !== undefined)
      patch.pass_through_note = b.passThroughNote;
    if (b.isActive !== undefined) patch.is_active = b.isActive;
    if (b.sortOrder !== undefined) patch.sort_order = b.sortOrder;

    const priceChanged =
      b.recurringPriceCents !== undefined &&
      (b.recurringPriceCents ?? null) !==
        (existing.recurring_price_cents ?? null);
    if (priceChanged) {
      patch.stripe_price_id = null;
      patch.stripe_synced_at = null;
    }

    const { error: updErr } = await raw
      .schema("resupply")
      .from("billing_addons")
      .update(patch)
      .eq("id", existing.id);
    if (updErr) {
      res.status(500).json({ error: "addon_update_failed" });
      return;
    }
    await logAudit({
      action: "platform.billing.catalog.addon.updated",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "billing_addons",
      targetId: existing.id,
      metadata: { code: param.data.code, priceChanged },
      ip: null,
      userAgent: null,
    }).catch(() => undefined);
    const affectedTenants = priceChanged
      ? await countTenantsAffectedByAddon(raw, existing.id)
      : 0;
    if (priceChanged) await resyncCatalogToStripe();
    const data = await loadCatalog(raw);
    if (!data) {
      res.status(500).json({ error: "billing_catalog_failed" });
      return;
    }
    res.json({ ...data, affectedTenants });
  },
);

// ── POST /platform/billing/tenants/resync-stripe ────────────────────
// Re-sync every tenant's live Stripe subscription to the CURRENT catalog
// (and per-tenant custom) pricing. The deliberate counterpart to a catalog
// price edit: editing the catalog never auto-reprices live subscriptions
// (that would prorate every tenant unexpectedly); the operator triggers
// this when they're ready to roll the new price out. Tenants with a custom
// override re-resolve to their custom price (a no-op), so running it over
// everyone is safe. Best-effort per tenant; one failure doesn't abort.
router.post(
  "/platform/billing/tenants/resync-stripe",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select("org_id")
      .in("status", ACTIVE_SUB_STATUSES)
      .not("stripe_subscription_id", "is", null);
    if (error) {
      res.status(500).json({ error: "tenant_resync_failed" });
      return;
    }
    const orgIds = Array.from(
      new Set(((data ?? []) as Array<{ org_id: string }>).map((r) => r.org_id)),
    );
    let synced = 0;
    let failed = 0;
    for (const orgId of orgIds) {
      try {
        await syncTenantStripeSubscription({
          orgId,
          adminEmail: req.platformAdminEmail ?? null,
        });
        synced += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof PlatformBillingAccountChangedError) {
          logger.warn(
            { event: "tenant_resync_account_changed", orgId },
            "tenant Stripe resync skipped — account changed",
          );
        } else {
          logger.error(
            { event: "tenant_resync_failed", orgId, err },
            "tenant Stripe resync failed",
          );
        }
      }
    }
    await logAudit({
      action: "platform.billing.tenants.stripe.resynced",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "tenant_billing_subscriptions",
      targetId: "fleet",
      metadata: { total: orgIds.length, synced, failed },
      ip: null,
      userAgent: null,
    }).catch(() => undefined);
    res.json({ total: orgIds.length, synced, failed });
  },
);

// ── GET /platform/billing/summary ───────────────────────────────────
// Fleet recurring-revenue (MRR) rollup for the super-admin dashboard:
// total MRR, ARPU, paying/trialing/past-due counts, and an MRR-by-plan
// breakdown. Aggregate dollar rollups only. Reads only the billing
// tables (subscriptions + add-ons + plans) plus a tenant HEAD count, so
// it stays cheap regardless of patient/order volume.
interface SummarySubRow {
  org_id: string;
  status: string;
  custom_monthly_price_cents: number | null;
  billing_plans: {
    code: string;
    name: string;
    monthly_price_cents: number | null;
  } | null;
}
interface SummaryAddonRow {
  org_id: string;
  quantity: number | null;
  custom_recurring_price_cents: number | null;
  billing_addons: { recurring_price_cents: number | null } | null;
}

router.get(
  "/platform/billing/summary",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const [orgCount, subs, addons] = await Promise.all([
      raw
        .schema("resupply")
        .from("organizations")
        .select("id", { count: "exact", head: true }),
      raw
        .schema("resupply")
        .from("tenant_billing_subscriptions")
        .select(
          "org_id, status, custom_monthly_price_cents, billing_plans(code, name, monthly_price_cents)",
        )
        .in("status", ["active", "trialing", "past_due"]),
      raw
        .schema("resupply")
        .from("tenant_billing_addons")
        .select(
          "org_id, quantity, custom_recurring_price_cents, billing_addons(recurring_price_cents)",
        )
        .eq("status", "active"),
    ]);
    if (orgCount.error || subs.error || addons.error) {
      logger.error(
        {
          event: "platform_billing_summary_failed",
          err: orgCount.error ?? subs.error ?? addons.error,
        },
        "platform billing summary read failed",
      );
      res.status(500).json({ error: "billing_summary_failed" });
      return;
    }

    // One subscription per org (the directory query may return history;
    // first active/trialing/past_due wins — mirrors /billing/tenants).
    // PostgREST's select-string parser types embedded relationships
    // (`billing_plans(...)`) as arrays, but a to-one embed returns a single
    // object at runtime — cast through `unknown` to our narrowed shape.
    const subByOrg = new Map<string, SummarySubRow>();
    for (const s of (subs.data ?? []) as unknown as SummarySubRow[]) {
      if (!subByOrg.has(s.org_id)) subByOrg.set(s.org_id, s);
    }
    const addonsByOrg = new Map<string, SummaryAddonRow[]>();
    for (const a of (addons.data ?? []) as unknown as SummaryAddonRow[]) {
      const list = addonsByOrg.get(a.org_id);
      if (list) list.push(a);
      else addonsByOrg.set(a.org_id, [a]);
    }

    const orgIds = new Set<string>([...subByOrg.keys(), ...addonsByOrg.keys()]);
    const entries: FleetBillingTenant[] = [...orgIds].map((orgId) => {
      const s = subByOrg.get(orgId);
      return {
        orgId,
        subscription: s
          ? {
              status: s.status,
              customMonthlyPriceCents: s.custom_monthly_price_cents,
              planCode: s.billing_plans?.code ?? "unknown",
              planName: s.billing_plans?.name ?? "Unknown plan",
              planMonthlyPriceCents:
                s.billing_plans?.monthly_price_cents ?? null,
            }
          : null,
        addons: (addonsByOrg.get(orgId) ?? []).map((a) => ({
          quantity: a.quantity ?? 0,
          customRecurringPriceCents: a.custom_recurring_price_cents,
          addonRecurringPriceCents:
            a.billing_addons?.recurring_price_cents ?? null,
        })),
      };
    });

    const summary = summarizeFleetBilling(entries, orgCount.count ?? 0);
    res.json({ ...summary, generatedAt: new Date().toISOString() });
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
      raw.rpc(
        "platform_tenant_usage_snapshot" as never,
        {
          p_month_start: monthStart.toISOString(),
        } as never,
      ),
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
    const { data: priorSub, error: priorSubErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select(
        "stripe_customer_id, stripe_subscription_id, stripe_account_ref, stripe_status, current_period_start, current_period_end, last_invoice_id, last_invoice_status",
      )
      .eq("org_id", param.data.id)
      .in("status", ["active", "trialing", "past_due"])
      .limit(1)
      .maybeSingle();
    if (priorSubErr) {
      res.status(500).json({ error: "subscription_update_failed" });
      return;
    }
    const { error: cancelErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .update({
        status: "canceled",
        updated_at: new Date().toISOString(),
        updated_by_email: req.platformAdminEmail ?? null,
        // MOVE the Stripe linkage off the canceled row onto the new active
        // row below — the partial UNIQUE index on stripe_subscription_id
        // (migration 0363) allows the id on only one row, so leaving it here
        // would make the carry-forward insert violate the index.
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_account_ref: null,
        stripe_status: null,
        current_period_start: null,
        current_period_end: null,
        last_invoice_id: null,
        last_invoice_status: null,
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
        // Carry the live Stripe linkage forward so a later
        // syncTenantStripeSubscription() UPDATES the existing subscription
        // (swapping its line items to the new plan) instead of creating a
        // second one and leaving the old one billing — see the same guard
        // on the tenant self-select route.
        stripe_customer_id: priorSub?.stripe_customer_id ?? null,
        stripe_subscription_id: priorSub?.stripe_subscription_id ?? null,
        stripe_account_ref: priorSub?.stripe_account_ref ?? null,
        stripe_status: priorSub?.stripe_status ?? null,
        current_period_start: priorSub?.current_period_start ?? null,
        current_period_end: priorSub?.current_period_end ?? null,
        last_invoice_id: priorSub?.last_invoice_id ?? null,
        last_invoice_status: priorSub?.last_invoice_status ?? null,
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
    await recordBillingEvent(raw, {
      orgId: param.data.id,
      action: "subscription.updated",
      actor: "platform",
      operatorEmail: req.platformAdminEmail ?? null,
      summary: `Assigned the ${plan.code} plan (${body.data.status})`,
      metadata: {
        planCode: body.data.planCode,
        status: body.data.status,
        customMonthlyPriceCents: body.data.customMonthlyPriceCents ?? null,
      },
    });
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
      let write = existing
        ? await raw
            .schema("resupply")
            .from("tenant_billing_addons")
            .update(payload)
            .eq("id", existing.id)
        : await raw
            .schema("resupply")
            .from("tenant_billing_addons")
            .insert({ ...payload, org_id: param.data.id, addon_id: addon.id });
      // Race fallback: the read-then-insert path can lose to a concurrent
      // request (double-click/retry) and trip the partial unique index on
      // (org_id, addon_id) WHERE status='active' (migration 0362). Treat
      // that 23505 as idempotent — update the row the winner just created
      // rather than 500 the loser. Mirrors the tenant self-service route.
      if (write.error && !existing && write.error.code === "23505") {
        write = await raw
          .schema("resupply")
          .from("tenant_billing_addons")
          .update(payload)
          .eq("org_id", param.data.id)
          .eq("addon_id", addon.id)
          .eq("status", "active");
      }
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
    await recordBillingEvent(raw, {
      orgId: param.data.id,
      action: "addon.updated",
      actor: "platform",
      operatorEmail: req.platformAdminEmail ?? null,
      summary:
        body.data.quantity === 0
          ? `Removed the ${addon.code} add-on`
          : `Set the ${addon.code} add-on to ×${body.data.quantity}`,
      metadata: {
        addonCode: body.data.addonCode,
        quantity: body.data.quantity,
      },
    });
    await tenantBilling(param.data.id, res);
  },
);

// ── POST /platform/billing/tenants/:id/preview ──────────────────────
// Cost / proration preview for the super-admin confirm step — the same
// estimate the tenant self-service route returns, for any tenant. Read-only.
router.post(
  "/platform/billing/tenants/:id/preview",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const param = tenantIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const body = previewBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "invalid_preview", details: body.error.flatten() });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    try {
      const result = await buildBillingPreview(raw, param.data.id, body.data);
      if (!result.ok) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result.preview);
    } catch (err) {
      logger.error(
        { event: "platform_billing_preview_failed", err },
        "platform billing preview failed",
      );
      res.status(500).json({ error: "billing_preview_failed" });
    }
  },
);

// ── GET /platform/billing/activity ──────────────────────────────────
// Recent tenant-billing changes across the fleet for the super-admin
// portal's "Recent billing activity" panel. Reads the append-only
// tenant_billing_events feed (migration 0386) and joins the org name so the
// panel can show which tenant each change applies to. Platform billing
// metadata only — plan/add-on codes, quantities, operator email. No PHI.
const billingActivityQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return 25;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return 25;
      return Math.min(n, 100);
    }),
});

interface BillingEventRow {
  id: string;
  org_id: string;
  action: string;
  actor: string;
  operator_email: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
}

router.get(
  "/platform/billing/activity",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = billingActivityQuery.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : 25;
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await raw
      .schema("resupply")
      .from("tenant_billing_events")
      .select(
        "id, org_id, action, actor, operator_email, summary, metadata, occurred_at",
      )
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) {
      logger.error(
        { event: "platform_billing_activity_failed", err: error },
        "platform billing activity read failed",
      );
      res.status(500).json({ error: "billing_activity_failed" });
      return;
    }
    const rows = (data ?? []) as BillingEventRow[];
    // Resolve org display names in one query (newest events reference few
    // distinct orgs). Falls back to the org id when the name is unknown.
    const orgIds = [...new Set(rows.map((r) => r.org_id))];
    const nameByOrg = new Map<string, string>();
    if (orgIds.length > 0) {
      const { data: orgs } = await raw
        .schema("resupply")
        .from("organizations")
        .select("id, slug, name, storefront_name")
        .in("id", orgIds);
      for (const o of (orgs ?? []) as Array<{
        id: string;
        slug: string | null;
        name: string | null;
        storefront_name: string | null;
      }>) {
        nameByOrg.set(o.id, o.storefront_name || o.name || o.slug || o.id);
      }
    }
    res.json({
      activity: rows.map((r) => ({
        id: r.id,
        tenantId: r.org_id,
        tenantName: nameByOrg.get(r.org_id) ?? r.org_id,
        action: r.action,
        actor: r.actor,
        operatorEmail: r.operator_email,
        summary: r.summary,
        metadata: r.metadata ?? {},
        occurredAt: r.occurred_at,
      })),
    });
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
      if (err instanceof PlatformBillingAccountChangedError) {
        res.status(409).json({ error: "stripe_account_changed" });
        return;
      }
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
      if (err instanceof PlatformBillingAccountChangedError) {
        res.status(409).json({ error: "stripe_account_changed" });
        return;
      }
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
