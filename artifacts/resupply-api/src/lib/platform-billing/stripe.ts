import type Stripe from "stripe";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../logger";
import {
  getStripeClient,
  readPlatformBillingStripeConfigOrNull,
  type PlatformBillingStripeConfig,
  type PlatformBillingStripeMode,
} from "../stripe/config";

const PLATFORM_BILLING_SCOPE = "platform_tenant";

// The standalone Virtual Mask Fitter per-fitting metered add-on (migrations
// 0419/0420) reports usage via a Stripe Billing Meter whose events carry this
// name; the mask_fitter plan's subscription intrinsically includes this
// add-on's metered price (it isn't an opt-in add-on).
export const FITTER_FITTING_METER_EVENT = "fitter_fitting";

/**
 * Whether usage-based OVERAGE billing for the STANDARD plan add-ons (SMS / AI
 * / billing transactions — migration 0421) is enabled. OFF by default: with
 * the flag unset those add-ons bill as the existing flat bundles and nothing
 * about existing tenants changes. The fitter add-on (migration 0420) is
 * intrinsically metered and NOT gated by this — it has no existing tenants.
 */
export function isMeteredOverageEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(
    process.env.PLATFORM_METERED_OVERAGE_ENABLED?.trim() ?? "",
  );
}

/**
 * Is this catalog row billed as metered RIGHT NOW? A row is metered-capable
 * when `usage_type === 'metered'`. The fitter add-on (in-price free tier,
 * `included_units` set) is always active; the standard overage add-ons
 * (`included_units` NULL) are active only behind the flag, so the flat-bundle
 * path stays the default.
 */
function meteredActive(row: {
  usage_type?: string | null;
  included_units?: number | null;
}): boolean {
  if (row.usage_type !== "metered") return false;
  if (row.included_units != null) return true; // fitter-style (report-all)
  return isMeteredOverageEnabled(); // overage-style (report-overage), gated
}

/**
 * Thrown when a tenant's stored Stripe customer/subscription was created on a
 * DIFFERENT Stripe account than the one platform billing is now using (e.g.
 * after switching STRIPE_PLATFORM_SECRET_KEY to a dedicated account). We refuse
 * to silently recreate billing objects on the new account — the old account's
 * subscription may still be charging the card, so recreating would double-bill.
 * The operator must migrate deliberately (cancel on the old account, clear the
 * stored IDs) first. Catalog products/prices, which never bill anyone, ARE
 * recreated automatically.
 */
export class PlatformBillingAccountChangedError extends Error {
  constructor() {
    super(
      "platform_billing_account_changed: this tenant's Stripe " +
        "customer/subscription belongs to a different Stripe account than the " +
        "one platform billing now uses. Migrate it deliberately (cancel on the " +
        "old account and clear the stored Stripe IDs) before syncing.",
    );
    this.name = "PlatformBillingAccountChangedError";
  }
}

// Stripe object IDs are account-scoped, so we record which account each synced
// object belongs to (tenant_billing_subscriptions/billing_*.stripe_account_ref)
// and refuse to reuse an ID across accounts. The account identity is the
// `acct_…` id of whichever Stripe account the active key belongs to, fetched
// once per client (accounts.retrieveCurrent() returns the key's own account)
// and memoized on the client instance.
const accountIdCache = new WeakMap<Stripe, string>();

async function resolvePlatformBillingAccountId(
  stripe: Stripe,
): Promise<string> {
  const cached = accountIdCache.get(stripe);
  if (cached) return cached;
  // retrieveCurrent() returns the account the API key itself belongs to.
  const account = await stripe.accounts.retrieveCurrent();
  accountIdCache.set(stripe, account.id);
  return account.id;
}

/**
 * Does a stored row's `stripe_account_ref` match the account we're syncing
 * against now? A NULL/blank ref predates the column — it was therefore synced
 * on the SHARED (patient-checkout) account, since dedicated mode didn't exist
 * yet — so it matches only when we're currently in shared mode.
 */
