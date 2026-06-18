import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...csrfHeader(),
      ...(headers ?? {}),
    },
    ...rest,
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {}
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export interface BillingPlan {
  code: string;
  name: string;
  description: string;
  monthlyPriceCents: number | null;
  onboardingFeeCents: number | null;
  isCustom: boolean;
  allowances: Record<string, number>;
  features: string[];
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  stripeSyncedAt?: string | null;
}

export interface BillingAddon {
  code: string;
  name: string;
  category: string;
  description: string;
  recurringPriceCents: number | null;
  oneTimeMinCents: number | null;
  oneTimeMaxCents: number | null;
  unitLabel: string | null;
  usageMetric: string | null;
  passThroughNote: string | null;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  stripeSyncedAt?: string | null;
}

export interface TenantBilling {
  tenantId: string;
  subscription: null | {
    status: string;
    customMonthlyPriceCents: number | null;
    customOnboardingFeeCents: number | null;
    customAllowances: Record<string, number>;
    notes: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    stripeStatus?: string | null;
    stripeLastSyncedAt?: string | null;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
    lastInvoiceId?: string | null;
    lastInvoiceStatus?: string | null;
    plan: BillingPlan;
  };
  addons: Array<{
    id: string;
    quantity: number;
    customRecurringPriceCents: number | null;
    notes: string;
    addon: BillingAddon;
  }>;
  usage: { month: string; metrics: Record<string, number> };
}

export interface BillingCatalogResponse {
  plans: BillingPlan[];
  addons: BillingAddon[];
}
export interface PlatformTenantBillingRow {
  id: string;
  slug: string;
  name: string | null;
  storefrontName: string | null;
  status: string;
  /** The tenant's provisioned fax number (E.164), or null when none. */
  faxNumber: string | null;
  /** When the fax number was attached (ISO), or null. */
  faxProvisionedAt: string | null;
  billing: TenantBilling;
}

export function fetchTenantBilling(): Promise<TenantBilling> {
  return jsonFetch<TenantBilling>("/admin/billing/package");
}

export function fetchPlatformBillingCatalog(): Promise<BillingCatalogResponse> {
  return jsonFetch<BillingCatalogResponse>("/platform/billing/catalog");
}

// ── Fleet recurring-revenue (MRR) summary ───────────────────────────

export interface FleetBillingByPlan {
  planCode: string;
  planName: string;
  tenants: number;
  mrrCents: number;
}

export interface FleetBillingSummaryResponse {
  /** Active + trialing recurring revenue, cents/month. */
  mrrCents: number;
  /** Recurring revenue from add-ons (a subset of mrrCents). */
  addonMrrCents: number;
  /** Past-due recurring revenue — booked but at risk. */
  atRiskMrrCents: number;
  /** Average revenue per paying tenant, cents/month. */
  arpuCents: number;
  payingTenants: number;
  trialingTenants: number;
  pastDueTenants: number;
  unsubscribedTenants: number;
  byPlan: FleetBillingByPlan[];
  generatedAt: string;
}

export function fetchFleetBillingSummary(): Promise<FleetBillingSummaryResponse> {
  return jsonFetch<FleetBillingSummaryResponse>("/platform/billing/summary");
}

export function fetchPlatformTenantBilling(): Promise<{
  tenants: PlatformTenantBillingRow[];
}> {
  return jsonFetch<{ tenants: PlatformTenantBillingRow[] }>(
    "/platform/billing/tenants",
  );
}

export function updateTenantPlan(
  tenantId: string,
  body: {
    planCode: string;
    status: string;
    customMonthlyPriceCents?: number | null;
    customOnboardingFeeCents?: number | null;
    customAllowances?: Record<string, number>;
    notes?: string;
  },
): Promise<TenantBilling> {
  return jsonFetch<TenantBilling>(
    `/platform/billing/tenants/${encodeURIComponent(tenantId)}/subscription`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function updateTenantAddon(
  tenantId: string,
  body: {
    addonCode: string;
    quantity: number;
    customRecurringPriceCents?: number | null;
    notes?: string;
  },
): Promise<TenantBilling> {
  return jsonFetch<TenantBilling>(
    `/platform/billing/tenants/${encodeURIComponent(tenantId)}/addons`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function syncPlatformBillingCatalogToStripe(): Promise<{
  stripeConfigured: boolean;
  catalog?: { plans: number; addons: number };
}> {
  return jsonFetch<{
    stripeConfigured: boolean;
    catalog?: { plans: number; addons: number };
  }>("/platform/billing/catalog/stripe/sync", { method: "POST" });
}

export function ensureTenantStripeCustomer(
  tenantId: string,
): Promise<TenantBilling> {
  return jsonFetch<TenantBilling>(
    `/platform/billing/tenants/${encodeURIComponent(tenantId)}/stripe/customer`,
    { method: "POST" },
  );
}

export function syncTenantStripeSubscription(
  tenantId: string,
): Promise<TenantBilling> {
  return jsonFetch<TenantBilling>(
    `/platform/billing/tenants/${encodeURIComponent(tenantId)}/stripe/subscription`,
    { method: "POST" },
  );
}

export function recordTenantUsage(body: {
  tenantId?: string;
  metricKey: string;
  quantity: number;
  source?: string;
}): Promise<{ id: string }> {
  return jsonFetch<{ id: string }>(
    body.tenantId
      ? "/platform/billing/usage-events"
      : "/admin/billing/usage-events",
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return "Custom";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
