import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { useToast } from "@/hooks/use-toast";
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

/** Plain-language explainer for each add-on, keyed by catalog `code`:
 *  what the add-on actually does and why it's worth having as part of the
 *  package. Surfaced in a collapsible dropdown under each add-on card so
 *  tenant owners can make an informed choice without contacting sales.
 *  Codes match the seed catalog (migration 0362); unknown codes fall back
 *  to the add-on's catalog description. */
const ADDON_DETAILS: Record<
  string,
  { whatItDoes: string; whyItMatters: string }
> = {
  additional_seat: {
    whatItDoes:
      "Adds one more admin/staff login beyond your plan's included seats.",
    whyItMatters:
      "Every team member should have their own secure login rather than sharing one — it keeps activity attributable, protects PHI, and means no one gets locked out as your team grows.",
  },
  active_patient_block: {
    whatItDoes: "Raises your active-patient ceiling by 500 patients/customers.",
    whyItMatters:
      "Your plan caps how many active patients you can manage at once. Adding a block before you hit the limit keeps resupply reminders and new orders flowing instead of stalling when your roster grows.",
  },
  additional_location: {
    whatItDoes: "Adds one more serviced business branch or location.",
    whyItMatters:
      "If you operate from more than one storefront or branch, each needs its own location record so orders route correctly and inventory and reporting stay accurate per site.",
  },
  message_bundle: {
    whatItDoes: "Adds 1,000 outbound SMS/email messages to your monthly pool.",
    whyItMatters:
      "Resupply reminders and order updates go out by text and email — the single biggest driver of repeat orders. Running out mid-month silently stops that outreach, so a bundle keeps patient communication uninterrupted.",
  },
  ai_text_bundle: {
    whatItDoes: "Adds 1,000 AI text interactions to your monthly pool.",
    whyItMatters:
      "These power the storefront chatbot, sleep coach, admin assistant, and email auto-replies. The bundle keeps the assistants answering patients and staff once you pass the plan's included interactions.",
  },
  billing_transaction_bundle: {
    whatItDoes:
      "Adds 1,000 claims, eligibility, or billing transactions per month.",
    whyItMatters:
      "Every insurance eligibility check and claim submission counts as a transaction. The bundle ensures billing keeps processing during high-volume months instead of holding up reimbursement.",
  },
  storage_100gb: {
    whatItDoes: "Adds 100 GB of document and attachment storage.",
    whyItMatters:
      "Prescription PDFs, proof-of-delivery photos, and inbound MMS attachments accumulate over time. Extra storage prevents upload failures and keeps required documentation on hand.",
  },
  ai_voice_agent: {
    whatItDoes: "Turns on the AI voice agent and IVR call automation.",
    whyItMatters:
      "It answers and places resupply calls automatically — freeing staff from the phones, capturing orders after hours, and scaling outreach without adding headcount.",
  },
  advanced_billing_automation: {
    whatItDoes:
      "Enables auto-submit, the AI work queue, denial analyzer, and payer rules.",
    whyItMatters:
      "Billing is the most labor-intensive part of DME. Automating submission and surfacing why claims are denied recovers revenue that otherwise leaks away and cuts manual rework.",
  },
  fax_automation: {
    whatItDoes: "Automates outbound and inbound fax workflows.",
    whyItMatters:
      "DME still runs on fax for prescriptions and prior authorizations. Automating it removes manual faxing and keeps required documents moving without a staffer babysitting the machine.",
  },
  additional_therapy_vendor: {
    whatItDoes:
      "Adds one more therapy-cloud vendor connection (e.g. ResMed, Philips, 3B).",
    whyItMatters:
      "Pulling device usage and compliance data straight from the manufacturer's cloud lets you serve patients across more device brands without manual data entry.",
  },
  advanced_analytics: {
    whatItDoes:
      "Unlocks financial, attribution, LTV/CAC, channel, and inventory analytics.",
    whyItMatters:
      "Shows where your revenue and customers actually come from so you can invest in the channels that work and spot inventory or margin problems before they cost you.",
  },
  multi_location_management: {
    whatItDoes:
      "Enables multi-branch workflows when they aren't included in your plan.",
    whyItMatters:
      "Coordinate inventory, staffing, and reporting across every branch from one place instead of running each location as a disconnected silo.",
  },
  data_migration: {
    whatItDoes:
      "A one-time project to import your existing patients, orders, and history.",
    whyItMatters:
      "Getting your current data in cleanly means you launch fully operational — with resupply timing and history intact — instead of starting from an empty system.",
  },
  custom_domain_branding_setup: {
    whatItDoes: "One-time setup of your own domain and storefront branding.",
    whyItMatters:
      "Running the storefront on your own domain with your brand keeps customers seeing you — not a generic platform — which builds trust and protects your brand equity.",
  },
  dedicated_success_manager: {
    whatItDoes:
      "Assigns a dedicated customer-success owner with recurring workflow reviews.",
    whyItMatters:
      "A named expert who knows your account proactively reviews your workflows and helps you get more value, rather than starting from scratch with general support each time.",
  },
  custom_integration: {
    whatItDoes: "Scoped custom integration work for a system you already use.",
    whyItMatters:
      "Connects the platform to tools that aren't covered out of the box so your existing systems keep working together instead of forcing manual double-entry.",
  },
};

