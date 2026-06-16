import type Stripe from "stripe";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../logger";
import {
  getStripeClient,
  readStripeConfigOrNull,
  type StripeConfig,
} from "../stripe/config";

const PLATFORM_BILLING_SCOPE = "platform_tenant";

type RawClient = ReturnType<ReturnType<typeof getOrgScopedClient>["raw"]>;

export interface PlatformStripeSyncResult {
  stripeConfigured: boolean;
  customerId?: string;
  subscriptionId?: string;
  status?: string | null;
  catalog?: { plans: number; addons: number };
}

async function rawClient(): Promise<RawClient | null> {
  const seedOrgId = await resolveSeedOrgId();
  return seedOrgId ? getOrgScopedClient(seedOrgId).raw() : null;
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStripeTimestamp(value: unknown): string | null {
  return typeof value === "number"
    ? new Date(value * 1000).toISOString()
    : null;
}

function invoiceStatus(invoice: unknown): {
  id: string | null;
  status: string | null;
} {
  if (!invoice || typeof invoice !== "object")
    return { id: null, status: null };
  const obj = invoice as { id?: unknown; status?: unknown };
  return {
    id: typeof obj.id === "string" ? obj.id : null,
    status: typeof obj.status === "string" ? obj.status : null,
  };
}

function priceMetadata(kind: "plan" | "addon", code: string) {
  return {
    billing_scope: PLATFORM_BILLING_SCOPE,
    billing_catalog_kind: kind,
    billing_catalog_code: code,
  };
}

/** A billing_plans / billing_addons catalog row, narrowed to the fields
 *  the Stripe sync touches. Rows arrive untyped from the service-role
 *  client (the billing tables aren't in the generated Database types). */
interface CatalogRow {
  id: string;
  name: string;
  description?: string | null;
  code: string;
  stripe_price_id?: string | null;
  stripe_product_id?: string | null;
}

async function ensureRecurringPrice(args: {
  stripe: Stripe;
  raw: RawClient;
  table: "billing_plans" | "billing_addons";
  kind: "plan" | "addon";
  row: CatalogRow;
  amountCents: number | null;
}): Promise<string | null> {
  if (!args.amountCents || args.amountCents <= 0)
    return args.row.stripe_price_id ?? null;
  if (args.row.stripe_price_id) return args.row.stripe_price_id;

  const product = args.row.stripe_product_id
    ? await args.stripe.products.update(args.row.stripe_product_id, {
        name: args.row.name,
        metadata: priceMetadata(args.kind, args.row.code),
      })
    : await args.stripe.products.create({
        name: args.row.name,
        description: args.row.description ?? undefined,
        metadata: priceMetadata(args.kind, args.row.code),
      });

  const price = await args.stripe.prices.create({
    product: product.id,
    unit_amount: args.amountCents,
    currency: "usd",
    recurring: { interval: "month" },
    metadata: priceMetadata(args.kind, args.row.code),
  });

  await args.raw
    .schema("resupply")
    .from(args.table)
    .update({
      stripe_product_id: product.id,
      stripe_price_id: price.id,
      stripe_synced_at: new Date().toISOString(),
    })
    .eq("id", args.row.id);
  return price.id;
}

export async function syncPlatformBillingCatalogToStripe(): Promise<PlatformStripeSyncResult> {
  const config = readStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const raw = await rawClient();
  if (!raw) throw new Error("tenant_directory_unavailable");
  const stripe = getStripeClient(config);
  const [plans, addons] = await Promise.all([
    raw.schema("resupply").from("billing_plans").select("*"),
    raw.schema("resupply").from("billing_addons").select("*"),
  ]);
  if (plans.error || addons.error) throw plans.error ?? addons.error;
  let syncedPlans = 0;
  for (const plan of plans.data ?? []) {
    const price = await ensureRecurringPrice({
      stripe,
      raw,
      table: "billing_plans",
      kind: "plan",
      row: plan,
      amountCents: cents(plan.monthly_price_cents),
    });
    if (price) syncedPlans += 1;
  }
  let syncedAddons = 0;
  for (const addon of addons.data ?? []) {
    const price = await ensureRecurringPrice({
      stripe,
      raw,
      table: "billing_addons",
      kind: "addon",
      row: addon,
      amountCents: cents(addon.recurring_price_cents),
    });
    if (price) syncedAddons += 1;
  }
  return {
    stripeConfigured: true,
    catalog: { plans: syncedPlans, addons: syncedAddons },
  };
}

async function tenantRow(raw: RawClient, orgId: string) {
  const { data, error } = await raw
    .schema("resupply")
    .from("organizations")
    .select("id, slug, name, storefront_name")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("tenant_not_found");
  return data;
}

async function activeSubscription(raw: RawClient, orgId: string) {
  const { data, error } = await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .select("*, billing_plans(*)")
    .eq("org_id", orgId)
    .in("status", ["active", "trialing", "past_due"])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("subscription_not_found");
  return data;
}

async function activeAddons(raw: RawClient, orgId: string) {
  const { data, error } = await raw
    .schema("resupply")
    .from("tenant_billing_addons")
    .select("*, billing_addons(*)")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (error) throw error;
  return data ?? [];
}

export async function ensureTenantStripeCustomer(args: {
  orgId: string;
  adminEmail?: string | null;
}): Promise<PlatformStripeSyncResult> {
  const config = readStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const raw = await rawClient();
  if (!raw) throw new Error("tenant_directory_unavailable");
  const [tenant, sub] = await Promise.all([
    tenantRow(raw, args.orgId),
    activeSubscription(raw, args.orgId),
  ]);
  if (sub.stripe_customer_id) {
    return { stripeConfigured: true, customerId: sub.stripe_customer_id };
  }
  const stripe = getStripeClient(config);
  const customer = await stripe.customers.create({
    name: tenant.storefront_name ?? tenant.name ?? tenant.slug,
    metadata: {
      billing_scope: PLATFORM_BILLING_SCOPE,
      org_id: args.orgId,
      tenant_slug: tenant.slug,
    },
  });
  await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .update({
      stripe_customer_id: customer.id,
      stripe_last_synced_at: new Date().toISOString(),
      updated_by_email: args.adminEmail ?? null,
    })
    .eq("id", sub.id);
  await logAudit({
    action: "platform.billing.stripe.customer.created",
    adminEmail: args.adminEmail ?? "platform-admin",
    adminUserId: null,
    targetTable: "tenant_billing_subscriptions",
    targetId: args.orgId,
    metadata: { stripeCustomerId: customer.id },
    ip: null,
    userAgent: null,
  }).catch(() => undefined);
  return { stripeConfigured: true, customerId: customer.id };
}

/** Recent Stripe API versions expose the billing period on subscription
 *  items rather than the subscription itself, so the SDK's
 *  `Stripe.Subscription` type no longer declares these top-level fields
 *  even though they're still present on the wire. Narrow to read them
 *  without reaching for `any`. */
type SubscriptionPeriods = {
  current_period_start?: number | null;
  current_period_end?: number | null;
};

/** The subscription line items this module builds: either a reference to
 *  an existing recurring price, or an inline `price_data` with
 *  `product_data`. The latter shape isn't modeled by the Stripe SDK's
 *  subscription-item `PriceData` type (it expects an existing `product`),
 *  so the call sites cast through `unknown` to the SDK param type rather
 *  than reach for `any`. */
type SubscriptionItemInput =
  | { price: string; quantity: number }
  | {
      price_data: {
        product_data: { name: string; metadata: Record<string, string> };
        currency: string;
        unit_amount: number;
        recurring: { interval: "month" };
      };
      quantity: number;
    };

function subscriptionStatus(sub: Stripe.Subscription): string | null {
  return sub.status ?? null;
}

export async function syncTenantStripeSubscription(args: {
  orgId: string;
  adminEmail?: string | null;
}): Promise<PlatformStripeSyncResult> {
  const config: StripeConfig | null = readStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const raw = await rawClient();
  if (!raw) throw new Error("tenant_directory_unavailable");
  const stripe = getStripeClient(config);
  await syncPlatformBillingCatalogToStripe();
  const [tenant, sub, addons] = await Promise.all([
    tenantRow(raw, args.orgId),
    activeSubscription(raw, args.orgId),
    activeAddons(raw, args.orgId),
  ]);
  const customer = sub.stripe_customer_id
    ? { id: sub.stripe_customer_id }
    : await stripe.customers.create({
        name: tenant.storefront_name ?? tenant.name ?? tenant.slug,
        metadata: {
          billing_scope: PLATFORM_BILLING_SCOPE,
          org_id: args.orgId,
          tenant_slug: tenant.slug,
        },
      });

  const plan = sub.billing_plans;
  const planAmount =
    cents(sub.custom_monthly_price_cents) ?? cents(plan.monthly_price_cents);
  const planPriceId = sub.custom_monthly_price_cents
    ? null
    : await ensureRecurringPrice({
        stripe,
        raw,
        table: "billing_plans",
        kind: "plan",
        row: plan,
        amountCents: cents(plan.monthly_price_cents),
      });
  if (!planAmount || planAmount <= 0) throw new Error("plan_not_billable");

  const items: SubscriptionItemInput[] = [
    planPriceId
      ? { price: planPriceId, quantity: 1 }
      : {
          price_data: {
            product_data: {
              name: `${plan.name} custom monthly`,
              metadata: priceMetadata("plan", plan.code),
            },
            currency: "usd",
            unit_amount: planAmount,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
  ];

  for (const tenantAddon of addons) {
    const addon = tenantAddon.billing_addons;
    const amount =
      cents(tenantAddon.custom_recurring_price_cents) ??
      cents(addon.recurring_price_cents);
    if (!amount || amount <= 0 || tenantAddon.quantity <= 0) continue;
    const priceId = tenantAddon.custom_recurring_price_cents
      ? null
      : await ensureRecurringPrice({
          stripe,
          raw,
          table: "billing_addons",
          kind: "addon",
          row: addon,
          amountCents: cents(addon.recurring_price_cents),
        });
    items.push(
      priceId
        ? { price: priceId, quantity: tenantAddon.quantity }
        : {
            price_data: {
              product_data: {
                name: `${addon.name} custom monthly`,
                metadata: priceMetadata("addon", addon.code),
              },
              currency: "usd",
              unit_amount: amount,
              recurring: { interval: "month" },
            },
            quantity: tenantAddon.quantity,
          },
    );
  }

  const metadata = {
    billing_scope: PLATFORM_BILLING_SCOPE,
    org_id: args.orgId,
    tenant_slug: tenant.slug,
    plan_code: plan.code,
  };
  let stripeSub: Stripe.Subscription;
  if (sub.stripe_subscription_id) {
    const existing = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id,
      { expand: ["items"] },
    );
    const deletedItems = (existing.items?.data ?? []).map((item) => ({
      id: item.id,
      deleted: true,
    }));
    stripeSub = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      metadata,
      items: [
        ...deletedItems,
        ...items,
      ] as unknown as Stripe.SubscriptionUpdateParams.Item[],
      proration_behavior: "create_prorations",
      expand: ["latest_invoice"],
    });
  } else {
    stripeSub = await stripe.subscriptions.create({
      customer: customer.id,
      items: items as unknown as Stripe.SubscriptionCreateParams.Item[],
      metadata,
      collection_method: "send_invoice",
      days_until_due: 15,
      expand: ["latest_invoice"],
    });
  }

  const latestInvoice = invoiceStatus(stripeSub.latest_invoice);
  const stripeSubPeriods = stripeSub as Stripe.Subscription &
    SubscriptionPeriods;
  await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .update({
      stripe_customer_id: customer.id,
      stripe_subscription_id: stripeSub.id,
      stripe_status: subscriptionStatus(stripeSub),
      stripe_last_synced_at: new Date().toISOString(),
      current_period_start: asStripeTimestamp(
        stripeSubPeriods.current_period_start,
      ),
      current_period_end: asStripeTimestamp(
        stripeSubPeriods.current_period_end,
      ),
      last_invoice_id: latestInvoice.id,
      last_invoice_status: latestInvoice.status,
      updated_by_email: args.adminEmail ?? null,
    })
    .eq("id", sub.id);

  await logAudit({
    action: "platform.billing.stripe.subscription.synced",
    adminEmail: args.adminEmail ?? "platform-admin",
    adminUserId: null,
    targetTable: "tenant_billing_subscriptions",
    targetId: args.orgId,
    metadata: {
      stripeCustomerId: customer.id,
      stripeSubscriptionId: stripeSub.id,
    },
    ip: null,
    userAgent: null,
  }).catch(() => undefined);

  return {
    stripeConfigured: true,
    customerId: customer.id,
    subscriptionId: stripeSub.id,
    status: subscriptionStatus(stripeSub),
  };
}

