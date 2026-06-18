import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  buildPreviewConfirm,
  fetchPlatformBillingActivity,
  fetchPlatformBillingCatalog,
  fetchPlatformTenantBilling,
  ensureTenantStripeCustomer,
  formatMoney,
  previewTenantBillingChange,
  syncPlatformBillingCatalogToStripe,
  syncTenantStripeSubscription,
  updateTenantAddon,
  updateTenantPlan,
  type BillingActivityEvent,
  type BillingAddon,
  type BillingPlan,
  type PlatformTenantBillingRow,
} from "@/lib/admin/platform-billing-api";
import { formatAppDateTime } from "@/lib/utils";

const METRIC_LABELS: Record<string, string> = {
  activePatients: "Active patients",
  seats: "Seats",
  locations: "Locations",
  ordersPerMonth: "Orders this month",
  activeSubscriptions: "Active subscriptions",
  outboundMessagesPerMonth: "Outbound messages",
  aiTextInteractionsPerMonth: "AI text interactions",
  billingTransactionsPerMonth: "Billing transactions",
  faxEvents: "Fax events",
  aiVoiceEvents: "AI voice events",
};

function pct(used: number, limit: number | undefined): number | null {
  if (!limit || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

function usageTone(used: number, limit: number | undefined) {
  const p = pct(used, limit);
  if (p === null) return "bg-slate-300";
  if (p >= 100) return "bg-red-600";
  if (p >= 90) return "bg-red-500";
  if (p >= 75) return "bg-amber-500";
  return "bg-emerald-500";
}

function allowanceStatus(tenant: PlatformTenantBillingRow) {
  const plan = tenant.billing.subscription?.plan;
  const allowances = {
    ...(plan?.allowances ?? {}),
    ...(tenant.billing.subscription?.customAllowances ?? {}),
  };
  const rows = Object.entries(tenant.billing.usage.metrics).map(
    ([key, used]) => {
      const limit = allowances[key];
      return { key, used, limit, percent: pct(used, limit) };
    },
  );
  const overLimit = rows.filter((r) => r.percent !== null && r.percent >= 100);
  const nearLimit = rows.filter(
    (r) => r.percent !== null && r.percent >= 75 && r.percent < 100,
  );
  return { allowances, rows, overLimit, nearLimit };
}

function UsageBar({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit?: number;
}) {
  const p = pct(used, limit);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span>
          {used.toLocaleString()}
          {limit ? ` / ${limit.toLocaleString()}` : ""}
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-100">
        <div
          className={`h-2 rounded-full ${usageTone(used, limit)}`}
          style={{ width: `${p ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function TenantEditor({
  tenant,
  plans,
  addons,
}: {
  tenant: PlatformTenantBillingRow;
  plans: BillingPlan[];
  addons: BillingAddon[];
}) {
  const qc = useQueryClient();
  const plan = tenant.billing.subscription?.plan;
  const { allowances, rows, overLimit, nearLimit } = allowanceStatus(tenant);
  const [planCode, setPlanCode] = useState(
    plan?.code ?? plans[0]?.code ?? "launch",
  );
  const [monthly, setMonthly] = useState(
    tenant.billing.subscription?.customMonthlyPriceCents?.toString() ?? "",
  );
  const [notes, setNotes] = useState(tenant.billing.subscription?.notes ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const savePlan = useMutation({
    mutationFn: () =>
      updateTenantPlan(tenant.id, {
        planCode,
        status: "active",
        customMonthlyPriceCents: monthly.trim() ? Number(monthly) : null,
        notes,
      }),
    onSuccess: () => {
      setMessage("Plan saved.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(err instanceof Error ? err.message : "Plan save failed.");
    },
  });
  const createStripeCustomer = useMutation({
    mutationFn: () => ensureTenantStripeCustomer(tenant.id),
    onSuccess: () => {
      setMessage("Stripe customer linked.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(
        err instanceof Error ? err.message : "Stripe customer sync failed.",
      );
    },
  });
  const syncStripeSubscription = useMutation({
    mutationFn: () => syncTenantStripeSubscription(tenant.id),
    onSuccess: () => {
      setMessage("Stripe subscription synced.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(
        err instanceof Error ? err.message : "Stripe subscription sync failed.",
      );
    },
  });
  const saveAddon = useMutation({
    mutationFn: ({
      addonCode,
      quantity,
    }: {
      addonCode: string;
      quantity: number;
    }) => updateTenantAddon(tenant.id, { addonCode, quantity }),
    onSuccess: () => {
      setMessage("Add-on saved.");
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setMessage(err instanceof Error ? err.message : "Add-on save failed.");
    },
  });
  const activeAddonQty = new Map(
    tenant.billing.addons.map((a) => [a.addon.code, a.quantity]),
  );
  const activeAddonsTotal = tenant.billing.addons.reduce((sum, a) => {
    const price =
      a.customRecurringPriceCents ?? a.addon.recurringPriceCents ?? 0;
    return sum + price * a.quantity;
  }, 0);
  const monthlyTotal =
    (tenant.billing.subscription?.customMonthlyPriceCents ??
      plan?.monthlyPriceCents ??
      0) + activeAddonsTotal;

  return (
    <Card className="space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">
              {tenant.storefrontName || tenant.name || tenant.slug}
            </h2>
            {overLimit.length > 0 ? (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
                {overLimit.length} over limit
              </span>
            ) : nearLimit.length > 0 ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                {nearLimit.length} near limit
              </span>
            ) : (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                Healthy usage
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {tenant.slug} · {tenant.status} · usage month{" "}
            {tenant.billing.usage.month}
          </p>
          <p className="text-sm text-slate-500">
            Fax:{" "}
            {tenant.faxNumber ? (
              <span className="font-medium tabular-nums text-slate-700">
                {tenant.faxNumber}
              </span>
            ) : (
              <span className="text-slate-400">not provisioned</span>
            )}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold text-slate-900">
            {formatMoney(monthlyTotal)}/mo estimated
          </div>
          <div className="text-slate-500">
            {plan?.name ?? "No plan"} · add-ons {formatMoney(activeAddonsTotal)}
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ key, used }) => (
          <UsageBar
            key={key}
            label={METRIC_LABELS[key] ?? key}
            used={used}
            limit={allowances[key]}
          />
        ))}
      </div>

      <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-semibold text-slate-900">Stripe billing</div>
            <div className="text-slate-600">
              Customer{" "}
              {tenant.billing.subscription?.stripeCustomerId ?? "not linked"}
              {" · "}
              Subscription{" "}
              {tenant.billing.subscription?.stripeSubscriptionId ??
                "not synced"}
            </div>
            <div className="text-xs text-slate-500">
              Status {tenant.billing.subscription?.stripeStatus ?? "—"} ·
              Invoice {tenant.billing.subscription?.lastInvoiceStatus ?? "—"}
              {tenant.billing.subscription?.currentPeriodEnd
                ? ` · Renews ${new Date(
                    tenant.billing.subscription.currentPeriodEnd,
                  ).toLocaleDateString(undefined, {
                    timeZone: "America/New_York",
                  })}`
                : ""}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => createStripeCustomer.mutate()}
              disabled={createStripeCustomer.isPending}
              className="rounded-md border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-60"
            >
              {createStripeCustomer.isPending
                ? "Linking…"
                : "Create Stripe customer"}
            </button>
            <button
              onClick={() => syncStripeSubscription.mutate()}
              disabled={syncStripeSubscription.isPending}
              className="rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              {syncStripeSubscription.isPending
                ? "Syncing…"
                : "Sync subscription"}
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[200px_180px_1fr_auto]">
        <label className="text-sm font-medium text-slate-700">
          Plan
          <select
            value={planCode}
            onChange={(e) => setPlanCode(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2"
          >
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} — {formatMoney(p.monthlyPriceCents)}/mo
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Custom monthly cents
          <input
            value={monthly}
            onChange={(e) => setMonthly(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="blank = catalog"
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Notes
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2"
          />
        </label>
        <button
          onClick={async () => {
            // Cost/proration preview before committing the plan change. A
            // custom monthly override skips the preview (it isn't catalog
            // priced); falls back to a plain confirm if the preview fails.
            if (!monthly.trim()) {
              try {
                const preview = await previewTenantBillingChange(tenant.id, {
                  kind: "plan",
                  planCode,
                });
                if (!window.confirm(buildPreviewConfirm(preview))) return;
              } catch {
                // preview unavailable — fall through and save
              }
            }
            savePlan.mutate();
          }}
          disabled={savePlan.isPending}
          className="self-end rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {savePlan.isPending ? "Saving…" : "Save plan"}
        </button>
      </div>
      {message ? <p className="text-sm text-slate-600">{message}</p> : null}

      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">
          Edit add-ons ({tenant.billing.addons.length} active)
        </summary>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {addons.map((addon) => {
            const qty = activeAddonQty.get(addon.code) ?? 0;
            return (
              <div
                key={addon.code}
                className="flex items-center justify-between gap-3 rounded-md bg-slate-50 p-3"
              >
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    {addon.name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {formatMoney(
                      addon.recurringPriceCents ?? addon.oneTimeMinCents,
                    )}{" "}
                    {addon.unitLabel ? `· ${addon.unitLabel}` : ""}
                  </div>
                  {addon.passThroughNote ? (
                    <div className="mt-1 text-xs text-amber-700">
                      {addon.passThroughNote}
                    </div>
                  ) : null}
                </div>
                <input
                  key={`${addon.code}:${qty}`}
                  aria-label={`${addon.name} quantity`}
                  defaultValue={qty}
                  type="number"
                  min={0}
                  step={1}
                  className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  onBlur={async (e) => {
                    // Normalize to a non-negative integer — the API schema
                    // expects an int, so an empty/decimal/NaN field would
                    // otherwise 400. Reflect the cleaned value back into the
                    // input so the UI matches what we'll send.
                    const parsed = Number(e.currentTarget.value);
                    const next = Number.isFinite(parsed)
                      ? Math.max(0, Math.floor(parsed))
                      : 0;
                    e.currentTarget.value = String(next);
                    if (next === qty) return;
                    // Cost/proration preview before committing the change.
                    try {
                      const preview = await previewTenantBillingChange(
                        tenant.id,
                        {
                          kind: "addon",
                          addonCode: addon.code,
                          quantity: next,
                        },
                      );
                      if (!window.confirm(buildPreviewConfirm(preview))) return;
                    } catch {
                      // preview unavailable — fall through and save
                    }
                    saveAddon.mutate({
                      addonCode: addon.code,
                      quantity: next,
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      </details>
    </Card>
  );
}

function CatalogPreview({
  plans,
  addons,
}: {
  plans: BillingPlan[];
  addons: BillingAddon[];
}) {
  const qc = useQueryClient();
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);
  const syncCatalog = useMutation({
    mutationFn: syncPlatformBillingCatalogToStripe,
    onSuccess: (result) => {
      setCatalogMessage(
        `Stripe catalog synced: ${result.catalog?.plans ?? 0} plans and ${
          result.catalog?.addons ?? 0
        } add-ons.`,
      );
      return qc.invalidateQueries({ queryKey: ["platform-billing"] });
    },
    onError: (err) => {
      setCatalogMessage(
        err instanceof Error ? err.message : "Stripe catalog sync failed.",
      );
    },
  });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-950">Billing catalog</h2>
        <button
          onClick={() => syncCatalog.mutate()}
          disabled={syncCatalog.isPending}
          className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
        >
          {syncCatalog.isPending ? "Syncing Stripe…" : "Sync catalog to Stripe"}
        </button>
      </div>
      {catalogMessage ? (
        <p className="mt-2 text-sm text-slate-600">{catalogMessage}</p>
      ) : null}
      <div className="mt-4 grid gap-3 lg:grid-cols-4">
        {plans.map((plan) => (
          <div
            key={plan.code}
            className="rounded-lg border border-slate-200 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-950">{plan.name}</div>
                <div className="text-xs text-slate-500">{plan.description}</div>
              </div>
              <div className="text-right text-sm font-semibold text-slate-900">
                {formatMoney(plan.monthlyPriceCents)}/mo
                <div className="text-[11px] font-normal text-slate-500">
                  {plan.stripePriceId ? "Stripe synced" : "No Stripe price"}
                </div>
              </div>
            </div>
            <ul className="mt-3 space-y-1 text-xs text-slate-600">
              {Object.entries(plan.allowances)
                .slice(0, 5)
                .map(([key, value]) => (
                  <li key={key}>
                    {METRIC_LABELS[key] ?? key}: {value.toLocaleString()}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-slate-600">
        {addons.length} add-ons configured. Super-admin tenant cards above apply
        quantities and pricing overrides.
      </p>
    </Card>
  );
}

/** Recent tenant-billing changes across the fleet — surfaces the
 *  tenant.billing.* / platform.billing.* events the logAudit stub can't show.
 *  Polls every 60s; degrades to a quiet empty/error state. */
function RecentBillingActivity() {
  const activity = useQuery({
    queryKey: ["platform-billing", "activity"],
    queryFn: () => fetchPlatformBillingActivity(25),
    refetchInterval: 60_000,
  });
  return (
    <Card className="p-5" data-testid="platform-billing-activity">
      <h2 className="font-semibold text-slate-950">Recent billing activity</h2>
      <p className="mt-1 text-sm text-slate-600">
        Plan and add-on changes across every tenant — who changed what, and
        when. Self-service tenant changes and super-admin assignments both show
        here.
      </p>
      {activity.isPending ? (
        <div className="mt-4">
          <Spinner label="Loading activity…" />
        </div>
      ) : activity.isError ? (
        <p className="mt-4 text-sm text-slate-500">
          Could not load billing activity.
        </p>
      ) : activity.data.activity.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No billing changes yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {activity.data.activity.map((e: BillingActivityEvent) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <span className="font-medium text-slate-900">
                  {e.tenantName}
                </span>
                <span className="text-slate-600">
                  {" "}
                  — {e.summary ?? e.action}
                </span>
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    e.actor === "tenant"
                      ? "bg-sky-50 text-sky-700"
                      : "bg-violet-50 text-violet-700"
                  }`}
                >
                  {e.actor === "tenant" ? "self-service" : "super-admin"}
                </span>
              </div>
              <div className="text-right text-xs text-slate-500">
                <div>{e.operatorEmail ?? "—"}</div>
                <time dateTime={e.occurredAt}>
                  {formatAppDateTime(e.occurredAt)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AdminPlatformBillingPage() {
  const catalog = useQuery({
    queryKey: ["platform-billing", "catalog"],
    queryFn: fetchPlatformBillingCatalog,
  });
  const tenants = useQuery({
    queryKey: ["platform-billing", "tenants"],
    queryFn: fetchPlatformTenantBilling,
  });
  const addons = useMemo(() => catalog.data?.addons ?? [], [catalog.data]);
  const plans = useMemo(() => catalog.data?.plans ?? [], [catalog.data]);

  if (catalog.isPending || tenants.isPending)
    return <Spinner label="Loading platform billing…" />;
  if (catalog.isError)
    return (
      <ErrorPanel
        title="Could not load billing catalog"
        error={catalog.error}
      />
    );
  if (tenants.isError)
    return (
      <ErrorPanel title="Could not load tenant billing" error={tenants.error} />
    );

  const tenantRows = tenants.data.tenants.map((tenant) => {
    const status = allowanceStatus(tenant);
    const addonsTotal = tenant.billing.addons.reduce((sum, a) => {
      const price =
        a.customRecurringPriceCents ?? a.addon.recurringPriceCents ?? 0;
      return sum + price * a.quantity;
    }, 0);
    return { tenant, status, addonsTotal };
  });
  const mrr = tenantRows.reduce((sum, row) => {
    const sub = row.tenant.billing.subscription;
    return (
      sum +
      (sub?.customMonthlyPriceCents ?? sub?.plan.monthlyPriceCents ?? 0) +
      row.addonsTotal
    );
  }, 0);
  const overLimitTenants = tenantRows.filter(
    (r) => r.status.overLimit.length > 0,
  ).length;
  const nearLimitTenants = tenantRows.filter(
    (r) => r.status.nearLimit.length > 0,
  ).length;

  return (
    <div data-testid="admin-platform-billing" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-950">Platform billing</h1>
        <p className="text-sm text-slate-600">
          Super-admin package assignment, add-ons, pricing overrides, and tenant
          usage tracking.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="p-4">
          <div className="text-sm text-slate-500">Estimated MRR</div>
          <div className="text-2xl font-bold">{formatMoney(mrr)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-slate-500">Tenants</div>
          <div className="text-2xl font-bold">
            {tenants.data.tenants.length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-slate-500">Over limit</div>
          <div className="text-2xl font-bold text-red-700">
            {overLimitTenants}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-slate-500">Near limit</div>
          <div className="text-2xl font-bold text-amber-700">
            {nearLimitTenants}
          </div>
        </Card>
      </div>
      <RecentBillingActivity />
      <CatalogPreview plans={plans} addons={addons} />
      {tenantRows.map(({ tenant }) => (
        <TenantEditor
          key={tenant.id}
          tenant={tenant}
          plans={plans}
          addons={addons}
        />
      ))}
    </div>
  );
}