export function accountRefMatches(
  rowRef: string | null | undefined,
  accountId: string,
  mode: PlatformBillingStripeMode,
): boolean {
  if (rowRef == null || rowRef === "") return mode === "shared";
  return rowRef === accountId;
}

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
  stripe_account_ref?: string | null;
  // Metered (usage-based) add-on fields (migration 0420). A NULL/absent
  // `usage_type` means licensed/flat — the default, unchanged behavior.
  usage_type?: string | null;
  included_units?: number | null;
  meter_event_name?: string | null;
  stripe_meter_id?: string | null;
  // Per-unit overage rate as a decimal string (migration 0421), e.g. "7.5"
  // for 7.5¢. Used for `included_units`-NULL (report-overage) metered prices;
  // kept separate from `recurring_price_cents` (the flat-bundle price).
  metered_unit_amount_decimal?: string | null;
  usage_metric?: string | null;
}

interface EnsurePriceArgs {
  stripe: Stripe;
  raw: RawClient;
  table: "billing_plans" | "billing_addons";
  kind: "plan" | "addon";
  row: CatalogRow;
  amountCents: number | null;
  accountId: string;
  mode: PlatformBillingStripeMode;
}

/**
 * Ensure a Stripe Billing Meter + a graduated metered Price for a
 * usage-based add-on (migration 0420). The meter is keyed by customer, so
 * reported usage survives the subscription-item delete/recreate the sync
 * does on every change. The price's first tier covers `included_units` at $0
 * (the plan's included allowance), then `amountCents` per unit. Idempotent &
 * account-scoped, mirroring `ensureRecurringPrice`.
 */
async function ensureMeteredAddonPrice(
  args: EnsurePriceArgs,
): Promise<string | null> {
  if (!args.amountCents || args.amountCents <= 0)
    return args.row.stripe_price_id ?? null;
  const sameAccount = accountRefMatches(
    args.row.stripe_account_ref,
    args.accountId,
    args.mode,
  );
  // Reuse the stored price ONLY if it's already a metered price (it has a
  // meter). A flag-off→on flip leaves a flat licensed `stripe_price_id` with
  // no `stripe_meter_id`; that price would bill a fixed recurring charge, not
  // usage, so we must re-mint a metered one instead of reusing it.
  if (args.row.stripe_price_id && args.row.stripe_meter_id && sameAccount)
    return args.row.stripe_price_id;

  // A meter cannot be deleted (only deactivated), so reuse the stored one
  // when it belongs to the account we're syncing against; otherwise mint one.
  const eventName = args.row.meter_event_name ?? `addon_${args.row.code}`;
  let meterId = sameAccount ? (args.row.stripe_meter_id ?? null) : null;
  if (!meterId) {
    const meter = await args.stripe.billing.meters.create({
      display_name: args.row.name,
      event_name: eventName,
      default_aggregation: { formula: "sum" },
      customer_mapping: {
        type: "by_id",
        event_payload_key: "stripe_customer_id",
      },
      value_settings: { event_payload_key: "value" },
    });
    meterId = meter.id;
  }

  const product =
    args.row.stripe_product_id && sameAccount
      ? await args.stripe.products.update(args.row.stripe_product_id, {
          name: args.row.name,
          metadata: priceMetadata(args.kind, args.row.code),
        })
      : await args.stripe.products.create({
          name: args.row.name,
          description: args.row.description ?? undefined,
          metadata: priceMetadata(args.kind, args.row.code),
        });

  // Two shapes:
  //   * `included_units` set (fitter, migration 0420) → a graduated tiered
  //     price with that many free, then `amountCents` each; the app reports
  //     ALL usage and Stripe applies the free tier.
  //   * `included_units` NULL (standard overage add-ons, migration 0421) → a
  //     simple per-unit metered price at `metered_unit_amount_decimal` cents;
  //     the app reports only the OVERAGE beyond the plan's allowance.
  const included = args.row.included_units ?? 0;
  const price =
    included > 0
      ? await args.stripe.prices.create({
          product: product.id,
          currency: "usd",
          recurring: {
            interval: "month",
            usage_type: "metered",
            meter: meterId,
          },
          billing_scheme: "tiered",
          tiers_mode: "graduated",
          tiers: [
            { up_to: included, unit_amount: 0 },
            { up_to: "inf" as const, unit_amount: args.amountCents },
          ],
          metadata: priceMetadata(args.kind, args.row.code),
        })
      : await args.stripe.prices.create({
          product: product.id,
          currency: "usd",
          recurring: {
            interval: "month",
            usage_type: "metered",
            meter: meterId,
          },
          // Sub-cent rates (e.g. 7.5¢) need the decimal field; fall back to the
          // whole-cent overage price when no decimal rate is stored. The SDK
          // types this as a decimal.js `Decimal`, but the REST API takes a
          // string (e.g. "7.5") — cast at the boundary.
          unit_amount_decimal: (args.row.metered_unit_amount_decimal ??
            String(args.amountCents)) as unknown as Stripe.Decimal,
          metadata: priceMetadata(args.kind, args.row.code),
        });

  await args.raw
    .schema("resupply")
    .from(args.table)
    .update({
      stripe_product_id: product.id,
      stripe_price_id: price.id,
      stripe_meter_id: meterId,
      stripe_account_ref: args.accountId,
      stripe_synced_at: new Date().toISOString(),
    })
    .eq("id", args.row.id);
  return price.id;
}