/** Collapsible "what this does & why it matters" explainer rendered under
 *  each add-on card. Uses a native <details> element so it needs no extra
 *  state and stays accessible. Falls back to the catalog description when
 *  no richer copy is mapped for the add-on's code. */
function AddonExplainer({ addon }: { addon: BillingAddon }) {
  const detail = ADDON_DETAILS[addon.code];
  return (
    <details
      className="group mt-3 border-t border-slate-100 pt-2"
      data-testid={`addon-explainer-${addon.code}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold text-slate-700 hover:text-slate-900">
        <span>What this does &amp; why it matters</span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-2 space-y-2 text-xs text-slate-600">
        {detail ? (
          <>
            <p>
              <span className="font-semibold text-slate-700">
                What it does:
              </span>{" "}
              {detail.whatItDoes}
            </p>
            <p>
              <span className="font-semibold text-slate-700">
                Why it matters:
              </span>{" "}
              {detail.whyItMatters}
            </p>
          </>
        ) : (
          <p>{addon.description}</p>
        )}
      </div>
    </details>
  );
}

/** Tenant self-service plan picker. Lists the public plans; the active
 *  plan is marked, non-custom plans get a "Select"/"Switch" button, and
 *  custom/Enterprise tiers render a "Contact us" state. Selecting a plan
 *  records the choice and syncs it to Stripe via the API, then refreshes
 *  the billing package query. */
function PlanSelector({ currentPlanCode }: { currentPlanCode: string | null }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingCode, setPendingCode] = useState<string | null>(null);

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
          const isPending = pendingCode === plan.code && mutation.isPending;
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
                    disabled={mutation.isPending}
                    onClick={async () => {
                      // Cost/proration preview before confirming. Falls back
                      // to a plain confirm if the preview can't be fetched.
                      let message = `Switch to the ${plan.name} plan (${formatMoney(
                        plan.monthlyPriceCents,
                      )}/mo)? This updates your Stripe billing immediately.`;
                      try {
                        const preview = await previewOwnBillingChange({
                          kind: "plan",
                          planCode: plan.code,
                        });
                        message = buildPreviewConfirm(preview);
                      } catch {
                        // keep the static fallback message
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
    const name = addons.find((a) => a.code === code)?.name ?? code;
    let message =
      quantity === 0
        ? `Remove the ${name} add-on? This updates your Stripe billing immediately.`
        : `Set ${name} to ${quantity}? This updates your Stripe billing immediately.`;
    try {
      const preview = await previewOwnBillingChange({
        kind: "addon",
        addonCode: code,
        quantity,
      });
      message = buildPreviewConfirm(preview);
    } catch {
      // keep the static fallback message
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
          const isPending = pendingCode === addon.code && mutation.isPending;
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
                      disabled={mutation.isPending || qty === 0}
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
                      disabled={mutation.isPending}
                      onClick={() => confirmAndMutate(addon.code, qty + 1)}
                    >
                      +
                    </Button>
                    {isActive && (
                      <Button
                        intent="ghost"
                        size="sm"
                        className="ml-auto"
                        disabled={mutation.isPending}
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
                ? new Date(sub.stripeLastSyncedAt).toLocaleDateString(
                    undefined,
                    {
                      timeZone: "America/New_York",
                    },
                  )
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
