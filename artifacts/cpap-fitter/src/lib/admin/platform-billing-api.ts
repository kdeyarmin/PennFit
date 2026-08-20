import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export interface BillingPlan {
  code: string;
  name: string;
  description: string;
  monthlyPriceCents: number | null;
  onboardingFeeCents: number | null;
  isPublic?: boolean;
  isCustom: boolean;
  /** The marketed tier's caps. Plans express "uncapped" by OMITTING a
   *  metric, never by a null — only a tenant's customAllowances override
   *  can carry an explicit unlimited. */
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
  isActive?: boolean | null;
  sortOrder?: number | null;
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
    /** Per-tenant override of the plan allowances; `null` = unlimited. */
    customAllowances: Record<string, number | null>;
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

/** Public plans a tenant owner can choose between (incl. custom/Enterprise
 *  tiers, which the UI renders as "contact us" rather than selectable). */
export function fetchSelectablePlans(): Promise<{ plans: BillingPlan[] }> {
  return jsonFetch<{ plans: BillingPlan[] }>("/admin/billing/plans");
}

/** Self-select a public, non-custom plan for the caller's own tenant.
 *  Records the choice and syncs it to Stripe; returns the refreshed
 *  tenant billing package. */
export function selectTenantPlan(planCode: string): Promise<TenantBilling> {
  return jsonFetch<TenantBilling>("/admin/billing/subscription", {
    method: "POST",
    body: JSON.stringify({ planCode }),
  });
}

/** Start a hosted Stripe Checkout session for the tenant's CURRENT plan
 *  ("Pay now" — card charged immediately, payment wall cleared on success).
 *  Returns the Checkout URL to redirect the browser to. `returnPath` is where
 *  Stripe sends the user back inside the admin SPA (defaults to billing). */
export function startTenantCheckout(
  returnPath?: string,
): Promise<{ url: string }> {
  return jsonFetch<{ url: string }>("/admin/billing/checkout", {
    method: "POST",
    body: JSON.stringify(returnPath ? { returnPath } : {}),
  });
}

/** Active add-ons a tenant owner can add to their plan. Recurring add-ons
 *  are self-selectable (quantity stepper); one-time/project add-ons have a
 *  null recurringPriceCents and are surfaced as a "Contact us" tier. */
export function fetchSelectableAddons(): Promise<{ addons: BillingAddon[] }> {
  return jsonFetch<{ addons: BillingAddon[] }>("/admin/billing/addons");
}

/** Set the quantity of a recurring add-on for the caller's own tenant
 *  (quantity 0 removes it). Syncs to Stripe and returns the refreshed
 *  tenant billing package. */
export function updateOwnAddon(
  addonCode: string,
  quantity: number,
): Promise<TenantBilling> {
  return jsonFetch<TenantBilling>("/admin/billing/addons", {
    method: "PUT",
    body: JSON.stringify({ addonCode, quantity }),
  });
}

// ── Cost / proration preview ────────────────────────────────────────

/** A pending plan switch or add-on quantity change to estimate the cost of. */
export type BillingPreviewChange =
  | { kind: "plan"; planCode: string }
  | { kind: "addon"; addonCode: string; quantity: number };

export interface BillingPreview {
  currentMonthlyCents: number;
  newMonthlyCents: number;
  /** newMonthly − currentMonthly. Positive = costs more going forward. */
  deltaMonthlyCents: number;
  /** Prorated charge (+) or credit (−) for the rest of the current period,
   *  or null when the billing period is unknown (no Stripe sync yet). */
  proratedNowCents: number | null;
  daysRemaining: number | null;
  periodDays: number | null;
  currentPeriodEnd: string | null;
  /** Human-readable description of the change, e.g. "Switch to Growth". */
  changeLabel: string;
}

/** Preview the cost impact of a change to the caller's own tenant. */
export function previewOwnBillingChange(
  change: BillingPreviewChange,
): Promise<BillingPreview> {
  return jsonFetch<BillingPreview>("/admin/billing/preview", {
    method: "POST",
    body: JSON.stringify(change),
  });
}

/** Preview the cost impact of a change to a given tenant (super-admin). */
export function previewTenantBillingChange(
  tenantId: string,
  change: BillingPreviewChange,
): Promise<BillingPreview> {
  return jsonFetch<BillingPreview>(
    `/platform/billing/tenants/${encodeURIComponent(tenantId)}/preview`,
    { method: "POST", body: JSON.stringify(change) },
  );
}

// ── Recent billing activity (super-admin portal) ────────────────────

export interface BillingActivityEvent {
  id: string;
  tenantId: string;
  tenantName: string;
  action: string;
  actor: "tenant" | "platform";
  operatorEmail: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

/** Recent billing activity across the fleet. Pass `tenantId` to scope the
 *  feed to a single tenant's billing history. */
export function fetchPlatformBillingActivity(
  limit = 25,
  tenantId?: string,
): Promise<{ activity: BillingActivityEvent[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (tenantId) params.set("tenantId", tenantId);
  return jsonFetch<{ activity: BillingActivityEvent[] }>(
    `/platform/billing/activity?${params.toString()}`,
  );
}

export function fetchPlatformBillingCatalog(): Promise<BillingCatalogResponse> {
  return jsonFetch<BillingCatalogResponse>("/platform/billing/catalog");
}

/** Editable fields on a catalog plan. Only the keys present are changed;
 *  an explicit `null` clears a nullable column. A monthly-price change
 *  re-mints the plan's Stripe price on the server (best-effort). */
export interface CatalogPlanEdit {
  name?: string;
  description?: string | null;
  monthlyPriceCents?: number | null;
  onboardingFeeCents?: number | null;
  allowances?: Record<string, number>;
  features?: string[];
  isPublic?: boolean;
  sortOrder?: number;
}

/** Editable fields on a catalog add-on. */
export interface CatalogAddonEdit {
  name?: string;
  description?: string | null;
  category?: string;
  recurringPriceCents?: number | null;
  oneTimeMinCents?: number | null;
  oneTimeMaxCents?: number | null;
  unitLabel?: string | null;
  usageMetric?: string | null;
  passThroughNote?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

/** A catalog edit returns the refreshed catalog plus, on a price change,
 *  the count of tenants still billing the OLD price (existing Stripe
 *  subscriptions aren't auto-repriced — the operator re-syncs deliberately
 *  via {@link resyncTenantStripeSubscriptions}). */
export interface CatalogEditResponse extends BillingCatalogResponse {
  affectedTenants?: number;
}

/** Edit a plan's base pricing/presentation. The change populates to every
 *  tenant account, the public marketing page, and (on a price change)
 *  Stripe. Returns the refreshed catalog + affected-tenant count. */
export function updateCatalogPlan(
  code: string,
  edit: CatalogPlanEdit,
): Promise<CatalogEditResponse> {
  return jsonFetch<CatalogEditResponse>(
    `/platform/billing/catalog/plans/${encodeURIComponent(code)}`,
    { method: "PUT", body: JSON.stringify(edit) },
  );
}

/** Re-sync every tenant's live Stripe subscription to the current catalog
 *  (+ custom) pricing. The deliberate counterpart to a catalog price edit. */
export function resyncTenantStripeSubscriptions(): Promise<{
  total: number;
  synced: number;
  failed: number;
}> {
  return jsonFetch("/platform/billing/tenants/resync-stripe", {
    method: "POST",
  });
}

/** Edit an add-on's base pricing/presentation. Returns the refreshed
 *  catalog + affected-tenant count. */
export function updateCatalogAddon(
  code: string,
  edit: CatalogAddonEdit,
): Promise<CatalogEditResponse> {
  return jsonFetch<CatalogEditResponse>(
    `/platform/billing/catalog/addons/${encodeURIComponent(code)}`,
    { method: "PUT", body: JSON.stringify(edit) },
  );
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
    customAllowances?: Record<string, number | null>;
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

/** Render a cost/proration preview as the body of a confirm dialog shown
 *  before a plan/add-on change is committed. Pure — unit-tested. */
export function buildPreviewConfirm(preview: BillingPreview): string {
  const lines = [`${preview.changeLabel}?`, ""];
  const delta = preview.deltaMonthlyCents;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  lines.push(
    `New monthly total: ${formatMoney(preview.newMonthlyCents)}/mo ` +
      `(${sign}${formatMoney(Math.abs(delta))}/mo vs. today).`,
  );
  if (preview.proratedNowCents == null) {
    lines.push(
      "Proration will be calculated by Stripe when billing is connected.",
    );
  } else if (preview.proratedNowCents > 0) {
    lines.push(
      `Estimated prorated charge for the rest of this period: ` +
        `~${formatMoney(preview.proratedNowCents)}.`,
    );
  } else if (preview.proratedNowCents < 0) {
    lines.push(
      `Estimated prorated credit for the rest of this period: ` +
        `~${formatMoney(-preview.proratedNowCents)}.`,
    );
  } else {
    lines.push("No proration for the remainder of this period.");
  }
  lines.push("", "This updates your Stripe billing immediately.");
  return lines.join("\n");
}
