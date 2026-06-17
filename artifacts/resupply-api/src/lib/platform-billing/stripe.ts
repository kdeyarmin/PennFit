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
  paymentMethod?: PlatformTenantPaymentMethodSummary | null;
}

export interface PlatformTenantPaymentMethodSummary {
  id: string;
  type: string | null;
  brand: string | null;
  last4: string | null;
}

export interface PlatformStripeHostedSessionResult {
  stripeConfigured: boolean;
  url?: string;
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

async function ensureRecurringPrice(args: {
  stripe: Stripe;
  raw: RawClient;
  table: "billing_plans" | "billing_addons";
  kind: "plan" | "addon";
  row: any;
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

function subscriptionStatus(sub: any): string | null {
  return typeof sub.status === "string" ? sub.status : null;
}

function adminBillingReturnUrl(config: StripeConfig, orgId: string): string {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams({ tenant: orgId });
  return `${base}/admin/platform-billing?${params.toString()}`;
}

function tenantBillingReturnUrl(config: StripeConfig): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/admin/billing/package`;
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

  const items: any[] = [
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
      items: [...deletedItems, ...items],
      proration_behavior: "create_prorations",
      expand: ["latest_invoice"],
    } as any);
  } else {
    stripeSub = await stripe.subscriptions.create({
      customer: customer.id,
      items,
      metadata,
      collection_method: "send_invoice",
      days_until_due: 15,
      expand: ["latest_invoice"],
    } as any);
  }

  const latestInvoice = invoiceStatus((stripeSub as any).latest_invoice);
  await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .update({
      stripe_customer_id: customer.id,
      stripe_subscription_id: stripeSub.id,
      stripe_status: subscriptionStatus(stripeSub),
      stripe_last_synced_at: new Date().toISOString(),
      current_period_start: asStripeTimestamp(
        (stripeSub as any).current_period_start,
      ),
      current_period_end: asStripeTimestamp(
        (stripeSub as any).current_period_end,
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

function paymentMethodSummary(
  paymentMethod: Stripe.PaymentMethod | null,
): PlatformTenantPaymentMethodSummary | null {
  if (!paymentMethod?.id) return null;
  const card = paymentMethod.card;
  const usBank = paymentMethod.us_bank_account;
  return {
    id: paymentMethod.id,
    type: paymentMethod.type ?? null,
    brand: card?.brand ?? usBank?.bank_name ?? null,
    last4: card?.last4 ?? usBank?.last4 ?? null,
  };
}

async function retrievePaymentMethodSummary(args: {
  stripe: Stripe;
  customerId: string;
  setupIntentId?: string | null;
}): Promise<PlatformTenantPaymentMethodSummary | null> {
  let paymentMethodId: string | null = null;
  if (args.setupIntentId) {
    const setupIntent = await args.stripe.setupIntents.retrieve(
      args.setupIntentId,
    );
    const ref = setupIntent.payment_method;
    paymentMethodId = typeof ref === "string" ? ref : (ref?.id ?? null);
  }
  if (!paymentMethodId) {
    const customer = await args.stripe.customers.retrieve(args.customerId);
    if (!customer.deleted) {
      const ref = customer.invoice_settings?.default_payment_method;
      paymentMethodId = typeof ref === "string" ? ref : (ref?.id ?? null);
    }
  }
  if (!paymentMethodId) return null;
  const paymentMethod =
    await args.stripe.paymentMethods.retrieve(paymentMethodId);
  return paymentMethodSummary(paymentMethod);
}

async function persistPaymentMethodSummary(args: {
  raw: RawClient;
  orgId: string;
  customerId: string;
  summary: PlatformTenantPaymentMethodSummary | null;
}) {
  await args.raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .update({
      stripe_customer_id: args.customerId,
      stripe_default_payment_method_id: args.summary?.id ?? null,
      stripe_payment_method_type: args.summary?.type ?? null,
      stripe_payment_method_brand: args.summary?.brand ?? null,
      stripe_payment_method_last4: args.summary?.last4 ?? null,
      stripe_payment_method_updated_at: new Date().toISOString(),
      stripe_last_synced_at: new Date().toISOString(),
    })
    .eq("org_id", args.orgId)
    .in("status", ["active", "trialing", "past_due"]);
}

export async function syncTenantStripePaymentMethod(args: {
  orgId: string;
  stripeCustomerId?: string | null;
  setupIntentId?: string | null;
  adminEmail?: string | null;
}): Promise<PlatformStripeSyncResult> {
  const config = readStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const raw = await rawClient();
  if (!raw) throw new Error("tenant_directory_unavailable");
  const sub = await activeSubscription(raw, args.orgId);
  const customerId = args.stripeCustomerId ?? sub.stripe_customer_id;
  if (!customerId) throw new Error("stripe_customer_not_linked");
  const stripe = getStripeClient(config);
  const summary = await retrievePaymentMethodSummary({
    stripe,
    customerId,
    setupIntentId: args.setupIntentId ?? null,
  });
  await persistPaymentMethodSummary({
    raw,
    orgId: args.orgId,
    customerId,
    summary,
  });
  await logAudit({
    action: "platform.billing.stripe.payment_method.synced",
    adminEmail: args.adminEmail ?? "platform-admin",
    adminUserId: null,
    targetTable: "tenant_billing_subscriptions",
    targetId: args.orgId,
    metadata: {
      stripeCustomerId: customerId,
      paymentMethodId: summary?.id ?? null,
    },
    ip: null,
    userAgent: null,
  }).catch(() => undefined);
  return { stripeConfigured: true, customerId, paymentMethod: summary };
}

export async function createTenantStripeSetupSession(args: {
  orgId: string;
  adminEmail?: string | null;
  returnUrl?: string | null;
}): Promise<PlatformStripeHostedSessionResult> {
  const config = readStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const customer = await ensureTenantStripeCustomer({
    orgId: args.orgId,
    adminEmail: args.adminEmail ?? null,
  });
  if (!customer.stripeConfigured || !customer.customerId) {
    return { stripeConfigured: customer.stripeConfigured };
  }
  const stripe = getStripeClient(config);
  const returnUrl = args.returnUrl ?? adminBillingReturnUrl(config, args.orgId);
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customer.customerId,
    payment_method_types: ["card", "us_bank_account"],
    success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}stripe_setup=success`,
    cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}stripe_setup=cancelled`,
    metadata: {
      billing_scope: PLATFORM_BILLING_SCOPE,
      org_id: args.orgId,
      setup_kind: "tenant_payment_method",
    },
  });
  await logAudit({
    action: "platform.billing.stripe.setup_session.created",
    adminEmail: args.adminEmail ?? "platform-admin",
    adminUserId: null,
    targetTable: "tenant_billing_subscriptions",
    targetId: args.orgId,
    metadata: { stripeCustomerId: customer.customerId },
    ip: null,
    userAgent: null,
  }).catch(() => undefined);
  return { stripeConfigured: true, url: session.url ?? undefined };
}

export async function createTenantStripeBillingPortalSession(args: {
  orgId: string;
  adminEmail?: string | null;
  tenantReturn?: boolean;
}): Promise<PlatformStripeHostedSessionResult> {
  const config = readStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const customer = await ensureTenantStripeCustomer({
    orgId: args.orgId,
    adminEmail: args.adminEmail ?? null,
  });
  if (!customer.stripeConfigured || !customer.customerId) {
    return { stripeConfigured: customer.stripeConfigured };
  }
  const stripe = getStripeClient(config);
  const session = await stripe.billingPortal.sessions.create({
    customer: customer.customerId,
    return_url: args.tenantReturn
      ? tenantBillingReturnUrl(config)
      : adminBillingReturnUrl(config, args.orgId),
  });
  await logAudit({
    action: "platform.billing.stripe.portal_session.created",
    adminEmail: args.adminEmail ?? "platform-admin",
    adminUserId: null,
    targetTable: "tenant_billing_subscriptions",
    targetId: args.orgId,
    metadata: { stripeCustomerId: customer.customerId },
    ip: null,
    userAgent: null,
  }).catch(() => undefined);
  return { stripeConfigured: true, url: session.url };
}

export async function handlePlatformTenantStripeEvent(
  event: Stripe.Event,
): Promise<boolean> {
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded" &&
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
  if (event.type.startsWith("checkout.session.")) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (
      session.mode !== "setup" ||
      session.metadata?.billing_scope !== PLATFORM_BILLING_SCOPE ||
      !session.metadata.org_id
    ) {
      return false;
    }
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null);
    const setupIntentId =
      typeof session.setup_intent === "string"
        ? session.setup_intent
        : (session.setup_intent?.id ?? null);
    if (!customerId) return false;
    const config = readStripeConfigOrNull();
    if (!config) return false;
    const stripe = getStripeClient(config);
    const summary = await retrievePaymentMethodSummary({
      stripe,
      customerId,
      setupIntentId,
    });
    await persistPaymentMethodSummary({
      raw,
      orgId: session.metadata.org_id,
      customerId,
      summary,
    });
    return true;
  }
  if (event.type.startsWith("customer.subscription.")) {
    const sub = event.data.object as Stripe.Subscription;
    if (
      sub.metadata?.billing_scope !== PLATFORM_BILLING_SCOPE ||
      !sub.metadata.org_id
    )
      return false;
    await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .update({
        stripe_subscription_id: sub.id,
        stripe_status: sub.status,
        stripe_last_synced_at: new Date().toISOString(),
        current_period_start: asStripeTimestamp(
          (sub as any).current_period_start,
        ),
        current_period_end: asStripeTimestamp((sub as any).current_period_end),
      })
      .eq("org_id", sub.metadata.org_id)
      .eq("stripe_subscription_id", sub.id);
    return true;
  }
  const invoice = event.data.object as Stripe.Invoice;
  const subRef = invoice.parent?.subscription_details?.subscription;
  const subscriptionId =
    typeof subRef === "string" ? subRef : (subRef?.id ?? null);
  if (!subscriptionId) return false;
  await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .update({
      last_invoice_id: invoice.id,
      last_invoice_status: invoice.status,
      stripe_last_synced_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId);
  logger.info(
    {
      event: "platform_billing_stripe_invoice_synced",
      stripeSubscriptionId: subscriptionId,
    },
    "platform billing Stripe invoice synced",
  );
  return true;
}