export async function handlePlatformTenantStripeEvent(
  event: Stripe.Event,
): Promise<boolean> {
  if (
    event.type !== "customer.subscription.created" &&
    event.type !== "customer.subscription.updated" &&
    event.type !== "customer.subscription.deleted" &&
    event.type !== "invoice.paid" &&
    event.type !== "invoice.payment_failed"
  ) {
    return false;
  }
  const raw = await rawClient();
  if (!raw) return false;
  if (event.type.startsWith("customer.subscription.")) {
    const sub = event.data.object as Stripe.Subscription;
    if (
      sub.metadata?.billing_scope !== PLATFORM_BILLING_SCOPE ||
      !sub.metadata.org_id
    )
      return false;
    const subPeriods = sub as Stripe.Subscription & SubscriptionPeriods;
    const { error } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .update({
        stripe_subscription_id: sub.id,
        stripe_status: sub.status,
        stripe_last_synced_at: new Date().toISOString(),
        current_period_start: asStripeTimestamp(
          subPeriods.current_period_start,
        ),
        current_period_end: asStripeTimestamp(subPeriods.current_period_end),
      })
      .eq("org_id", sub.metadata.org_id)
      .in("status", ["active", "trialing", "past_due"]);
    if (error) {
      logger.error(
        {
          event: "platform_billing_stripe_subscription_webhook_update_failed",
          err: error,
          orgId: sub.metadata.org_id,
          stripeSubscriptionId: sub.id,
        },
        "platform billing Stripe subscription webhook update failed",
      );
    }
    return true;
  }
  const invoice = event.data.object as Stripe.Invoice;
  const legacySub = (
    invoice as Stripe.Invoice & {
      subscription?: string | Stripe.Subscription | null;
    }
  ).subscription;
  const subRef =
    invoice.parent?.subscription_details?.subscription ?? legacySub;
  const subscriptionId =
    typeof subRef === "string" ? subRef : (subRef?.id ?? null);
  if (!subscriptionId) return false;
  const { error } = await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .update({
      last_invoice_id: invoice.id,
      last_invoice_status: invoice.status,
      stripe_last_synced_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId);
  if (error) {
    logger.error(
      {
        event: "platform_billing_stripe_invoice_webhook_update_failed",
        err: error,
        stripeSubscriptionId: subscriptionId,
      },
      "platform billing Stripe invoice webhook update failed",
    );
  }
  logger.info(
    {
      event: "platform_billing_stripe_invoice_synced",
      stripeSubscriptionId: subscriptionId,
    },
    "platform billing Stripe invoice synced",
  );
  return true;
}
