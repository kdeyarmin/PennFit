import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchTenantBilling,
  formatMoney,
} from "@/lib/admin/platform-billing-api";

const LABELS: Record<string, string> = {
  seats: "Seats",
  activePatients: "Active patients",
  locations: "Locations",
  ordersPerMonth: "Orders this month",
  activeSubscriptions: "Active subscriptions",
  outboundMessagesPerMonth: "Outbound messages",
  aiTextInteractionsPerMonth: "AI text interactions",
  billingTransactionsPerMonth: "Billing transactions",
  faxEvents: "Fax events",
  aiVoiceEvents: "AI voice events",
};

export function AdminBillingPackagePage() {
  const q = useQuery({
    queryKey: ["tenant-billing-package"],
    queryFn: fetchTenantBilling,
    staleTime: 30_000,
  });
  if (q.isPending) return <Spinner label="Loading billing package…" />;
  if (q.isError)
    return (
      <ErrorPanel title="Could not load billing package" error={q.error} />
    );
  const sub = q.data.subscription;
  const allowances = {
    ...(sub?.plan.allowances ?? {}),
    ...(sub?.customAllowances ?? {}),
  };
  return (
    <div data-testid="admin-billing-package" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-950">
          Billing package & usage
        </h1>
        <p className="text-sm text-slate-600">
          Current CareMetric Breathe package, add-ons, and usage for this
          tenant.
        </p>
      </div>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-sm uppercase tracking-wide text-slate-500">
              Current package
            </div>
            <h2 className="text-xl font-semibold text-slate-950">
              {sub?.plan.name ?? "No package assigned"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              {sub?.plan.description}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-950">
              {formatMoney(
                sub?.customMonthlyPriceCents ?? sub?.plan.monthlyPriceCents,
              )}
              /mo
            </div>
            <div className="text-sm text-slate-500">
              Onboarding{" "}
              {formatMoney(
                sub?.customOnboardingFeeCents ?? sub?.plan.onboardingFeeCents,
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {(sub?.plan.features ?? []).map((f) => (
            <span
              key={f}
              className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800"
            >
              {f}
            </span>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="font-semibold text-slate-950">Tenant billing status</h2>
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-4">
          <div>
            <div className="text-slate-500">Stripe status</div>
            <div className="font-medium text-slate-900">
              {sub?.stripeStatus ?? "Not synced"}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Invoice status</div>
            <div className="font-medium text-slate-900">
              {sub?.lastInvoiceStatus ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Current period end</div>
            <div className="font-medium text-slate-900">
              {sub?.currentPeriodEnd
                ? new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, {
                    timeZone: "America/New_York",
                  })
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Last synced</div>
            <div className="font-medium text-slate-900">
              {sub?.stripeLastSyncedAt
                ? new Date(sub.stripeLastSyncedAt).toLocaleDateString(undefined, {
                    timeZone: "America/New_York",
                  })
                : "—"}
            </div>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(q.data.usage.metrics).map(([key, used]) => {
          const limit = allowances[key];
          const pct =
            typeof limit === "number" && limit > 0
              ? Math.min(100, Math.round((used / limit) * 100))
              : 0;
          return (
            <Card key={key} className="p-4">
              <div className="flex justify-between text-sm font-medium text-slate-700">
                <span>{LABELS[key] ?? key}</span>
                <span>
                  {used.toLocaleString()}
                  {limit ? ` / ${limit.toLocaleString()}` : ""}
                </span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-slate-100">
                <div
                  className={`h-2 rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </Card>
          );
        })}
      </div>
      <Card className="p-5">
        <h2 className="font-semibold text-slate-950">Active add-ons</h2>
        {q.data.addons.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No active add-ons.</p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {q.data.addons.map((a) => (
              <div
                key={a.id}
                className="rounded-lg border border-slate-200 p-3"
              >
                <div className="font-medium text-slate-900">
                  {a.addon.name} × {a.quantity}
                </div>
                <div className="text-sm text-slate-500">
                  {formatMoney(
                    a.customRecurringPriceCents ??
                      a.addon.recurringPriceCents ??
                      a.addon.oneTimeMinCents,
                  )}{" "}
                  {a.addon.unitLabel ? `· ${a.addon.unitLabel}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