type MeteredAddonRow = CatalogRow & { recurring_price_cents?: number | null };

/**
 * All metered catalog add-ons (`usage_type='metered'`), so the subscription
 * build can attach each plan's intrinsic metered overage items. Fail-soft:
 * returns [] on error.
 */
async function meteredOverageAddons(
  raw: RawClient,
): Promise<MeteredAddonRow[]> {
  const { data, error } = await raw
    .schema("resupply")
    .from("billing_addons")
    .select("*")
    .eq("usage_type", "metered");
  if (error || !data) return [];
  return data as MeteredAddonRow[];
}

async function ensureRecurringPrice(
  args: EnsurePriceArgs,
): Promise<string | null> {
  // Usage-based add-ons take the metered path (Billing Meter + metered
  // price) ONLY when metered billing is active for the row (the fitter
  // always; the standard overage add-ons behind the flag). Otherwise — plans,
  // flat add-ons, and standard add-ons with the flag off — fall through to the
  // unchanged licensed flow below, so flat-bundle billing stays the default.
  if (meteredActive(args.row)) return ensureMeteredAddonPrice(args);
  if (!args.amountCents || args.amountCents <= 0)
    return args.row.stripe_price_id ?? null;
  // Catalog objects are account-scoped: reuse the stored product/price ONLY
  // when it belongs to the account we're syncing against now. If the account
  // changed (e.g. shared → dedicated), recreate them — products/prices never
  // bill anyone, so recreating is safe (unlike customers/subscriptions).
  const sameAccount = accountRefMatches(
    args.row.stripe_account_ref,
    args.accountId,
    args.mode,
  );
  // Reuse the stored price ONLY if it's a flat (licensed) price — i.e. it has
  // no meter. A flag-on→off flip leaves a metered `stripe_price_id` (with a
  // `stripe_meter_id`); reusing that as a flat bundle would mis-bill, so
  // re-mint a flat price instead. Plans never carry a meter, so this is a
  // no-op for them.
  if (args.row.stripe_price_id && !args.row.stripe_meter_id && sameAccount)
    return args.row.stripe_price_id;

  const product =
    args.row.stripe_product_id && sameAccount
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
      stripe_account_ref: args.accountId,
      stripe_synced_at: new Date().toISOString(),
      // This price is flat (no meter). Clear any stale meter id on an add-on
      // (a metered→flat flip) so `stripe_meter_id` reliably marks "the stored
      // price is metered". `billing_plans` has no such column, so only touch
      // add-ons.
      ...(args.table === "billing_addons" ? { stripe_meter_id: null } : {}),
    })
    .eq("id", args.row.id);
  return price.id;
}

