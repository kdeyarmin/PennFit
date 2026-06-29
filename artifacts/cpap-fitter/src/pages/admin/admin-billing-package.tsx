import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { useToast } from "@/hooks/use-toast";
import { AddonExplainer } from "@/lib/admin/addon-details";
import {
  type BillingAddon,
  type BillingPlan,
  buildPreviewConfirm,
  fetchSelectableAddons,
  fetchSelectablePlans,
  fetchTenantBilling,
  formatMoney,
  previewOwnBillingChange,
  selectTenantPlan,
  updateOwnAddon,
} from "@/lib/admin/platform-billing-api";
import { formatAppDate } from "@/lib/utils";

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
  fitterFittingsPerMonth: "Completed mask fittings",
};

/** Tenant self-service plan picker. Lists the public plans; the active
 *  plan is marked, non-custom plans get a "Select"/"Switch" button, and
 *  custom/Enterprise tiers render a "Contact us" state. Selecting a plan
 *  records the choice and syncs it to Stripe via the API, then refreshes
 *  the billing package query. */
function PlanSelector({ currentPlanCode }: { currentPlanCode: string | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  // Guards the async preview window: until the preview resolves and
  // mutation.isPending flips, a second fast click would otherwise open a
  // duplicate confirm dialog and fire a second mutation.
  const [previewingCode, setPreviewingCode] = useState<string | null>(null);

  const plansQuery = useQuery({
    queryKey: ["tenant-billing-plans"],
    queryFn: fetchSelectablePlans,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (planCode: string) => selectTenantPlan(planCode),
    onMutate: (planCode) => setPendingCode(planCode),
    onSettled: () => setPendingCode(null),
    onSuccess: (_data, planCode) => {
      void queryClient.invalidateQueries({
        queryKey: ["tenant-billing-package"],
      });
      const name =
        plansQuery.data?.plans.find((p) => p.code === planCode)?.name ??
        planCode;
      toast({
        title: "Plan updated",
        description: `You're now on the ${name} plan.`,
      });
    },
    onError: () => {
      toast({
        title: "Could not change plan",
        description:
          "We couldn't update your subscription. Please try again or contact support.",
        variant: "destructive",
      });
    },
  });

  if (plansQuery.isPending) return <Spinner label="Loading available plans…" />;
  if (plansQuery.isError)
    return <ErrorPanel title="Could not load plans" error={plansQuery.error} />;

  const plans = plansQuery.data.plans;
  if (plans.length === 0) return null;

  return (
    <Card className="p-5" data-testid="plan-selector">
      <h2 className="font-semibold text-slate-950">Choose your plan</h2>
      <p className="mt-1 text-sm text-slate-600">
        Pick the CareMetric Breathe plan that fits your practice. Changes take
        effect immediately and update your Stripe billing.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan: BillingPlan) => {
          const isCurrent = plan.code === currentPlanCode;
          const isPending =
            (pendingCode === plan.code && mutation.isPending) ||
            previewingCode === plan.code;
          return (
            <div
              key={plan.code}
              data-testid={`plan-card-${plan.code}`}
              className={`flex flex-col rounded-lg border p-4 ${
                isCurrent
                  ? "border-emerald-400 bg-emerald-50/40"
                  : "border-slate-200"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold text-slate-950">{plan.name}</h3>
                {isCurrent && (
                  <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white">
                    Current
                  </span>
                )}
              </div>
              <div className="mt-1 text-2xl font-bold text-slate-950">
                {formatMoney(plan.monthlyPriceCents)}
                {plan.monthlyPriceCents != null && (
                  <span className="text-sm font-normal text-slate-500">
                    /mo
                  </span>
                )}
              </div>
              {plan.description && (
                <p className="mt-1 text-sm text-slate-600">
                  {plan.description}
                </p>
              )}
              <ul className="mt-3 flex-1 space-y-1 text-sm text-slate-600">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span aria-hidden="true" className="text-emerald-600">
                      ✓
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                {plan.isCustom ? (
                  <a
                    href="mailto:sales@cmbreathe.com?subject=Enterprise%20plan%20inquiry"
                    className="inline-flex w-full items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Contact us
                  </a>
                ) : isCurrent ? (
                  <Button intent="secondary" disabled className="w-full">
                    Current plan
                  </Button>
                ) : (
                  <Button
                    intent="primary"
                    className="w-full"
                    isLoading={isPending}
                    disabled={mutation.isPending || previewingCode !== null}
                    onClick={async () => {
                      // Ignore re-entrant clicks while a preview is already
                      // in flight or a mutation is committing.
                      if (mutation.isPending || previewingCode !== null) return;
                      // Cost/proration preview before confirming. Falls back
                      // to a plain confirm if the preview can't be fetched.
                      let message = `Switch to the ${plan.name} plan (${formatMoney(
                        plan.monthlyPriceCents,
                      )}/mo)? This updates your Stripe billing immediately.`;
                      setPreviewingCode(plan.code);
                      try {
                        const preview = await previewOwnBillingChange({
                          kind: "plan",
                          planCode: plan.code,
                        });
                        message = buildPreviewConfirm(preview);
                      } catch {
                        // keep the static fallback message
                      } finally {
                        setPreviewingCode(null);
                      }
                      if (window.confirm(message)) {
                        mutation.mutate(plan.code);
                      }
                    }}
                  >
                    {currentPlanCode ? "Switch to this plan" : "Select plan"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Tenant self-service add-on picker. Lists active add-ons; recurring
 *  ones get a quantity stepper (0 removes), one-time/project add-ons render
 *  a "Contact us" state. Each change records the quantity and syncs it to
 *  Stripe via the API, then refreshes the billing package query. */
function AddonSelector({
  currentByCode,
}: {
  currentByCode: Map<string, number>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  // Guards the async preview window so a fast second click (or a
  // blur→refocus→blur) can't open a duplicate confirm + second mutation.
  const [previewingCode, setPreviewingCode] = useState<string | null>(null);

  const addonsQuery = useQuery({
    queryKey: ["tenant-billing-addons"],
    queryFn: fetchSelectableAddons,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: ({ code, quantity }: { code: string; quantity: number }) =>
      updateOwnAddon(code, quantity),
    onMutate: ({ code }) => setPendingCode(code),
    onSettled: () => setPendingCode(null),
    onSuccess: (_data, { code, quantity }) => {
      void queryClient.invalidateQueries({
        queryKey: ["tenant-billing-package"],
      });
      const name =
        addonsQuery.data?.addons.find((a) => a.code === code)?.name ?? code;
      toast({
        title: quantity === 0 ? "Add-on removed" : "Add-on updated",
        description:
          quantity === 0
            ? `${name} removed from your plan.`
            : `${name} set to ${quantity}.`,
      });
    },
    onError: () => {
      toast({
        title: "Could not update add-on",
        description:
          "We couldn't update your add-ons. Please try again or contact support.",
        variant: "destructive",
      });
    },
  });

  if (addonsQuery.isPending) return <Spinner label="Loading add-ons…" />;
  if (addonsQuery.isError)
    return (
      <ErrorPanel title="Could not load add-ons" error={addonsQuery.error} />
    );

  const addons = addonsQuery.data.addons;
  if (addons.length === 0) return null;

  // Show a cost/proration preview before committing an add-on change. Falls
  // back to a plain confirm when the preview can't be fetched.
  const confirmAndMutate = async (code: string, quantity: number) => {
    // Ignore re-entrant changes while a preview is in flight or a mutation
    // is committing.
    if (mutation.isPending || previewingCode !== null) return;
    const name = addons.find((a) => a.code === code)?.name ?? code;
    let message =
      quantity === 0
        ? `Remove the ${name} add-on? This updates your Stripe billing immediately.`
        : `Set ${name} to ${quantity}? This updates your Stripe billing immediately.`;
    setPreviewingCode(code);
    try {
      const preview = await previewOwnBillingChange({
        kind: "addon",
        addonCode: code,
        quantity,
      });
      message = buildPreviewConfirm(preview);
    } catch {
      // keep the static fallback message
    } finally {
      setPreviewingCode(null);
    }
    if (window.confirm(message)) mutation.mutate({ code, quantity });
  };

  return (
    <Card className="p-5" data-testid="addon-selector">
      <h2 className="font-semibold text-slate-950">Add-ons</h2>
      <p className="mt-1 text-sm text-slate-600">
        Extend your plan with optional add-ons. Recurring add-ons bill monthly
        at the listed rate and update your Stripe billing immediately.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {addons.map((addon: BillingAddon) => {
          const qty = currentByCode.get(addon.code) ?? 0;
          const isActive = qty > 0;
          const isRecurring = addon.recurringPriceCents != null;
          const isPending =
            (pendingCode === addon.code && mutation.isPending) ||
            previewingCode === addon.code;
          const busy = mutation.isPending || previewingCode !== null;
          return (
            <div
              key={addon.code}
              data-testid={`addon-card-${addon.code}`}
              className={`flex flex-col rounded-lg border p-4 ${
                isActive
                  ? "border-emerald-400 bg-emerald-50/40"
                  : "border-slate-200"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold text-slate-950">{addon.name}</h3>
                {isActive && (
                  <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white">
                    ×{qty}
                  </span>
                )}
              </div>
              <div className="mt-1 text-lg font-bold text-slate-950">
                {formatMoney(
                  addon.recurringPriceCents ?? addon.oneTimeMinCents,
                )}
                {addon.unitLabel && (
                  <span className="text-sm font-normal text-slate-500">
                    {" "}
                    · {addon.unitLabel}
                  </span>
                )}
              </div>
              {addon.description && (
                <p className="mt-1 flex-1 text-sm text-slate-600">
                  {addon.description}
                </p>
              )}
              {addon.passThroughNote && (
                <p className="mt-1 text-xs text-amber-700">
                  {addon.passThroughNote}
                </p>
              )}
              <AddonExplainer addon={addon} />
              <div className="mt-4">
                {!isRecurring ? (
                  <a
                    href={`mailto:sales@cmbreathe.com?subject=${encodeURIComponent(
                      `${addon.name} inquiry`,
                    )}`}
                    className="inline-flex w-full items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Contact us
                  </a>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      intent="secondary"
                      size="sm"
                      aria-label={`Decrease ${addon.name}`}
                      disabled={busy || qty === 0}
                      onClick={() => confirmAndMutate(addon.code, qty - 1)}
                    >
                      −
                    </Button>
                    <span
                      data-testid={`addon-qty-${addon.code}`}
                      className="min-w-8 text-center text-sm font-semibold text-slate-900"
                    >
                      {isPending ? "…" : qty}
                    </span>
                    <Button
                      intent="secondary"
                      size="sm"
                      aria-label={`Increase ${addon.name}`}
                      disabled={busy}
                      onClick={() => confirmAndMutate(addon.code, qty + 1)}
                    >
                      +
                    </Button>
                    {isActive && (
                      <Button
                        intent="ghost"
                        size="sm"
                        className="ml-auto"
                        disabled={busy}
                        onClick={() => confirmAndMutate(addon.code, 0)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

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
      <PlanSelector currentPlanCode={sub?.plan.code ?? null} />
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
            <div className="text-slate-500">Billing period ends</div>
            <div className="font-medium text-slate-900">
              {sub?.currentPeriodEnd
                ? formatAppDate(sub.currentPeriodEnd, {
                    timeZone: "America/New_York",
                  })
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Last synced</div>
            <div className="font-medium text-slate-900">
              {sub?.stripeLastSyncedAt
                ? formatAppDate(sub.stripeLastSyncedAt, {
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
      <AddonSelector
        currentByCode={
          new Map(q.data.addons.map((a) => [a.addon.code, a.quantity]))
        }
      />
    </div>
  );
}