export async function syncPlatformBillingCatalogToStripe(): Promise<PlatformStripeSyncResult> {
  const config = readPlatformBillingStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const raw = await rawClient();
  if (!raw) throw new Error("tenant_directory_unavailable");
  const stripe = getStripeClient(config);
  const accountId = await resolvePlatformBillingAccountId(stripe);
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
      accountId,
      mode: config.mode,
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
      accountId,
      mode: config.mode,
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
  const config = readPlatformBillingStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const raw = await rawClient();
  if (!raw) throw new Error("tenant_directory_unavailable");
  const stripe = getStripeClient(config);
  const accountId = await resolvePlatformBillingAccountId(stripe);
  const [tenant, sub] = await Promise.all([
    tenantRow(raw, args.orgId),
    activeSubscription(raw, args.orgId),
  ]);
  if (sub.stripe_customer_id) {
    // A customer from a different Stripe account can't be reused here — fail
    // loudly rather than create a duplicate on the new account.
    if (!accountRefMatches(sub.stripe_account_ref, accountId, config.mode)) {
      throw new PlatformBillingAccountChangedError();
    }
    return { stripeConfigured: true, customerId: sub.stripe_customer_id };
  }
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
      stripe_account_ref: accountId,
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
  // Metered item — a usage_type='metered' price. Stripe REJECTS `quantity`
  // on a metered item; usage is reported as meter events instead.
  | { price: string }
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
  const config: PlatformBillingStripeConfig | null =
    readPlatformBillingStripeConfigOrNull();
  if (!config) return { stripeConfigured: false };
  const raw = await rawClient();
  if (!raw) throw new Error("tenant_directory_unavailable");
  const stripe = getStripeClient(config);
  const accountId = await resolvePlatformBillingAccountId(stripe);
  await syncPlatformBillingCatalogToStripe();
  const [tenant, sub, addons] = await Promise.all([
    tenantRow(raw, args.orgId),
    activeSubscription(raw, args.orgId),
    activeAddons(raw, args.orgId),
  ]);
  // Existing customer/subscription IDs are account-scoped. If they belong to a
  // different account (e.g. after switching to a dedicated platform-billing
  // account), refuse rather than retrieve/recreate against the wrong account —
  // the old subscription may still be billing the card.
  if (
    (sub.stripe_customer_id || sub.stripe_subscription_id) &&
    !accountRefMatches(sub.stripe_account_ref, accountId, config.mode)
  ) {
    throw new PlatformBillingAccountChangedError();
  }
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
        accountId,
        mode: config.mode,
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

  // Metered price ids already attached, so the mask_fitter auto-include
  // below never double-adds the per-fitting overage item.
  const meteredPriceIds = new Set<string>();
  for (const tenantAddon of addons) {
    const addon = tenantAddon.billing_addons;
    // A flag-off standard overage add-on is NOT metered-active → it takes the
    // flat-bundle (quantity) path below, unchanged.
    const isMetered = meteredActive(addon);
    const amount =
      cents(tenantAddon.custom_recurring_price_cents) ??
      cents(addon.recurring_price_cents);
    if (!amount || amount <= 0) continue;
    // Metered items bill by reported usage, not quantity — never skip them on
    // quantity. Per-unit custom price overrides don't apply to metered items
    // (the meter + tiers define the price), so they take the catalog price.
    if (!isMetered && tenantAddon.quantity <= 0) continue;
    const priceId =
      tenantAddon.custom_recurring_price_cents && !isMetered
        ? null
        : await ensureRecurringPrice({
            stripe,
            raw,
            table: "billing_addons",
            kind: "addon",
            row: addon,
            amountCents: cents(addon.recurring_price_cents),
            accountId,
            mode: config.mode,
          });
    if (isMetered) {
      // Metered subscription item: NO quantity. Skip if no metered price
      // synced (e.g. a custom-priced metered addon, which isn't supported).
      if (priceId) {
        items.push({ price: priceId });
        meteredPriceIds.add(priceId);
      }
      continue;
    }
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

  // Intrinsic metered overage items. A metered add-on bills usage beyond the
  // plan's included allowance for its metric, so attach its metered price to
  // any plan that declares that allowance — it is NOT an opt-in add-on. This
  // covers the fitter (mask_fitter → fitterFittingsPerMonth) and, behind the
  // flag, the standard SMS/AI/billing overage on Launch/Growth/Scale. Deduped
  // against the opt-in loop above.
  const planAllowances = (plan.allowances ?? {}) as Record<string, unknown>;
  for (const addon of await meteredOverageAddons(raw)) {
    const metric = addon.usage_metric;
    if (!metric || !(metric in planAllowances)) continue;
    if (!meteredActive(addon)) continue;
    const priceId = await ensureRecurringPrice({
      stripe,
      raw,
      table: "billing_addons",
      kind: "addon",
      row: addon,
      amountCents: cents(addon.recurring_price_cents),
      accountId,
      mode: config.mode,
    });
    if (priceId && !meteredPriceIds.has(priceId)) {
      items.push({ price: priceId });
      meteredPriceIds.add(priceId);
    }
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
      stripe_account_ref: accountId,
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
  const { data, error } = await raw
    .schema("resupply")
    .from("tenant_billing_subscriptions")
    .update({
      last_invoice_id: invoice.id,
      last_invoice_status: invoice.status,
      stripe_last_synced_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId)
    .select("id, org_id");
  if (error) throw error;
  if (!data || data.length === 0) return false;
  logger.info(
    {
      event: "platform_billing_stripe_invoice_synced",
      stripeSubscriptionId: subscriptionId,
    },
    "platform billing Stripe invoice synced",
  );

  // Payment wall (migration 0425): the first PAID invoice clears the tenant's
  // `billing_required` flag, unlocking the full console. Idempotent — re-runs
  // on a replayed invoice.paid event just re-set false. Best-effort: a failure
  // here leaves the tenant gated (they can retry from the billing page) rather
  // than failing the webhook, which Stripe would otherwise keep retrying.
  if (event.type === "invoice.paid") {
    const orgId = (data[0] as { org_id?: string | null }).org_id ?? null;
    if (orgId) {
      const { error: clearErr } = await raw
        .schema("resupply")
        .from("organizations")
        .update({ billing_required: false })
        .eq("id", orgId);
      if (clearErr) {
        logger.error(
          {
            event: "platform_billing_paywall_clear_failed",
            err: clearErr,
            orgId,
          },
          "payment wall: failed to clear billing_required after invoice.paid",
        );
      } else {
        logger.info(
          { event: "platform_billing_paywall_cleared", orgId },
          "payment wall: billing_required cleared after invoice.paid",
        );
      }
    }
  }
  return true;
}

/**
 * Report one completed mask fitting to Stripe as a Billing Meter event
 * (migration 0420), so per-fitting overage on the Virtual Mask Fitter plan
 * is invoiced. Fire-and-forget + fail-soft: it NEVER throws or rejects, and
 * no-ops when platform Stripe billing is unconfigured or the tenant has no
 * Stripe customer yet (e.g. before their first subscription sync). Meter
 * events are customer-keyed, so they bill correctly even though the
 * subscription's items are deleted/recreated on every sync.
 *
 * Caller pattern: `void reportFitterFittingMeterEvent(orgId)` on the same
 * completion that increments the usage rollup — no await, no try/catch.
 */
export async function reportFitterFittingMeterEvent(
  orgId: string | undefined | null,
): Promise<void> {
  const id = orgId?.trim();
  if (!id) return;
  try {
    const config = readPlatformBillingStripeConfigOrNull();
    if (!config) return; // platform Stripe not configured → nothing to meter
    const raw = await rawClient();
    if (!raw) return;
    const { data, error } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select("stripe_customer_id")
      .eq("org_id", id)
      .in("status", ["active", "trialing", "past_due"])
      .not("stripe_customer_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (error || !data?.stripe_customer_id) return;
    const stripe = getStripeClient(config);
    await stripe.billing.meterEvents.create({
      event_name: FITTER_FITTING_METER_EVENT,
      payload: { stripe_customer_id: data.stripe_customer_id, value: "1" },
    });
  } catch (err) {
    logger.warn(
      {
        event: "fitter_meter_event_report_failed",
        orgId: id,
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "fitter meter event report failed (ignored)",
    );
  }
}

/**
 * Overage units to report for one usage increment, given the running total
 * BEFORE the increment and the plan's included allowance. Pure + exported for
 * testing. Only usage beyond the allowance is billable, so an increment that
 * stays within the allowance reports 0, one that straddles the boundary
 * reports only the part above it, and one fully above reports in full.
 */
export function computeMeteredOverageDelta(
  priorTotal: number,
  increment: number,
  allowance: number,
): number {
  const newTotal = priorTotal + increment;
  const after = Math.max(0, newTotal - allowance);
  const before = Math.max(0, priorTotal - allowance);
  return Math.max(0, after - before);
}

interface OverageAddonRow {
  meter_event_name: string | null;
  billing_plans?: never;
}

/**
 * Report the billable OVERAGE for a standard metered metric (SMS / AI /
 * billing transactions — migration 0421) to Stripe as a Billing Meter event.
 * Called fire-and-forget from `recordTenantUsage` after the monthly rollup is
 * incremented; NEVER throws. No-ops unless the overage flag is on, the metric
 * has a report-overage metered add-on, the tenant has a synced Stripe
 * customer, and usage actually crossed the plan's allowance.
 *
 * NOTE: it reads the post-increment rollup and derives the prior total from
 * `increment`; under heavy concurrency the boundary math can be slightly off
 * for an individual event, which is acceptable for a fire-and-forget billing
 * signal. Reports only when overage > 0.
 */
export async function reportMeteredOverage(input: {
  orgId: string | undefined | null;
  metricKey: string;
  increment: number;
  /** The ATOMIC post-increment total from increment_tenant_usage_rollup
   *  (migration 0422). When provided, overage is computed from it directly
   *  rather than a racy re-read of the rollup. */
  newTotal?: number;
}): Promise<void> {
  const id = input.orgId?.trim();
  if (!id || input.increment <= 0) return;
  if (!isMeteredOverageEnabled()) return;
  try {
    const config = readPlatformBillingStripeConfigOrNull();
    if (!config) return;
    const raw = await rawClient();
    if (!raw) return;

    // The report-overage metered add-on for this metric (included_units NULL
    // distinguishes it from the fitter's report-all add-on).
    const { data: addon, error: addonErr } = await raw
      .schema("resupply")
      .from("billing_addons")
      .select("meter_event_name")
      .eq("usage_metric", input.metricKey)
      .eq("usage_type", "metered")
      .is("included_units", null)
      .limit(1)
      .maybeSingle();
    if (addonErr || !addon) return;
    const eventName = (addon as OverageAddonRow).meter_event_name;
    if (!eventName) return;

    // The tenant's Stripe customer + the plan allowance for this metric.
    const { data: sub, error: subErr } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select("stripe_customer_id, billing_plans(allowances)")
      .eq("org_id", id)
      .in("status", ["active", "trialing", "past_due"])
      .not("stripe_customer_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (subErr || !sub) return;
    const customerId = (sub as { stripe_customer_id?: string | null })
      .stripe_customer_id;
    if (!customerId) return;
    const allowances = ((sub as { billing_plans?: { allowances?: unknown } })
      .billing_plans?.allowances ?? {}) as Record<string, unknown>;
    const allowanceRaw = allowances[input.metricKey];
    const allowance = typeof allowanceRaw === "number" ? allowanceRaw : 0;

    // Post-increment running total. Prefer the atomic value the increment RPC
    // returned (migration 0422); fall back to a (racy) read for callers that
    // don't pass it.
    let newTotal: number;
    if (typeof input.newTotal === "number") {
      newTotal = input.newTotal;
    } else {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const monthDate = monthStart.toISOString().slice(0, 10);
      const { data: rollup, error: rollupErr } = await raw
        .schema("resupply")
        .from("tenant_usage_monthly_rollups")
        .select("quantity")
        .eq("org_id", id)
        .eq("month", monthDate)
        .eq("metric_key", input.metricKey)
        .limit(1)
        .maybeSingle();
      if (rollupErr) return;
      newTotal =
        typeof (rollup as { quantity?: number } | null)?.quantity === "number"
          ? (rollup as { quantity: number }).quantity
          : input.increment;
    }
    const priorTotal = newTotal - input.increment;
    const overage = computeMeteredOverageDelta(
      priorTotal,
      input.increment,
      allowance,
    );
    if (overage <= 0) return;

    const stripe = getStripeClient(config);
    await stripe.billing.meterEvents.create({
      event_name: eventName,
      payload: { stripe_customer_id: customerId, value: String(overage) },
    });
  } catch (err) {
    logger.warn(
      {
        event: "metered_overage_report_failed",
        orgId: id,
        metricKey: input.metricKey,
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "metered overage report failed (ignored)",
    );
  }
}
